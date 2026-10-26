//! Playing sound at other speeds. Time-stretch keeps the pitch with WSOLA
//! (waveform-similarity overlap-add): windows of the source are laid a hop apart
//! on the output, each read near where the speed puts it, at the offset that
//! best continues the window before. Varispeed lets the pitch follow the speed:
//! the source is read between its samples through a windowed sinc whose cutoff
//! falls with the speed, so nothing aliases.
//!
//! Output windows sit on a fixed grid of output samples, so any stretch of the
//! output can be rendered on its own. Each window's offset depends on the one
//! before; a [`Stretcher`] remembers the offsets it chose, and starts a few
//! windows early where it knows none.
use std::collections::BTreeMap;

/// Windows decided before the first one wanted, when nothing earlier is known.
const WARM_UP: i64 = 6;
/// How far back a remembered window still helps; further, a fresh start is quicker.
const RECALL: i64 = 256;
/// Offsets remembered per stretcher.
const MEMORY: usize = 4096;

/// WSOLA's window, the hop between windows, and how far either side of its
/// nominal place a window may be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grains {
    pub window: usize,
    pub hop: usize,
    pub reach: usize,
}

impl Grains {
    /// 20 ms windows overlapping by half, read up to 10 ms either side.
    pub fn at(rate: u32) -> Grains {
        let hop = ((rate as f64 * 0.010).round() as usize).max(16);
        Grains {
            window: hop * 2,
            hop,
            reach: hop,
        }
    }

    /// A periodic Hann window: windows a hop apart add up to exactly one.
    pub fn weight(&self, index: usize) -> f32 {
        let phase = index as f64 / self.window as f64;
        (0.5 - 0.5 * (std::f64::consts::TAU * phase).cos()) as f32
    }
}

/// The offset in `-reach..=reach` at which `candidates` best continues
/// `template`: the highest normalised cross-correlation. `candidates` holds
/// `template.len() + 2 * reach` samples, centred on the nominal place. Searched
/// every fourth offset over every fourth sample, then around the best of those.
/// Ties keep the nominal place.
pub fn best_offset(template: &[f32], candidates: &[f32], reach: usize) -> i64 {
    let n = template.len();
    debug_assert!(candidates.len() >= n + 2 * reach);
    let score = |offset: usize, step: usize| {
        let (mut dot, mut energy) = (0.0f64, 0.0f64);
        let mut i = 0;
        while i < n {
            let c = candidates[offset + i] as f64;
            dot += template[i] as f64 * c;
            energy += c * c;
            i += step;
        }
        if energy <= 1e-18 {
            0.0
        } else {
            dot / energy.sqrt()
        }
    };
    let mut best = reach;
    let mut best_score = score(reach, 4);
    for offset in (0..=2 * reach).step_by(4) {
        let s = score(offset, 4);
        if s > best_score + 1e-9 {
            (best, best_score) = (offset, s);
        }
    }
    let (low, high) = (best.saturating_sub(4), (best + 4).min(2 * reach));
    let mut fine = best;
    let mut fine_score = score(best, 1);
    for offset in low..=high {
        let s = score(offset, 1);
        if s > fine_score + 1e-9 {
            (fine, fine_score) = (offset, s);
        }
    }
    fine as i64 - reach as i64
}

/// The windows one stretched sound reads: where each one starts in the source.
#[derive(Clone, Debug, Default)]
pub struct Stretcher {
    starts: BTreeMap<i64, i64>,
}

impl Stretcher {
    /// Where output window `k` reads the source. `nominal(k)` is where the speed
    /// puts it; `read(start, out)` fills `out` with the (mono) source from `start`.
    pub fn start(
        &mut self,
        grains: Grains,
        k: i64,
        nominal: &impl Fn(i64) -> i64,
        read: &mut impl FnMut(i64, &mut [f32]),
    ) -> i64 {
        if let Some(&start) = self.starts.get(&k) {
            return start;
        }
        let known = self
            .starts
            .range(k - RECALL..k)
            .next_back()
            .map(|(&j, &start)| (j, start));
        let (mut j, mut previous) = match known {
            Some(found) => found,
            None => {
                let first = k - WARM_UP;
                (first, nominal(first))
            }
        };
        let mut template = vec![0.0f32; grains.window - grains.hop];
        let mut candidates = vec![0.0f32; template.len() + 2 * grains.reach];
        while j < k {
            j += 1;
            let place = nominal(j);
            // The window before, continued: what this one should sound like at first.
            read(previous + grains.hop as i64, &mut template);
            read(place - grains.reach as i64, &mut candidates);
            previous = place + best_offset(&template, &candidates, grains.reach);
            self.starts.insert(j, previous);
        }
        if self.starts.len() > MEMORY {
            // Keep the windows around the latest ones asked for.
            let keep = self.starts.split_off(&(k - (MEMORY as i64) / 2));
            self.starts = keep;
        }
        previous
    }
}

/// `sin(πx) / (πx)`.
fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        let px = std::f64::consts::PI * x;
        px.sin() / px
    }
}

/// Zero crossings of the varispeed kernel either side, at normal speed.
const SINC_ZEROS: f64 = 8.0;

/// The sound at fractional source position `position`, read through `get`, for
/// playing `ratio` times as fast: a Blackman-windowed sinc whose cutoff falls by
/// the ratio above 1, normalised so a constant stays constant.
pub fn sinc_at(get: impl Fn(i64) -> f32, position: f64, ratio: f64) -> f32 {
    let scale = ratio.abs().max(1.0);
    let half = (SINC_ZEROS * scale).ceil() as i64;
    let centre = position.floor() as i64;
    let fraction = position - centre as f64;
    let (mut sum, mut norm) = (0.0f64, 0.0f64);
    for j in (1 - half)..=half {
        let distance = j as f64 - fraction;
        let x = distance / half as f64;
        if x.abs() >= 1.0 {
            continue;
        }
        let blackman = 0.42
            + 0.5 * (std::f64::consts::PI * x).cos()
            + 0.08 * (2.0 * std::f64::consts::PI * x).cos();
        let weight = sinc(distance / scale) * blackman;
        sum += weight * get(centre + j) as f64;
        norm += weight;
    }
    if norm.abs() < 1e-12 {
        0.0
    } else {
        (sum / norm) as f32
    }
}

/// The source samples `sinc_at` reads either side of a position at `ratio`.
pub fn sinc_reach(ratio: f64) -> i64 {
    (SINC_ZEROS * ratio.abs().max(1.0)).ceil() as i64 + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_signal::sine;

    /// Frequency from upward zero crossings, interpolated between samples.
    fn frequency(samples: &[f32], rate: u32) -> f64 {
        let mut crossings = Vec::new();
        for i in 1..samples.len() {
            let (a, b) = (samples[i - 1], samples[i]);
            if a < 0.0 && b >= 0.0 {
                crossings.push(i as f64 - 1.0 + (-a / (b - a)) as f64);
            }
        }
        let periods = crossings.len() - 1;
        periods as f64 * rate as f64 / (crossings[periods] - crossings[0])
    }

    /// Stretches a whole signal at a constant `speed`, as the mixer does.
    fn stretch(source: &[f32], speed: f64, rate: u32) -> Vec<f32> {
        let grains = Grains::at(rate);
        let length = (source.len() as f64 / speed) as usize - grains.window * 2;
        let nominal = |k: i64| (k as f64 * grains.hop as f64 * speed).round() as i64;
        let mut read = |start: i64, out: &mut [f32]| {
            for (i, sample) in out.iter_mut().enumerate() {
                let at = start + i as i64;
                *sample = if at >= 0 && (at as usize) < source.len() {
                    source[at as usize]
                } else {
                    0.0
                };
            }
        };
        let mut stretcher = Stretcher::default();
        let mut window = vec![0.0f32; grains.window];
        let mut out = vec![0.0f32; length];
        for k in 0..=(length / grains.hop) as i64 {
            let start = stretcher.start(grains, k, &nominal, &mut read);
            read(start, &mut window);
            for (i, sample) in window.iter().enumerate() {
                let t = k as usize * grains.hop + i;
                if t < length {
                    out[t] += sample * grains.weight(i);
                }
            }
        }
        out
    }

    #[test]
    fn windows_a_hop_apart_add_up_to_one() {
        let grains = Grains::at(48_000);
        assert_eq!((grains.window, grains.hop, grains.reach), (960, 480, 480));
        for i in 0..grains.hop {
            let sum = grains.weight(i) + grains.weight(i + grains.hop);
            assert!((sum - 1.0).abs() < 1e-6);
        }
    }

    #[test]
    fn the_best_offset_lines_a_wave_up_with_itself() {
        let wave = sine(48_000, 220.0, 0.5, 4000);
        let template = &wave[1000..1480];
        // Candidates centred 37 samples before the matching place.
        let candidates = &wave[1037 - 480..1037 + 480 + 480];
        let offset = best_offset(template, candidates, 480);
        // One period of 220 Hz is about 218 samples: any whole number of them fits.
        let period = 48_000.0 / 220.0;
        let k = ((offset + 37) as f64 / period).round();
        assert!(((offset + 37) as f64 - k * period).abs() < 1.0, "{offset}");
        let silence = vec![0.0; 1440];
        assert_eq!(best_offset(&silence[..480], &silence, 480), 0);
    }

    #[test]
    fn time_stretch_keeps_the_pitch_and_follows_the_speed() {
        let rate = 48_000;
        for tone in [220.0, 1000.0, 3150.0] {
            let source = sine(rate, tone, 0.5, rate as usize * 3);
            for speed in [0.25, 0.5, 0.8, 1.5, 2.0, 4.0] {
                let out = stretch(&source, speed, rate);
                let middle = &out[out.len() / 4..out.len() * 3 / 4];
                let measured = frequency(middle, rate);
                let cents = 1200.0 * (measured / tone).log2();
                assert!(
                    cents.abs() < 10.0,
                    "{tone} Hz at {speed}×: {measured} ({cents} cents)"
                );
                let level = crate::test_signal::rms(middle);
                assert!(
                    (level / (0.5 / 2f64.sqrt()) - 1.0).abs() < 0.06,
                    "level {level}"
                );
            }
        }
    }

    #[test]
    fn varispeed_shifts_the_pitch_with_the_speed() {
        let rate = 48_000;
        let source = sine(rate, 1000.0, 0.5, rate as usize);
        let get = |at: i64| {
            if (0..source.len() as i64).contains(&at) {
                source[at as usize]
            } else {
                0.0
            }
        };
        for speed in [0.5, 1.0, 1.7, 4.0] {
            let out: Vec<f32> = (0..8000)
                .map(|t| sinc_at(get, 400.0 + t as f64 * speed, speed))
                .collect();
            let measured = frequency(&out, rate);
            let expected = 1000.0 * speed;
            assert!(
                (measured / expected - 1.0).abs() < 0.001,
                "{speed}×: {measured}"
            );
        }
        // At 4×, 15 kHz would alias down to 12 kHz; it is filtered out instead.
        let high = sine(rate, 15_000.0, 0.5, rate as usize);
        let high_get = |at: i64| high.get(at.max(0) as usize).copied().unwrap_or(0.0);
        let folded: Vec<f32> = (0..4000)
            .map(|t| sinc_at(high_get, 1000.0 + t as f64 * 4.0, 4.0))
            .collect();
        assert!(crate::test_signal::rms(&folded) < 0.01);
    }
}

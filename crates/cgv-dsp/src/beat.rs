//! Beat detection: an onset envelope (spectral flux in log-spaced bands every
//! 10 ms), the tempo that best fits it, and beat times tracked by dynamic
//! programming (Ellis, "Beat Tracking by Dynamic Programming", 2007, as librosa
//! does it).
use std::sync::Arc;

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};

/// Envelope readings per second.
pub const HOPS_PER_SECOND: u32 = 100;
/// Tempos the tracker considers, in beats per minute.
pub const TEMPO_RANGE: (f64, f64) = (40.0, 220.0);
/// Bands are compressed as log(1 + γ·level), so quiet onsets count too.
const COMPRESSION: f32 = 1.0;
/// Flux is measured from this frequency up to the next: kicks, snares, chords
/// and hats...
const BOTTOM_HZ: f32 = 30.0;
const TOP_HZ: f32 = 11_000.0;
/// ...in bands this many to the octave, at least a bin wide, so a kick's few
/// low bins count as much as a hat's hundreds of high ones.
const BANDS_PER_OCTAVE: f32 = 6.0;
/// How strongly beats keep to the tempo (librosa's `tightness`).
const TIGHTNESS: f64 = 300.0;
/// The tempo the prior favours, and its spread in octaves.
const PRIOR_BPM: f64 = 120.0;
const PRIOR_OCTAVES: f64 = 1.0;

/// Spectral flux of planar sound in log-spaced bands, every 10 ms. Reading `k` compares the frames
/// centred on hops `k − 1` and `k`, so it peaks as an onset arrives at time
/// `k / 100` s. Fed in blocks of any size, it reads the same as one block.
pub struct Onsets {
    frame: usize,
    hop: usize,
    /// The first bin of each band, then the end of the last.
    bands: Vec<usize>,
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    /// Mono samples not yet taken by a frame; the first frame is centred on 0.
    pending: Vec<f32>,
    taken: usize,
    pushed: usize,
    previous: Vec<f32>,
    input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    envelope: Vec<f32>,
}

impl Onsets {
    pub fn new(rate: u32) -> Onsets {
        // About 21 ms: short enough to place onsets within a few milliseconds.
        let frame = ((rate as f32 * 0.021) as usize).next_power_of_two();
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(frame);
        let window = (0..frame)
            .map(|i| {
                let phase = 2.0 * std::f32::consts::PI * i as f32 / frame as f32;
                0.5 - 0.5 * phase.cos()
            })
            .collect();
        let bin = |hz: f32| ((hz * frame as f32 / rate as f32).round() as usize).min(frame / 2);
        let mut bands = vec![bin(BOTTOM_HZ).max(1)];
        let top = bin(TOP_HZ);
        let mut hz = BOTTOM_HZ;
        while *bands.last().expect("a first band") < top {
            hz *= 2f32.powf(1.0 / BANDS_PER_OCTAVE);
            let edge = bin(hz).clamp(bands[bands.len() - 1] + 1, top);
            if edge > bands[bands.len() - 1] && (bin(hz) >= edge || edge == top) {
                bands.push(edge);
            }
        }
        Onsets {
            frame,
            hop: (rate / HOPS_PER_SECOND).max(1) as usize,
            bands,
            spectrum: fft.make_output_vec(),
            input: fft.make_input_vec(),
            fft,
            window,
            pending: vec![0.0; frame / 2],
            taken: 0,
            pushed: 0,
            previous: Vec::new(),
            envelope: Vec::new(),
        }
    }

    /// Adds planar sound: one slice per channel, all the same length.
    pub fn push(&mut self, planes: &[&[f32]]) {
        let Some(first) = planes.first() else { return };
        let scale = 1.0 / planes.len() as f32;
        self.pending.extend(
            (0..first.len()).map(|i| planes.iter().map(|plane| plane[i]).sum::<f32>() * scale),
        );
        self.pushed += first.len();
        self.run();
    }

    /// The envelope: one reading per hop of the sound pushed.
    pub fn finish(mut self) -> Vec<f32> {
        let hops = self.pushed.div_ceil(self.hop);
        while self.envelope.len() < hops {
            let missing = self.frame.saturating_sub(self.pending.len() - self.taken);
            self.pending
                .extend(std::iter::repeat_n(0.0, missing.max(self.hop)));
            self.run();
        }
        self.envelope.truncate(hops);
        self.envelope
    }

    fn run(&mut self) {
        while self.pending.len() - self.taken >= self.frame {
            let frame = &self.pending[self.taken..self.taken + self.frame];
            for ((x, &sample), &w) in self.input.iter_mut().zip(frame).zip(&self.window) {
                *x = sample * w;
            }
            self.fft
                .process(&mut self.input, &mut self.spectrum)
                .expect("buffer sizes match the plan");
            let current: Vec<f32> = self
                .bands
                .windows(2)
                .map(|band| {
                    let level: f32 = self.spectrum[band[0]..band[1]]
                        .iter()
                        .map(|bin| bin.norm())
                        .sum();
                    (1.0 + COMPRESSION * level).ln()
                })
                .collect();
            let flux = if self.previous.is_empty() {
                0.0
            } else {
                current
                    .iter()
                    .zip(&self.previous)
                    .map(|(now, before)| (now - before).max(0.0))
                    .sum()
            };
            self.envelope.push(flux);
            self.previous = current;
            self.taken += self.hop;
        }
        if self.taken > 1 << 16 {
            self.pending.drain(..self.taken);
            self.taken = 0;
        }
    }
}

/// The envelope less its local mean (over a second), floored at zero: steady
/// sound adds nothing, onsets stand out.
fn onset_strength(envelope: &[f32]) -> Vec<f64> {
    let reach = HOPS_PER_SECOND as usize / 2;
    let mut sums = vec![0.0f64; envelope.len() + 1];
    for (i, &x) in envelope.iter().enumerate() {
        sums[i + 1] = sums[i] + x as f64;
    }
    (0..envelope.len())
        .map(|i| {
            let (a, b) = (i.saturating_sub(reach), (i + reach + 1).min(envelope.len()));
            let mean = (sums[b] - sums[a]) / (b - a) as f64;
            (envelope[i] as f64 - mean).max(0.0)
        })
        .collect()
}

/// The tempo of an onset envelope in beats per minute: the autocorrelation lag
/// that scores best under a prior centred on 120 BPM, refined between hops.
/// None when the envelope has no onsets or is shorter than two beats.
pub fn tempo(envelope: &[f32]) -> Option<f64> {
    let strength = onset_strength(envelope);
    let rate = HOPS_PER_SECOND as f64;
    let shortest = (60.0 * rate / TEMPO_RANGE.1).floor() as usize;
    let longest = (60.0 * rate / TEMPO_RANGE.0).ceil() as usize;
    if strength.len() < 2 * longest || strength.iter().all(|&x| x == 0.0) {
        return None;
    }
    let correlation = |lag: usize| -> f64 {
        strength[lag..]
            .iter()
            .zip(&strength)
            .map(|(a, b)| a * b)
            .sum::<f64>()
            / (strength.len() - lag) as f64
    };
    let scores: Vec<f64> = (0..=longest + 1)
        .map(|lag| {
            if lag < shortest.saturating_sub(1) || lag == 0 {
                return 0.0;
            }
            let bpm = 60.0 * rate / lag as f64;
            let octaves = (bpm / PRIOR_BPM).log2() / PRIOR_OCTAVES;
            correlation(lag) * (-0.5 * octaves * octaves).exp()
        })
        .collect();
    let best = (shortest..=longest).max_by(|&a, &b| scores[a].total_cmp(&scores[b]))?;
    if scores[best] <= 0.0 {
        return None;
    }
    // The same peak several beats on gives the period more exactly: a hop in
    // four beats is a quarter of a hop in one. A parabola places it between hops.
    let beats = (1..=4)
        .rev()
        .find(|&n| (n * best + n + 1) * 2 <= strength.len())
        .unwrap_or(1);
    let around = beats * best;
    let peak = (around - beats..=around + beats)
        .max_by(|&a, &b| correlation(a).total_cmp(&correlation(b)))
        .unwrap_or(around);
    let (before, at, after) = (
        correlation(peak - 1),
        correlation(peak),
        correlation(peak + 1),
    );
    let curve = before - 2.0 * at + after;
    let offset = if curve < 0.0 {
        (0.5 * (before - after) / curve).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    Some(60.0 * rate * beats as f64 / (peak as f64 + offset))
}

/// Beat times in seconds for an onset envelope at `bpm` (from [`tempo`]), in
/// order. Weak beats before the music starts and after it stops are left out.
pub fn beats(envelope: &[f32], bpm: f64) -> Vec<f64> {
    let rate = HOPS_PER_SECOND as f64;
    let period = 60.0 * rate / bpm;
    let strength = onset_strength(envelope);
    let deviation = {
        let mean = strength.iter().sum::<f64>() / strength.len().max(1) as f64;
        let variance = strength
            .iter()
            .map(|x| (x - mean) * (x - mean))
            .sum::<f64>()
            / strength.len().max(1) as f64;
        variance.sqrt()
    };
    if deviation == 0.0 || !period.is_finite() || period < 1.0 {
        return Vec::new();
    }
    // Local score: the normalised strength smoothed by a Gaussian a 32nd of a beat wide.
    let sigma = (period / 32.0).max(0.5);
    let reach = (3.0 * sigma).ceil() as isize;
    let kernel: Vec<f64> = (-reach..=reach)
        .map(|i| (-0.5 * (i as f64 / sigma).powi(2)).exp())
        .collect();
    let n = strength.len();
    let local: Vec<f64> = (0..n as isize)
        .map(|t| {
            kernel
                .iter()
                .enumerate()
                .filter_map(|(k, w)| {
                    let i = t + k as isize - reach;
                    (0..n as isize)
                        .contains(&i)
                        .then(|| w * strength[i as usize] / deviation)
                })
                .sum()
        })
        .collect();
    // Each hop's best chain of beats ending there, one beat period apart or so.
    let mut cumulative = vec![0.0f64; n];
    let mut back = vec![usize::MAX; n];
    let (near, far) = (
        (period / 2.0).round() as usize,
        (2.0 * period).round() as usize,
    );
    for t in 0..n {
        let mut best = 0.0;
        for gap in near.max(1)..=far {
            let Some(before) = t.checked_sub(gap) else {
                break;
            };
            let penalty = TIGHTNESS * (gap as f64 / period).ln().powi(2);
            let score = cumulative[before] - penalty;
            if back[t] == usize::MAX || score > best {
                best = score;
                back[t] = before;
            }
        }
        cumulative[t] = local[t] + if back[t] == usize::MAX { 0.0 } else { best };
    }
    // The chain ends at the last strong peak of the cumulative score.
    let peaks: Vec<usize> = (1..n.saturating_sub(1))
        .filter(|&t| cumulative[t] > cumulative[t - 1] && cumulative[t] >= cumulative[t + 1])
        .collect();
    let Some(&last) = ({
        let mut values: Vec<f64> = peaks.iter().map(|&t| cumulative[t]).collect();
        values.sort_by(f64::total_cmp);
        let median = values.get(values.len() / 2).copied().unwrap_or(0.0);
        peaks.iter().rev().find(|&&t| cumulative[t] >= 0.5 * median)
    }) else {
        return Vec::new();
    };
    let mut chain = vec![last];
    while let Some(&t) = chain.last() {
        match back[t] {
            usize::MAX => break,
            before => chain.push(before),
        }
    }
    chain.reverse();
    // Leading and trailing beats with little under them, smoothed over their
    // neighbours, are the tracker filling time before and after the music.
    let at: Vec<f64> = chain.iter().map(|&t| local[t]).collect();
    let smoothed: Vec<f64> = (0..at.len())
        .map(|i| {
            let before = if i > 0 { at[i - 1] } else { 0.0 };
            let after = at.get(i + 1).copied().unwrap_or(0.0);
            0.5 * before + at[i] + 0.5 * after
        })
        .collect();
    let rms = (smoothed.iter().map(|x| x * x).sum::<f64>() / smoothed.len() as f64).sqrt();
    let strong = |x: &f64| *x > 0.5 * rms;
    let first = smoothed.iter().position(strong).unwrap_or(chain.len());
    let end = smoothed.iter().rposition(strong).map_or(first, |i| i + 1);
    chain[first..end].iter().map(|&t| t as f64 / rate).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_signal::noise;

    const RATE: u32 = 44_100;

    /// A kick on every beat from `first` (s) at `bpm`, hats between, over noise.
    fn groove(bpm: f64, first: f64, seconds: f64) -> (Vec<f32>, Vec<f64>) {
        let frames = (seconds * RATE as f64) as usize;
        let mut samples: Vec<f32> = noise(3, frames).iter().map(|x| x * 0.01).collect();
        let hiss = noise(11, frames);
        let beat = 60.0 / bpm;
        let mut times = Vec::new();
        let mut t = first;
        while t < seconds - 0.2 {
            times.push(t);
            let start = (t * RATE as f64).round() as usize;
            let mut phase = 0.0f64;
            // A falling sine with the beater's click on top, then a hat between beats.
            for i in 0..((0.25 * RATE as f64) as usize).min(frames - start) {
                let age = i as f64 / RATE as f64;
                let frequency = 50.0 + 70.0 * (-age / 0.03).exp();
                phase += 2.0 * std::f64::consts::PI * frequency / RATE as f64;
                let click = 0.3 * (-age / 0.002).exp() * hiss[start + i] as f64;
                samples[start + i] += (0.8 * (-age / 0.12).exp() * phase.sin() + click) as f32;
            }
            let hat = ((t + beat / 2.0) * RATE as f64).round() as usize;
            for i in 0..(0.04 * RATE as f64) as usize {
                if hat + i < frames {
                    let age = i as f32 / RATE as f32;
                    samples[hat + i] += 0.3 * (-age / 0.01).exp() * hiss[hat + i];
                }
            }
            t += beat;
        }
        (samples, times)
    }

    fn envelope(samples: &[f32], block: usize) -> Vec<f32> {
        let mut onsets = Onsets::new(RATE);
        for chunk in samples.chunks(block) {
            onsets.push(&[chunk]);
        }
        onsets.finish()
    }

    #[test]
    fn the_envelope_is_the_same_in_any_blocks_and_one_reading_a_hop() {
        let (samples, _) = groove(120.0, 0.25, 4.0);
        let whole = envelope(&samples, samples.len());
        assert_eq!(whole.len(), samples.len().div_ceil(441));
        let pieces = envelope(&samples, 1000);
        for (a, b) in whole.iter().zip(&pieces) {
            assert!((a - b).abs() <= 1e-3 * a.abs().max(1.0), "{a} {b}");
        }
    }

    #[test]
    fn tempo_and_beats_of_a_steady_groove() {
        for (bpm, first) in [(120.0, 0.25), (92.0, 0.61), (128.0, 0.1)] {
            let (samples, truth) = groove(bpm, first, 30.0);
            let envelope = envelope(&samples, 4096);
            let found = tempo(&envelope).expect("a tempo");
            assert!((found - bpm).abs() < 0.01 * bpm, "{bpm}: {found}");
            let beats = beats(&envelope, found);
            // Every kick has a beat within 15 ms, and no beat is far from a kick.
            let near = |t: f64, list: &[f64]| list.iter().any(|&x| (x - t).abs() <= 0.015);
            let missed: Vec<f64> = truth
                .iter()
                .copied()
                .filter(|&t| !near(t, &beats))
                .collect();
            assert!(missed.is_empty(), "{bpm}: missed {missed:?} in {beats:?}");
            let extra: Vec<f64> = beats
                .iter()
                .copied()
                .filter(|&t| !near(t, &truth))
                .collect();
            assert!(extra.is_empty(), "{bpm}: extra {extra:?}");
        }
    }

    #[test]
    fn silence_has_no_tempo_or_beats() {
        let silence = envelope(&vec![0.0; RATE as usize * 10], 4096);
        assert_eq!(tempo(&silence), None);
        assert!(beats(&silence, 120.0).is_empty());
        assert_eq!(tempo(&envelope(&vec![0.0; 1000], 1000)), None);
    }
}

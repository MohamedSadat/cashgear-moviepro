//! Lining up recordings of one event by their sound: where in one recording the
//! sound heard at a moment of another is, to a fraction of a millisecond.
//!
//! Microphones differ in level, tone and noise, so matching starts on onsets:
//! how sharply the sound gets louder each millisecond, which every microphone
//! hears alike. Their cross-correlation finds the lag to the millisecond. The
//! sound itself, high-passed, then settles it to a fraction of a sample.
use realfft::num_complex::Complex;
use realfft::RealFftPlanner;

/// The rate recordings are synced at.
pub const RATE: u32 = 16_000;
/// Samples per onset step: 1 ms.
const STEP: usize = 16;
/// The fine search spans this many samples either side of the coarse lag.
const FINE_SPAN: i64 = 48;
/// The fine search compares at most this much sound: 60 s.
const FINE_LENGTH: usize = 60 * RATE as usize;

/// Where `other`'s sound lines up with `reference`'s.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lag {
    /// Seconds to add to a time in `reference` for the same moment in `other`.
    pub seconds: f64,
    /// How alike the sound is there, from 0 (unrelated) to 1 (the same).
    pub confidence: f32,
}

/// A high-passed copy of `samples`, rid of rumble and offsets that every
/// microphone records differently.
fn high_pass(samples: &[f32]) -> Vec<f32> {
    // A one-pole high-pass at about 150 Hz.
    let k = (-2.0 * std::f32::consts::PI * 150.0 / RATE as f32).exp();
    let mut out = Vec::with_capacity(samples.len());
    let (mut previous_in, mut previous_out) = (0.0f32, 0.0f32);
    for &x in samples {
        let y = k * (previous_out + x - previous_in);
        out.push(y);
        previous_in = x;
        previous_out = y;
    }
    out
}

/// How sharply the sound gets louder in each millisecond of `samples`
/// (high-passed), with the mean taken out and scaled to unit energy.
fn onsets(samples: &[f32]) -> Vec<f32> {
    let levels: Vec<f32> = samples
        .chunks(STEP)
        .map(|chunk| {
            let energy = chunk.iter().map(|x| x * x).sum::<f32>() / chunk.len() as f32;
            (energy + 1e-9).ln()
        })
        .collect();
    let mut rises: Vec<f32> = (0..levels.len())
        .map(|i| {
            let before = levels[i.saturating_sub(4)..i.max(1)]
                .iter()
                .copied()
                .fold(f32::MIN, f32::max);
            (levels[i] - before).max(0.0)
        })
        .collect();
    normalise(&mut rises);
    rises
}

fn normalise(values: &mut [f32]) {
    if values.is_empty() {
        return;
    }
    let mean = values.iter().sum::<f32>() / values.len() as f32;
    let energy: f32 = values.iter().map(|v| (v - mean) * (v - mean)).sum();
    let scale = if energy > 0.0 {
        energy.sqrt().recip()
    } else {
        0.0
    };
    for v in values.iter_mut() {
        *v = (*v - mean) * scale;
    }
}

/// The cross-correlation `c[k] = Σ a[t] b[t + k]` for `k` in `-max_lag..=max_lag`,
/// by FFT.
fn correlate(a: &[f32], b: &[f32], max_lag: usize) -> Vec<f32> {
    let size = (a.len() + b.len()).next_power_of_two().max(2);
    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(size);
    let inverse = planner.plan_fft_inverse(size);
    let spectrum = |signal: &[f32]| {
        let mut input = vec![0.0; size];
        input[..signal.len()].copy_from_slice(signal);
        let mut output = forward.make_output_vec();
        forward
            .process(&mut input, &mut output)
            .expect("buffer sizes match the plan");
        output
    };
    let (fa, fb) = (spectrum(a), spectrum(b));
    let mut product: Vec<Complex<f32>> = fa.iter().zip(&fb).map(|(x, y)| x.conj() * y).collect();
    let mut out = inverse.make_output_vec();
    inverse
        .process(&mut product, &mut out)
        .expect("buffer sizes match the plan");
    let scale = 1.0 / size as f32;
    (-(max_lag as i64)..=max_lag as i64)
        .map(|k| out[k.rem_euclid(size as i64) as usize] * scale)
        .collect()
}

/// The normalised correlation of `a` and `b` shifted by `lag` samples, over at
/// most [`FINE_LENGTH`] samples where both have sound, from `from` in `a`.
fn similarity(a: &[f32], b: &[f32], lag: i64, from: usize) -> f32 {
    let start = from.max((-lag).max(0) as usize);
    let end = (start + FINE_LENGTH)
        .min(a.len())
        .min((b.len() as i64 - lag).max(0) as usize);
    if end <= start {
        return 0.0;
    }
    let (mut ab, mut aa, mut bb) = (0.0f64, 0.0f64, 0.0f64);
    for t in start..end {
        let x = a[t] as f64;
        let y = b[(t as i64 + lag) as usize] as f64;
        ab += x * y;
        aa += x * x;
        bb += y * y;
    }
    if aa <= 0.0 || bb <= 0.0 {
        0.0
    } else {
        (ab / (aa * bb).sqrt()) as f32
    }
}

/// Where `other`'s sound lines up with `reference`'s, both mono at [`RATE`],
/// looking at most `max_lag` seconds either way. None when either is silent.
pub fn lag(reference: &[f32], other: &[f32], max_lag: f64) -> Option<Lag> {
    let (a, b) = (high_pass(reference), high_pass(other));
    let (onsets_a, onsets_b) = (onsets(&a), onsets(&b));
    if onsets_a.iter().all(|v| *v == 0.0) || onsets_b.iter().all(|v| *v == 0.0) {
        return None;
    }
    let max_steps = ((max_lag * 1000.0) as usize).min(onsets_a.len() + onsets_b.len());
    let coarse = correlate(&onsets_a, &onsets_b, max_steps);
    let best = coarse
        .iter()
        .enumerate()
        .max_by(|x, y| x.1.total_cmp(y.1))
        .map(|(index, _)| index as i64 - max_steps as i64)?;
    // Settle it on the sound itself, where the reference is loudest.
    let around = best * STEP as i64;
    let window = (FINE_LENGTH / 2).min(a.len());
    let from = loudest(&a, window);
    let candidates: Vec<(i64, f32)> = (around - FINE_SPAN..=around + FINE_SPAN)
        .map(|lag| (lag, similarity(&a, &b, lag, from)))
        .collect();
    let (index, &(lag, peak)) = candidates
        .iter()
        .enumerate()
        .max_by(|x, y| x.1 .1.total_cmp(&y.1 .1))?;
    // A parabola through the peak and its neighbours finds the fraction.
    let fraction = match (
        candidates.get(index.wrapping_sub(1)),
        candidates.get(index + 1),
    ) {
        (Some(&(_, left)), Some(&(_, right))) => {
            let curve = left - 2.0 * peak + right;
            if curve < 0.0 {
                (0.5 * (left - right) / curve).clamp(-0.5, 0.5)
            } else {
                0.0
            }
        }
        _ => 0.0,
    };
    Some(Lag {
        seconds: (lag as f64 + fraction as f64) / RATE as f64,
        confidence: peak.clamp(0.0, 1.0),
    })
}

/// The start of the `window` samples of `samples` with the most energy, in
/// steps of a second.
fn loudest(samples: &[f32], window: usize) -> usize {
    let second = RATE as usize;
    let energies: Vec<f64> = samples
        .chunks(second)
        .map(|chunk| chunk.iter().map(|&x| x as f64 * x as f64).sum())
        .collect();
    let span = window.div_ceil(second).max(1);
    let mut best = (0.0, 0);
    let mut sum: f64 = energies.iter().take(span).sum();
    for start in 0..energies.len().saturating_sub(span).max(1) {
        if start > 0 {
            sum += energies.get(start + span - 1).copied().unwrap_or(0.0) - energies[start - 1];
        }
        if sum > best.0 {
            best = (sum, start);
        }
    }
    best.1 * second
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_signal::noise;

    /// An event's sound at continuous time `t` seconds: bursts of tones and
    /// noise, as speech and claps have.
    fn event(t: f64, noise: &[f32]) -> f64 {
        let burst = |at: f64, length: f64, pitch: f64| {
            let x = t - at;
            if !(0.0..length).contains(&x) {
                return 0.0;
            }
            let envelope = (x / 0.004).min(1.0) * (-(x / length) * 3.0).exp();
            envelope * ((pitch * x * std::f64::consts::TAU).sin() + 0.3 * (pitch * 2.7 * x).sin())
        };
        let mut value = 0.0;
        for k in 0..40 {
            let k = k as f64;
            value += burst(
                0.37 + k * 0.613 + (k * 7.1).sin() * 0.2,
                0.18,
                180.0 + 37.0 * k,
            );
        }
        // A clap: a short noise burst.
        let clap = t - 9.0;
        if (0.0..0.03).contains(&clap) {
            let index = ((clap * RATE as f64) as usize).min(noise.len() - 1);
            value += noise[index] as f64 * (1.0 - clap / 0.03);
        }
        value
    }

    /// A microphone that started `start` seconds into the event, at `gain`, with
    /// noise of its own, `seconds` long.
    fn recording(start: f64, gain: f64, seed: u64, seconds: f64) -> Vec<f32> {
        let clap = noise(99, 1000);
        let own = noise(seed, (seconds * RATE as f64) as usize);
        (0..own.len())
            .map(|i| {
                let t = start + i as f64 / RATE as f64;
                (gain * event(t, &clap) + 0.02 * own[i] as f64) as f32
            })
            .collect()
    }

    #[test]
    fn recordings_line_up_within_a_tenth_of_a_millisecond() {
        let reference = recording(0.0, 0.5, 1, 24.0);
        // Started later, quieter and noisier; started earlier and louder.
        for (start, gain, seed) in [(1.23456, 0.2, 2), (-2.7071, 0.9, 3), (0.000_31, 0.6, 4)] {
            let other = recording(start, gain, seed, 22.0);
            let found = lag(&reference, &other, 10.0).expect("both have sound");
            // A moment at t in the reference is at t - start in the other.
            let expected = -start;
            assert!(
                (found.seconds - expected).abs() < 1e-4,
                "{start}: found {found:?}, expected {expected}"
            );
            assert!(found.confidence > 0.8, "{found:?}");
        }
    }

    #[test]
    fn silence_does_not_line_up() {
        let reference = recording(0.0, 0.5, 1, 5.0);
        assert_eq!(lag(&reference, &vec![0.0; 80_000], 2.0), None);
    }
}

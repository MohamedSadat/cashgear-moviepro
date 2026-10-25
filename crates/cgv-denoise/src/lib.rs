//! Noise reduction with RNNoise (`nnnoiseless`), as a WASM module of its own.
//! The engine worker loads it the first time a clip asks for noise reduction
//! and runs each block of that clip's source sound through it before the mixer
//! stores the block, so playback and export hear the same cleaned sound.
//!
//! RNNoise works on 48 kHz audio in 10 ms frames, so other rates are resampled
//! first. Each channel has its own denoiser. The result is moved back by the
//! denoiser's delay, so cleaned sound lines up with the original sample for
//! sample.
use nnnoiseless::DenoiseState;
use rubato::audioadapter_buffers::direct::SequentialSlice;
use rubato::{Async, FixedAsync, Resampler, SincInterpolationParameters, WindowFunction};

/// The rate RNNoise works at, and the rate cleaned sound comes back at.
pub const RATE: u32 = 48_000;
/// Samples RNNoise's output trails its input by.
pub const DELAY: usize = DenoiseState::FRAME_SIZE;
/// RNNoise expects samples on the scale of 16-bit integers.
const SCALE: f32 = 32768.0;

fn resample(planes: &[&[f32]], from: u32) -> Result<Vec<Vec<f32>>, String> {
    let channels = planes.len();
    let frames = planes[0].len();
    let parameters = SincInterpolationParameters::new(128, WindowFunction::BlackmanHarris2);
    let mut resampler = Async::<f32>::new_sinc(
        RATE as f64 / from as f64,
        1.0,
        &parameters,
        1024,
        channels,
        FixedAsync::Input,
    )
    .map_err(|error| format!("Could not set up resampling: {error}"))?;
    let input: Vec<f32> = planes.iter().flat_map(|p| p.iter().copied()).collect();
    let input = SequentialSlice::new(&input, channels, frames)
        .map_err(|error| format!("Invalid audio layout: {error}"))?;
    let capacity = resampler.process_all_needed_output_len(frames);
    let mut output = vec![0.0f32; capacity * channels];
    let (_, produced) = {
        let mut adapter = SequentialSlice::new_mut(&mut output, channels, capacity)
            .map_err(|error| format!("Invalid audio layout: {error}"))?;
        resampler
            .process_all_into_buffer(&input, &mut adapter, frames, None)
            .map_err(|error| format!("Resampling failed: {error}"))?
    };
    Ok((0..channels)
        .map(|c| output[c * capacity..c * capacity + produced].to_vec())
        .collect())
}

/// One channel at 48 kHz, cleaned and moved back by the denoiser's delay.
fn clean(plane: &[f32]) -> Vec<f32> {
    let frame = DenoiseState::FRAME_SIZE;
    let mut state = DenoiseState::new();
    let mut out = vec![0.0f32; plane.len()];
    let mut input = vec![0.0f32; frame];
    let mut output = vec![0.0f32; frame];
    let mut start = 0;
    while start < plane.len() + DELAY {
        for (i, value) in input.iter_mut().enumerate() {
            *value = plane.get(start + i).copied().unwrap_or(0.0) * SCALE;
        }
        state.process_frame(&mut output, &input);
        for (i, &value) in output.iter().enumerate() {
            let at = (start + i).wrapping_sub(DELAY);
            if let Some(slot) = out.get_mut(at) {
                *slot = value / SCALE;
            }
        }
        start += frame;
    }
    out
}

/// Cleans planar sound (`channels` planes at `rate`) and returns it planar at
/// 48 kHz, starting at the same moment.
pub fn denoise(rate: u32, channels: usize, data: &[f32]) -> Result<Vec<f32>, String> {
    if rate == 0 || channels == 0 || !data.len().is_multiple_of(channels) {
        return Err("Sound to clean has an invalid layout".into());
    }
    let frames = data.len() / channels;
    if frames == 0 {
        return Ok(Vec::new());
    }
    let planes: Vec<&[f32]> = (0..channels)
        .map(|c| &data[c * frames..(c + 1) * frames])
        .collect();
    let at_rate = if rate == RATE {
        planes.iter().map(|p| p.to_vec()).collect()
    } else {
        resample(&planes, rate)?
    };
    Ok(at_rate.iter().flat_map(|plane| clean(plane)).collect())
}

#[cfg(target_arch = "wasm32")]
mod bindings {
    use wasm_bindgen::prelude::*;

    /// Cleans planar sound and returns it planar at 48 kHz (see `cgv_denoise::denoise`).
    #[wasm_bindgen]
    pub fn denoise(rate: u32, channels: usize, data: &[f32]) -> Result<Vec<f32>, JsValue> {
        super::denoise(rate, channels, data).map_err(|error| JsValue::from_str(&error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Voiced sound: harmonics of a gliding pitch in syllable-like bursts.
    fn voice(frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| {
                let t = i as f64 / RATE as f64;
                let syllable = (t * 4.0).fract();
                let envelope = if syllable < 0.7 {
                    (std::f64::consts::PI * syllable / 0.7).sin()
                } else {
                    0.0
                };
                let pitch = 130.0 + 20.0 * (t * 1.3).sin();
                let phase = 2.0 * std::f64::consts::PI * pitch * t;
                let sum: f64 = (1..=12)
                    .map(|h| (phase * h as f64).sin() / h as f64 * (1.0 + (h as f64 * 0.4).cos()))
                    .sum();
                (0.12 * envelope * sum) as f32
            })
            .collect()
    }

    fn noise(frames: usize, level: f32) -> Vec<f32> {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        (0..frames)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                level * ((state >> 40) as f32 / (1u64 << 23) as f32 - 1.0)
            })
            .collect()
    }

    fn energy(samples: &[f32]) -> f64 {
        samples.iter().map(|&x| x as f64 * x as f64).sum::<f64>() / samples.len() as f64
    }

    #[test]
    fn hiss_goes_down_and_speech_stays_in_place() {
        let frames = 4 * RATE as usize;
        let clean_voice = voice(frames);
        let hiss = noise(frames, 0.02);
        let noisy: Vec<f32> = clean_voice.iter().zip(&hiss).map(|(v, n)| v + n).collect();
        let cleaned = denoise(RATE, 1, &noisy).unwrap();
        assert_eq!(cleaned.len(), frames);
        // In the pauses between syllables (the last 30% of each quarter second),
        // after the first second, the hiss is far lower.
        let pauses = |s: &[f32]| -> f64 {
            let quarter = RATE as usize / 4;
            let mut sum = 0.0;
            for q in 4..16 {
                let start = q * quarter + quarter * 75 / 100;
                sum += energy(&s[start..q * quarter + quarter * 95 / 100]);
            }
            sum
        };
        let reduction = 10.0 * (pauses(&noisy) / pauses(&cleaned)).log10();
        assert!(reduction > 15.0, "hiss down only {reduction:.1} dB");
        // Speech stays where it was: within a quarter of a millisecond (on clean
        // voices the best lag is 0 to 3 samples; hiss nudges the estimate).
        let correlation = |lag: isize| -> f64 {
            (RATE as usize..3 * RATE as usize)
                .map(|i| clean_voice[i] as f64 * cleaned[(i as isize + lag) as usize] as f64)
                .sum()
        };
        let best = (-48..=48)
            .max_by(|&a, &b| correlation(a).total_cmp(&correlation(b)))
            .unwrap();
        assert!(best.abs() <= 12, "cleaned sound is {best} samples off");
    }

    #[test]
    fn other_rates_come_back_at_48_khz_and_blocks_join_closely() {
        let at_44 = denoise(44_100, 2, &vec![0.0; 2 * 44_100]).unwrap();
        assert!(
            (at_44.len() as i64 - 2 * 48_000).abs() <= 2,
            "{}",
            at_44.len()
        );
        assert!(denoise(48_000, 2, &[0.0; 3]).is_err());
        // A block cleaned with a second of sound before it, as the engine does,
        // matches the same stretch of one long pass closely.
        let frames = 4 * RATE as usize;
        let noisy: Vec<f32> = voice(frames)
            .iter()
            .zip(noise(frames, 0.02))
            .map(|(v, n)| v + n)
            .collect();
        let whole = denoise(RATE, 1, &noisy).unwrap();
        let from = RATE as usize;
        let block = denoise(RATE, 1, &noisy[from..3 * RATE as usize]).unwrap();
        let error: f64 = (RATE as usize..2 * RATE as usize)
            .map(|i| (whole[from + i] - block[i]) as f64)
            .map(|d| d * d)
            .sum::<f64>()
            / RATE as f64;
        let signal = energy(&whole[2 * RATE as usize..3 * RATE as usize]);
        let snr = 10.0 * (signal / error.max(1e-20)).log10();
        assert!(snr > 30.0, "blocks differ from one pass by {snr:.1} dB SNR");
    }
}

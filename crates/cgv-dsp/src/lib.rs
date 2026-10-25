//! Sound processing with no knowledge of projects: filters, dynamics, echo,
//! reverb, meters and loudness. Every processor works in place on planar `f32`
//! blocks of one or two channels at a fixed rate, and keeps its state from one
//! block to the next, so a stream cut into blocks of any size sounds the same.
pub mod biquad;
pub mod delay;
pub mod duck;
pub mod dynamics;
pub mod effect;
pub mod loudness;
pub mod meter;
pub mod oversample;
pub mod reverb;

pub use effect::{Chain, Settings};

/// Decibels to linear gain.
pub fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Linear gain to decibels; silence is a very low number, not infinity.
pub fn gain_to_db(gain: f32) -> f32 {
    20.0 * gain.max(1e-10).log10()
}

/// A one-pole smoothing coefficient that covers about 63% of a step in `seconds`.
pub(crate) fn coefficient(seconds: f32, rate: u32) -> f32 {
    if seconds <= 0.0 {
        0.0
    } else {
        (-1.0 / (seconds * rate as f32)).exp()
    }
}

/// The first two channels of planar sound; the second is missing for mono.
pub(crate) fn split<'a>(channels: &'a mut [&mut [f32]]) -> (&'a mut [f32], Option<&'a mut [f32]>) {
    match channels {
        [] => (&mut [], None),
        [left] => (left, None),
        [left, right, ..] => (left, Some(right)),
    }
}

/// Values this small decay for ever in feedback loops and slow some CPUs down.
pub(crate) fn flush(value: f32) -> f32 {
    if value.abs() < 1e-20 {
        0.0
    } else {
        value
    }
}

#[cfg(test)]
pub(crate) mod test_signal {
    /// A sine of `amplitude` at `frequency`, `frames` long.
    pub fn sine(rate: u32, frequency: f64, amplitude: f64, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| {
                (amplitude
                    * (2.0 * std::f64::consts::PI * frequency * i as f64 / rate as f64).sin())
                    as f32
            })
            .collect()
    }

    pub fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0f32, |peak, x| peak.max(x.abs()))
    }

    pub fn rms(samples: &[f32]) -> f64 {
        (samples.iter().map(|&x| x as f64 * x as f64).sum::<f64>() / samples.len() as f64).sqrt()
    }

    /// Repeatable white noise from -1 to 1.
    pub fn noise(seed: u64, frames: usize) -> Vec<f32> {
        let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        (0..frames)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 40) as f32 / (1u64 << 23) as f32 - 1.0
            })
            .collect()
    }
}

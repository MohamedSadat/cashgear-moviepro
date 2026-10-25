//! True peaks: the highest level the sound reaches between its samples, found by
//! interpolating four points a sample (ITU-R BS.1770 annex 2 uses the same idea).
//! The estimate for sample `n` is ready once sample `n + DELAY` has arrived.

/// Samples after a sample before its true peak is known.
pub const DELAY: usize = 7;
const TAPS: usize = 16;
const PHASES: usize = 4;

/// Windowed-sinc kernels for the points a quarter, a half and three quarters of
/// the way to the next sample, each summing to one.
fn kernels() -> [[f32; TAPS]; PHASES - 1] {
    let mut kernels = [[0.0f32; TAPS]; PHASES - 1];
    for (phase, kernel) in kernels.iter_mut().enumerate() {
        let fraction = (phase + 1) as f64 / PHASES as f64;
        let mut values = [0.0f64; TAPS];
        for (tap, value) in values.iter_mut().enumerate() {
            // Taps reach from 7 samples before the interval to 8 after it.
            let t = tap as f64 - (TAPS / 2 - 1) as f64 - fraction;
            let sinc = if t == 0.0 {
                1.0
            } else {
                (std::f64::consts::PI * t).sin() / (std::f64::consts::PI * t)
            };
            let u = t / (TAPS / 2) as f64;
            let window = 0.42
                + 0.5 * (std::f64::consts::PI * u).cos()
                + 0.08 * (2.0 * std::f64::consts::PI * u).cos();
            *value = sinc * window;
        }
        let sum: f64 = values.iter().sum();
        for (out, value) in kernel.iter_mut().zip(values) {
            *out = (value / sum) as f32;
        }
    }
    kernels
}

/// Follows up to two channels and reports, as each frame arrives, the true peak
/// of the stretch ending at the frame `DELAY` samples earlier.
#[derive(Clone, Debug)]
pub struct TruePeak {
    kernels: [[f32; TAPS]; PHASES - 1],
    history: [[f32; TAPS]; 2],
    channels: usize,
}

impl TruePeak {
    pub fn new(channels: usize) -> TruePeak {
        TruePeak {
            kernels: kernels(),
            history: [[0.0; TAPS]; 2],
            channels: channels.clamp(1, 2),
        }
    }

    pub fn reset(&mut self) {
        self.history = [[0.0; TAPS]; 2];
    }

    /// The frame `DELAY` samples before the last one pushed, on `channel`.
    pub fn delayed(&self, channel: usize) -> f32 {
        self.history[channel][TAPS - 1 - DELAY]
    }

    /// Adds a frame and returns the largest absolute value, over every channel, of
    /// the delayed sample and the points between it and the sample before it.
    pub fn push(&mut self, frame: [f32; 2]) -> f32 {
        let mut peak = 0.0f32;
        for (history, value) in self.history.iter_mut().zip(frame).take(self.channels) {
            history.copy_within(1.., 0);
            history[TAPS - 1] = value;
            peak = peak.max(history[TAPS - 1 - DELAY].abs());
            for kernel in &self.kernels {
                let value: f32 = kernel.iter().zip(history.iter()).map(|(k, x)| k * x).sum();
                peak = peak.max(value.abs());
            }
        }
        peak
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_peak_between_samples() {
        // A sine at a quarter of the rate, sampled 45° off its crests: every
        // sample is at 0.707 of the true peak.
        let mut meter = TruePeak::new(1);
        let mut found = 0.0f32;
        for n in 0..400 {
            let x =
                (std::f64::consts::FRAC_PI_2 * n as f64 + std::f64::consts::FRAC_PI_4).sin() * 0.5;
            let peak = meter.push([x as f32, 0.0]);
            if n > 50 {
                found = found.max(peak);
            }
        }
        assert!((found - 0.5).abs() < 0.005, "{found}");
    }

    #[test]
    fn delays_by_seven_samples_and_keeps_low_tones_exact() {
        let mut meter = TruePeak::new(2);
        let mut highest = 0.0f32;
        for n in 0..4800 {
            let x = (2.0 * std::f64::consts::PI * 1000.0 * n as f64 / 48_000.0).sin() as f32 * 0.25;
            highest = highest.max(meter.push([x, -x]));
            if n >= DELAY {
                let expected = (2.0 * std::f64::consts::PI * 1000.0 * (n - DELAY) as f64 / 48_000.0)
                    .sin() as f32
                    * 0.25;
                assert_eq!(meter.delayed(0), expected);
                assert_eq!(meter.delayed(1), -expected);
            }
        }
        assert!((highest - 0.25).abs() < 0.001, "{highest}");
    }
}

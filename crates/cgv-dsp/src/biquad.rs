//! Second-order filters from Robert Bristow-Johnson's Audio EQ Cookbook, run in
//! transposed direct form II with `f64` state, so low frequencies stay exact.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterKind {
    LowPass,
    HighPass,
    Peak,
    LowShelf,
    HighShelf,
}

/// Coefficients normalised so that `a0` is 1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coefficients {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Coefficients {
    pub const IDENTITY: Coefficients = Coefficients {
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
    };

    /// `q` shapes passes and peaks; shelves use a slope of 1. `gain_db` is for
    /// peaks and shelves. The frequency is kept below 49% of the rate.
    pub fn new(kind: FilterKind, rate: u32, frequency: f64, q: f64, gain_db: f64) -> Coefficients {
        let frequency = frequency.clamp(1.0, rate as f64 * 0.49);
        let w0 = 2.0 * std::f64::consts::PI * frequency / rate as f64;
        let (sin, cos) = w0.sin_cos();
        let q = q.max(0.05);
        let alpha = sin / (2.0 * q);
        let a = 10f64.powf(gain_db / 40.0);
        let [b0, b1, b2, a0, a1, a2] = match kind {
            FilterKind::LowPass => [
                (1.0 - cos) / 2.0,
                1.0 - cos,
                (1.0 - cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ],
            FilterKind::HighPass => [
                (1.0 + cos) / 2.0,
                -(1.0 + cos),
                (1.0 + cos) / 2.0,
                1.0 + alpha,
                -2.0 * cos,
                1.0 - alpha,
            ],
            FilterKind::Peak => [
                1.0 + alpha * a,
                -2.0 * cos,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos,
                1.0 - alpha / a,
            ],
            FilterKind::LowShelf | FilterKind::HighShelf => {
                // Shelf slope 1: alpha = sin / 2 * sqrt(2).
                let shelf = 2.0 * a.sqrt() * sin / 2.0 * std::f64::consts::SQRT_2;
                let (plus, minus) = (a + 1.0, a - 1.0);
                if kind == FilterKind::LowShelf {
                    [
                        a * (plus - minus * cos + shelf),
                        2.0 * a * (minus - plus * cos),
                        a * (plus - minus * cos - shelf),
                        plus + minus * cos + shelf,
                        -2.0 * (minus + plus * cos),
                        plus + minus * cos - shelf,
                    ]
                } else {
                    [
                        a * (plus + minus * cos + shelf),
                        -2.0 * a * (minus + plus * cos),
                        a * (plus + minus * cos - shelf),
                        plus - minus * cos + shelf,
                        2.0 * (minus - plus * cos),
                        plus - minus * cos - shelf,
                    ]
                }
            }
        };
        Coefficients {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    /// The gain this filter gives a sine at `frequency`.
    pub fn magnitude(&self, rate: u32, frequency: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * frequency / rate as f64;
        let (s1, c1) = (-w).sin_cos();
        let (s2, c2) = (-2.0 * w).sin_cos();
        let num = (
            self.b0 + self.b1 * c1 + self.b2 * c2,
            self.b1 * s1 + self.b2 * s2,
        );
        let den = (
            1.0 + self.a1 * c1 + self.a2 * c2,
            self.a1 * s1 + self.a2 * s2,
        );
        (num.0.hypot(num.1)) / (den.0.hypot(den.1))
    }
}

/// One filter over up to two channels.
#[derive(Clone, Debug)]
pub struct Biquad {
    c: Coefficients,
    state: [[f64; 2]; 2],
}

impl Default for Biquad {
    fn default() -> Self {
        Biquad::new(Coefficients::IDENTITY)
    }
}

impl Biquad {
    pub fn new(c: Coefficients) -> Biquad {
        Biquad {
            c,
            state: [[0.0; 2]; 2],
        }
    }

    /// New coefficients; the state carries on, so a change does not restart the sound.
    pub fn set(&mut self, c: Coefficients) {
        self.c = c;
    }

    pub fn reset(&mut self) {
        self.state = [[0.0; 2]; 2];
    }

    pub fn process(&mut self, channel: usize, samples: &mut [f32]) {
        let c = self.c;
        let [z1, z2] = &mut self.state[channel];
        for sample in samples {
            let x = *sample as f64;
            let y = c.b0 * x + *z1;
            *z1 = c.b1 * x - c.a1 * y + *z2;
            *z2 = c.b2 * x - c.a2 * y;
            *sample = y as f32;
        }
        if z1.abs() < 1e-30 {
            *z1 = 0.0;
        }
        if z2.abs() < 1e-30 {
            *z2 = 0.0;
        }
    }
}

/// Butterworth sections for a pass filter of 12 or 24 dB an octave.
pub fn butterworth_q(sections: usize) -> &'static [f64] {
    match sections {
        1 => &[std::f64::consts::FRAC_1_SQRT_2],
        _ => &[0.541_196_100_146_197, 1.306_562_964_876_376_7],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_signal::{rms, sine};

    const RATE: u32 = 48_000;

    fn db(gain: f64) -> f64 {
        20.0 * gain.log10()
    }

    #[test]
    fn peaks_and_shelves_reach_their_gain() {
        let peak = Coefficients::new(FilterKind::Peak, RATE, 1000.0, 1.0, 6.0);
        assert!((db(peak.magnitude(RATE, 1000.0)) - 6.0).abs() < 1e-9);
        assert!(db(peak.magnitude(RATE, 50.0)).abs() < 0.05);
        assert!(db(peak.magnitude(RATE, 20_000.0)).abs() < 0.1);
        let cut = Coefficients::new(FilterKind::Peak, RATE, 300.0, 2.0, -12.0);
        assert!((db(cut.magnitude(RATE, 300.0)) + 12.0).abs() < 1e-9);

        let low = Coefficients::new(FilterKind::LowShelf, RATE, 200.0, 0.7, 9.0);
        assert!((db(low.magnitude(RATE, 10.0)) - 9.0).abs() < 0.05);
        assert!(
            (db(low.magnitude(RATE, 200.0)) - 4.5).abs() < 0.01,
            "half the gain at the corner"
        );
        assert!(db(low.magnitude(RATE, 10_000.0)).abs() < 0.05);
        let high = Coefficients::new(FilterKind::HighShelf, RATE, 6000.0, 0.7, -6.0);
        assert!((db(high.magnitude(RATE, 23_000.0)) + 6.0).abs() < 0.1);
        assert!((db(high.magnitude(RATE, 6000.0)) + 3.0).abs() < 0.01);
        assert!(db(high.magnitude(RATE, 100.0)).abs() < 0.05);
    }

    #[test]
    fn passes_are_three_decibels_down_at_their_corner() {
        let q = butterworth_q(1)[0];
        let low = Coefficients::new(FilterKind::LowPass, RATE, 2000.0, q, 0.0);
        assert!((db(low.magnitude(RATE, 2000.0)) + 3.0103).abs() < 0.001);
        assert!(db(low.magnitude(RATE, 20.0)).abs() < 1e-6);
        // 12 dB an octave well above the corner.
        let slope = db(low.magnitude(RATE, 8000.0)) - db(low.magnitude(RATE, 16_000.0));
        assert!(slope > 11.0, "{slope}");
        let high = Coefficients::new(FilterKind::HighPass, RATE, 100.0, q, 0.0);
        assert!((db(high.magnitude(RATE, 100.0)) + 3.0103).abs() < 0.001);
        assert!(db(high.magnitude(RATE, 10_000.0)).abs() < 1e-4);
        // Two Butterworth sections: 24 dB an octave, still -3 dB at the corner.
        let qs = butterworth_q(2);
        let gain = |f: f64| {
            qs.iter()
                .map(|&q| {
                    Coefficients::new(FilterKind::HighPass, RATE, 100.0, q, 0.0).magnitude(RATE, f)
                })
                .product::<f64>()
        };
        assert!((db(gain(100.0)) + 3.0103).abs() < 0.001);
        assert!(db(gain(25.0)) < -46.0);
    }

    #[test]
    fn filtering_a_sine_gives_the_magnitude_and_blocks_join_seamlessly() {
        let c = Coefficients::new(FilterKind::Peak, RATE, 1000.0, 1.0, -9.0);
        let tone = sine(RATE, 1000.0, 0.5, RATE as usize);
        let mut whole = tone.clone();
        Biquad::new(c).process(0, &mut whole);
        let measured = rms(&whole[24_000..]) / rms(&tone[24_000..]);
        assert!((db(measured) + 9.0).abs() < 0.01, "{}", db(measured));
        // The same sound in blocks of 1000 samples.
        let mut blocks = tone.clone();
        let mut filter = Biquad::new(c);
        for block in blocks.chunks_mut(1000) {
            filter.process(0, block);
        }
        assert_eq!(blocks, whole);
    }
}

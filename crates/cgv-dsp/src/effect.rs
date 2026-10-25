//! A clip's chain of sound effects. Settings are plain values; the chain keeps
//! each processor's state, and new settings for the same effects in the same
//! order change them in place, so turning a knob while playing does not restart
//! a reverb tail or a compressor's gain.
use crate::biquad::{butterworth_q, Biquad, Coefficients, FilterKind};
use crate::delay::{Echo, EchoSettings};
use crate::dynamics::{
    Compressor, CompressorSettings, Gate, GateSettings, Limiter, LimiterSettings,
};
use crate::reverb::{Reverb, ReverbSettings};

/// One band of an equaliser.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EqBand {
    pub kind: FilterKind,
    pub frequency: f32,
    pub gain_db: f32,
    pub q: f32,
}

/// A high- or low-pass filter of 12 dB (one section) or 24 dB an octave.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PassSettings {
    pub frequency: f32,
    pub sections: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Settings {
    Equalizer(Vec<EqBand>),
    HighPass(PassSettings),
    LowPass(PassSettings),
    Compressor(CompressorSettings),
    Gate(GateSettings),
    Limiter(LimiterSettings),
    Echo(EchoSettings),
    Reverb(ReverbSettings),
}

impl Settings {
    fn same_kind(&self, other: &Settings) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other)
    }
}

#[derive(Clone, Debug)]
struct Filters {
    filters: Vec<Biquad>,
}

impl Filters {
    fn coefficients(settings: &Settings, rate: u32) -> Vec<Coefficients> {
        match settings {
            Settings::Equalizer(bands) => bands
                .iter()
                .filter(|band| {
                    // A flat band changes nothing, so it costs nothing.
                    matches!(band.kind, FilterKind::LowPass | FilterKind::HighPass)
                        || band.gain_db.abs() > 1e-3
                })
                .map(|band| {
                    Coefficients::new(
                        band.kind,
                        rate,
                        band.frequency as f64,
                        band.q as f64,
                        band.gain_db as f64,
                    )
                })
                .collect(),
            Settings::HighPass(pass) | Settings::LowPass(pass) => {
                let kind = if matches!(settings, Settings::HighPass(_)) {
                    FilterKind::HighPass
                } else {
                    FilterKind::LowPass
                };
                butterworth_q(pass.sections.clamp(1, 2))
                    .iter()
                    .map(|&q| Coefficients::new(kind, rate, pass.frequency as f64, q, 0.0))
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    fn new(settings: &Settings, rate: u32) -> Filters {
        Filters {
            filters: Self::coefficients(settings, rate)
                .into_iter()
                .map(Biquad::new)
                .collect(),
        }
    }

    /// New coefficients, keeping state where the number of filters is unchanged.
    fn set(&mut self, settings: &Settings, rate: u32) {
        let coefficients = Self::coefficients(settings, rate);
        if coefficients.len() == self.filters.len() {
            for (filter, c) in self.filters.iter_mut().zip(coefficients) {
                filter.set(c);
            }
        } else {
            *self = Filters {
                filters: coefficients.into_iter().map(Biquad::new).collect(),
            };
        }
    }

    fn process(&mut self, channels: &mut [&mut [f32]]) {
        for filter in &mut self.filters {
            for (index, channel) in channels.iter_mut().enumerate() {
                filter.process(index, channel);
            }
        }
    }

    fn reset(&mut self) {
        for filter in &mut self.filters {
            filter.reset();
        }
    }
}

#[derive(Clone, Debug)]
enum Unit {
    Filters(Filters),
    Compressor(Compressor),
    Gate(Gate),
    Limiter(Limiter),
    Echo(Echo),
    Reverb(Reverb),
}

impl Unit {
    fn new(settings: &Settings, rate: u32, channels: usize) -> Unit {
        match settings {
            Settings::Equalizer(_) | Settings::HighPass(_) | Settings::LowPass(_) => {
                Unit::Filters(Filters::new(settings, rate))
            }
            Settings::Compressor(s) => Unit::Compressor(Compressor::new(*s, rate)),
            Settings::Gate(s) => Unit::Gate(Gate::new(*s, rate)),
            Settings::Limiter(s) => Unit::Limiter(Limiter::new(*s, rate, channels)),
            Settings::Echo(s) => Unit::Echo(Echo::new(*s, rate)),
            Settings::Reverb(s) => Unit::Reverb(Reverb::new(*s, rate)),
        }
    }

    fn set(&mut self, settings: &Settings, rate: u32) {
        match (self, settings) {
            (Unit::Filters(unit), _) => unit.set(settings, rate),
            (Unit::Compressor(unit), Settings::Compressor(s)) => unit.set(*s),
            (Unit::Gate(unit), Settings::Gate(s)) => unit.set(*s),
            (Unit::Limiter(unit), Settings::Limiter(s)) => unit.set(*s),
            (Unit::Echo(unit), Settings::Echo(s)) => unit.set(*s),
            (Unit::Reverb(unit), Settings::Reverb(s)) => unit.set(*s),
            _ => unreachable!("settings of another kind"),
        }
    }

    fn process(&mut self, channels: &mut [&mut [f32]]) {
        match self {
            Unit::Filters(unit) => unit.process(channels),
            Unit::Compressor(unit) => unit.process(channels),
            Unit::Gate(unit) => unit.process(channels),
            Unit::Limiter(unit) => unit.process(channels),
            Unit::Echo(unit) => unit.process(channels),
            Unit::Reverb(unit) => unit.process(channels),
        }
    }

    fn reset(&mut self) {
        match self {
            Unit::Filters(unit) => unit.reset(),
            Unit::Compressor(unit) => unit.reset(),
            Unit::Gate(unit) => unit.reset(),
            Unit::Limiter(unit) => unit.reset(),
            Unit::Echo(unit) => unit.reset(),
            Unit::Reverb(unit) => unit.reset(),
        }
    }
}

/// Effects run in order on planar sound of one or two channels.
#[derive(Clone, Debug)]
pub struct Chain {
    rate: u32,
    channels: usize,
    settings: Vec<Settings>,
    units: Vec<Unit>,
}

impl Chain {
    pub fn new(rate: u32, channels: usize, settings: &[Settings]) -> Chain {
        let channels = channels.clamp(1, 2);
        Chain {
            rate,
            channels,
            settings: settings.to_vec(),
            units: settings
                .iter()
                .map(|s| Unit::new(s, rate, channels))
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }

    pub fn settings(&self) -> &[Settings] {
        &self.settings
    }

    /// Takes new settings. The same kinds in the same order keep their state;
    /// anything else starts again.
    pub fn update(&mut self, settings: &[Settings]) {
        if settings == self.settings.as_slice() {
            return;
        }
        let same = settings.len() == self.settings.len()
            && settings
                .iter()
                .zip(&self.settings)
                .all(|(a, b)| a.same_kind(b));
        if same {
            for (unit, s) in self.units.iter_mut().zip(settings) {
                unit.set(s, self.rate);
            }
            self.settings = settings.to_vec();
        } else {
            *self = Chain::new(self.rate, self.channels, settings);
        }
    }

    pub fn process(&mut self, channels: &mut [&mut [f32]]) {
        for unit in &mut self.units {
            unit.process(channels);
        }
    }

    pub fn reset(&mut self) {
        for unit in &mut self.units {
            unit.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_signal::{noise, rms, sine};

    const RATE: u32 = 48_000;

    fn reverb(mix: f32) -> Settings {
        Settings::Reverb(ReverbSettings {
            room_size: 0.8,
            damping: 0.3,
            width: 1.0,
            mix,
        })
    }

    #[test]
    fn changing_a_setting_keeps_the_tail_but_another_effect_starts_again() {
        let mut chain = Chain::new(RATE, 1, &[reverb(0.5)]);
        let mut burst = noise(5, 4800);
        chain.process(&mut [&mut burst]);
        let mut after = vec![0.0f32; 4800];
        chain.update(&[reverb(0.6)]);
        chain.process(&mut [&mut after]);
        assert!(rms(&after) > 1e-3, "the tail rings on");
        chain.update(&[Settings::Echo(EchoSettings {
            delay: 0.1,
            feedback: 0.0,
            level: 1.0,
            damping: 0.0,
        })]);
        let mut silence = vec![0.0f32; 4800];
        chain.process(&mut [&mut silence]);
        assert_eq!(rms(&silence), 0.0, "a new chain has no tail");
    }

    #[test]
    fn an_equaliser_of_flat_bands_leaves_sound_untouched() {
        let flat = Settings::Equalizer(vec![
            EqBand {
                kind: FilterKind::LowShelf,
                frequency: 100.0,
                gain_db: 0.0,
                q: 0.7,
            },
            EqBand {
                kind: FilterKind::Peak,
                frequency: 1000.0,
                gain_db: 0.0,
                q: 1.0,
            },
        ]);
        let mut chain = Chain::new(RATE, 2, &[flat]);
        let tone = sine(RATE, 440.0, 0.5, 4800);
        let (mut left, mut right) = (tone.clone(), tone.clone());
        chain.process(&mut [&mut left, &mut right]);
        assert_eq!(left, tone);
        assert_eq!(right, tone);
    }

    #[test]
    fn a_high_pass_removes_rumble_and_keeps_speech() {
        let mut chain = Chain::new(
            RATE,
            1,
            &[Settings::HighPass(PassSettings {
                frequency: 120.0,
                sections: 2,
            })],
        );
        let mut rumble = sine(RATE, 30.0, 0.5, 96_000);
        chain.process(&mut [&mut rumble]);
        assert!(rms(&rumble[48_000..]) < 0.5 / 2f64.sqrt() * 0.01);
        chain.reset();
        let mut voice = sine(RATE, 1000.0, 0.5, 48_000);
        chain.process(&mut [&mut voice]);
        assert!((rms(&voice[24_000..]) / (0.5 / 2f64.sqrt()) - 1.0).abs() < 0.01);
    }
}

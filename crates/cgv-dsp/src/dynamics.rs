//! Dynamics: a compressor, a noise gate and a look-ahead limiter. Levels are
//! taken over both channels together, so the stereo image never shifts.
use std::collections::VecDeque;

use crate::oversample::{TruePeak, DELAY};
use crate::{coefficient, db_to_gain, gain_to_db};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CompressorSettings {
    pub threshold_db: f32,
    /// 1 or more: 4 means 4 dB in gives 1 dB out above the threshold.
    pub ratio: f32,
    /// Width of the soft knee around the threshold.
    pub knee_db: f32,
    /// Seconds.
    pub attack: f32,
    pub release: f32,
    pub makeup_db: f32,
}

/// A feed-forward compressor: a peak detector gives the level, and the gain
/// follows the static curve for it, quickly when it must fall and slowly when it
/// may rise.
#[derive(Clone, Debug)]
pub struct Compressor {
    settings: CompressorSettings,
    rate: u32,
    attack: f32,
    release: f32,
    detector: f32,
    envelope: f32,
    reduction_db: f32,
}

/// Seconds the level detector holds a peak before it falls away.
const DETECTOR_RELEASE: f32 = 0.02;

impl Compressor {
    pub fn new(settings: CompressorSettings, rate: u32) -> Compressor {
        let mut compressor = Compressor {
            settings,
            rate,
            attack: 0.0,
            release: 0.0,
            detector: coefficient(DETECTOR_RELEASE, rate),
            envelope: 0.0,
            reduction_db: 0.0,
        };
        compressor.set(settings);
        compressor
    }

    pub fn set(&mut self, settings: CompressorSettings) {
        self.settings = settings;
        self.attack = coefficient(settings.attack, self.rate);
        self.release = coefficient(settings.release, self.rate);
    }

    pub fn reset(&mut self) {
        self.envelope = 0.0;
        self.reduction_db = 0.0;
    }

    /// The gain change, at most 0 dB, that the static curve gives `level_db`.
    pub fn curve(&self, level_db: f32) -> f32 {
        let s = &self.settings;
        let over = level_db - s.threshold_db;
        let slope = 1.0 / s.ratio.max(1.0) - 1.0;
        let knee = s.knee_db.max(0.0);
        if knee > 0.0 && over.abs() <= knee / 2.0 {
            slope * (over + knee / 2.0).powi(2) / (2.0 * knee)
        } else if over > 0.0 {
            slope * over
        } else {
            0.0
        }
    }

    pub fn process(&mut self, channels: &mut [&mut [f32]]) {
        let frames = channels.first().map_or(0, |c| c.len());
        let makeup = self.settings.makeup_db;
        for i in 0..frames {
            let level = channels.iter().fold(0.0f32, |m, c| m.max(c[i].abs()));
            // Peaks are held briefly, so a steady tone gives a steady level.
            self.envelope = level.max(self.envelope * self.detector);
            let target = self.curve(gain_to_db(self.envelope));
            let coef = if target < self.reduction_db {
                self.attack
            } else {
                self.release
            };
            self.reduction_db = target + (self.reduction_db - target) * coef;
            let gain = db_to_gain(self.reduction_db + makeup);
            for channel in channels.iter_mut() {
                channel[i] *= gain;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GateSettings {
    /// The gate opens above this level and closes 3 dB below it.
    pub threshold_db: f32,
    /// How far a closed gate lowers the sound, as a positive number of decibels.
    pub reduction_db: f32,
    /// Seconds.
    pub attack: f32,
    pub hold: f32,
    pub release: f32,
}

/// A noise gate: lowers the sound while it stays below the threshold.
#[derive(Clone, Debug)]
pub struct Gate {
    settings: GateSettings,
    rate: u32,
    attack: f32,
    release: f32,
    follower: f32,
    envelope: f32,
    open: bool,
    hold_left: usize,
    gain: f32,
}

impl Gate {
    pub fn new(settings: GateSettings, rate: u32) -> Gate {
        let mut gate = Gate {
            settings,
            rate,
            attack: 0.0,
            release: 0.0,
            follower: coefficient(0.01, rate),
            envelope: 0.0,
            open: false,
            hold_left: 0,
            gain: 0.0,
        };
        gate.set(settings);
        gate.reset();
        gate
    }

    pub fn set(&mut self, settings: GateSettings) {
        self.settings = settings;
        self.attack = coefficient(settings.attack, self.rate);
        self.release = coefficient(settings.release, self.rate);
    }

    pub fn reset(&mut self) {
        self.envelope = 0.0;
        self.open = false;
        self.hold_left = 0;
        self.gain = db_to_gain(-self.settings.reduction_db.abs());
    }

    pub fn process(&mut self, channels: &mut [&mut [f32]]) {
        let frames = channels.first().map_or(0, |c| c.len());
        let floor = db_to_gain(-self.settings.reduction_db.abs());
        let open_at = db_to_gain(self.settings.threshold_db);
        let close_at = db_to_gain(self.settings.threshold_db - 3.0);
        let hold = (self.settings.hold.max(0.0) * self.rate as f32) as usize;
        for i in 0..frames {
            let level = channels.iter().fold(0.0f32, |m, c| m.max(c[i].abs()));
            self.envelope = level.max(self.envelope * self.follower);
            if self.envelope >= open_at || (self.open && self.envelope >= close_at) {
                self.open = true;
                self.hold_left = hold;
            } else if self.hold_left > 0 {
                self.hold_left -= 1;
            } else {
                self.open = false;
            }
            let target = if self.open || self.hold_left > 0 {
                1.0
            } else {
                floor
            };
            let coef = if target > self.gain {
                self.attack
            } else {
                self.release
            };
            self.gain = target + (self.gain - target) * coef;
            for channel in channels.iter_mut() {
                channel[i] *= self.gain;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LimiterSettings {
    pub ceiling_db: f32,
    /// Seconds.
    pub release: f32,
    /// Limit the peaks between samples too, as loudness targets measure them.
    pub true_peak: bool,
}

/// Seconds the limiter looks ahead, so its gain is down before a peak arrives.
pub const LOOKAHEAD: f32 = 0.003;

/// A look-ahead brickwall limiter. The gain needed at each sample is the minimum
/// over the look-ahead, then averaged over the same length: every value in the
/// average is at or below the gain the peak needs, so no sample passes the
/// ceiling, and the gain moves in straight lines rather than jumps. The sound
/// comes out `latency()` samples late.
#[derive(Clone, Debug)]
pub struct Limiter {
    settings: LimiterSettings,
    rate: u32,
    channels: usize,
    ceiling: f32,
    release: f32,
    lookahead: usize,
    minimum: VecDeque<(u64, f32)>,
    averaged: VecDeque<f32>,
    sum: f64,
    delayed: VecDeque<[f32; 2]>,
    gain: f32,
    index: u64,
    true_peak: Option<Box<TruePeak>>,
}

impl Limiter {
    pub fn new(settings: LimiterSettings, rate: u32, channels: usize) -> Limiter {
        let lookahead = ((LOOKAHEAD * rate as f32).round() as usize).max(1);
        let mut limiter = Limiter {
            settings,
            rate,
            channels: channels.clamp(1, 2),
            ceiling: 1.0,
            release: 0.0,
            lookahead,
            minimum: VecDeque::new(),
            averaged: VecDeque::new(),
            sum: 0.0,
            delayed: VecDeque::new(),
            gain: 1.0,
            index: 0,
            true_peak: None,
        };
        limiter.set(settings);
        limiter.reset();
        limiter
    }

    pub fn set(&mut self, settings: LimiterSettings) {
        let changed = settings.true_peak != self.settings.true_peak;
        self.settings = settings;
        // A hair under the ceiling covers rounding in the running average.
        self.ceiling = db_to_gain(settings.ceiling_db) * 0.9999;
        self.release = coefficient(settings.release, self.rate);
        if changed {
            self.reset();
        }
    }

    /// Samples between a sample going in and coming out.
    pub fn latency(&self) -> usize {
        self.lookahead + if self.settings.true_peak { DELAY } else { 0 }
    }

    pub fn reset(&mut self) {
        let window = self.lookahead + 1;
        self.minimum.clear();
        self.averaged = std::iter::repeat_n(1.0, window).collect();
        self.sum = window as f64;
        // The average ending at sample n is the gain of sample n - lookahead.
        self.delayed = std::iter::repeat_n([0.0; 2], self.lookahead).collect();
        self.gain = 1.0;
        self.index = 0;
        self.true_peak = self
            .settings
            .true_peak
            .then(|| Box::new(TruePeak::new(self.channels)));
    }

    /// The gain applied to the last frame that came out, for meters and tests.
    pub fn gain(&self) -> f32 {
        self.gain
    }

    fn step(&mut self, frame: [f32; 2], peak: f32) -> [f32; 2] {
        let needed = if peak > self.ceiling {
            self.ceiling / peak
        } else {
            1.0
        };
        let window = self.lookahead as u64 + 1;
        while self.minimum.back().is_some_and(|&(_, g)| g >= needed) {
            self.minimum.pop_back();
        }
        self.minimum.push_back((self.index, needed));
        while self
            .minimum
            .front()
            .is_some_and(|&(at, _)| at + window <= self.index)
        {
            self.minimum.pop_front();
        }
        self.index += 1;
        let lowest = self.minimum.front().map_or(1.0, |&(_, g)| g);
        self.sum += lowest as f64 - self.averaged.pop_front().unwrap_or(1.0) as f64;
        self.averaged.push_back(lowest);
        let average = (self.sum / window as f64) as f32;
        self.gain = if average < self.gain {
            average
        } else {
            average + (self.gain - average) * self.release
        };
        self.delayed.push_back(frame);
        let out = self.delayed.pop_front().unwrap_or([0.0; 2]);
        [out[0] * self.gain, out[1] * self.gain]
    }

    fn frame(&mut self, frame: [f32; 2]) -> [f32; 2] {
        let (input, peak) = match self.true_peak.as_mut() {
            Some(meter) => {
                let peak = meter.push(frame);
                ([meter.delayed(0), meter.delayed(1)], peak)
            }
            None => (frame, frame[0].abs().max(frame[1].abs())),
        };
        self.step(input, peak)
    }

    pub fn process(&mut self, channels: &mut [&mut [f32]]) {
        match crate::split(channels) {
            (left, Some(right)) => {
                for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                    [*l, *r] = self.frame([*l, *r]);
                }
            }
            (left, None) => {
                for l in left.iter_mut() {
                    *l = self.frame([*l, 0.0])[0];
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_signal::{noise, peak, sine};

    const RATE: u32 = 48_000;

    fn db(value: f64) -> f64 {
        20.0 * value.log10()
    }

    #[test]
    fn the_compressor_follows_its_static_curve() {
        let settings = CompressorSettings {
            threshold_db: -20.0,
            ratio: 4.0,
            knee_db: 0.0,
            attack: 0.005,
            release: 0.2,
            makeup_db: 0.0,
        };
        let compressor = Compressor::new(settings, RATE);
        assert_eq!(compressor.curve(-30.0), 0.0);
        assert_eq!(compressor.curve(-10.0), -7.5);
        let soft = Compressor::new(
            CompressorSettings {
                knee_db: 6.0,
                ..settings
            },
            RATE,
        );
        assert!((soft.curve(-20.0) + 0.5625).abs() < 1e-6);
        assert_eq!(soft.curve(-23.0), 0.0);
        // A steady sine 10 dB over the threshold comes out 2.5 dB over it.
        let mut tone = sine(RATE, 1000.0, db_to_gain(-10.0) as f64, RATE as usize);
        Compressor::new(settings, RATE).process(&mut [&mut tone]);
        let level = db(peak(&tone[24_000..]) as f64);
        assert!((level + 17.5).abs() < 0.3, "{level}");
        // Quiet sound passes untouched, with make-up gain added.
        let mut quiet = sine(RATE, 1000.0, 0.01, 4800);
        let original = quiet.clone();
        Compressor::new(
            CompressorSettings {
                makeup_db: 6.0,
                ..settings
            },
            RATE,
        )
        .process(&mut [&mut quiet]);
        assert!((quiet[100] / original[100] - db_to_gain(6.0)).abs() < 1e-4);
    }

    #[test]
    fn the_gate_closes_after_its_hold_and_opens_for_sound() {
        let settings = GateSettings {
            threshold_db: -40.0,
            reduction_db: 60.0,
            attack: 0.001,
            hold: 0.05,
            release: 0.02,
        };
        let mut gate = Gate::new(settings, RATE);
        // 0.2 s of a -20 dB tone, then 0.5 s of -60 dB hiss.
        let mut sound = sine(RATE, 440.0, 0.1, 9600);
        sound.extend(noise(3, 24_000).iter().map(|x| x * 0.001));
        let original = sound.clone();
        gate.process(&mut [&mut sound]);
        let gain = |from: usize, to: usize| {
            db(peak(&sound[from..to]) as f64 / peak(&original[from..to]) as f64)
        };
        assert!(gain(4800, 9600).abs() < 0.1, "open for the tone");
        assert!(gain(9600, 9600 + 2000).abs() < 0.5, "held open");
        assert!(gain(9600 + 12_000, 33_600) < -55.0, "closed afterwards");
        // The same sound in small blocks gives the same result.
        let mut blocks = original.clone();
        let mut gate = Gate::new(settings, RATE);
        for block in blocks.chunks_mut(333) {
            gate.process(&mut [block]);
        }
        assert_eq!(blocks, sound);
    }

    #[test]
    fn the_limiter_never_passes_its_ceiling_and_leaves_quiet_sound_alone() {
        let settings = LimiterSettings {
            ceiling_db: -1.0,
            release: 0.1,
            true_peak: false,
        };
        let mut limiter = Limiter::new(settings, RATE, 2);
        let latency = limiter.latency();
        assert_eq!(latency, 144);
        let mut left: Vec<f32> = noise(1, 48_000).iter().map(|x| x * 3.0).collect();
        let mut right: Vec<f32> = noise(2, 48_000).iter().map(|x| x * 0.5).collect();
        limiter.process(&mut [&mut left, &mut right]);
        let ceiling = db_to_gain(-1.0);
        assert!(peak(&left) <= ceiling && peak(&right) <= ceiling);
        // Quiet sound comes out unchanged, only late.
        let mut limiter = Limiter::new(settings, RATE, 1);
        let quiet = sine(RATE, 300.0, 0.3, 4800);
        let mut out = quiet.clone();
        limiter.process(&mut [&mut out]);
        assert_eq!(&out[latency..], &quiet[..4800 - latency]);
    }

    #[test]
    fn the_true_peak_limiter_catches_peaks_between_samples() {
        let settings = LimiterSettings {
            ceiling_db: -1.0,
            release: 0.05,
            true_peak: true,
        };
        let mut limiter = Limiter::new(settings, RATE, 1);
        assert_eq!(limiter.latency(), 144 + DELAY);
        // A full-scale tone at a quarter of the rate, 45° off: samples at 0.707
        // but true peaks at 1.0, 1 dB above the ceiling's sample value.
        let mut tone: Vec<f32> = (0..9600)
            .map(|n| {
                (std::f64::consts::FRAC_PI_2 * n as f64 + std::f64::consts::FRAC_PI_4).sin() as f32
            })
            .collect();
        limiter.process(&mut [&mut tone]);
        // The meter's first readings ring from its silent history, so it warms up first.
        let mut meter = TruePeak::new(1);
        let highest = tone[1900..]
            .iter()
            .map(|&x| meter.push([x, 0.0]))
            .skip(100)
            .fold(0.0f32, f32::max);
        assert!(db(highest as f64) <= -0.99, "{}", db(highest as f64));
        assert!(db(highest as f64) > -1.5);
    }
}

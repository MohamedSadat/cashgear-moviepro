//! Loudness after EBU R128 and ITU-R BS.1770, measured by the `ebur128` crate:
//! momentary (400 ms), short-term (3 s) and integrated loudness in LUFS, and
//! true peak.
use ebur128::{EbuR128, Mode};

/// Silence, in LUFS.
pub const SILENT: f64 = -200.0;

pub struct Loudness {
    meter: EbuR128,
    channels: usize,
}

impl Loudness {
    /// `true_peak` also follows the peaks between samples, which costs more.
    pub fn new(rate: u32, channels: usize, true_peak: bool) -> Loudness {
        let mut mode = Mode::M | Mode::S | Mode::I;
        if true_peak {
            mode |= Mode::TRUE_PEAK;
        }
        let channels = channels.clamp(1, 2);
        let mut meter = EbuR128::new(channels as u32, rate, mode).expect("valid loudness settings");
        if channels == 1 {
            // A mono mix plays from both speakers.
            meter
                .set_channel(0, ebur128::Channel::DualMono)
                .expect("a channel");
        }
        Loudness { meter, channels }
    }

    pub fn reset(&mut self) {
        self.meter.reset();
    }

    /// Adds planar samples.
    pub fn add(&mut self, channels: &[&[f32]]) {
        let _ = self
            .meter
            .add_frames_planar_f32(&channels[..self.channels.min(channels.len())]);
    }

    fn value(result: Result<f64, ebur128::Error>) -> f64 {
        match result {
            Ok(value) if value.is_finite() => value.max(SILENT),
            _ => SILENT,
        }
    }

    pub fn momentary(&self) -> f64 {
        Self::value(self.meter.loudness_momentary())
    }

    pub fn short_term(&self) -> f64 {
        Self::value(self.meter.loudness_shortterm())
    }

    /// Gated loudness of everything added since the start or the last reset.
    pub fn integrated(&self) -> f64 {
        Self::value(self.meter.loudness_global())
    }

    /// The highest true peak so far, linear, over every channel (0 without
    /// true-peak measuring).
    pub fn true_peak(&self) -> f64 {
        (0..self.channels as u32)
            .filter_map(|channel| self.meter.true_peak(channel).ok())
            .fold(0.0, f64::max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_to_gain;
    use crate::test_signal::sine;

    #[test]
    fn a_stereo_sine_at_minus_23_dbfs_is_minus_23_lufs() {
        // EBU Tech 3341, case 1: 1 kHz at -23 dBFS on both channels.
        let tone = sine(48_000, 1000.0, db_to_gain(-23.0) as f64, 20 * 48_000);
        let mut loudness = Loudness::new(48_000, 2, true);
        for chunk in tone.chunks(4800) {
            loudness.add(&[chunk, chunk]);
        }
        assert!(
            (loudness.integrated() + 23.0).abs() < 0.1,
            "{}",
            loudness.integrated()
        );
        assert!((loudness.momentary() + 23.0).abs() < 0.1);
        assert!((loudness.short_term() + 23.0).abs() < 0.1);
        assert!((20.0 * loudness.true_peak().log10() + 23.0).abs() < 0.1);
    }

    #[test]
    fn mono_counts_as_both_speakers_and_silence_has_a_floor() {
        let tone = sine(48_000, 1000.0, db_to_gain(-23.0) as f64, 5 * 48_000);
        let mut mono = Loudness::new(48_000, 1, false);
        mono.add(&[&tone]);
        assert!(
            (mono.integrated() + 23.0).abs() < 0.1,
            "{}",
            mono.integrated()
        );
        let mut quiet = Loudness::new(48_000, 2, false);
        assert_eq!(quiet.integrated(), SILENT);
        let silence = vec![0.0f32; 48_000];
        quiet.add(&[&silence, &silence]);
        assert_eq!(quiet.momentary(), SILENT);
        assert_eq!(quiet.true_peak(), 0.0);
    }
}

//! Ducking: lowering one sound while another plays. Time is cut into hops (see
//! [`crate::meter::HOP_SECONDS`]); the depth at the start of a hop depends only
//! on which hops nearby held speech, so any stretch can be worked out alone and
//! comes out the same however playback cuts it up. Depth moves along raised
//! cosines, starting before speech (the mixer sees ahead) and easing back after
//! it, so the lowered sound never jumps.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DuckSettings {
    /// How far the sound is lowered, as a positive number of decibels.
    pub amount_db: f32,
    /// Speech counts above this RMS level over a hop.
    pub threshold_db: f32,
    /// Seconds the fall takes, ending as speech starts.
    pub attack: f32,
    /// Seconds speech counts as going on after it stops, so the sound stays down
    /// between words.
    pub hold: f32,
    /// Seconds the rise takes after that.
    pub release: f32,
}

impl Default for DuckSettings {
    fn default() -> Self {
        DuckSettings {
            amount_db: 12.0,
            threshold_db: -40.0,
            attack: 0.2,
            hold: 0.3,
            release: 0.6,
        }
    }
}

fn ease(distance: f64, length: f64) -> f64 {
    if length <= 0.0 || distance >= length {
        0.0
    } else {
        0.5 * (1.0 + (std::f64::consts::PI * distance / length).cos())
    }
}

impl DuckSettings {
    fn hops(&self, hop_seconds: f64) -> (f64, f64, f64) {
        // Rounded to a thousandth, so 0.3 s (as f32) is 30 hops, not a hair over.
        let h = |seconds: f32| ((seconds.max(0.0) as f64 / hop_seconds) * 1e3).round() / 1e3;
        (h(self.attack), h(self.hold), h(self.release))
    }

    /// Hops before and after hop `k` whose speech can change its depth.
    pub fn reach(&self, hop_seconds: f64) -> (i64, i64) {
        let (attack, hold, release) = self.hops(hop_seconds);
        ((1.0 + hold + release).ceil() as i64, attack.ceil() as i64)
    }

    /// Depth at the start of hop `k`, from 0 (untouched) to 1 (lowered by the
    /// full amount). `speaking(j)` says whether hop `j` held speech.
    pub fn depth(&self, k: i64, hop_seconds: f64, speaking: impl Fn(i64) -> bool) -> f32 {
        let (attack, hold, release) = self.hops(hop_seconds);
        let (before, after) = self.reach(hop_seconds);
        let at = k as f64;
        let mut depth = 0.0f64;
        for j in k - before..=k + after {
            if !speaking(j) {
                continue;
            }
            let (start, end) = (j as f64, j as f64 + 1.0 + hold);
            let value = if at < start {
                ease(start - at, attack)
            } else if at <= end {
                1.0
            } else {
                ease(at - end, release)
            };
            depth = depth.max(value);
            if depth >= 1.0 {
                break;
            }
        }
        depth as f32
    }

    /// The gain for a depth.
    pub fn gain(&self, depth: f32) -> f32 {
        crate::db_to_gain(-self.amount_db.abs() * depth)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOP: f64 = 0.01;

    #[test]
    fn depth_eases_down_before_speech_and_back_up_after_it() {
        let settings = DuckSettings::default();
        // Speech in hops 100 to 149 (1 s to 1.5 s).
        let speaking = |j: i64| (100..150).contains(&j);
        let depth = |k: i64| settings.depth(k, HOP, speaking);
        assert_eq!(settings.reach(HOP), (91, 20));
        assert_eq!(depth(70), 0.0);
        assert!(
            (depth(90) - 0.5).abs() < 1e-6,
            "half way through the 0.2 s fall"
        );
        assert_eq!(depth(100), 1.0);
        assert_eq!(depth(170), 1.0, "held 0.3 s after the last hop");
        assert!(
            (depth(210) - 0.5).abs() < 1e-6,
            "half way through the 0.6 s rise"
        );
        assert_eq!(depth(241), 0.0);
        // Never a jump: neighbouring hops differ by at most the steepest step
        // of the 0.2 s cosine.
        let steepest = (std::f64::consts::PI / 2.0 / 20.0) as f32;
        for k in 50..260 {
            assert!((depth(k + 1) - depth(k)).abs() <= steepest + 1e-6, "{k}");
        }
        assert!((settings.gain(1.0) - crate::db_to_gain(-12.0)).abs() < 1e-6);
        assert_eq!(settings.gain(0.0), 1.0);
    }

    #[test]
    fn a_short_gap_between_words_stays_down() {
        let settings = DuckSettings::default();
        let speaking = |j: i64| (100..120).contains(&j) || (140..160).contains(&j);
        for k in 100..190 {
            assert_eq!(settings.depth(k, HOP, speaking), 1.0, "{k}");
        }
    }
}

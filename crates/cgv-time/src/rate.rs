use serde::{Deserialize, Serialize};
use std::fmt;

use crate::{div_round, floor_div, Flicks, FLICKS_PER_SECOND};

/// A frame rate as a reduced fraction of frames per second.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FrameRate {
    pub num: u32,
    pub den: u32,
}

const fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

impl FrameRate {
    pub const FPS_23_976: FrameRate = FrameRate {
        num: 24_000,
        den: 1001,
    };
    pub const FPS_24: FrameRate = FrameRate { num: 24, den: 1 };
    pub const FPS_25: FrameRate = FrameRate { num: 25, den: 1 };
    pub const FPS_29_97: FrameRate = FrameRate {
        num: 30_000,
        den: 1001,
    };
    pub const FPS_30: FrameRate = FrameRate { num: 30, den: 1 };
    pub const FPS_48: FrameRate = FrameRate { num: 48, den: 1 };
    pub const FPS_50: FrameRate = FrameRate { num: 50, den: 1 };
    pub const FPS_59_94: FrameRate = FrameRate {
        num: 60_000,
        den: 1001,
    };
    pub const FPS_60: FrameRate = FrameRate { num: 60, den: 1 };
    pub const FPS_120: FrameRate = FrameRate { num: 120, den: 1 };

    pub const STANDARD: [FrameRate; 10] = [
        Self::FPS_23_976,
        Self::FPS_24,
        Self::FPS_25,
        Self::FPS_29_97,
        Self::FPS_30,
        Self::FPS_48,
        Self::FPS_50,
        Self::FPS_59_94,
        Self::FPS_60,
        Self::FPS_120,
    ];

    /// A reduced rate, or None when either part is zero.
    pub fn new(num: u32, den: u32) -> Option<Self> {
        if num == 0 || den == 0 {
            return None;
        }
        let g = gcd(num as u64, den as u64) as u32;
        Some(FrameRate {
            num: num / g,
            den: den / g,
        })
    }

    /// Snaps a measured rate (for example the mean packet rate of a stream) to
    /// the nearest standard rate within 0.1%, else to the nearest 1/1000 fps.
    pub fn from_measured(fps: f64) -> Option<Self> {
        if !fps.is_finite() || fps <= 0.0 {
            return None;
        }
        if let Some(standard) = Self::STANDARD
            .iter()
            .copied()
            .find(|rate| (rate.as_f64() - fps).abs() / rate.as_f64() < 0.001)
        {
            return Some(standard);
        }
        let millis = (fps * 1000.0).round();
        if millis < 1.0 || millis > u32::MAX as f64 {
            return None;
        }
        Self::new(millis as u32, 1000)
    }

    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    /// Duration of one frame. Exact for every rate in [`FrameRate::STANDARD`].
    pub fn frame_duration(self) -> Flicks {
        self.time_of_frame(1)
    }

    /// True when every frame boundary is a whole number of flicks.
    pub fn is_exact(self) -> bool {
        (FLICKS_PER_SECOND as i128 * self.den as i128) % self.num as i128 == 0
    }

    /// Start time of frame `frame`, rounded to the nearest flick.
    pub fn time_of_frame(self, frame: i64) -> Flicks {
        Flicks(div_round(
            frame as i128 * FLICKS_PER_SECOND as i128 * self.den as i128,
            self.num as i128,
        ) as i64)
    }

    /// The frame showing at `time`: the last frame that starts at or before it.
    pub fn frame_at(self, time: Flicks) -> i64 {
        floor_div(
            time.0 as i128 * self.num as i128,
            FLICKS_PER_SECOND as i128 * self.den as i128,
        ) as i64
    }

    /// The whole-number rate timecode counts in: 30 for 29.97, 24 for 23.976.
    pub fn nominal(self) -> u32 {
        (self.as_f64().round() as u32).max(1)
    }

    /// Drop-frame timecode exists for 29.97 and 59.94 only.
    pub fn supports_drop_frame(self) -> bool {
        self == Self::FPS_29_97 || self == Self::FPS_59_94
    }

    /// A short display label: "30", "29.97", "23.976".
    pub fn label(self) -> String {
        if self.den == 1 {
            return self.num.to_string();
        }
        let text = format!("{:.3}", self.as_f64());
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

impl fmt::Display for FrameRate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.num, self.den)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduces_and_rejects_zero() {
        assert_eq!(FrameRate::new(60, 2), Some(FrameRate::FPS_30));
        assert_eq!(FrameRate::new(48_000, 2002), Some(FrameRate::FPS_23_976));
        assert_eq!(FrameRate::new(0, 1), None);
        assert_eq!(FrameRate::new(30, 0), None);
    }

    #[test]
    fn every_standard_rate_has_exact_frame_boundaries() {
        for rate in FrameRate::STANDARD {
            assert!(rate.is_exact(), "{rate} is not exact");
            let one_hour = rate.time_of_frame(rate.frame_at(Flicks(FLICKS_PER_SECOND * 3600)));
            assert_eq!(
                rate.frame_at(one_hour),
                rate.frame_at(Flicks(FLICKS_PER_SECOND * 3600))
            );
        }
        assert_eq!(FrameRate::FPS_29_97.frame_duration().0, 23_543_520);
        assert_eq!(FrameRate::FPS_23_976.frame_duration().0, 29_429_400);
        assert_eq!(FrameRate::FPS_25.frame_duration().0, 28_224_000);
    }

    #[test]
    fn frame_at_is_the_inverse_of_time_of_frame() {
        for rate in FrameRate::STANDARD {
            for frame in [-3, 0, 1, 2, 999, 107_892] {
                let start = rate.time_of_frame(frame);
                assert_eq!(rate.frame_at(start), frame, "{rate} frame {frame}");
                assert_eq!(rate.frame_at(start + Flicks(1)), frame);
                assert_eq!(rate.frame_at(start - Flicks(1)), frame - 1);
            }
        }
    }

    #[test]
    fn measured_rates_snap_to_standards() {
        assert_eq!(FrameRate::from_measured(29.97), Some(FrameRate::FPS_29_97));
        assert_eq!(
            FrameRate::from_measured(29.970_03),
            Some(FrameRate::FPS_29_97)
        );
        assert_eq!(
            FrameRate::from_measured(23.976),
            Some(FrameRate::FPS_23_976)
        );
        assert_eq!(FrameRate::from_measured(30.0), Some(FrameRate::FPS_30));
        assert_eq!(FrameRate::from_measured(59.94), Some(FrameRate::FPS_59_94));
        assert_eq!(FrameRate::from_measured(15.0), FrameRate::new(15, 1));
        assert_eq!(FrameRate::from_measured(12.5), FrameRate::new(25, 2));
        assert_eq!(FrameRate::from_measured(0.0), None);
        assert_eq!(FrameRate::from_measured(f64::NAN), None);
    }

    #[test]
    fn labels_and_nominal_rates() {
        assert_eq!(FrameRate::FPS_30.label(), "30");
        assert_eq!(FrameRate::FPS_29_97.label(), "29.97");
        assert_eq!(FrameRate::FPS_23_976.label(), "23.976");
        assert_eq!(FrameRate::FPS_59_94.label(), "59.94");
        assert_eq!(FrameRate::FPS_29_97.nominal(), 30);
        assert_eq!(FrameRate::FPS_23_976.nominal(), 24);
        assert_eq!(FrameRate::FPS_29_97.to_string(), "30000/1001");
        assert!(FrameRate::FPS_59_94.supports_drop_frame());
        assert!(!FrameRate::FPS_23_976.supports_drop_frame());
    }
}

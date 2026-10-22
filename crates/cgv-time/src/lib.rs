//! Rational time for the editor: integer flicks, frame rates and timecode.
//!
//! A flick is 1/705,600,000 of a second. That number divides evenly by every
//! common frame rate (including 24000/1001 and 30000/1001) and sample rate, so
//! frame and sample boundaries are exact integers.
mod rate;
mod timecode;

pub use rate::FrameRate;
pub use timecode::{format_clock, timecode};

use serde::{Deserialize, Serialize};
use std::ops::{Add, AddAssign, Neg, Sub, SubAssign};

pub const FLICKS_PER_SECOND: i64 = 705_600_000;
/// 705.6 flicks per microsecond, kept as a fraction so conversions stay exact.
const FLICKS_PER_MICRO_NUM: i128 = 3528;
const FLICKS_PER_MICRO_DEN: i128 = 5;

/// A point or span on the timeline, in flicks.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct Flicks(pub i64);

impl Flicks {
    pub const ZERO: Flicks = Flicks(0);
    pub const ONE_SECOND: Flicks = Flicks(FLICKS_PER_SECOND);

    pub fn from_seconds(seconds: f64) -> Self {
        Flicks((seconds * FLICKS_PER_SECOND as f64).round() as i64)
    }
    pub fn as_seconds(self) -> f64 {
        self.0 as f64 / FLICKS_PER_SECOND as f64
    }

    /// From WebCodecs-style integer microseconds. Exact for every whole microsecond
    /// divisible by 5; others round to the nearest flick.
    pub fn from_micros(micros: i64) -> Self {
        Flicks(div_round(micros as i128 * FLICKS_PER_MICRO_NUM, FLICKS_PER_MICRO_DEN) as i64)
    }
    /// To integer microseconds, rounded to the nearest one.
    pub fn as_micros(self) -> i64 {
        div_round(self.0 as i128 * FLICKS_PER_MICRO_DEN, FLICKS_PER_MICRO_NUM) as i64
    }

    /// From a container's `ticks / timescale` timestamp, rounded to the nearest flick.
    pub fn from_ticks(ticks: i64, timescale: u32) -> Self {
        assert!(timescale > 0, "timescale must be positive");
        Flicks(div_round(ticks as i128 * FLICKS_PER_SECOND as i128, timescale as i128) as i64)
    }

    /// The sample index at this time for `sample_rate`, rounded down.
    pub fn to_samples(self, sample_rate: u32) -> i64 {
        floor_div(
            self.0 as i128 * sample_rate as i128,
            FLICKS_PER_SECOND as i128,
        ) as i64
    }
    pub fn from_samples(samples: i64, sample_rate: u32) -> Self {
        Self::from_ticks(samples, sample_rate)
    }
}

impl Add for Flicks {
    type Output = Flicks;
    fn add(self, rhs: Flicks) -> Flicks {
        Flicks(self.0 + rhs.0)
    }
}
impl AddAssign for Flicks {
    fn add_assign(&mut self, rhs: Flicks) {
        self.0 += rhs.0;
    }
}
impl Sub for Flicks {
    type Output = Flicks;
    fn sub(self, rhs: Flicks) -> Flicks {
        Flicks(self.0 - rhs.0)
    }
}
impl SubAssign for Flicks {
    fn sub_assign(&mut self, rhs: Flicks) {
        self.0 -= rhs.0;
    }
}
impl Neg for Flicks {
    type Output = Flicks;
    fn neg(self) -> Flicks {
        Flicks(-self.0)
    }
}

/// Division rounding half away from zero.
pub(crate) fn div_round(numerator: i128, denominator: i128) -> i128 {
    debug_assert!(denominator > 0);
    let half = denominator / 2;
    if numerator >= 0 {
        (numerator + half) / denominator
    } else {
        -((-numerator + half) / denominator)
    }
}

/// Division rounding towards negative infinity.
pub(crate) fn floor_div(numerator: i128, denominator: i128) -> i128 {
    debug_assert!(denominator > 0);
    numerator.div_euclid(denominator)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seconds_round_trip() {
        assert_eq!(Flicks::from_seconds(1.0), Flicks::ONE_SECOND);
        assert_eq!(Flicks::from_seconds(-0.5).0, -FLICKS_PER_SECOND / 2);
        assert_eq!(Flicks(FLICKS_PER_SECOND * 3).as_seconds(), 3.0);
    }

    #[test]
    fn microseconds_convert_exactly_on_multiples_of_five() {
        assert_eq!(Flicks::from_micros(1_000_000), Flicks::ONE_SECOND);
        assert_eq!(Flicks::from_micros(5).0, 3528);
        assert_eq!(Flicks(3528).as_micros(), 5);
        assert_eq!(Flicks::from_micros(-5).0, -3528);
        // 33,367 µs is the usual rounding of one 29.97 frame.
        let frame = Flicks::from_micros(33_367);
        assert_eq!(frame.as_micros(), 33_367);
    }

    #[test]
    fn ticks_from_common_timescales_are_exact() {
        assert_eq!(Flicks::from_ticks(90_000, 90_000), Flicks::ONE_SECOND);
        assert_eq!(Flicks::from_ticks(1001, 30_000).0, 23_543_520);
        assert_eq!(Flicks::from_ticks(1, 48_000).0, 14_700);
        assert_eq!(Flicks::from_ticks(1, 44_100).0, 16_000);
    }

    #[test]
    fn samples_round_down_and_back() {
        let t = Flicks::from_samples(48_000 * 3 + 7, 48_000);
        assert_eq!(t.to_samples(48_000), 48_000 * 3 + 7);
        assert_eq!(Flicks(14_699).to_samples(48_000), 0);
        assert_eq!(Flicks(-1).to_samples(48_000), -1);
    }

    #[test]
    fn arithmetic() {
        let mut t = Flicks(10) + Flicks(5) - Flicks(3);
        t += Flicks(1);
        t -= Flicks(2);
        assert_eq!(t, Flicks(11));
        assert_eq!(-t, Flicks(-11));
    }

    #[test]
    fn rounding_helpers() {
        assert_eq!(div_round(5, 2), 3);
        assert_eq!(div_round(-5, 2), -3);
        assert_eq!(div_round(4, 3), 1);
        assert_eq!(floor_div(-1, 3), -1);
        assert_eq!(floor_div(7, 3), 2);
    }
}

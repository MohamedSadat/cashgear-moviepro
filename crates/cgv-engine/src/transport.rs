//! The playhead: where it is and how it moves. While playing, the position
//! follows a master clock given in seconds since the playhead started moving:
//! the audio clock when sound plays, the wall clock otherwise.
use cgv_time::Flicks;

/// Playback rates the shuttle steps through, each way.
pub const SHUTTLE_RATES: [f64; 4] = [1.0, 2.0, 4.0, 8.0];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shuttle {
    /// L: play forward, faster each press.
    Forward,
    /// K: stop.
    Stop,
    /// J: play backward, faster each press.
    Reverse,
}

/// The rate after a J, K or L press at `rate`.
pub fn shuttle(rate: f64, key: Shuttle) -> f64 {
    let faster = |rate: f64| {
        SHUTTLE_RATES
            .iter()
            .copied()
            .find(|&step| step > rate.abs() + 1e-9)
            .unwrap_or(SHUTTLE_RATES[SHUTTLE_RATES.len() - 1])
    };
    match key {
        Shuttle::Stop => 0.0,
        Shuttle::Forward if rate <= 0.0 => 1.0,
        Shuttle::Forward => faster(rate),
        Shuttle::Reverse if rate >= 0.0 => -1.0,
        Shuttle::Reverse => -faster(rate),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transport {
    /// The position when the clock read zero.
    anchor: Flicks,
    /// Zero when paused.
    rate: f64,
}

impl Transport {
    pub fn paused(at: Flicks) -> Transport {
        Transport {
            anchor: at,
            rate: 0.0,
        }
    }

    pub fn playing(from: Flicks, rate: f64) -> Transport {
        Transport { anchor: from, rate }
    }

    pub fn rate(&self) -> f64 {
        self.rate
    }
    pub fn is_playing(&self) -> bool {
        self.rate != 0.0
    }
    pub fn anchor(&self) -> Flicks {
        self.anchor
    }

    /// The position at clock `seconds`, kept within `0..=last` (the last frame's start).
    pub fn position(&self, seconds: f64, last: Flicks) -> Flicks {
        let moved = Flicks::from_seconds(seconds.max(0.0) * self.rate);
        (self.anchor + moved).clamp(Flicks::ZERO, last.max(Flicks::ZERO))
    }

    /// True once playback has run past either end of `0..end`.
    pub fn finished(&self, seconds: f64, end: Flicks) -> bool {
        let at = self.anchor + Flicks::from_seconds(seconds.max(0.0) * self.rate);
        (self.rate > 0.0 && at >= end) || (self.rate < 0.0 && at <= Flicks::ZERO)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shuttle_steps_through_the_rates_each_way() {
        let mut rate = 0.0;
        let mut forward = Vec::new();
        for _ in 0..5 {
            rate = shuttle(rate, Shuttle::Forward);
            forward.push(rate);
        }
        assert_eq!(forward, [1.0, 2.0, 4.0, 8.0, 8.0]);
        assert_eq!(shuttle(4.0, Shuttle::Reverse), -1.0);
        assert_eq!(shuttle(-1.0, Shuttle::Reverse), -2.0);
        assert_eq!(shuttle(-8.0, Shuttle::Reverse), -8.0);
        assert_eq!(shuttle(-2.0, Shuttle::Forward), 1.0);
        assert_eq!(shuttle(-2.0, Shuttle::Stop), 0.0);
    }

    #[test]
    fn the_position_follows_the_clock_within_the_timeline() {
        let second = Flicks::ONE_SECOND;
        let last = Flicks(second.0 * 10);
        let paused = Transport::paused(Flicks(second.0 * 3));
        assert!(!paused.is_playing());
        assert_eq!(paused.position(5.0, last), Flicks(second.0 * 3));
        let play = Transport::playing(Flicks(second.0 * 3), 1.0);
        assert_eq!(play.position(-0.02, last), Flicks(second.0 * 3));
        assert_eq!(play.position(1.5, last), Flicks(second.0 * 9 / 2));
        assert_eq!(play.position(100.0, last), last);
        assert!(!play.finished(6.9, Flicks(second.0 * 10)));
        assert!(play.finished(7.0, Flicks(second.0 * 10)));
        let back = Transport::playing(Flicks(second.0 * 3), -2.0);
        assert_eq!(back.position(1.0, last), Flicks(second.0));
        assert_eq!(back.position(2.0, last), Flicks::ZERO);
        assert!(back.finished(1.5, last));
        assert_eq!(
            Transport::playing(second, 1.0).position(1.0, Flicks(-1)),
            Flicks::ZERO
        );
    }
}

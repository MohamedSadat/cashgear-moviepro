//! How a clip's time maps to its media's: constant speed, speed ramps, reverse
//! and freeze frames. Offsets count from the clip's start.
//!
//! A ramp is a curve of speed over the clip's timeline, as points joined by
//! straight lines and held before the first and after the last. Its points are
//! stored by time, so trims and splits keep the curve where it was, as they keep
//! keyframes. A reversed clip plays its source range from the out point back to
//! the in point, its ramp still read in timeline order. A freeze frame shows the
//! frame at its in point throughout.
use cgv_time::Flicks;
use serde::{Deserialize, Serialize};

use crate::project::{Clip, Speed};

/// Points one ramp can have.
pub const MAX_RAMP_POINTS: usize = 64;
/// The slowest and fastest a ramped clip may play anywhere, its speed included.
pub const MIN_RAMP_SPEED: f64 = 0.1;
pub const MAX_RAMP_SPEED: f64 = 100.0;

/// A point of a speed ramp: at `time` from the clip's start it plays at `speed`
/// times the clip's speed.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RampPoint {
    pub time: Flicks,
    pub speed: f64,
}

/// A ramp point by fraction of the clip's length, as presets and the curve
/// editor give them: the length follows from the curve.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RampShape {
    /// 0 (the clip's start) to 1 (its end).
    pub at: f64,
    pub speed: f64,
}

/// The ramp's speed `t` flicks from the clip's start.
pub fn ramp_speed(points: &[RampPoint], t: f64) -> f64 {
    let Some(first) = points.first() else {
        return 1.0;
    };
    if t <= first.time.0 as f64 {
        return first.speed;
    }
    for pair in points.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let (ta, tb) = (a.time.0 as f64, b.time.0 as f64);
        if t <= tb {
            return a.speed + (b.speed - a.speed) * (t - ta) / (tb - ta);
        }
    }
    points.last().map_or(1.0, |last| last.speed)
}

/// Media time the ramp covers over the first `t` flicks of the clip (negative
/// before it), at a clip speed of 1: the integral of its speed.
pub fn ramp_span(points: &[RampPoint], t: f64) -> f64 {
    let Some(first) = points.first() else {
        return t;
    };
    let t0 = first.time.0 as f64;
    if t <= t0 {
        return first.speed * t;
    }
    let mut total = first.speed * t0;
    for pair in points.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let (ta, tb) = (a.time.0 as f64, b.time.0 as f64);
        let x = t.min(tb) - ta;
        let slope = (b.speed - a.speed) / (tb - ta);
        total += a.speed * x + slope * x * x / 2.0;
        if t <= tb {
            return total;
        }
    }
    let last = points.last().expect("a point");
    total + last.speed * (t - last.time.0 as f64)
}

/// The inverse of [`ramp_span`]: the time from the clip's start over which the
/// ramp covers `span` of media.
pub fn ramp_time(points: &[RampPoint], span: f64) -> f64 {
    let Some(first) = points.first() else {
        return span;
    };
    let t0 = first.time.0 as f64;
    let mut covered = first.speed * t0;
    if span <= covered {
        return span / first.speed;
    }
    for pair in points.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let (ta, tb) = (a.time.0 as f64, b.time.0 as f64);
        let length = tb - ta;
        let whole = (a.speed + b.speed) / 2.0 * length;
        if span <= covered + whole {
            let left = span - covered;
            let slope = (b.speed - a.speed) / length;
            if slope.abs() < 1e-18 {
                return ta + left / a.speed;
            }
            // a·x + slope·x²/2 = left, for the root in the segment.
            let root = (a.speed * a.speed + 2.0 * slope * left).max(0.0).sqrt();
            return ta + (root - a.speed) / slope;
        }
        covered += whole;
    }
    let last = points.last().expect("a point");
    last.time.0 as f64 + (span - covered) / last.speed
}

/// The ramp from `delta` on, as seen from there: points before it go, and one at
/// the new start keeps the speed the curve had there.
fn ramp_from(points: &[RampPoint], delta: Flicks) -> Vec<RampPoint> {
    if points.is_empty() {
        return Vec::new();
    }
    let mut kept: Vec<RampPoint> = points
        .iter()
        .filter(|p| p.time > delta)
        .map(|p| RampPoint {
            time: p.time - delta,
            speed: p.speed,
        })
        .collect();
    if kept.len() < points.len() {
        kept.insert(
            0,
            RampPoint {
                time: Flicks::ZERO,
                speed: ramp_speed(points, delta.0 as f64),
            },
        );
    }
    kept
}

/// The ramp up to `end`: points after it go, and one there keeps the speed.
fn ramp_until(points: &[RampPoint], end: Flicks) -> Vec<RampPoint> {
    let mut kept: Vec<RampPoint> = points.iter().filter(|p| p.time <= end).copied().collect();
    if kept.len() < points.len() && kept.last().is_none_or(|p| p.time < end) {
        kept.push(RampPoint {
            time: end,
            speed: ramp_speed(points, end.0 as f64),
        });
    }
    kept
}

/// The mean speed of a curve given by fraction of its length.
pub fn shape_mean(shape: &[RampShape]) -> f64 {
    let points: Vec<RampPoint> = shape
        .iter()
        .map(|p| RampPoint {
            time: Flicks((p.at * 1e9).round() as i64),
            speed: p.speed,
        })
        .collect();
    ramp_span(&points, 1e9) / 1e9
}

/// Checks a ramp's points against the clip's length and speed.
pub(crate) fn check_ramp(
    points: &[RampPoint],
    duration: Flicks,
    speed: Speed,
) -> Result<(), String> {
    if points.len() > MAX_RAMP_POINTS {
        return Err(format!("A speed ramp has at most {MAX_RAMP_POINTS} points"));
    }
    let base = speed.as_f64();
    for (index, point) in points.iter().enumerate() {
        if point.time < Flicks::ZERO || point.time > duration {
            return Err("Speed ramp points lie within the clip".into());
        }
        if index > 0 && points[index - 1].time >= point.time {
            return Err("Speed ramp points are out of order".into());
        }
        let speed = point.speed * base;
        if !point.speed.is_finite() || !(MIN_RAMP_SPEED..=MAX_RAMP_SPEED).contains(&speed) {
            return Err(format!(
                "A speed ramp plays from {MIN_RAMP_SPEED}× to {MAX_RAMP_SPEED}×"
            ));
        }
    }
    Ok(())
}

/// Checks a curve given by fractions, as [`check_ramp`] does stored points.
pub(crate) fn check_shape(shape: &[RampShape], speed: Speed) -> Result<(), String> {
    if shape.len() > MAX_RAMP_POINTS {
        return Err(format!("A speed ramp has at most {MAX_RAMP_POINTS} points"));
    }
    for (index, point) in shape.iter().enumerate() {
        if !(0.0..=1.0).contains(&point.at) || (index > 0 && shape[index - 1].at >= point.at) {
            return Err("Speed ramp points run from the clip's start to its end, in order".into());
        }
        let effective = point.speed * speed.as_f64();
        if !point.speed.is_finite() || !(MIN_RAMP_SPEED..=MAX_RAMP_SPEED).contains(&effective) {
            return Err(format!(
                "A speed ramp plays from {MIN_RAMP_SPEED}× to {MAX_RAMP_SPEED}×"
            ));
        }
    }
    Ok(())
}

impl Clip {
    /// How fast the media plays `offset` from the clip's start, as a multiple
    /// of normal speed: zero for a freeze frame.
    pub fn speed_at(&self, offset: Flicks) -> f64 {
        if self.freeze {
            return 0.0;
        }
        self.speed.as_f64() * ramp_speed(&self.ramp, offset.0 as f64)
    }

    /// Media time the first `offset` of the clip covers (negative before its
    /// start), whichever way it plays.
    pub fn span_at(&self, offset: Flicks) -> Flicks {
        if self.freeze {
            Flicks::ZERO
        } else if self.ramp.is_empty() {
            self.speed.source_span(offset)
        } else {
            let span = self.speed.as_f64() * ramp_span(&self.ramp, offset.0 as f64);
            Flicks(span.round() as i64)
        }
    }

    /// Timeline time from the clip's start over which it covers `span` of media.
    pub fn time_for_span(&self, span: Flicks) -> Flicks {
        if self.freeze || self.ramp.is_empty() {
            self.speed.timeline_span(span)
        } else {
            let t = ramp_time(&self.ramp, span.0 as f64 / self.speed.as_f64());
            Flicks(t.round() as i64)
        }
    }

    /// The length of media the clip plays.
    pub fn source_span(&self) -> Flicks {
        self.span_at(self.duration)
    }

    /// Source time just after the last frame of the range the clip plays.
    pub fn source_out(&self) -> Flicks {
        self.source_in + self.source_span()
    }

    /// The media time shown by the frame starting `offset` from the clip's
    /// start, `frame` long. Outside the clip (in a transition) the media goes on
    /// past its edges. A reversed clip samples the middle of the frame, so it
    /// shows each source frame the forward clip shows, in the opposite order.
    pub fn source_at(&self, offset: Flicks, frame: Flicks) -> Flicks {
        if self.freeze {
            self.source_in
        } else if self.reverse {
            self.source_out() - self.span_at(offset + Flicks(frame.0 / 2))
        } else {
            self.source_in + self.span_at(offset)
        }
    }

    /// Whether the clip plays its media at anything but normal speed forwards.
    pub fn retimed(&self) -> bool {
        self.freeze || self.reverse || !self.ramp.is_empty() || self.speed != Speed::NORMAL
    }

    /// Removes the first `delta` of the clip's timeline (a negative `delta`
    /// extends it), keeping its content where it still plays: the in point of a
    /// forward clip moves, a reversed one's out point does. `still` clips have
    /// no source position.
    pub(crate) fn cut_start(&mut self, delta: Flicks, still: bool) {
        if !still && !self.freeze && !self.reverse {
            self.source_in += self.span_at(delta);
        }
        if delta >= Flicks::ZERO {
            self.ramp = ramp_from(&self.ramp, delta);
        } else {
            // The first speed holds over the added stretch.
            for point in &mut self.ramp {
                point.time -= delta;
            }
        }
        self.duration -= delta;
    }

    /// Moves the clip's end so it lasts `duration`, keeping its content where it
    /// still plays: a reversed clip's in point moves.
    pub(crate) fn set_end(&mut self, duration: Flicks, still: bool) {
        let out = self.source_out();
        self.ramp = ramp_until(&self.ramp, duration);
        self.duration = duration;
        if !still && self.reverse && !self.freeze {
            self.source_in = out - self.source_span();
        }
    }

    /// Plays the clip at `speed`, with its ramp's shape kept, over `duration`:
    /// ramp points move with the length, and a reversed clip keeps its out point.
    pub(crate) fn retime(&mut self, speed: Speed, duration: Flicks) {
        let out = self.source_out();
        let scale = duration.0 as f64 / self.duration.0 as f64;
        for point in &mut self.ramp {
            point.time = Flicks((point.time.0 as f64 * scale).round() as i64).min(duration);
        }
        self.ramp.dedup_by_key(|point| point.time);
        self.speed = speed;
        self.duration = duration;
        if self.reverse && !self.freeze {
            self.source_in = out - self.source_span();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn points(list: &[(i64, f64)]) -> Vec<RampPoint> {
        list.iter()
            .map(|&(time, speed)| RampPoint {
                time: Flicks(time),
                speed,
            })
            .collect()
    }

    #[test]
    fn ramps_integrate_their_speed_and_invert() {
        let ramp = points(&[(100, 1.0), (300, 3.0), (400, 3.0)]);
        assert_eq!(ramp_speed(&ramp, 0.0), 1.0);
        assert_eq!(ramp_speed(&ramp, 200.0), 2.0);
        assert_eq!(ramp_speed(&ramp, 1000.0), 3.0);
        // 100 at 1×, then 200 rising from 1× to 3× (400), then 100 at 3×.
        assert_eq!(ramp_span(&ramp, 100.0), 100.0);
        assert_eq!(ramp_span(&ramp, 300.0), 500.0);
        assert_eq!(ramp_span(&ramp, 400.0), 800.0);
        assert_eq!(ramp_span(&ramp, 500.0), 1100.0);
        assert_eq!(ramp_span(&ramp, -50.0), -50.0);
        for t in [-30.0, 0.0, 50.0, 150.0, 299.0, 350.0, 700.0] {
            let back = ramp_time(&ramp, ramp_span(&ramp, t));
            assert!((back - t).abs() < 1e-9, "{t} came back as {back}");
        }
        let falling = points(&[(0, 4.0), (100, 0.5)]);
        for t in [10.0, 60.0, 99.0, 150.0] {
            assert!((ramp_time(&falling, ramp_span(&falling, t)) - t).abs() < 1e-9);
        }
        assert_eq!(ramp_span(&[], 70.0), 70.0);
        let shape = [
            RampShape {
                at: 0.0,
                speed: 1.0,
            },
            RampShape {
                at: 1.0,
                speed: 3.0,
            },
        ];
        assert!((shape_mean(&shape) - 2.0).abs() < 1e-12);
    }

    #[test]
    fn cutting_a_ramp_keeps_its_curve_where_it_plays() {
        let ramp = points(&[(0, 1.0), (100, 2.0), (200, 0.5)]);
        let from = ramp_from(&ramp, Flicks(50));
        assert_eq!(from, points(&[(0, 1.5), (50, 2.0), (150, 0.5)]));
        for t in [0.0, 30.0, 120.0, 400.0] {
            assert!((ramp_speed(&from, t) - ramp_speed(&ramp, t + 50.0)).abs() < 1e-12);
        }
        // Nothing before the cut: the first speed already holds there.
        assert_eq!(
            ramp_from(&points(&[(80, 2.0)]), Flicks(50)),
            points(&[(30, 2.0)])
        );
        let until = ramp_until(&ramp, Flicks(150));
        assert_eq!(until, points(&[(0, 1.0), (100, 2.0), (150, 1.25)]));
        assert_eq!(ramp_until(&ramp, Flicks(200)), ramp);
    }
}

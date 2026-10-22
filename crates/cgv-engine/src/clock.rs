/// Converts host timestamps (milliseconds) into pattern time (seconds),
/// starting at zero on the first frame.
#[derive(Debug, Default)]
pub struct PatternClock {
    origin_ms: Option<f64>,
}

impl PatternClock {
    pub fn seconds(&mut self, now_ms: f64) -> f32 {
        let origin = *self.origin_ms.get_or_insert(now_ms);
        ((now_ms - origin).max(0.0) / 1000.0) as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_at_zero_and_advances_in_seconds() {
        let mut clock = PatternClock::default();
        assert_eq!(clock.seconds(5_000.0), 0.0);
        assert_eq!(clock.seconds(5_500.0), 0.5);
        assert_eq!(clock.seconds(7_000.0), 2.0);
    }

    #[test]
    fn never_runs_backwards_past_its_origin() {
        let mut clock = PatternClock::default();
        clock.seconds(1_000.0);
        assert_eq!(clock.seconds(900.0), 0.0);
    }
}

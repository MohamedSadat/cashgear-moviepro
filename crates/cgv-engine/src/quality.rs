//! Preview quality. Full, 1/2 and 1/4 render the composition at that fraction of
//! the project resolution. Auto (the default) plays at full resolution and drops
//! one step when frames run late although their pictures were decoded in time,
//! which means drawing is the bottleneck, then steps back up after a calm spell.
//! A paused Auto preview always shows full resolution.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QualityMode {
    Auto,
    Full,
    Half,
    Quarter,
}

/// Scale of each level: full, half, quarter.
pub const LEVEL_SCALES: [f64; 3] = [1.0, 0.5, 0.25];
/// How long Auto watches before deciding.
pub const WINDOW_MS: f64 = 1000.0;
/// Frames missed by drawing in one window that count as running late.
const LATE_FRAMES: u32 = 2;
/// Calm windows before the first step back up.
const FIRST_CALM: u32 = 3;
/// The most calm windows Auto ever waits for.
const MAX_CALM: u32 = 30;

#[derive(Clone, Debug, PartialEq)]
pub struct Governor {
    mode: QualityMode,
    level: usize,
    window_start: Option<f64>,
    /// Frames skipped although their pictures were ready (drawing was late).
    drawing_missed: u32,
    /// Frames skipped in all.
    missed: u32,
    calm: u32,
    /// Calm windows needed to step up. Doubles when a step up does not hold,
    /// so Auto settles instead of bouncing between levels.
    calm_needed: u32,
    stepped_up: bool,
}

impl Default for Governor {
    fn default() -> Self {
        Governor {
            mode: QualityMode::Auto,
            level: 0,
            window_start: None,
            drawing_missed: 0,
            missed: 0,
            calm: 0,
            calm_needed: FIRST_CALM,
            stepped_up: false,
        }
    }
}

impl Governor {
    pub fn mode(&self) -> QualityMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: QualityMode) {
        self.mode = mode;
        self.restart();
    }

    /// 0 full, 1 half, 2 quarter.
    pub fn level(&self, playing: bool) -> usize {
        match self.mode {
            QualityMode::Full => 0,
            QualityMode::Half => 1,
            QualityMode::Quarter => 2,
            QualityMode::Auto if playing => self.level,
            QualityMode::Auto => 0,
        }
    }

    pub fn scale(&self, playing: bool) -> f64 {
        LEVEL_SCALES[self.level(playing)]
    }

    /// Starts a fresh observation window (playback started or the mode changed).
    pub fn restart(&mut self) {
        self.window_start = None;
        self.drawing_missed = 0;
        self.missed = 0;
    }

    /// Records a frame shown while playing, after `missed` skipped frames, of
    /// which `drawing_missed` had their pictures decoded in time. Returns true
    /// when Auto changed the level.
    pub fn record(&mut self, now_ms: f64, missed: u32, drawing_missed: u32) -> bool {
        let start = *self.window_start.get_or_insert(now_ms);
        self.missed += missed;
        self.drawing_missed += drawing_missed.min(missed);
        // Half a millisecond of slack: 30 frames at 30 fps span 999.99… ms.
        if now_ms - start < WINDOW_MS - 0.5 {
            return false;
        }
        let before = self.level;
        if self.mode == QualityMode::Auto {
            if self.drawing_missed >= LATE_FRAMES {
                if self.level + 1 < LEVEL_SCALES.len() {
                    self.level += 1;
                    if self.stepped_up {
                        self.calm_needed = (self.calm_needed * 2).min(MAX_CALM);
                    }
                }
                self.stepped_up = false;
                self.calm = 0;
            } else if self.missed == 0 {
                self.calm += 1;
                if self.calm >= self.calm_needed && self.level > 0 {
                    self.level -= 1;
                    self.stepped_up = true;
                    self.calm = 0;
                }
            } else {
                self.calm = 0;
            }
        }
        self.restart();
        self.window_start = Some(now_ms);
        self.level != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUDGET: f64 = 1000.0 / 30.0;

    /// Records frames `from..to` at 30 fps (a window closes on every 30th frame).
    /// Every `late_every`th frame follows one that drawing missed.
    fn play(governor: &mut Governor, frames: std::ops::Range<u32>, late_every: u32) {
        for frame in frames {
            let missed = (late_every > 0 && frame % late_every == 0) as u32;
            governor.record(frame as f64 * BUDGET, missed, missed);
        }
    }

    #[test]
    fn fixed_modes_ignore_timing_and_auto_is_full_when_paused() {
        let mut governor = Governor::default();
        assert_eq!(governor.mode(), QualityMode::Auto);
        assert_eq!(governor.scale(true), 1.0);
        governor.set_mode(QualityMode::Quarter);
        play(&mut governor, 0..90, 1);
        assert_eq!(governor.scale(true), 0.25);
        assert_eq!(governor.scale(false), 0.25);
        governor.set_mode(QualityMode::Half);
        assert_eq!(governor.level(false), 1);
    }

    #[test]
    fn auto_drops_a_step_when_drawing_runs_late_and_recovers_after_calm() {
        let mut governor = Governor::default();
        // Drawing misses a frame every 5: windows close at frames 30 and 60.
        play(&mut governor, 0..31, 5);
        assert_eq!(governor.level(true), 1);
        assert_eq!(governor.level(false), 0);
        play(&mut governor, 31..61, 5);
        assert_eq!(governor.level(true), 2);
        play(&mut governor, 61..91, 5);
        assert_eq!(governor.level(true), 2, "quarter is the lowest");
        // Three calm windows (closing at 120, 150 and 180) per step back up.
        play(&mut governor, 91..180, 0);
        assert_eq!(governor.level(true), 2);
        play(&mut governor, 180..181, 0);
        assert_eq!(governor.level(true), 1);
        play(&mut governor, 181..271, 0);
        assert_eq!(governor.level(true), 0);
    }

    #[test]
    fn a_step_up_that_does_not_hold_doubles_the_wait() {
        let mut governor = Governor::default();
        play(&mut governor, 0..31, 5);
        assert_eq!(governor.level(true), 1);
        play(&mut governor, 31..121, 0);
        assert_eq!(governor.level(true), 0);
        // Full is too much again: back down, and now six calm windows to return.
        play(&mut governor, 121..151, 5);
        assert_eq!(governor.level(true), 1);
        play(&mut governor, 151..301, 0);
        assert_eq!(governor.level(true), 1);
        play(&mut governor, 301..331, 0);
        assert_eq!(governor.level(true), 0);
    }

    #[test]
    fn frames_missed_by_slow_decoding_keep_full_resolution() {
        // Decoding, not drawing, is behind: a smaller picture would not help.
        let mut governor = Governor::default();
        for frame in 0..200 {
            let missed = (frame % 3 == 0) as u32;
            governor.record(frame as f64 * BUDGET, missed, 0);
        }
        assert_eq!(governor.level(true), 0);
    }
}

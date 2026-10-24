//! Preview quality. Full, 1/2 and 1/4 render the composition at that fraction of
//! the project resolution. Auto (the default) plays at full resolution and drops
//! one step when the GPU makes frames run late, then steps back up after a few
//! seconds with headroom. A paused Auto preview always shows full resolution.
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
/// Missed frames in a window that count as running late.
const LATE_FRAMES: u32 = 2;
/// GPU time, as a share of the frame budget, that means the GPU is the cause.
const BUSY_SHARE: f64 = 0.75;
/// GPU time below this share of the budget counts as headroom.
const IDLE_SHARE: f64 = 0.35;
/// Calm windows in a row before stepping back up.
const CALM_WINDOWS: u32 = 3;

#[derive(Clone, Debug, PartialEq)]
pub struct Governor {
    mode: QualityMode,
    level: usize,
    window_start: Option<f64>,
    frames: u32,
    missed: u32,
    gpu_total: f64,
    gpu_max: f64,
    calm: u32,
}

impl Default for Governor {
    fn default() -> Self {
        Governor {
            mode: QualityMode::Auto,
            level: 0,
            window_start: None,
            frames: 0,
            missed: 0,
            gpu_total: 0.0,
            gpu_max: 0.0,
            calm: 0,
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
        self.frames = 0;
        self.missed = 0;
        self.gpu_total = 0.0;
        self.gpu_max = 0.0;
    }

    /// Records a frame shown while playing: `missed` frames were skipped before
    /// it, `gpu_ms` is the GPU time of the latest finished frame and `budget_ms`
    /// one frame's duration. Returns true when Auto changed the level.
    pub fn record(&mut self, now_ms: f64, budget_ms: f64, gpu_ms: f64, missed: u32) -> bool {
        let start = *self.window_start.get_or_insert(now_ms);
        self.frames += 1;
        self.missed += missed;
        self.gpu_total += gpu_ms;
        self.gpu_max = self.gpu_max.max(gpu_ms);
        // Half a millisecond of slack: 30 frames at 30 fps span 999.99… ms.
        if now_ms - start < WINDOW_MS - 0.5 {
            return false;
        }
        let gpu_mean = self.gpu_total / self.frames as f64;
        let before = self.level;
        if self.mode == QualityMode::Auto {
            if self.missed >= LATE_FRAMES && gpu_mean > BUSY_SHARE * budget_ms {
                self.level = (self.level + 1).min(LEVEL_SCALES.len() - 1);
                self.calm = 0;
            } else if self.missed == 0 && self.gpu_max < IDLE_SHARE * budget_ms {
                self.calm += 1;
                if self.calm >= CALM_WINDOWS && self.level > 0 {
                    self.level -= 1;
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

    /// Records frames `from..to` at 30 fps: a window closes on every 30th frame.
    fn play(governor: &mut Governor, frames: std::ops::Range<u32>, gpu_ms: f64, missed_every: u32) {
        for frame in frames {
            let missed = (missed_every > 0 && frame % missed_every == 0) as u32;
            governor.record(frame as f64 * BUDGET, BUDGET, gpu_ms, missed);
        }
    }

    #[test]
    fn fixed_modes_ignore_timing_and_auto_is_full_when_paused() {
        let mut governor = Governor::default();
        assert_eq!(governor.mode(), QualityMode::Auto);
        assert_eq!(governor.scale(true), 1.0);
        governor.set_mode(QualityMode::Quarter);
        play(&mut governor, 0..90, 40.0, 1);
        assert_eq!(governor.scale(true), 0.25);
        assert_eq!(governor.scale(false), 0.25);
        governor.set_mode(QualityMode::Half);
        assert_eq!(governor.level(false), 1);
    }

    #[test]
    fn auto_drops_a_step_when_the_gpu_runs_late_and_recovers_with_headroom() {
        let mut governor = Governor::default();
        // A busy GPU with a frame missed every 5: windows close at frames 30 and 60.
        play(&mut governor, 0..31, 30.0, 5);
        assert_eq!(governor.level(true), 1);
        assert_eq!(governor.level(false), 0);
        play(&mut governor, 31..61, 30.0, 5);
        assert_eq!(governor.level(true), 2);
        play(&mut governor, 61..91, 30.0, 5);
        assert_eq!(governor.level(true), 2, "quarter is the lowest");
        // Three calm windows per step back up (closing at 120, 150 and 180).
        play(&mut governor, 91..180, 4.0, 0);
        assert_eq!(governor.level(true), 2);
        play(&mut governor, 180..181, 4.0, 0);
        assert_eq!(governor.level(true), 1);
        play(&mut governor, 181..271, 4.0, 0);
        assert_eq!(governor.level(true), 0);
    }

    #[test]
    fn late_frames_with_an_idle_gpu_keep_full_resolution() {
        // Decoding, not drawing, is behind: a smaller picture would not help.
        let mut governor = Governor::default();
        play(&mut governor, 0..200, 5.0, 3);
        assert_eq!(governor.level(true), 0);
    }
}

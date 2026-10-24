//! Playback measurements: frames shown and dropped, render and GPU times, and
//! the A/V offset of every frame shown with sound, for the dev overlay and the
//! sync tests.
use serde::Serialize;

/// Histogram bins of |offset|, 0.25 ms each, up to 100 ms (one overflow bin).
const BIN_MS: f64 = 0.25;
const BINS: usize = 400;

#[derive(Clone, Debug, PartialEq)]
pub struct PlaybackStats {
    presented: u64,
    dropped: u64,
    late: u64,
    render: Accumulator,
    gpu: Accumulator,
    offset: Accumulator,
    offset_abs_max: f64,
    last_offset: Option<f64>,
    histogram: Vec<u32>,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Accumulator {
    count: u64,
    total: f64,
    max: f64,
}

impl Accumulator {
    fn add(&mut self, value: f64) {
        if !value.is_finite() {
            return;
        }
        self.count += 1;
        self.total += value;
        self.max = if self.count == 1 {
            value
        } else {
            self.max.max(value)
        };
    }
    fn summary(&self) -> Timing {
        Timing {
            mean: if self.count > 0 {
                self.total / self.count as f64
            } else {
                0.0
            },
            max: self.max,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Timing {
    pub mean: f64,
    pub max: f64,
}

/// Offsets are video minus audio: positive means the picture is ahead.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OffsetSummary {
    pub count: u64,
    pub mean_ms: f64,
    pub max_abs_ms: f64,
    pub last_ms: Option<f64>,
    /// Percentiles of |offset|, to the histogram's 0.25 ms resolution.
    pub p50_abs_ms: f64,
    pub p95_abs_ms: f64,
    pub p99_abs_ms: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSummary {
    pub presented: u64,
    pub dropped: u64,
    pub late: u64,
    pub render_ms: Timing,
    pub gpu_ms: Timing,
    pub offset: OffsetSummary,
}

impl Default for PlaybackStats {
    fn default() -> Self {
        PlaybackStats {
            presented: 0,
            dropped: 0,
            late: 0,
            render: Accumulator::default(),
            gpu: Accumulator::default(),
            offset: Accumulator::default(),
            offset_abs_max: 0.0,
            last_offset: None,
            histogram: vec![0; BINS + 1],
        }
    }
}

impl PlaybackStats {
    /// A frame was shown. `late` marks one shown after it was first due.
    pub fn presented(&mut self, render_ms: f64, gpu_ms: f64, offset_ms: Option<f64>, late: bool) {
        self.presented += 1;
        self.late += late as u64;
        self.render.add(render_ms);
        self.gpu.add(gpu_ms);
        if let Some(offset) = offset_ms.filter(|value| value.is_finite()) {
            self.offset.add(offset);
            self.offset_abs_max = self.offset_abs_max.max(offset.abs());
            self.last_offset = Some(offset);
            let bin = ((offset.abs() / BIN_MS) as usize).min(BINS);
            self.histogram[bin] += 1;
        }
    }

    /// Frames that were due but never shown.
    pub fn dropped(&mut self, frames: u64) {
        self.dropped += frames;
    }

    fn percentile(&self, share: f64) -> f64 {
        let total: u64 = self.histogram.iter().map(|&count| count as u64).sum();
        if total == 0 {
            return 0.0;
        }
        let wanted = (share * total as f64).ceil() as u64;
        let mut seen = 0;
        for (bin, &count) in self.histogram.iter().enumerate() {
            seen += count as u64;
            if seen >= wanted {
                return if bin == BINS {
                    self.offset_abs_max
                } else {
                    (bin + 1) as f64 * BIN_MS
                };
            }
        }
        self.offset_abs_max
    }

    pub fn summary(&self) -> StatsSummary {
        let offset = self.offset.summary();
        StatsSummary {
            presented: self.presented,
            dropped: self.dropped,
            late: self.late,
            render_ms: self.render.summary(),
            gpu_ms: self.gpu.summary(),
            offset: OffsetSummary {
                count: self.offset.count,
                mean_ms: offset.mean,
                max_abs_ms: self.offset_abs_max,
                last_ms: self.last_offset,
                p50_abs_ms: self.percentile(0.5),
                p95_abs_ms: self.percentile(0.95),
                p99_abs_ms: self.percentile(0.99),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_timings_and_offsets() {
        let mut stats = PlaybackStats::default();
        assert_eq!(stats.summary().offset.p95_abs_ms, 0.0);
        for i in 0..100 {
            let offset = if i < 90 { 1.1 } else { -12.0 };
            stats.presented(2.0, 4.0 + i as f64 * 0.01, Some(offset), i == 5);
        }
        stats.presented(1.0, f64::NAN, None, false);
        stats.dropped(3);
        let summary = stats.summary();
        assert_eq!(
            (summary.presented, summary.dropped, summary.late),
            (101, 3, 1)
        );
        assert!((summary.render_ms.mean - 201.0 / 101.0).abs() < 1e-9);
        assert_eq!(summary.render_ms.max, 2.0);
        assert!((summary.gpu_ms.max - 4.99).abs() < 1e-9);
        assert_eq!(summary.offset.count, 100);
        assert_eq!(summary.offset.max_abs_ms, 12.0);
        assert_eq!(summary.offset.last_ms, Some(-12.0));
        assert!((summary.offset.mean_ms - (90.0 * 1.1 - 120.0) / 100.0).abs() < 1e-9);
        assert_eq!(summary.offset.p50_abs_ms, 1.25);
        assert_eq!(summary.offset.p95_abs_ms, 12.25);
        // Offsets beyond the histogram report the true maximum.
        stats.presented(1.0, 1.0, Some(250.0), false);
        assert_eq!(stats.summary().offset.max_abs_ms, 250.0);
    }
}

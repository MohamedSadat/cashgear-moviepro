//! Level meters: the sample peak of each short hop, and the RMS of the last
//! 300 ms, per channel. RMS is plain (a full-scale sine reads -3.01 dBFS), as
//! FFmpeg's `astats` reports it. Hold and fall are for the display to apply.
use std::collections::VecDeque;

/// Seconds a reading covers.
pub const HOP_SECONDS: f64 = 0.01;
/// Seconds the RMS is taken over.
pub const RMS_SECONDS: f64 = 0.3;

/// One reading: linear levels per channel (the second is the first for mono).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Level {
    pub peak: [f32; 2],
    pub rms: [f32; 2],
}

impl Level {
    /// The louder of two readings, channel by channel.
    pub fn max(self, other: Level) -> Level {
        Level {
            peak: [
                self.peak[0].max(other.peak[0]),
                self.peak[1].max(other.peak[1]),
            ],
            rms: [self.rms[0].max(other.rms[0]), self.rms[1].max(other.rms[1])],
        }
    }
}

#[derive(Clone, Debug)]
pub struct LevelMeter {
    hop: usize,
    window: usize,
    channels: usize,
    filled: usize,
    peak: [f32; 2],
    squares: [f64; 2],
    hops: VecDeque<[f64; 2]>,
    sum: [f64; 2],
}

impl LevelMeter {
    pub fn new(rate: u32, channels: usize) -> LevelMeter {
        let hop = (rate as f64 * HOP_SECONDS).round().max(1.0) as usize;
        LevelMeter {
            hop,
            window: (RMS_SECONDS / HOP_SECONDS).round() as usize,
            channels: channels.clamp(1, 2),
            filled: 0,
            peak: [0.0; 2],
            squares: [0.0; 2],
            hops: VecDeque::new(),
            sum: [0.0; 2],
        }
    }

    /// Samples a reading covers.
    pub fn hop(&self) -> usize {
        self.hop
    }

    pub fn reset(&mut self) {
        self.filled = 0;
        self.peak = [0.0; 2];
        self.squares = [0.0; 2];
        self.hops.clear();
        self.sum = [0.0; 2];
    }

    /// Adds planar samples. `reading` is called at the end of every hop with the
    /// number of samples of this call that came before it.
    pub fn add(&mut self, channels: &[&[f32]], mut reading: impl FnMut(usize, Level)) {
        let frames = channels.first().map_or(0, |c| c.len());
        let mut at = 0;
        while at < frames {
            let take = (self.hop - self.filled).min(frames - at);
            for channel in 0..self.channels {
                let samples = &channels[channel.min(channels.len() - 1)][at..at + take];
                for &x in samples {
                    self.peak[channel] = self.peak[channel].max(x.abs());
                    self.squares[channel] += x as f64 * x as f64;
                }
            }
            at += take;
            self.filled += take;
            if self.filled == self.hop {
                self.hops.push_back(self.squares);
                for (sum, square) in self.sum.iter_mut().zip(self.squares) {
                    *sum += square;
                }
                if self.hops.len() > self.window {
                    let old = self.hops.pop_front().unwrap();
                    for (sum, square) in self.sum.iter_mut().zip(old) {
                        *sum -= square;
                    }
                }
                let samples = (self.window * self.hop) as f64;
                let rms = |c: usize| (self.sum[c].max(0.0) / samples).sqrt() as f32;
                let mut level = Level {
                    peak: self.peak,
                    rms: [rms(0), rms(1)],
                };
                if self.channels == 1 {
                    level.peak[1] = level.peak[0];
                    level.rms[1] = level.rms[0];
                }
                reading(at, level);
                self.filled = 0;
                self.peak = [0.0; 2];
                self.squares = [0.0; 2];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gain_to_db;
    use crate::test_signal::sine;

    #[test]
    fn a_sine_reads_its_peak_and_plain_rms() {
        let mut meter = LevelMeter::new(48_000, 2);
        assert_eq!(meter.hop(), 480);
        let left = sine(48_000, 997.0, 1.0, 48_000);
        let right = sine(48_000, 997.0, crate::db_to_gain(-20.0) as f64, 48_000);
        let mut readings = Vec::new();
        // Blocks that do not line up with hops.
        for (l, r) in left.chunks(1000).zip(right.chunks(1000)) {
            meter.add(&[l, r], |_, level| readings.push(level));
        }
        assert_eq!(readings.len(), 100);
        let last = readings.last().unwrap();
        assert!(gain_to_db(last.peak[0]).abs() < 0.01);
        assert!((gain_to_db(last.rms[0]) + 3.0103).abs() < 0.01);
        assert!((gain_to_db(last.peak[1]) + 20.0).abs() < 0.01);
        assert!((gain_to_db(last.rms[1]) + 23.0103).abs() < 0.01);
        // The RMS rises over the first 300 ms.
        assert!(readings[14].rms[0] < readings[40].rms[0]);
    }

    #[test]
    fn readings_report_where_their_hop_ended() {
        let mut meter = LevelMeter::new(48_000, 1);
        let mut ends = Vec::new();
        meter.add(&[&vec![0.5; 1000]], |at, _| ends.push(at));
        meter.add(&[&vec![0.5; 1000]], |at, _| ends.push(at));
        assert_eq!(ends, vec![480, 960, 440, 920]);
    }
}

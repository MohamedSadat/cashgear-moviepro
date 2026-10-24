//! Audio mixing for preview and export. Decoded source audio is kept in blocks
//! of one second at the project rate; mixing a stretch of the timeline is a pure
//! function of the clips and those blocks, so preview and export sound the same.
//!
//! Sources at another rate are resampled with `rubato` when a block is stored.
//! Each block is resampled from slightly more audio than it holds, so blocks do
//! not depend on each other or on the order they were decoded in.
use std::collections::HashMap;

use rubato::audioadapter_buffers::direct::SequentialSlice;
use rubato::{Async, FixedAsync, Resampler, SincInterpolationParameters, WindowFunction};

/// Length of the anti-click ramps at clip edges.
pub const FADE_SECONDS: f64 = 0.005;
/// Audio decoded beyond each side of a block, so resampling and codec priming
/// never touch the samples a block keeps.
pub const BLOCK_PAD_SECONDS: f64 = 0.1;
/// Default memory budget for decoded blocks.
pub const DEFAULT_BUDGET_BYTES: usize = 64 * 1024 * 1024;

/// A clip as the mixer sees it. Positions are samples at the project rate.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioClip {
    pub media: String,
    /// First timeline sample and the one after the last.
    pub start: i64,
    pub end: i64,
    /// Source sample heard at `start`.
    pub source_start: i64,
    /// Linear gain.
    pub gain: f32,
    /// False where the neighbouring clip continues the same audio seamlessly.
    pub fade_in: bool,
    pub fade_out: bool,
}

/// Decoded source audio handed to [`Mixer::insert_block`].
pub struct SourceAudio<'a> {
    pub sample_rate: u32,
    pub channels: usize,
    /// Planar samples: every channel's `frames` samples, one channel after another.
    pub data: &'a [f32],
    /// Media time of the first sample, in seconds.
    pub start_seconds: f64,
}

/// One second of one medium's audio at the project rate.
struct Block {
    /// One or two channels.
    channels: Vec<Vec<f32>>,
    last_used: u64,
}

impl Block {
    fn bytes(&self) -> usize {
        self.channels.iter().map(|channel| channel.len() * 4).sum()
    }
}

/// Mixes clips at the project rate and channel count (mono or stereo).
pub struct Mixer {
    rate: u32,
    channels: usize,
    blocks: HashMap<(String, i64), Block>,
    bytes: usize,
    budget: usize,
    clock: u64,
    resamplers: HashMap<(u32, usize), Async<f32>>,
}

impl Mixer {
    pub fn new(rate: u32, channels: usize, budget: usize) -> Mixer {
        assert!(rate > 0 && (1..=2).contains(&channels));
        Mixer {
            rate,
            channels,
            blocks: HashMap::new(),
            bytes: 0,
            budget,
            clock: 0,
            resamplers: HashMap::new(),
        }
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }
    pub fn channels(&self) -> usize {
        self.channels
    }
    /// Samples per block: one second.
    pub fn block_len(&self) -> i64 {
        self.rate as i64
    }
    pub fn cached_bytes(&self) -> usize {
        self.bytes
    }
    pub fn cached_blocks(&self) -> usize {
        self.blocks.len()
    }

    /// The source span `[start, end)` in seconds to decode for `block`.
    pub fn block_span(&self, block: i64) -> (f64, f64) {
        let start = block as f64;
        (
            (start - BLOCK_PAD_SECONDS).max(0.0),
            start + 1.0 + BLOCK_PAD_SECONDS,
        )
    }

    /// The blocks `clips` need for `frames` samples from `start`, in play order,
    /// that are not stored yet.
    pub fn missing(&self, clips: &[AudioClip], start: i64, frames: usize) -> Vec<(String, i64)> {
        let mut missing: Vec<(String, i64)> = Vec::new();
        for (media, block) in self.needed(clips, start, frames) {
            let key = (media, block);
            if !self.blocks.contains_key(&key) && !missing.contains(&key) {
                missing.push(key);
            }
        }
        missing
    }

    fn needed(&self, clips: &[AudioClip], start: i64, frames: usize) -> Vec<(String, i64)> {
        let len = self.block_len();
        let end = start + frames as i64;
        let mut needed = Vec::new();
        for clip in clips {
            let (from, to) = (clip.start.max(start), clip.end.min(end));
            if from >= to {
                continue;
            }
            let first = (clip.source_start + from - clip.start).max(0);
            let last = (clip.source_start + to - clip.start - 1).max(0);
            for block in first.div_euclid(len)..=last.div_euclid(len) {
                needed.push((clip.media.clone(), block));
            }
        }
        needed
    }

    /// True when every block the stretch needs is stored.
    pub fn ready(&self, clips: &[AudioClip], start: i64, frames: usize) -> bool {
        self.needed(clips, start, frames)
            .into_iter()
            .all(|key| self.blocks.contains_key(&key))
    }

    /// Stores block `block` of `media` from decoded audio covering it
    /// (ideally [`Mixer::block_span`]). Missing parts are silent.
    pub fn insert_block(
        &mut self,
        media: &str,
        block: i64,
        source: SourceAudio,
    ) -> Result<(), String> {
        let channels = source.channels;
        if channels == 0 || source.sample_rate == 0 || !source.data.len().is_multiple_of(channels) {
            return Err("Decoded audio has an invalid layout".into());
        }
        let frames = source.data.len() / channels;
        // Start every block's input exactly BLOCK_PAD_SECONDS before the block, a
        // whole number of samples at every common rate. Then each block sits at the
        // same sub-sample phase after resampling, and blocks join without clicks.
        let rate = source.sample_rate as f64;
        let first = (source.start_seconds * rate).round() as i64;
        let wanted = ((block as f64 - BLOCK_PAD_SECONDS) * rate).round() as i64;
        let skip = (wanted - first).clamp(0, frames as i64) as usize;
        let start_seconds = (first + skip as i64) as f64 / rate;
        // Keep mono as mono and the first two channels of anything wider.
        let kept = channels.min(2);
        let planes: Vec<&[f32]> = (0..kept)
            .map(|channel| &source.data[channel * frames + skip..(channel + 1) * frames])
            .collect();
        let frames = frames - skip;
        let resampled;
        let planes: Vec<&[f32]> = if source.sample_rate == self.rate || frames == 0 {
            planes
        } else {
            resampled = self.resample(&planes, source.sample_rate)?;
            resampled.iter().map(Vec::as_slice).collect()
        };
        let len = self.block_len();
        // Where the block starts in the (resampled) input.
        let offset = ((block as f64 - start_seconds) * self.rate as f64).round() as i64;
        let block_channels = planes
            .iter()
            .map(|plane| {
                (0..len)
                    .map(|k| {
                        let index = offset + k;
                        if index >= 0 && (index as usize) < plane.len() {
                            plane[index as usize]
                        } else {
                            0.0
                        }
                    })
                    .collect()
            })
            .collect();
        self.clock += 1;
        let stored = Block {
            channels: block_channels,
            last_used: self.clock,
        };
        self.bytes += stored.bytes();
        if let Some(old) = self.blocks.insert((media.to_string(), block), stored) {
            self.bytes -= old.bytes();
        }
        self.evict();
        Ok(())
    }

    fn resample(&mut self, planes: &[&[f32]], from: u32) -> Result<Vec<Vec<f32>>, String> {
        let channels = planes.len();
        let frames = planes[0].len();
        let ratio = self.rate as f64 / from as f64;
        let key = (from, channels);
        let resampler = match self.resamplers.entry(key) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                // A 128-tap sinc keeps the cost low in WASM with negligible loss.
                let parameters =
                    SincInterpolationParameters::new(128, WindowFunction::BlackmanHarris2);
                let fixed = FixedAsync::Input;
                let resampler =
                    Async::<f32>::new_sinc(ratio, 1.0, &parameters, 1024, channels, fixed)
                        .map_err(|error| format!("Could not set up resampling: {error}"))?;
                entry.insert(resampler)
            }
        };
        resampler.reset();
        let input: Vec<f32> = planes
            .iter()
            .flat_map(|plane| plane.iter().copied())
            .collect();
        let input = SequentialSlice::new(&input, channels, frames)
            .map_err(|error| format!("Invalid audio layout: {error}"))?;
        let capacity = resampler.process_all_needed_output_len(frames);
        let mut output = vec![0.0f32; capacity * channels];
        let (_, produced) = {
            let mut adapter = SequentialSlice::new_mut(&mut output, channels, capacity)
                .map_err(|error| format!("Invalid audio layout: {error}"))?;
            resampler
                .process_all_into_buffer(&input, &mut adapter, frames, None)
                .map_err(|error| format!("Resampling failed: {error}"))?
        };
        Ok((0..channels)
            .map(|channel| output[channel * capacity..channel * capacity + produced].to_vec())
            .collect())
    }

    fn evict(&mut self) {
        while self.bytes > self.budget && self.blocks.len() > 1 {
            let oldest = self
                .blocks
                .iter()
                .min_by_key(|(_, block)| block.last_used)
                .map(|(key, _)| key.clone())
                .unwrap();
            let block = self.blocks.remove(&oldest).unwrap();
            self.bytes -= block.bytes();
        }
    }

    /// Drops every block of `media` (it was removed or changed).
    pub fn forget(&mut self, media: &str) {
        self.blocks.retain(|(id, _), _| id != media);
        self.bytes = self.blocks.values().map(Block::bytes).sum();
    }

    pub fn clear(&mut self) {
        self.blocks.clear();
        self.bytes = 0;
    }

    /// Mixes `frames` samples from timeline sample `start`: interleaved, at the
    /// project's channel count. Audio whose block is not stored is silent.
    pub fn mix(&mut self, clips: &[AudioClip], start: i64, frames: usize) -> Vec<f32> {
        let out_channels = self.channels;
        let mut out = vec![0.0f32; frames * out_channels];
        let len = self.block_len();
        let fade = (self.rate as f64 * FADE_SECONDS).round().max(1.0) as f32;
        let end = start + frames as i64;
        self.clock += 1;
        let clock = self.clock;
        for clip in clips {
            let (from, to) = (clip.start.max(start), clip.end.min(end));
            let mut at = from;
            while at < to {
                let source = clip.source_start + at - clip.start;
                if source < 0 {
                    at += 1;
                    continue;
                }
                let index = source.rem_euclid(len);
                let run_end = to.min(at + (len - index));
                if let Some(block) = self
                    .blocks
                    .get_mut(&(clip.media.clone(), source.div_euclid(len)))
                {
                    block.last_used = clock;
                    for t in at..run_end {
                        let mut gain = clip.gain;
                        if clip.fade_in {
                            gain *= (((t - clip.start) as f32 + 0.5) / fade).min(1.0);
                        }
                        if clip.fade_out {
                            gain *= (((clip.end - t) as f32 - 0.5) / fade).clamp(0.0, 1.0);
                        }
                        let sample = (index + t - at) as usize;
                        let frame = (t - start) as usize * out_channels;
                        match (block.channels.len(), out_channels) {
                            (1, 1) => out[frame] += gain * block.channels[0][sample],
                            (1, _) => {
                                let value = gain * block.channels[0][sample];
                                out[frame] += value;
                                out[frame + 1] += value;
                            }
                            (_, 1) => {
                                out[frame] += gain
                                    * 0.5
                                    * (block.channels[0][sample] + block.channels[1][sample]);
                            }
                            _ => {
                                out[frame] += gain * block.channels[0][sample];
                                out[frame + 1] += gain * block.channels[1][sample];
                            }
                        }
                    }
                }
                at = run_end;
            }
        }
        out
    }
}

/// Decibels to linear gain.
pub fn db_to_gain(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 48_000;

    fn clip(media: &str, start: i64, end: i64, source_start: i64) -> AudioClip {
        AudioClip {
            media: media.into(),
            start,
            end,
            source_start,
            gain: 1.0,
            fade_in: false,
            fade_out: false,
        }
    }

    /// Stereo audio whose left channel is the media time in seconds and right its negative.
    fn ramp(mixer: &mut Mixer, media: &str, block: i64, rate: u32) {
        let (start, end) = mixer.block_span(block);
        let first = (start * rate as f64).round() as i64;
        let frames = ((end - start) * rate as f64).round() as usize;
        let left: Vec<f32> = (0..frames)
            .map(|i| ((first + i as i64) as f64 / rate as f64) as f32)
            .collect();
        let right: Vec<f32> = left.iter().map(|value| -value).collect();
        let data = [left, right].concat();
        mixer
            .insert_block(
                media,
                block,
                SourceAudio {
                    sample_rate: rate,
                    channels: 2,
                    data: &data,
                    start_seconds: first as f64 / rate as f64,
                },
            )
            .unwrap();
    }

    #[test]
    fn blocks_hold_one_second_at_the_project_rate() {
        let mut mixer = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
        assert_eq!(mixer.block_span(0), (0.0, 1.1));
        assert_eq!(mixer.block_span(3), (2.9, 4.1));
        ramp(&mut mixer, "a", 2, RATE);
        let out = mixer.mix(&[clip("a", 0, 10, 2 * 48_000)], 0, 10);
        for frame in 0..10 {
            let expected = (2.0 + frame as f64 / 48_000.0) as f32;
            assert_eq!(out[frame * 2], expected);
            assert_eq!(out[frame * 2 + 1], -expected);
        }
        assert_eq!(mixer.cached_blocks(), 1);
        assert_eq!(mixer.cached_bytes(), 2 * 48_000 * 4);
    }

    #[test]
    fn missing_blocks_are_listed_in_play_order_and_play_silent() {
        let mut mixer = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
        // A clip whose source starts half a second into block 1, heard from timeline 0.
        let clips = [clip("a", 0, 96_000, 72_000)];
        assert_eq!(
            mixer.missing(&clips, 0, 96_000),
            vec![
                ("a".to_string(), 1),
                ("a".to_string(), 2),
                ("a".to_string(), 3)
            ]
        );
        assert!(!mixer.ready(&clips, 0, 100));
        ramp(&mut mixer, "a", 1, RATE);
        assert!(mixer.ready(&clips, 0, 100));
        assert_eq!(mixer.missing(&clips, 0, 24_000), vec![]);
        // Block 2 is missing: silence from timeline sample 24,000.
        let out = mixer.mix(&clips, 23_999, 2);
        assert!((out[0] - 1.999_98).abs() < 1e-4);
        assert_eq!(out[2], 0.0);
    }

    #[test]
    fn clips_mix_with_gain_and_mute_outside_their_range() {
        let mut mixer = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
        ramp(&mut mixer, "a", 0, RATE);
        ramp(&mut mixer, "b", 0, RATE);
        let mut quiet = clip("b", 5, 10, 0);
        quiet.gain = db_to_gain(-6.0);
        let out = mixer.mix(&[clip("a", 0, 10, 1000), quiet], 0, 10);
        let a = |i: i64| ((1000 + i) as f64 / 48_000.0) as f32;
        assert_eq!(out[0], a(0));
        let b = |i: i64| (i as f64 / 48_000.0) as f32 * db_to_gain(-6.0);
        assert!((out[7 * 2] - (a(7) + b(2))).abs() < 1e-7);
        assert!((db_to_gain(-6.0) - 0.501_187).abs() < 1e-6);
    }

    #[test]
    fn clip_edges_ramp_over_five_milliseconds_except_at_seamless_cuts() {
        let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
        let data = vec![1.0f32; 48_000 + 9600];
        mixer
            .insert_block(
                "dc",
                0,
                SourceAudio {
                    sample_rate: RATE,
                    channels: 1,
                    data: &data,
                    start_seconds: 0.0,
                },
            )
            .unwrap();
        let mut faded = clip("dc", 0, 2000, 0);
        faded.fade_in = true;
        faded.fade_out = true;
        let out = mixer.mix(&[faded], 0, 2000);
        assert!(out[0] > 0.0 && out[0] < 0.01);
        assert!((out[120] - 120.5 / 240.0).abs() < 1e-6);
        assert_eq!(out[240], 1.0);
        assert_eq!(out[1000], 1.0);
        assert!(out[1999] < 0.01);
        // A split clip continues seamlessly: no dip at the cut.
        let mut left = clip("dc", 0, 1000, 0);
        left.fade_in = true;
        let mut right = clip("dc", 1000, 2000, 1000);
        right.fade_out = true;
        let out = mixer.mix(&[left, right], 990, 20);
        assert!(out.iter().all(|&value| value == 1.0), "{out:?}");
    }

    #[test]
    fn channel_mapping() {
        let mut stereo_out = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
        let mono = vec![0.25f32; 1000];
        stereo_out
            .insert_block(
                "m",
                0,
                SourceAudio {
                    sample_rate: RATE,
                    channels: 1,
                    data: &mono,
                    start_seconds: 0.0,
                },
            )
            .unwrap();
        assert_eq!(
            stereo_out.mix(&[clip("m", 0, 1, 0)], 0, 1),
            vec![0.25, 0.25]
        );
        let mut mono_out = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
        // Four channels: only the first two are kept, then averaged for mono.
        let quad: Vec<f32> = [0.2f32, 0.4, 9.0, 9.0]
            .iter()
            .flat_map(|&value| std::iter::repeat_n(value, 10))
            .collect();
        mono_out
            .insert_block(
                "q",
                0,
                SourceAudio {
                    sample_rate: RATE,
                    channels: 4,
                    data: &quad,
                    start_seconds: 0.0,
                },
            )
            .unwrap();
        let out = mono_out.mix(&[clip("q", 0, 1, 0)], 0, 1);
        assert!((out[0] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn other_rates_are_resampled_in_time_and_in_tune() {
        let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
        let source_rate = 44_100;
        let tone = |t: f64| (2.0 * std::f64::consts::PI * 440.0 * t).sin() as f32;
        for block in [0, 1] {
            let (start, end) = mixer.block_span(block);
            let first = (start * source_rate as f64).round() as i64;
            let frames = ((end - start) * source_rate as f64).round() as i64;
            let data: Vec<f32> = (first..first + frames)
                .map(|i| tone(i as f64 / source_rate as f64))
                .collect();
            mixer
                .insert_block(
                    "t",
                    block,
                    SourceAudio {
                        sample_rate: source_rate,
                        channels: 1,
                        data: &data,
                        start_seconds: first as f64 / source_rate as f64,
                    },
                )
                .unwrap();
        }
        // Across the block boundary the 48 kHz output is the ideal tone, give or
        // take a constant offset under half a sample (the resampler's delay is not
        // a whole number of samples).
        let out = mixer.mix(&[clip("t", 0, 96_000, 0)], 47_000, 2000);
        let worst_at = |shift: f64| {
            out.iter()
                .enumerate()
                .map(|(i, &value)| (value - tone((47_000.0 + i as f64 + shift) / 48_000.0)).abs())
                .fold(0.0f32, f32::max)
        };
        let best = (-10..=10)
            .map(|step| worst_at(step as f64 * 0.05))
            .fold(f32::MAX, f32::min);
        assert!(best < 1e-3, "worst error {best}");
    }

    #[test]
    fn blocks_land_on_the_same_phase_whatever_packet_decoding_started_at() {
        let tone = |t: f64| (2.0 * std::f64::consts::PI * 440.0 * t).sin() as f32;
        let source_rate = 44_100;
        let block_from = |first: i64| {
            let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
            let data: Vec<f32> = (first..first + 60_000)
                .map(|i| tone(i as f64 / source_rate as f64))
                .collect();
            mixer
                .insert_block(
                    "t",
                    1,
                    SourceAudio {
                        sample_rate: source_rate,
                        channels: 1,
                        data: &data,
                        start_seconds: first as f64 / source_rate as f64,
                    },
                )
                .unwrap();
            mixer.mix(&[clip("t", 0, 48_000, 48_000)], 0, 48_000)
        };
        // Decoding started at two different AAC packets before the block.
        assert_eq!(block_from(36_864), block_from(38_912));
    }

    #[test]
    fn the_budget_evicts_the_least_recently_used_blocks() {
        let one_block = 2 * 48_000 * 4;
        let mut mixer = Mixer::new(RATE, 2, one_block * 2);
        ramp(&mut mixer, "a", 0, RATE);
        ramp(&mut mixer, "a", 1, RATE);
        mixer.mix(&[clip("a", 0, 1, 0)], 0, 1);
        ramp(&mut mixer, "a", 2, RATE);
        assert_eq!(mixer.cached_blocks(), 2);
        assert_eq!(
            mixer.missing(&[clip("a", 0, 1, 48_000)], 0, 1),
            vec![("a".to_string(), 1)]
        );
        assert!(mixer.ready(&[clip("a", 0, 1, 0)], 0, 1));
        mixer.forget("a");
        assert_eq!((mixer.cached_blocks(), mixer.cached_bytes()), (0, 0));
    }

    #[test]
    fn invalid_audio_is_refused() {
        let mut mixer = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
        let odd = [0.0f32; 3];
        let source = SourceAudio {
            sample_rate: RATE,
            channels: 2,
            data: &odd,
            start_seconds: 0.0,
        };
        assert!(mixer.insert_block("x", 0, source).is_err());
    }
}

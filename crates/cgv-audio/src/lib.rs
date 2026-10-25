//! Audio mixing for preview and export. Decoded source audio is kept in blocks
//! of one second at the project rate; mixing a stretch of the timeline depends
//! only on the plan, those blocks and the state the effect chains carry from
//! the stretch before, so preview and export sound the same.
//!
//! A plan is a list of audible tracks. Each track is a bus: its clips' sound
//! passes through their fades, noise reduction and effect chains, and the bus
//! is then turned up or down, panned, ducked under dialogue and metered. The
//! buses add up to the master. Effect chains carry their state from one stretch
//! to the next; after a seek they first hear the second before it, so a sound
//! picked up mid-way matches the same sound played from the start.
//!
//! Sources at another rate are resampled with `rubato` when a block is stored.
//! Each block is resampled from slightly more audio than it holds, so blocks do
//! not depend on each other or on the order they were decoded in.
use std::collections::HashMap;

use rubato::audioadapter_buffers::direct::SequentialSlice;
use rubato::{Async, FixedAsync, Resampler, SincInterpolationParameters, WindowFunction};

mod mix;

pub use cgv_dsp::duck::DuckSettings;
pub use cgv_dsp::meter::Level;
pub use cgv_dsp::Settings;
pub use mix::Reading;

/// Length of the anti-click ramps at clip edges without fades.
pub const FADE_SECONDS: f64 = 0.005;
/// Audio decoded beyond each side of a block, so resampling and codec priming
/// never touch the samples a block keeps.
pub const BLOCK_PAD_SECONDS: f64 = 0.1;
/// Default memory budget for decoded blocks.
pub const DEFAULT_BUDGET_BYTES: usize = 64 * 1024 * 1024;
/// Seconds an effect chain hears before the first sample it plays after a seek.
pub const WARMUP_SECONDS: f64 = 1.0;

/// A clip as the mixer sees it. Positions are samples at the project rate.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioClip {
    /// The medium whose blocks it plays.
    pub media: String,
    /// First timeline sample and the one after the last.
    pub start: i64,
    pub end: i64,
    /// Source sample heard at `start`.
    pub source_start: i64,
    /// Linear gain.
    pub gain: f32,
    /// Linear gains at timeline samples, in order, joined by straight lines and
    /// held beyond the ends: animated volume. Empty means `gain` throughout.
    pub envelope: Vec<(i64, f32)>,
    /// Samples of the equal-power fade at each edge (crossfades included).
    /// Without one, an edge gets a 5 ms ramp unless it is seamless.
    pub fade_in: i64,
    pub fade_out: i64,
    /// The neighbouring clip continues the same audio at this edge: no ramp.
    pub seamless_in: bool,
    pub seamless_out: bool,
    /// Blocks of the noise-reduced sound, and how much of it to hear (0 to 1).
    pub denoised: Option<(String, f32)>,
    /// Sound effects, in order.
    pub effects: Vec<Settings>,
    /// Clips with the same key, one after another on a track, run through one
    /// effect chain, so a seamless cut keeps reverb and echo tails.
    pub chain: u64,
}

impl AudioClip {
    /// A clip of `media` with no fades, effects or noise reduction.
    pub fn plain(media: &str, start: i64, end: i64, source_start: i64) -> AudioClip {
        AudioClip {
            media: media.into(),
            start,
            end,
            source_start,
            gain: 1.0,
            envelope: Vec::new(),
            fade_in: 0,
            fade_out: 0,
            seamless_in: false,
            seamless_out: false,
            denoised: None,
            effects: Vec::new(),
            chain: 0,
        }
    }

    /// The media keys whose blocks the clip reads.
    fn sources(&self) -> impl Iterator<Item = &str> {
        let wet = self
            .denoised
            .as_ref()
            .map(|(key, amount)| (key.as_str(), *amount));
        let dry = match wet {
            Some((_, amount)) if amount >= 1.0 => None,
            _ => Some(self.media.as_str()),
        };
        dry.into_iter().chain(wet.map(|(key, _)| key))
    }
}

/// What a track does in the mix.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Role {
    #[default]
    Other,
    /// Music tracks with ducking dip while dialogue tracks have speech.
    Dialogue,
    Music,
}

/// An audible track.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioTrack {
    pub id: u64,
    /// By start time.
    pub clips: Vec<AudioClip>,
    pub gain: f32,
    /// -1 (left) to 1 (right).
    pub pan: f32,
    pub role: Role,
    /// How the track dips under dialogue.
    pub duck: Option<DuckSettings>,
}

impl AudioTrack {
    pub fn new(id: u64, clips: Vec<AudioClip>) -> AudioTrack {
        AudioTrack {
            id,
            clips,
            gain: 1.0,
            pan: 0.0,
            role: Role::Other,
            duck: None,
        }
    }
}

/// What the mixer plays: the audible tracks, bottom first.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioPlan {
    pub tracks: Vec<AudioTrack>,
}

impl AudioPlan {
    /// One track holding `clips`.
    pub fn single(clips: Vec<AudioClip>) -> AudioPlan {
        AudioPlan {
            tracks: vec![AudioTrack::new(0, clips)],
        }
    }
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

/// Mixes plans at the project rate and channel count (mono or stereo).
pub struct Mixer {
    rate: u32,
    channels: usize,
    blocks: HashMap<(String, i64), Block>,
    bytes: usize,
    budget: usize,
    clock: u64,
    resamplers: HashMap<(u32, usize), Async<f32>>,
    state: mix::State,
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
            state: mix::State::default(),
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

    /// The blocks the plan needs for `frames` samples from `start`, in play
    /// order, that are not stored yet.
    pub fn missing(&self, plan: &AudioPlan, start: i64, frames: usize) -> Vec<(String, i64)> {
        let mut missing: Vec<(String, i64)> = Vec::new();
        for key in self.needed(plan, start, frames) {
            if !self.blocks.contains_key(&key) && !missing.contains(&key) {
                missing.push(key);
            }
        }
        missing
    }

    /// Every block mixing the stretch reads: the clips heard in it, the second
    /// before for clips with effects (their warm-up), dialogue around it for
    /// ducking, and the limiter's look-ahead when mastering.
    fn needed(&self, plan: &AudioPlan, start: i64, frames: usize) -> Vec<(String, i64)> {
        let len = self.block_len();
        let end = start + frames as i64 + self.state.lookahead() as i64;
        let warmup = (WARMUP_SECONDS * self.rate as f64) as i64;
        let (before, after) = mix::duck_reach(plan, self.rate);
        let mut needed = Vec::new();
        for track in &plan.tracks {
            for clip in &track.clips {
                let mut from = start;
                let mut to = end;
                if !clip.effects.is_empty() {
                    from -= warmup;
                }
                if track.role == Role::Dialogue {
                    from = from.min(start - before);
                    to = to.max(end + after);
                }
                let (from, to) = (clip.start.max(from), clip.end.min(to));
                if from >= to {
                    continue;
                }
                let first = (clip.source_start + from - clip.start).max(0);
                let last = (clip.source_start + to - clip.start - 1).max(0);
                for source in clip.sources() {
                    for block in first.div_euclid(len)..=last.div_euclid(len) {
                        needed.push((source.to_string(), block));
                    }
                }
            }
        }
        needed
    }

    /// True when every block the stretch needs is stored.
    pub fn ready(&self, plan: &AudioPlan, start: i64, frames: usize) -> bool {
        self.needed(plan, start, frames)
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
        self.state.forget_speech();
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

    /// Drops every block of `media` (it was removed or changed), with its
    /// noise-reduced variants.
    pub fn forget(&mut self, media: &str) {
        let variant = format!("{media}#");
        self.blocks
            .retain(|(id, _), _| id != media && !id.starts_with(&variant));
        self.bytes = self.blocks.values().map(Block::bytes).sum();
        self.state.forget_speech();
    }

    pub fn clear(&mut self) {
        self.blocks.clear();
        self.bytes = 0;
        let metering = self.state.metering.is_some();
        self.state = mix::State::default();
        self.set_metering(metering);
    }

    /// Mixes `frames` samples from timeline sample `start`: interleaved, at the
    /// project's channel count. Audio whose block is not stored is silent.
    pub fn mix(&mut self, plan: &AudioPlan, start: i64, frames: usize) -> Vec<f32> {
        let planar = self.mix_mastered(plan, start, frames);
        let mut out = vec![0.0f32; frames * self.channels];
        for (channel, samples) in planar.iter().enumerate() {
            for (frame, &value) in samples.iter().enumerate() {
                out[frame * self.channels + channel] = value;
            }
        }
        out
    }

    /// Meter every bus and the master while mixing (playback), or stop.
    /// Turning metering on starts the meters afresh.
    pub fn set_metering(&mut self, on: bool) {
        self.state.metering = on.then(|| mix::Metering::new(self.rate, self.channels));
    }

    /// The readings since the last call, oldest first.
    pub fn take_readings(&mut self) -> Vec<Reading> {
        self.state
            .metering
            .as_mut()
            .map(|metering| std::mem::take(&mut metering.readings))
            .unwrap_or_default()
    }

    /// Exports: a fixed gain on the master, then a true-peak limiter with the
    /// given ceiling, its delay made up by mixing ahead. None removes both.
    pub fn set_mastering(&mut self, mastering: Option<(f32, f32)>) {
        self.state.mastering = mastering.map(|(gain_db, ceiling_db)| {
            mix::Mastering::new(gain_db, ceiling_db, self.rate, self.channels)
        });
    }
}

/// Decibels to linear gain.
pub fn db_to_gain(db: f64) -> f32 {
    10f64.powf(db / 20.0) as f32
}

#[cfg(test)]
mod tests;

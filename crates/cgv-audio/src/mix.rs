//! Mixing a plan: clips into buses, effect chains, pan, ducking, meters, the
//! master and, for exports, its gain and limiter.
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap};
use std::f32::consts::FRAC_PI_2;
use std::hash::{Hash, Hasher};

use cgv_dsp::dynamics::{Limiter, LimiterSettings};
use cgv_dsp::loudness::Loudness;
use cgv_dsp::meter::{Level, LevelMeter, HOP_SECONDS};
use cgv_dsp::stretch::{sinc_at, sinc_reach, Grains, Stretcher};
use cgv_dsp::Chain;

use crate::{
    AudioClip, AudioPlan, AudioTrack, Block, Mixer, Role, Timing, FADE_SECONDS, MAX_SOUND_SPEED,
    WARMUP_SECONDS,
};

/// Each timed clip's stretcher, with the mix that last used it.
type Stretchers = HashMap<u64, (Stretcher, u64)>;

type Planar = Vec<Vec<f32>>;

/// One reading of the meters, at the end of a 10 ms hop.
#[derive(Clone, Debug, PartialEq)]
pub struct Reading {
    /// The timeline sample just after the hop.
    pub sample: i64,
    pub master: Level,
    /// LUFS, as of the last 100 ms.
    pub momentary: f64,
    pub short_term: f64,
    /// Since metering started.
    pub integrated: f64,
    /// Each audible track's level, after its volume, pan and ducking.
    pub tracks: Vec<(u64, Level)>,
}

struct ChainState {
    chain: Chain,
    /// The timeline sample the chain expects next.
    next: i64,
    used: u64,
}

pub(crate) struct Metering {
    tracks: HashMap<u64, LevelMeter>,
    master: LevelMeter,
    loudness: Loudness,
    hops: usize,
    values: [f64; 3],
    pub(crate) readings: Vec<Reading>,
}

impl Metering {
    pub(crate) fn new(rate: u32, channels: usize) -> Metering {
        Metering {
            tracks: HashMap::new(),
            master: LevelMeter::new(rate, channels),
            loudness: Loudness::new(rate, channels, false),
            hops: 0,
            values: [cgv_dsp::loudness::SILENT; 3],
            readings: Vec::new(),
        }
    }
}

pub(crate) struct Mastering {
    gain: f32,
    limiter: Limiter,
    next: Option<i64>,
}

impl Mastering {
    pub(crate) fn new(gain_db: f32, ceiling_db: f32, rate: u32, channels: usize) -> Mastering {
        let settings = LimiterSettings {
            ceiling_db,
            release: 0.1,
            true_peak: true,
        };
        Mastering {
            gain: cgv_dsp::db_to_gain(gain_db),
            limiter: Limiter::new(settings, rate, channels),
            next: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct State {
    chains: HashMap<u64, ChainState>,
    stretchers: Stretchers,
    /// RMS of the dialogue tracks per hop, for the plan with this fingerprint.
    speech: BTreeMap<i64, f32>,
    speech_key: u64,
    pub(crate) metering: Option<Metering>,
    pub(crate) mastering: Option<Mastering>,
}

impl State {
    /// Samples mixed ahead of the requested stretch for the limiter.
    pub(crate) fn lookahead(&self) -> usize {
        self.mastering
            .as_ref()
            .map_or(0, |mastering| mastering.limiter.latency())
    }

    pub(crate) fn forget_speech(&mut self) {
        self.speech.clear();
    }
}

fn hop_len(rate: u32) -> i64 {
    (rate as f64 * HOP_SECONDS).round().max(1.0) as i64
}

fn has_dialogue(plan: &AudioPlan) -> bool {
    plan.tracks.iter().any(|track| track.role == Role::Dialogue)
}

/// Samples of dialogue before and after a stretch that ducking reads.
pub(crate) fn duck_reach(plan: &AudioPlan, rate: u32) -> (i64, i64) {
    if !has_dialogue(plan) {
        return (0, 0);
    }
    let hop = hop_len(rate);
    let hop_seconds = hop as f64 / rate as f64;
    plan.tracks
        .iter()
        .filter_map(|track| track.duck.as_ref())
        .map(|duck| duck.reach(hop_seconds))
        .fold((0, 0), |(before, after), (b, a)| {
            (before.max((b + 1) * hop), after.max((a + 2) * hop))
        })
}

/// Constant-power pan that keeps the centre at unity: the far side falls along
/// a sine (-3 dB half way), the near side stays at full level.
pub(crate) fn pan_gains(pan: f32) -> [f32; 2] {
    let angle = (pan.clamp(-1.0, 1.0) as f64 + 1.0) * std::f64::consts::FRAC_PI_4;
    let boost = std::f64::consts::SQRT_2;
    [
        (boost * angle.cos()).min(1.0) as f32,
        (boost * angle.sin()).min(1.0) as f32,
    ]
}

/// The equal-power rise of a fade, `p` from 0 to 1.
fn rise(p: f32) -> f32 {
    (p.clamp(0.0, 1.0) * FRAC_PI_2).sin()
}

/// The clip's gain at timeline sample `t`: its volume (or envelope), fades and
/// the anti-click ramps of edges that are neither faded nor seamless.
fn gain_at(clip: &AudioClip, t: i64, ramp: f32, cursor: &mut usize) -> f32 {
    let mut gain = if clip.envelope.is_empty() {
        clip.gain
    } else {
        envelope_gain(&clip.envelope, t, cursor)
    };
    if clip.fade_in > 0 {
        gain *= rise(((t - clip.start) as f32 + 0.5) / clip.fade_in as f32);
    } else if !clip.seamless_in {
        gain *= (((t - clip.start) as f32 + 0.5) / ramp).min(1.0);
    }
    if clip.fade_out > 0 {
        gain *= rise(((clip.end - t) as f32 - 0.5) / clip.fade_out as f32);
    } else if !clip.seamless_out {
        gain *= (((clip.end - t) as f32 - 0.5) / ramp).clamp(0.0, 1.0);
    }
    gain
}

/// One channel of a medium's stored sound, `out.len()` samples from source
/// sample `start`; silence where no block is stored.
fn read_run(
    blocks: &HashMap<(String, i64), Block>,
    key: &str,
    rate: u32,
    channel: usize,
    start: i64,
    out: &mut [f32],
) {
    let len = rate as i64;
    let mut filled = 0;
    while filled < out.len() {
        let at = start + filled as i64;
        let index = at.rem_euclid(len) as usize;
        let run = (len as usize - index).min(out.len() - filled);
        let stored = (at >= 0)
            .then(|| blocks.get(&(key.to_string(), at.div_euclid(len))))
            .flatten();
        match stored {
            Some(block) => {
                let plane = &block.channels[channel.min(block.channels.len() - 1)];
                out[filled..filled + run].copy_from_slice(&plane[index..index + run]);
            }
            None => out[filled..filled + run].fill(0.0),
        }
        filled += run;
    }
}

/// A timed clip's source as it reads it: dry and noise-reduced sound mixed, and
/// backwards when reversed.
struct ClipReader<'a> {
    blocks: &'a HashMap<(String, i64), Block>,
    rate: u32,
    dry: Option<&'a str>,
    wet: Option<(&'a str, f32)>,
    reverse: bool,
}

impl ClipReader<'_> {
    /// `out.len()` samples of `channel` from (negated, when reversed) position `start`.
    fn read(&self, channel: usize, start: i64, out: &mut [f32]) {
        let n = out.len() as i64;
        let first = if self.reverse {
            -(start + n - 1)
        } else {
            start
        };
        match self.dry {
            Some(key) => read_run(self.blocks, key, self.rate, channel, first, out),
            None => out.fill(0.0),
        }
        if let Some((key, amount)) = self.wet {
            let mut wet = vec![0.0f32; out.len()];
            read_run(self.blocks, key, self.rate, channel, first, &mut wet);
            for (o, w) in out.iter_mut().zip(wet) {
                *o = *o * (1.0 - amount) + w * amount;
            }
        }
        if self.reverse {
            out.reverse();
        }
    }

    /// Mono or stereo, as the source's stored blocks are.
    fn channels(&self, near: i64) -> usize {
        let block = near.max(0).div_euclid(self.rate as i64);
        [self.dry, self.wet.map(|(key, _)| key)]
            .into_iter()
            .flatten()
            .find_map(|key| self.blocks.get(&(key.to_string(), block)))
            .map_or(1, |block| block.channels.len().min(2))
    }
}

/// The clip's sound over `from..to`, time-stretched: windows on the timeline's
/// hop grid, each read where its stretcher puts it.
#[allow(clippy::too_many_arguments)]
fn stretch_into(
    raw: &mut [Vec<f32>],
    reader: &ClipReader,
    stretcher: &mut Stretcher,
    timing: &Timing,
    rate: u32,
    from: i64,
    to: i64,
) {
    let grains = Grains::at(rate);
    let hop = grains.hop as i64;
    let channels = raw.len();
    let nominal = |k: i64| timing.position((k * hop) as f64).round() as i64;
    let mut mono = |start: i64, out: &mut [f32]| {
        reader.read(0, start, out);
        if channels > 1 {
            let mut other = vec![0.0f32; out.len()];
            reader.read(1, start, &mut other);
            for (a, b) in out.iter_mut().zip(other) {
                *a = (*a + b) * 0.5;
            }
        }
    };
    let mut window = vec![0.0f32; grains.window];
    for k in from.div_euclid(hop) - 1..=(to - 1).div_euclid(hop) {
        let start = stretcher.start(grains, k, &nominal, &mut mono);
        let span = timing.position(((k + 1) * hop) as f64) - timing.position((k * hop) as f64);
        if span.abs() / hop as f64 > MAX_SOUND_SPEED {
            continue;
        }
        for (channel, samples) in raw.iter_mut().enumerate() {
            reader.read(channel, start, &mut window);
            for (i, &x) in window.iter().enumerate() {
                let t = k * hop + i as i64;
                if t >= from && t < to {
                    samples[(t - from) as usize] += x * grains.weight(i);
                }
            }
        }
    }
}

/// The clip's sound over `from..to` at varispeed: the source read between its
/// samples, its pitch following the speed.
fn varispeed_into(raw: &mut [Vec<f32>], reader: &ClipReader, timing: &Timing, from: i64, to: i64) {
    let mut ends = [timing.position(from as f64), timing.position(to as f64)];
    for &(at, position) in &timing.map {
        if (from..=to).contains(&at) {
            ends[0] = ends[0].min(position);
            ends[1] = ends[1].max(position);
        }
    }
    let reach = sinc_reach(MAX_SOUND_SPEED);
    let first = ends[0].min(ends[1]).floor() as i64 - reach;
    let count = (ends[0].max(ends[1]).ceil() as i64 + reach - first + 1).max(1) as usize;
    let mut source = vec![0.0f32; count];
    for (channel, samples) in raw.iter_mut().enumerate() {
        reader.read(channel, first, &mut source);
        let get = |i: i64| {
            let at = i - first;
            if at >= 0 && (at as usize) < source.len() {
                source[at as usize]
            } else {
                0.0
            }
        };
        for t in from..to {
            let speed = timing.speed(t as f64);
            if speed <= MAX_SOUND_SPEED {
                samples[(t - from) as usize] = sinc_at(get, timing.position(t as f64), speed);
            }
        }
    }
}

/// Adds a timed clip's sound over timeline samples `from..to` into `out`, at
/// `offset` samples in.
#[allow(clippy::too_many_arguments)]
fn render_timed(
    blocks: &mut HashMap<(String, i64), Block>,
    stretchers: &mut Stretchers,
    clock: u64,
    rate: u32,
    clip: &AudioClip,
    timing: &Timing,
    from: i64,
    to: i64,
    out: &mut [Vec<f32>],
    offset: usize,
) {
    let base = offset as i64 - from;
    let (from, to) = (clip.start.max(from), clip.end.min(to));
    if from >= to {
        return;
    }
    let (wet, amount) = match &clip.denoised {
        Some((key, amount)) => (Some(key.as_str()), amount.clamp(0.0, 1.0)),
        None => (None, 0.0),
    };
    let dry = (amount < 1.0).then_some(clip.media.as_str());
    let len = rate as i64;
    let (low, high) = timing.source_range(from, to, rate);
    for key in [dry, wet].into_iter().flatten() {
        for block in low.max(0).div_euclid(len)..=high.max(0).div_euclid(len) {
            if let Some(stored) = blocks.get_mut(&(key.to_string(), block)) {
                stored.last_used = clock;
            }
        }
    }
    let reader = ClipReader {
        blocks,
        rate,
        dry,
        wet: wet.map(|key| (key, amount)),
        reverse: timing.reverse,
    };
    let channels = reader.channels(low);
    let mut raw = vec![vec![0.0f32; (to - from) as usize]; channels];
    if timing.keep_pitch {
        let entry = stretchers
            .entry(timing.key)
            .or_insert_with(|| (Stretcher::default(), clock));
        entry.1 = clock;
        stretch_into(&mut raw, &reader, &mut entry.0, timing, rate, from, to);
    } else {
        varispeed_into(&mut raw, &reader, timing, from, to);
    }
    let ramp = (rate as f64 * FADE_SECONDS).round().max(1.0) as f32;
    let mut cursor = 0;
    for t in from..to {
        let gain = gain_at(clip, t, ramp, &mut cursor);
        let i = (t - from) as usize;
        let frame = (base + t) as usize;
        match (channels > 1, out.len()) {
            (false, _) => {
                let v = gain * raw[0][i];
                for channel in out.iter_mut() {
                    channel[frame] += v;
                }
            }
            (true, 1) => out[0][frame] += gain * 0.5 * (raw[0][i] + raw[1][i]),
            (true, _) => {
                out[0][frame] += gain * raw[0][i];
                out[1][frame] += gain * raw[1][i];
            }
        }
    }
}

/// Adds clip `clip`'s sound over timeline samples `from..to` into `out`, at
/// `offset` samples in.
#[allow(clippy::too_many_arguments)]
fn render_clip(
    blocks: &mut HashMap<(String, i64), Block>,
    stretchers: &mut Stretchers,
    clock: u64,
    rate: u32,
    clip: &AudioClip,
    from: i64,
    to: i64,
    out: &mut [Vec<f32>],
    offset: usize,
) {
    if let Some(timing) = &clip.timing {
        return render_timed(
            blocks, stretchers, clock, rate, clip, timing, from, to, out, offset,
        );
    }
    // Where timeline sample t lands in `out`.
    let base = offset as i64 - from;
    let (from, to) = (clip.start.max(from), clip.end.min(to));
    if from >= to {
        return;
    }
    let len = rate as i64;
    let ramp = (rate as f64 * FADE_SECONDS).round().max(1.0) as f32;
    let out_channels = out.len();
    let (wet_key, amount) = match &clip.denoised {
        Some((key, amount)) => (Some(key.as_str()), amount.clamp(0.0, 1.0)),
        None => (None, 0.0),
    };
    let mut cursor = 0;
    let mut at = from;
    while at < to {
        let source = clip.source_start + at - clip.start;
        if source < 0 {
            at += 1;
            continue;
        }
        let index = source.rem_euclid(len);
        let run_end = to.min(at + (len - index));
        let block = source.div_euclid(len);
        let dry_key = (amount < 1.0).then_some(clip.media.as_str());
        for key in [dry_key, wet_key].into_iter().flatten() {
            if let Some(stored) = blocks.get_mut(&(key.to_string(), block)) {
                stored.last_used = clock;
            }
        }
        let blocks_now = &*blocks;
        let get = |key: Option<&str>| {
            key.and_then(|key| blocks_now.get(&(key.to_string(), block)))
                .map(|stored| &stored.channels)
        };
        let (dry, wet) = (get(dry_key), get(wet_key));
        let stereo = dry.or(wet).is_some_and(|planes| planes.len() > 1);
        if dry.is_some() || wet.is_some() {
            for t in at..run_end {
                let gain = gain_at(clip, t, ramp, &mut cursor);
                let sample = (index + t - at) as usize;
                let value = |channel: usize| {
                    let pick = |planes: &Planar| planes[channel.min(planes.len() - 1)][sample];
                    let dry = dry.map_or(0.0, pick);
                    match wet {
                        Some(wet) => dry * (1.0 - amount) + pick(wet) * amount,
                        None => dry,
                    }
                };
                let frame = (base + t) as usize;
                match (stereo, out_channels) {
                    (false, _) => {
                        let v = gain * value(0);
                        for channel in out.iter_mut() {
                            channel[frame] += v;
                        }
                    }
                    (true, 1) => out[0][frame] += gain * 0.5 * (value(0) + value(1)),
                    (true, _) => {
                        out[0][frame] += gain * value(0);
                        out[1][frame] += gain * value(1);
                    }
                }
            }
        }
        at = run_end;
    }
}

/// The gain of `envelope` at sample `t`. `cursor` remembers the segment, so a run
/// of rising `t` walks the envelope once.
fn envelope_gain(envelope: &[(i64, f32)], t: i64, cursor: &mut usize) -> f32 {
    while *cursor + 1 < envelope.len() && envelope[*cursor + 1].0 <= t {
        *cursor += 1;
    }
    let (at, gain) = envelope[*cursor];
    match envelope.get(*cursor + 1) {
        Some(&(next, next_gain)) if t > at => {
            gain + (next_gain - gain) * ((t - at) as f32 / (next - at) as f32)
        }
        _ => gain,
    }
}

fn dialogue_key(plan: &AudioPlan) -> u64 {
    let mut hasher = DefaultHasher::new();
    for track in plan.tracks.iter().filter(|t| t.role == Role::Dialogue) {
        track.id.hash(&mut hasher);
        track.gain.to_bits().hash(&mut hasher);
        for clip in &track.clips {
            clip.media.hash(&mut hasher);
            (clip.start, clip.end, clip.source_start).hash(&mut hasher);
            clip.gain.to_bits().hash(&mut hasher);
            for (at, gain) in &clip.envelope {
                (at, gain.to_bits()).hash(&mut hasher);
            }
            (
                clip.fade_in,
                clip.fade_out,
                clip.seamless_in,
                clip.seamless_out,
            )
                .hash(&mut hasher);
            if let Some((key, amount)) = &clip.denoised {
                (key, amount.to_bits()).hash(&mut hasher);
            }
        }
    }
    hasher.finish()
}

impl Mixer {
    pub(crate) fn mix_mastered(&mut self, plan: &AudioPlan, start: i64, frames: usize) -> Planar {
        let Some(mut mastering) = self.state.mastering.take() else {
            return self.mix_planar(plan, start, frames);
        };
        let latency = mastering.limiter.latency();
        if mastering.next != Some(start) {
            mastering.limiter.reset();
            let mut primer = self.mix_planar(plan, start, latency);
            for channel in &mut primer {
                channel.iter_mut().for_each(|x| *x *= mastering.gain);
            }
            mastering.limiter.process(&mut slices(&mut primer));
        }
        let mut out = self.mix_planar(plan, start + latency as i64, frames);
        for channel in &mut out {
            channel.iter_mut().for_each(|x| *x *= mastering.gain);
        }
        mastering.limiter.process(&mut slices(&mut out));
        mastering.next = Some(start + frames as i64);
        self.state.mastering = Some(mastering);
        out
    }

    fn mix_planar(&mut self, plan: &AudioPlan, start: i64, frames: usize) -> Planar {
        self.clock += 1;
        let channels = self.channels;
        let mut master: Planar = vec![vec![0.0; frames]; channels];
        let ducks = self.duck_gains(plan, start, frames);
        // Each track's readings in this block, one for each of the master's below.
        let mut track_hops: Vec<(u64, Vec<Level>)> = Vec::new();
        for track in &plan.tracks {
            let mut bus: Planar = vec![vec![0.0; frames]; channels];
            self.render_track(track, start, frames, &mut bus);
            let pan = if channels == 2 {
                pan_gains(track.pan)
            } else {
                [1.0, 1.0]
            };
            for (channel, samples) in bus.iter_mut().enumerate() {
                let gain = track.gain * pan[channel];
                match ducks.get(&track.id) {
                    Some(duck) => {
                        for (x, d) in samples.iter_mut().zip(duck) {
                            *x *= gain * d;
                        }
                    }
                    None => samples.iter_mut().for_each(|x| *x *= gain),
                }
            }
            if let Some(metering) = self.state.metering.as_mut() {
                let master = &metering.master;
                let meter = metering.tracks.entry(track.id).or_insert_with(|| {
                    // In step with the master's, so every reading has each track's hop.
                    let mut meter = LevelMeter::new(self.rate, channels);
                    meter.align_with(master);
                    meter
                });
                let mut levels = Vec::new();
                meter.add(&views(&bus), |_, level| levels.push(level));
                track_hops.push((track.id, levels));
            }
            for (sum, samples) in master.iter_mut().zip(&bus) {
                for (s, x) in sum.iter_mut().zip(samples) {
                    *s += x;
                }
            }
        }
        if let Some(metering) = self.state.metering.as_mut() {
            metering.loudness.add(&views(&master));
            let mut hops = Vec::new();
            metering
                .master
                .add(&views(&master), |at, level| hops.push((at, level)));
            for (index, (at, level)) in hops.into_iter().enumerate() {
                if metering.hops % 10 == 0 {
                    metering.values = [
                        metering.loudness.momentary(),
                        metering.loudness.short_term(),
                        metering.loudness.integrated(),
                    ];
                }
                metering.hops += 1;
                metering.readings.push(Reading {
                    sample: start + at as i64,
                    master: level,
                    momentary: metering.values[0],
                    short_term: metering.values[1],
                    integrated: metering.values[2],
                    tracks: track_hops
                        .iter()
                        .map(|(id, levels)| (*id, levels.get(index).copied().unwrap_or_default()))
                        .collect(),
                });
            }
            // Meters of tracks no longer in the plan go.
            metering
                .tracks
                .retain(|id, _| plan.tracks.iter().any(|track| track.id == *id));
        }
        let clock = self.clock;
        self.state
            .chains
            .retain(|_, state| clock.saturating_sub(state.used) < 200);
        self.state
            .stretchers
            .retain(|_, (_, used)| clock.saturating_sub(*used) < 200);
        master
    }

    fn render_track(&mut self, track: &AudioTrack, start: i64, frames: usize, bus: &mut Planar) {
        let end = start + frames as i64;
        let mut index = 0;
        while index < track.clips.len() {
            // A run: clips one after another sharing an effect chain.
            let key = track.clips[index].chain;
            let mut last = index;
            while last + 1 < track.clips.len() && track.clips[last + 1].chain == key {
                last += 1;
            }
            let run = &track.clips[index..=last];
            index = last + 1;
            let effects = &run[0].effects;
            if effects.is_empty() {
                for clip in run {
                    render_clip(
                        &mut self.blocks,
                        &mut self.state.stretchers,
                        self.clock,
                        self.rate,
                        clip,
                        start,
                        end,
                        bus,
                        0,
                    );
                }
                continue;
            }
            let run_start = run.iter().map(|c| c.start).min().unwrap_or(0);
            let run_end = run.iter().map(|c| c.end).max().unwrap_or(0);
            let (from, to) = (run_start.max(start), run_end.min(end));
            if from >= to {
                continue;
            }
            let channels = self.channels;
            let rate = self.rate;
            let mut state = self
                .state
                .chains
                .remove(&key)
                .unwrap_or_else(|| ChainState {
                    chain: Chain::new(rate, channels, effects),
                    next: i64::MIN,
                    used: 0,
                });
            state.chain.update(effects);
            if state.next != from {
                state.chain.reset();
                let warm_from = run_start.max(from - (WARMUP_SECONDS * rate as f64) as i64);
                if warm_from < from {
                    let mut warm: Planar = vec![vec![0.0; (from - warm_from) as usize]; channels];
                    for clip in run {
                        render_clip(
                            &mut self.blocks,
                            &mut self.state.stretchers,
                            self.clock,
                            rate,
                            clip,
                            warm_from,
                            from,
                            &mut warm,
                            0,
                        );
                    }
                    state.chain.process(&mut slices(&mut warm));
                }
            }
            let mut sound: Planar = vec![vec![0.0; (to - from) as usize]; channels];
            for clip in run {
                render_clip(
                    &mut self.blocks,
                    &mut self.state.stretchers,
                    self.clock,
                    rate,
                    clip,
                    from,
                    to,
                    &mut sound,
                    0,
                );
            }
            state.chain.process(&mut slices(&mut sound));
            let offset = (from - start) as usize;
            for (out, samples) in bus.iter_mut().zip(&sound) {
                for (o, x) in out[offset..].iter_mut().zip(samples) {
                    *o += x;
                }
            }
            state.next = to;
            state.used = self.clock;
            self.state.chains.insert(key, state);
        }
    }

    /// Per-sample gains of the ducked tracks over the stretch.
    fn duck_gains(
        &mut self,
        plan: &AudioPlan,
        start: i64,
        frames: usize,
    ) -> HashMap<u64, Vec<f32>> {
        let mut gains = HashMap::new();
        if !has_dialogue(plan) || plan.tracks.iter().all(|t| t.duck.is_none()) {
            return gains;
        }
        let hop = hop_len(self.rate);
        let hop_seconds = hop as f64 / self.rate as f64;
        let first = start.div_euclid(hop);
        let last = (start + frames as i64 - 1).div_euclid(hop) + 1;
        let (before, after) = duck_reach(plan, self.rate);
        self.update_speech(plan, first - before / hop - 1, last + after / hop + 1);
        for track in &plan.tracks {
            let Some(duck) = &track.duck else {
                continue;
            };
            let threshold = cgv_dsp::db_to_gain(duck.threshold_db);
            let speech = &self.state.speech;
            let speaking = |j: i64| speech.get(&j).is_some_and(|&level| level > threshold);
            let edges: Vec<f32> = (first..=last)
                .map(|k| duck.gain(duck.depth(k, hop_seconds, speaking)))
                .collect();
            let samples = (start..start + frames as i64)
                .map(|t| {
                    let k = t.div_euclid(hop);
                    let i = (k - first) as usize;
                    let fraction = (t - k * hop) as f32 / hop as f32;
                    edges[i] + (edges[i + 1] - edges[i]) * fraction
                })
                .collect();
            gains.insert(track.id, samples);
        }
        gains
    }

    /// Fills the dialogue level of hops `first..=last` that are not known yet.
    fn update_speech(&mut self, plan: &AudioPlan, first: i64, last: i64) {
        let key = dialogue_key(plan);
        if key != self.state.speech_key {
            self.state.speech.clear();
            self.state.speech_key = key;
        }
        let hop = hop_len(self.rate);
        let mut j = first;
        while j <= last {
            if self.state.speech.contains_key(&j) {
                j += 1;
                continue;
            }
            let mut end = j;
            while end < last && !self.state.speech.contains_key(&(end + 1)) {
                end += 1;
            }
            let (from, to) = (j * hop, (end + 1) * hop);
            let mut sound: Planar = vec![vec![0.0; (to - from) as usize]; self.channels];
            for track in plan.tracks.iter().filter(|t| t.role == Role::Dialogue) {
                let mut part: Planar = vec![vec![0.0; (to - from) as usize]; self.channels];
                for clip in &track.clips {
                    render_clip(
                        &mut self.blocks,
                        &mut self.state.stretchers,
                        self.clock,
                        self.rate,
                        clip,
                        from,
                        to,
                        &mut part,
                        0,
                    );
                }
                for (sum, samples) in sound.iter_mut().zip(&part) {
                    for (s, x) in sum.iter_mut().zip(samples) {
                        *s += x * track.gain;
                    }
                }
            }
            for h in j..=end {
                let at = ((h - j) * hop) as usize;
                let squares: f64 = sound
                    .iter()
                    .map(|channel| {
                        channel[at..at + hop as usize]
                            .iter()
                            .map(|&x| x as f64 * x as f64)
                            .sum::<f64>()
                    })
                    .sum();
                let rms = (squares / (hop as f64 * self.channels as f64)).sqrt() as f32;
                self.state.speech.insert(h, rms);
            }
            j = end + 1;
        }
        // Keep about a minute of hops around the playhead.
        if self.state.speech.len() > 6000 {
            self.state.speech = self.state.speech.split_off(&(first - 3000));
        }
    }
}

fn slices(planar: &mut Planar) -> Vec<&mut [f32]> {
    planar.iter_mut().map(|c| c.as_mut_slice()).collect()
}

fn views(planar: &Planar) -> Vec<&[f32]> {
    planar.iter().map(|c| c.as_slice()).collect()
}

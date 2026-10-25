import type { FontLoader } from '../fonts/loader';
import type { MediaService } from '../media/service';
import type { ManagedFrame } from '../media/frames';
import { copyPlanes } from '../media/planes';
import { StreamDecoders } from '../media/stream-decoders';
import { streamConfig, VideoStream } from '../media/video-stream';
import { Playback, type Engine, type ProjectSession } from '../pkg/cgv_wasm';
import { FLICKS_PER_SECOND } from '../project/types';
import type { AudioPlayer } from './audio-player';
import { drawFrame, drawsGpuFrames, type LayerSource } from './draw';
import type {
  FramePlan,
  LayerPlan,
  PlaybackState,
  PlaybackStatsReport,
  Pixels,
  QualityMode,
} from './types';

/** How long playback waits for decoders and sound before starting anyway. */
const preRollTimeoutMs = 1500;
/** Sound decoded before the clock starts. */
const preRollAudioSeconds = 0.3;
/** Clips starting this soon get their decoder started early. */
const upcomingFlicks = 3 * FLICKS_PER_SECOND;
/** Playback follows the wall clock once the sound device's clock is unreadable this long. */
const audioClockTimeoutMs = 600;
/** Snippet length when scrubbing. */
const scrubSeconds = 0.08;
/** State updates while playing, at most this often. */
const stateIntervalMs = 33;

type Clock =
  /** `reported`: the last tick the sound device's clock could be read. */
  { kind: 'audio'; reported: number } | { kind: 'wall'; startAbsMs: number };

export interface PlaybackDeps {
  engine: Engine;
  /** Gives the engine the fonts its titles need. */
  fonts: FontLoader;
  session(): ProjectSession | null;
  media(): MediaService | undefined;
  audio(): AudioPlayer | null;
  onState(state: PlaybackState): void;
  onError(message: string): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Playback in the engine worker. Every frame goes through one path: plan the
 * frame (Rust), gather a source per layer, compose (Rust, GPU). While playing,
 * sources come from decoders running ahead of the playhead and a frame that is
 * not decoded in time is dropped; while paused or seeking they are awaited. The
 * clock is the sound the listener hears, so the picture follows the audio.
 */
export class PlaybackController {
  private playback = new Playback();
  /** The playhead while paused: the start of a frame. */
  private position = 0;
  private starting: { from: number; rate: number; since: number; drawn: boolean } | null = null;
  private clock: Clock | null = null;
  /** Why the latest playback left the audio clock, if it did. */
  private fallback: string | null = null;
  private streams = new Map<number, { media: string; stream: VideoStream }>();
  private stillSizes = new Map<string, { width: number; height: number }>();
  private stillLoads = new Map<string, Promise<void>>();
  /** The frame the monitor shows (it became visible on the refresh after it was drawn). */
  private onScreen: { frame: number; time: number } | null = null;
  private lastPresented = -1;
  private target = { frame: -1, tick: 0 };
  /** Frames that were due but not decoded yet, since the last frame shown. */
  private undecoded = new Set<number>();
  /** The latest skips while playing, for diagnosis. */
  private drops: PlaybackStatsReport['recentDrops'] = [];
  /** The latest ticks that kept the worker busy for long, for diagnosis. */
  private slowTicks: PlaybackStatsReport['slowTicks'] = [];
  private created = 0;
  /** Playback decoders, warmed up before the clock starts and passed from clip to clip. */
  private decoders = new StreamDecoders();
  private ticks = 0;
  private lastTick = 0;
  /** Milliseconds since the tick before this one. */
  private interval = 0;
  /** The longest recent gap between ticks, decaying slowly (ms). */
  private intervalPeak = 0;
  private vsyncMs = 1000 / 60;
  private dirty = true;
  private rendering = false;
  private renderToken = 0;
  private settled: (() => void)[] = [];
  private lastState = '';
  private lastStateAt = 0;
  /** Diagnostics: draw the Phase 0 test pattern instead of the timeline. */
  pattern = false;
  constructor(private readonly deps: PlaybackDeps) {}

  // ---- Commands ----

  /** Plays from the playhead at `rate` (1 is normal speed). */
  play(rate = 1) {
    const session = this.deps.session();
    if (!session || rate === 0) return;
    let from = this.playing ? this.currentTime() : this.position;
    const last = this.lastFrameTime(session);
    if (rate > 0 && from >= last) from = 0;
    if (rate < 0 && from <= 0) from = last;
    this.halt();
    this.starting = { from, rate, since: performance.now(), drawn: false };
    this.fallback = null;
    this.drops = [];
    this.slowTicks = [];
    this.playback.pause(from);
    this.playback.reset_stats();
    this.publish(true);
  }

  pause() {
    if (!this.playing) return;
    this.stopAt(this.currentTime());
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play(1);
  }

  /** J, K or L. */
  shuttle(key: 'j' | 'k' | 'l') {
    const rate = Playback.shuttle(this.playing ? this.rate : 0, key);
    if (rate === 0) this.pause();
    else this.play(rate);
  }

  /** Moves the playhead to `time` (flicks). `scrub` plays a short snippet of sound. */
  seek(time: number, options: { scrub?: boolean } = {}) {
    const session = this.deps.session();
    if (!session) return;
    const at = session.frame_time(
      session.frame_at(Math.max(0, Math.min(time, this.lastFrameTime(session)))),
    );
    if (this.playing) {
      const rate = this.rate;
      this.halt();
      this.starting = { from: at, rate, since: performance.now(), drawn: false };
      this.playback.pause(at);
      this.publish(true);
      return;
    }
    this.position = at;
    this.invalidate();
    if (options.scrub)
      this.deps.audio()?.snippet(session, this.sampleAt(session, at), scrubSeconds);
  }

  /** Steps `frames` frames from the playhead and pauses there. */
  step(frames: number) {
    const session = this.deps.session();
    if (!session) return;
    const from = this.playing ? this.currentTime() : this.position;
    if (this.playing) this.stopAt(from);
    this.seek(session.frame_time(session.frame_at(from) + frames));
  }

  setQuality(mode: QualityMode) {
    this.playback.set_quality(mode);
    if (!this.playing) this.invalidate();
    this.publish(true);
  }

  /** The project changed: show the playhead's frame again. */
  invalidate() {
    this.dirty = true;
    if (!this.playing) void this.renderPaused();
  }

  /** A different project opened (or none): stop and start over at zero. */
  reset() {
    this.halt();
    this.starting = null;
    this.playback.pause(0);
    this.position = 0;
    this.onScreen = null;
    this.lastPresented = -1;
    this.deps.audio()?.mixer.clear();
    this.decoders.clear();
    this.invalidate();
    this.publish(true);
  }

  /** A medium was removed or now decodes differently. */
  mediaChanged(id: string) {
    for (const [clip, entry] of this.streams)
      if (entry.media === id) {
        entry.stream.close();
        this.streams.delete(clip);
      }
    this.decoders.clear(id);
    this.decoders.clear(id + ':proxy');
    this.deps.audio()?.mixer.forget(id);
    // A still, or every frame of an animated image.
    for (const key of [...this.stillSizes.keys()])
      if (key === id || key.startsWith(id + '#')) {
        this.deps.engine.drop_still(key);
        this.stillSizes.delete(key);
      }
    this.deps.engine.drop_still(id);
    this.stillLoads.delete(id);
    this.invalidate();
  }

  /** Resolves when the playhead's frame has been drawn (no paused render pending). */
  whenSettled(): Promise<void> {
    if (!this.rendering && !this.dirty) return Promise.resolve();
    return new Promise((resolve) => this.settled.push(resolve));
  }

  /** Diagnostics: the playhead frame at `time` as sRGB RGBA bytes, at full quality. */
  async pixels(time: number): Promise<Pixels> {
    this.pause();
    this.seek(time);
    await this.whenSettled();
    return (await this.deps.engine.read_pixels()) as Pixels;
  }

  dispose() {
    this.halt();
    this.decoders.clear();
    this.playback.free();
  }

  // ---- State ----

  get playing() {
    return this.starting !== null || this.playback.playing();
  }

  private get gpuFrames() {
    return drawsGpuFrames(this.deps.engine);
  }

  private get rate() {
    return this.starting?.rate ?? this.playback.rate();
  }

  private currentTime() {
    if (this.starting) return this.starting.from;
    return this.onScreen?.time ?? this.playback.anchor();
  }

  private lastFrameTime(session: ProjectSession) {
    const end = session.duration();
    return end > 0 ? session.frame_time(session.frame_at(end - 1)) : 0;
  }

  private sampleAt(session: ProjectSession, time: number) {
    // Flicks per sample is a whole number at 44.1 and 48 kHz.
    return Math.floor(time / (FLICKS_PER_SECOND / session.sample_rate()));
  }

  state(): PlaybackState {
    const session = this.deps.session();
    const time = this.playing ? this.currentTime() : this.position;
    return {
      playing: this.playing,
      starting: this.starting !== null,
      rate: this.playing ? this.rate : 0,
      time,
      frame: session ? session.frame_at(time) : 0,
      timecode: session ? session.timecode(time) : '00:00:00:00',
      duration: session ? session.duration() : 0,
      durationTimecode: session ? session.timecode(session.duration()) : '00:00:00:00',
      lastFrame: session ? session.frame_at(this.lastFrameTime(session)) : 0,
      lastFrameTime: session ? this.lastFrameTime(session) : 0,
      quality: this.playback.quality_mode() as QualityMode,
      level: this.playback.quality_level(),
      clock: this.clock?.kind ?? null,
    };
  }

  private publish(force = false, now = performance.now()) {
    if (!force && now - this.lastStateAt < stateIntervalMs) return;
    const state = this.state();
    const text = JSON.stringify(state);
    if (text === this.lastState) return;
    this.lastState = text;
    this.lastStateAt = now;
    this.deps.onState(state);
  }

  stats(): PlaybackStatsReport {
    const audio = this.deps.audio();
    return {
      ...JSON.parse(this.playback.stats()),
      audio: audio ? audio.report() : null,
      clock: this.clock?.kind ?? null,
      fallback: this.fallback,
      recentDrops: this.drops,
      slowTicks: this.slowTicks,
      streams: this.streams.size,
      vsyncMs: this.vsyncMs,
      quality: this.playback.quality_mode() as QualityMode,
      level: this.playback.quality_level(),
      compositionFormat: this.deps.engine.composition_format(),
    };
  }

  resetStats() {
    this.playback.reset_stats();
    this.drops = [];
  }

  // ---- The frame loop ----

  /** Runs on every animation frame of the worker. Returns whether a frame was shown. */
  tick(now: number): boolean {
    const engine = this.deps.engine;
    this.interval = this.lastTick > 0 ? now - this.lastTick : 0;
    this.intervalPeak = Math.max(this.interval, this.intervalPeak * 0.99);
    if (this.interval > 2 && this.interval < 100)
      this.vsyncMs += (this.interval - this.vsyncMs) * 0.05;
    this.lastTick = now;
    this.ticks++;
    if (this.pattern) return engine.pattern_frame(now);
    let presented = engine.needs_present() ? engine.present_again() : false;
    const session = this.deps.session();
    if (!session) {
      if (this.dirty) {
        this.dirty = false;
        presented = engine.clear() || presented;
        this.resolveSettled();
      }
      return presented;
    }
    const started = performance.now();
    this.created = 0;
    try {
      if (this.starting) presented = this.startTick(session, now) || presented;
      else if (this.playback.playing()) presented = this.playTick(session, now) || presented;
      else if (this.dirty) void this.renderPaused();
      const busy = performance.now() - started;
      if (busy > 8 && this.playback.playing()) {
        this.slowTicks.push({ ms: busy, created: this.created, at: now });
        if (this.slowTicks.length > 10) this.slowTicks.shift();
      }
    } catch (error) {
      this.halt();
      this.starting = null;
      this.playback.pause(this.position);
      this.deps.onError(`Playback stopped: ${message(error)}`);
    }
    this.publish(false, now);
    return presented;
  }

  /**
   * Pre-roll: wait until the first frames and the first sound are decoded, draw
   * the first frame and let the GPU finish it (first draws can take long), then
   * start the clock. Playback never starts with a stall it could have waited out.
   */
  private startTick(session: ProjectSession, now: number): boolean {
    const starting = this.starting!;
    const { from, rate, since } = starting;
    const planJson = session.plan_frame(from);
    const plan = JSON.parse(planJson) as FramePlan;
    const audio = rate === 1 ? this.deps.audio() : null;
    const withSound = !!audio && audio.usable(now) && audio.sampleRate === session.sample_rate();
    const sample = this.sampleAt(session, from);
    let ready = true;
    if (rate > 0) {
      this.warmDecoders(session, plan);
      this.keepStreams(session, plan, rate);
      ready = this.layersReady(plan);
    }
    if (withSound && !audio.ready(session, sample, preRollAudioSeconds)) ready = false;
    if (this.deps.fonts.prefetch(planJson, plan)) ready = false;
    const waited = now - since;
    if (!ready && waited < preRollTimeoutMs) return false;

    if (rate > 0 && !starting.drawn) {
      starting.drawn = true;
      const sources = this.gatherNow(plan);
      const scale = this.playback.quality_scale();
      const presented = !!sources && this.draw(session, planJson, plan, sources, scale, true);
      if (presented) {
        this.lastPresented = plan.frame;
        this.onScreen = { frame: plan.frame, time: plan.time };
      }
      return presented;
    }
    if (this.deps.engine.gpu_busy() && waited < 2 * preRollTimeoutMs) return false;
    this.playback.play(from, rate);
    if (withSound) {
      audio.start(session, sample);
      this.clock = { kind: 'audio', reported: now };
    } else {
      this.clock = { kind: 'wall', startAbsMs: performance.timeOrigin + now };
    }
    this.starting = null;
    if (rate < 0) this.lastPresented = -1;
    this.publish(true, now);
    return false;
  }

  /** Seconds of playback the clock shows at absolute time `atMs`, or null before it runs. */
  private readClock(atMs: number): number | null {
    const clock = this.clock;
    if (!clock) return null;
    if (clock.kind === 'wall') return (atMs - clock.startAbsMs) / 1000;
    return this.deps.audio()?.heardSeconds(atMs) ?? null;
  }

  /** Continues on the wall clock from the frame on screen (the sound device stopped). */
  private fallBackToWall(now: number, reason: string) {
    this.fallback = reason;
    const from = this.currentTime();
    this.deps.audio()?.stop();
    this.playback.play(from, this.rate);
    this.clock = { kind: 'wall', startAbsMs: performance.timeOrigin + now };
  }

  private playTick(session: ProjectSession, now: number): boolean {
    const rate = this.playback.rate();
    const nowAbs = performance.timeOrigin + now;
    const audio = this.deps.audio();
    if (this.clock?.kind === 'audio') {
      if (this.readClock(nowAbs) !== null) this.clock.reported = now;
      const silent = now - this.clock.reported;
      const unusable = audio ? audio.unusable(now) : 'there is no sound output';
      if (unusable) this.fallBackToWall(now, unusable);
      else if (silent > audioClockTimeoutMs)
        this.fallBackToWall(now, 'the sound device reported no output time');
      // Mix far enough ahead to outlast the slowest recent ticks: a busy machine
      // drops frames, but its sound and clock keep going.
      else audio!.fill(session, (2.5 * this.intervalPeak) / 1000);
    }
    // The frame drawn now is seen on the next refresh: pick it for that moment.
    const seconds = this.readClock(nowAbs + this.vsyncMs);
    if (seconds === null) return false;
    const end = session.duration();
    const last = this.lastFrameTime(session);
    if (this.playback.finished(seconds, end)) {
      this.stopAt(rate > 0 ? last : 0);
      return false;
    }
    const frameDuration = session.frame_duration();
    if (this.clock?.kind === 'audio' && this.onScreen && rate === 1) {
      const heard = this.readClock(nowAbs);
      if (heard !== null && heard >= 0) {
        const heardTime = this.playback.anchor() + heard * FLICKS_PER_SECOND;
        const shown = this.onScreen.time + frameDuration / 2;
        this.playback.record_offset(((shown - heardTime) / FLICKS_PER_SECOND) * 1000);
      }
    }
    const frame = session.frame_at(this.playback.position(seconds, last));
    if (frame !== this.target.frame) this.target = { frame, tick: this.ticks };
    const time = session.frame_time(frame);
    if (rate < 0) {
      // Backwards: decoders only run forwards, so frames are read from key frames.
      if (frame !== this.lastPresented && !this.rendering) void this.renderAwaited(time, frame);
      return false;
    }
    const planJson = session.plan_frame(time);
    const plan = JSON.parse(planJson) as FramePlan;
    this.keepStreams(session, plan, rate);
    if (frame === this.lastPresented) return false;
    // A title's font arriving late shows from the next frame on.
    this.deps.fonts.prefetch(planJson, plan);
    const started = performance.now();
    const sources = this.gatherNow(plan);
    if (!sources) {
      this.undecoded.add(frame);
      return false;
    }
    const scale = this.playback.quality_scale();
    const presented = this.draw(session, planJson, plan, sources, scale, true);
    if (!presented) return false;
    const previous = this.lastPresented;
    const missed = rate === 1 && previous >= 0 ? Math.max(0, frame - previous - 1) : 0;
    // Skipped frames that were never short of a picture: drawing fell behind.
    let undecoded = 0;
    for (const due of this.undecoded) if (due > previous && due < frame) undecoded++;
    this.undecoded.clear();
    const late = this.ticks > this.target.tick;
    const render = performance.now() - started;
    if (missed > 0) {
      this.drops.push({ frame, missed, undecoded, afterMs: this.interval, at: now });
      if (this.drops.length > 20) this.drops.shift();
    }
    const changed = this.playback.record_frame(
      now,
      render,
      this.deps.engine.gpu_ms(),
      missed,
      Math.max(0, missed - undecoded),
      late,
    );
    this.lastPresented = frame;
    this.onScreen = { frame, time };
    if (changed) this.publish(true, now);
    return true;
  }

  private stopAt(time: number) {
    const drawnBelowFull = this.playback.quality_level() > 0;
    this.halt();
    this.starting = null;
    this.playback.pause(time);
    this.position = time;
    // Paused, Auto shows full quality; redraw if playback ran lower or elsewhere.
    if (drawnBelowFull || this.onScreen?.time !== time) this.invalidate();
    this.publish(true);
  }

  /** Stops the clock, the sound and the decoders. */
  private halt() {
    this.clock = null;
    this.deps.audio()?.stop();
    for (const { stream } of this.streams.values()) stream.close();
    this.streams.clear();
  }

  // ---- Sources ----

  private stream(layer: LayerPlan): VideoStream | null {
    const media = this.deps.media();
    let entry = this.streams.get(layer.clip);
    // A hardware decoder that fails is not used for this medium again.
    if (entry?.stream.error && entry.stream.hardware) media?.noHardware(entry.media);
    if (entry && (entry.stream.error || entry.media !== layer.media)) {
      entry.stream.close();
      this.streams.delete(layer.clip);
      entry = undefined;
    }
    if (entry) return entry.stream;
    const source = media?.streamSource(layer.media);
    if (!media || !source) return null;
    const start = Math.max(0, media.frameNumber(layer.media, layer.sourceTime));
    const stream = new VideoStream(source, start, this.decoders, !this.gpuFrames);
    this.created++;
    this.streams.set(layer.clip, { media: layer.media, stream });
    return stream;
  }

  /** Keeps decoders for the frame's clips and the clips about to start; closes the rest. */
  private keepStreams(session: ProjectSession, plan: FramePlan, rate: number) {
    const keep = new Set<number>();
    const upcoming =
      rate > 0
        ? (JSON.parse(session.upcoming_layers(plan.time, upcomingFlicks)) as LayerPlan[])
        : [];
    for (const layer of [...plan.layers, ...upcoming]) {
      if (layer.still) {
        void this.ensureStill(layer.media);
        continue;
      }
      if (this.stream(layer)) keep.add(layer.clip);
    }
    for (const [clip, { stream }] of this.streams) {
      if (keep.has(clip)) void stream.pump(true);
      else {
        stream.close();
        this.streams.delete(clip);
      }
    }
  }

  /**
   * Starts enough decoders for the clips playing and the ones that follow before
   * the clock runs: starting a hardware decoder stalls the GPU process briefly.
   */
  private warmDecoders(session: ProjectSession, plan: FramePlan) {
    const media = this.deps.media();
    if (!media) return;
    const upcoming = JSON.parse(session.upcoming_layers(plan.time, upcomingFlicks)) as LayerPlan[];
    const counts = new Map<string, number>();
    for (const layer of [...plan.layers, ...upcoming])
      if (!layer.still) counts.set(layer.media, (counts.get(layer.media) ?? 0) + 1);
    for (const [id, count] of counts) {
      const source = media.streamSource(id);
      // Playing clips plus as many again to take over at the next cuts.
      const active = plan.layers.filter((layer) => layer.media === id).length;
      if (source) this.decoders.warm(source.key, streamConfig(source), Math.max(count, 2 * active));
    }
  }

  private layersReady(plan: FramePlan) {
    const media = this.deps.media();
    return plan.layers.every((layer) => {
      if (!media?.hasPicture(layer.media)) return true;
      if (layer.still) return this.stillSizes.has(media.stillKey(layer.media, layer.sourceTime));
      const entry = this.streams.get(layer.clip);
      entry?.stream.hurry();
      return !entry || entry.stream.primed(media.frameNumber(layer.media, layer.sourceTime));
    });
  }

  /** Sources available right now, or null when a layer's frame is not decoded yet. */
  private gatherNow(plan: FramePlan): (LayerSource | null)[] | null {
    const media = this.deps.media();
    const sources: (LayerSource | null)[] = [];
    for (const layer of plan.layers) {
      if (!media?.hasPicture(layer.media)) {
        sources.push(null);
        continue;
      }
      if (layer.still) {
        const key = media.stillKey(layer.media, layer.sourceTime);
        const size = this.stillSizes.get(key);
        if (!size) {
          void this.ensureStill(layer.media);
          return null;
        }
        sources.push({ kind: 'still', key, ...size });
        continue;
      }
      const stream = this.stream(layer);
      if (!stream) {
        sources.push(null);
        continue;
      }
      const item = stream.frameFor(media.frameNumber(layer.media, layer.sourceTime));
      if (!item) return null;
      const rotation = media.rotation(layer.media);
      sources.push(
        item.kind === 'gpu'
          ? { kind: 'gpu', frame: item.frame.raw, rotation }
          : { kind: 'planes', planes: item.planes, rotation },
      );
    }
    return sources;
  }

  /**
   * Sources for a frame, waiting for decodes (paused, seeking, backwards). A
   * freshly decoded hardware frame is drawn as it is; `opened` holds the frames
   * to close once the frame is composed.
   */
  private async gatherAwaited(
    plan: FramePlan,
    opened: ManagedFrame[],
  ): Promise<(LayerSource | null)[]> {
    const media = this.deps.media();
    return Promise.all(
      plan.layers.map(async (layer): Promise<LayerSource | null> => {
        if (!media?.hasPicture(layer.media)) return null;
        try {
          if (layer.still) {
            await this.ensureStill(layer.media);
            const key = media.stillKey(layer.media, layer.sourceTime);
            const size = this.stillSizes.get(key);
            return size ? { kind: 'still', key, ...size } : null;
          }
          const number = media.frameNumber(layer.media, layer.sourceTime);
          if (number < 0) return null;
          const { frame, gpu } = await media.readFrame(layer.media, number);
          const rotation = media.rotation(layer.media);
          if (gpu && this.gpuFrames) {
            opened.push(frame);
            return { kind: 'gpu', frame: frame.raw, rotation };
          }
          try {
            return { kind: 'planes', planes: await copyPlanes(frame.raw), rotation };
          } finally {
            frame.close();
          }
        } catch (error) {
          console.warn(`Layer ${layer.clip} could not be drawn: ${message(error)}`);
          return null;
        }
      }),
    );
  }

  /** Uploads the still `id` shows: the image, or every frame of an animated one. */
  private ensureStill(id: string): Promise<void> {
    let load = this.stillLoads.get(id);
    if (!load) {
      const media = this.deps.media();
      const engine = this.deps.engine;
      load = (async () => {
        if (!media) throw new Error('The media library is not configured');
        for (const key of media.stillKeys(id)) {
          const bitmap = await media.stillBitmap(key, engine.max_texture_size());
          try {
            engine.upload_still(key, bitmap);
            this.stillSizes.set(key, { width: bitmap.width, height: bitmap.height });
          } finally {
            bitmap.close();
          }
        }
      })();
      load.catch(() => this.stillLoads.delete(id));
      this.stillLoads.set(id, load);
    }
    return load;
  }

  /** Composes `planJson` with its gathered sources and shows it. */
  private draw(
    session: ProjectSession,
    planJson: string,
    plan: FramePlan,
    sources: (LayerSource | null)[],
    scale: number,
    present: boolean,
  ) {
    return drawFrame(this.deps.engine, session, planJson, plan, sources, scale, present);
  }

  /** Draws the playhead's frame while paused, waiting for its sources. */
  private async renderPaused() {
    if (this.rendering) {
      this.dirty = true;
      return;
    }
    const session = this.deps.session();
    this.dirty = false;
    if (!session) return;
    await this.renderAwaited(this.position, session.frame_at(this.position));
  }

  private async renderAwaited(time: number, frame: number) {
    const session = this.deps.session();
    if (!session || this.rendering) return;
    this.rendering = true;
    const token = ++this.renderToken;
    const reverse = this.playback.playing();
    const opened: ManagedFrame[] = [];
    try {
      const planJson = session.plan_frame(time);
      const plan = JSON.parse(planJson) as FramePlan;
      const [sources] = await Promise.all([
        this.gatherAwaited(plan, opened),
        this.deps.fonts.ensure(planJson, plan),
      ]);
      // A newer request, playback or another project took over meanwhile.
      if (token !== this.renderToken || this.deps.session() !== session) return;
      if (reverse !== this.playback.playing() || this.starting) return;
      const scale = this.playback.quality_scale();
      if (this.draw(session, planJson, plan, sources, scale, true) || !reverse) {
        this.lastPresented = frame;
        this.onScreen = { frame, time };
      }
    } catch (error) {
      this.deps.onError(`Could not draw the frame: ${message(error)}`);
    } finally {
      // Drawing copied them to the GPU: the decoder can have its frames back.
      for (const frame of opened) frame.close();
      this.rendering = false;
      if (this.dirty && !this.playing) void this.renderPaused();
      else this.resolveSettled();
    }
  }

  private resolveSettled() {
    if (this.rendering || this.dirty) return;
    const waiting = this.settled;
    this.settled = [];
    for (const resolve of waiting) resolve();
  }
}

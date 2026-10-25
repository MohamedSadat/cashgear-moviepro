import {
  buffered,
  C,
  flush,
  H,
  heardFrame,
  type ClockMemo,
  ringViews,
  writeFrames,
  type RingViews,
} from '../audio/ring';
import { MeterQueue, parseReadings, type MeterReading } from '../audio/meters';
import type { AudioBlocks } from '../media/audio-blocks';
import { Mixer, type ProjectSession } from '../pkg/cgv_wasm';

/** Seconds of mixed sound kept ahead of the device, at least and at most. */
const minAheadSeconds = 0.25;
const maxAheadSeconds = 1.5;
/** Seconds of source audio decoded ahead of the mix. */
const prefetchSeconds = 3;
/** Frames mixed per call. */
const chunkFrames = 1024;
/** The worklet's clock counts as stalled when it has not moved for this long. */
const stallMs = 400;

export interface AudioReport {
  running: boolean;
  sampleRate: number;
  bufferedMs: number;
  underruns: number;
  outputLatencyMs: number;
  cachedBytes: number;
}

/**
 * The worker's side of sound: mixes the timeline into the ring the audio
 * worklet plays, and reads back which timeline sample the listener hears.
 * A play session starts at a timeline sample and keeps the ring topped up.
 */
export class AudioPlayer {
  readonly ring: RingViews;
  readonly mixer: Mixer;
  private session: { startFrame: number; startSample: number; next: number } | null = null;
  private lastWorkletTime = 0;
  private lastWorkletChange = 0;
  private memo: ClockMemo = {};
  private meters = new MeterQueue();

  constructor(
    buffer: SharedArrayBuffer,
    readonly sampleRate: number,
    readonly channels: number,
    private readonly blocks: AudioBlocks,
  ) {
    this.ring = ringViews(buffer);
    this.mixer = new Mixer(sampleRate, channels);
  }

  /** Sound can drive the clock: the context runs and its worklet keeps moving. */
  usable(now: number) {
    return this.unusable(now) === null;
  }

  /** Why sound cannot drive the clock now, or null when it can. */
  unusable(now: number): string | null {
    const time = this.ring.clock[C.contextTime];
    if (time !== this.lastWorkletTime) {
      this.lastWorkletTime = time;
      this.lastWorkletChange = now;
    }
    if (this.ring.clock[C.running] !== 1) return 'the sound device is not running';
    if (time <= 0) return 'the sound worklet has not started';
    if (now - this.lastWorkletChange >= stallMs) return 'the sound worklet stopped';
    return null;
  }

  /** True when the stretch from `sample` is decoded, so playback can start there. */
  ready(project: ProjectSession, sample: number, seconds: number) {
    const frames = Math.round(seconds * this.sampleRate);
    this.request(project, sample, frames);
    return this.mixer.ready(project, sample, frames);
  }

  private request(project: ProjectSession, sample: number, frames: number) {
    const missing = JSON.parse(this.mixer.missing(project, sample, frames)) as [string, number][];
    if (missing.length) this.blocks.request(this.mixer, missing);
  }

  /** Starts sound at timeline `sample`. Returns the ring frame it plays from. */
  start(project: ProjectSession, sample: number) {
    const startFrame = flush(this.ring);
    this.session = { startFrame, startSample: sample, next: sample };
    this.mixer.set_metering(true);
    this.meters.clear();
    // Sound first: a quantum played before it would count as an underrun.
    this.fill(project);
    Atomics.store(this.ring.header, H.active, 1);
    return startFrame;
  }

  stop() {
    this.session = null;
    Atomics.store(this.ring.header, H.active, 0);
    flush(this.ring);
    this.mixer.set_metering(false);
    this.meters.clear();
  }

  get playing() {
    return this.session !== null;
  }

  /**
   * Tops the ring up with mixed sound, as far as decoded audio allows, to
   * `aheadSeconds` (clamped) ahead of the device. Sound must outlast the longest
   * pause between two fills, or the clock it drives would stall with it.
   */
  fill(project: ProjectSession, aheadSeconds = minAheadSeconds) {
    const session = this.session;
    if (!session) return;
    this.request(project, session.next, Math.round(prefetchSeconds * this.sampleRate));
    const ahead = Math.min(maxAheadSeconds, Math.max(minAheadSeconds, aheadSeconds));
    const target = Math.round(ahead * this.sampleRate);
    let queued = buffered(this.ring);
    while (queued < target) {
      if (!this.mixer.ready(project, session.next, chunkFrames)) break;
      const samples = this.mixer.mix(project, session.next, chunkFrames);
      this.meters.push(parseReadings(this.mixer.take_readings()));
      const written = writeFrames(this.ring, samples, chunkFrames);
      session.next += written;
      queued += written;
      if (written < chunkFrames) break;
    }
  }

  /**
   * Seconds of the session the listener has heard at absolute time `nowMs`
   * (performance.timeOrigin + performance.now()); negative before the first
   * sample reaches the speakers; null while the device reports no timestamp.
   */
  heardSeconds(nowMs: number): number | null {
    const session = this.session;
    if (!session) return null;
    const heard = heardFrame(this.ring, nowMs, this.memo);
    if (heard === null) return null;
    const whole = Math.floor(heard);
    const since = ((whole - session.startFrame) | 0) + (heard - whole);
    return since / this.sampleRate;
  }

  /** The meters for the sound heard at absolute time `nowMs`, while playing. */
  meterAt(nowMs: number): MeterReading | null {
    const session = this.session;
    const heard = this.heardSeconds(nowMs);
    if (!session || heard === null || heard < 0) return null;
    return this.meters.at(session.startSample + heard * this.sampleRate);
  }

  /** Plays `seconds` of the timeline from `sample` once (scrubbing), if decoded. */
  snippet(project: ProjectSession, sample: number, seconds: number) {
    if (this.session) return false;
    const frames = Math.round(seconds * this.sampleRate);
    if (!this.ready(project, sample, seconds)) return false;
    const samples = this.mixer.mix(project, sample, frames);
    // Short ramps keep the snippet from clicking.
    const ramp = Math.min(frames >> 1, Math.round(0.005 * this.sampleRate));
    for (let i = 0; i < ramp; i++) {
      const gain = (i + 0.5) / ramp;
      for (let channel = 0; channel < this.channels; channel++) {
        samples[i * this.channels + channel] *= gain;
        samples[(frames - 1 - i) * this.channels + channel] *= gain;
      }
    }
    flush(this.ring);
    writeFrames(this.ring, samples, frames);
    return true;
  }

  report(): AudioReport {
    return {
      running: this.ring.clock[C.running] === 1,
      sampleRate: this.sampleRate,
      bufferedMs: (buffered(this.ring) / this.sampleRate) * 1000,
      underruns: Atomics.load(this.ring.header, H.underruns),
      outputLatencyMs: this.ring.clock[C.outputLatency] * 1000,
      cachedBytes: this.mixer.cached_bytes(),
    };
  }

  dispose() {
    this.stop();
    this.mixer.free();
  }
}

import type { AudioBlocks } from '../media/audio-blocks';
import { LoudnessMeter, type Mixer, type ProjectSession } from '../pkg/cgv_wasm';
import type { AudioTrackSink } from './encoders';
import { loudnessCeiling, loudnessGain, type LoudnessPlan } from './settings';

/** Samples mixed and encoded at a time. */
const chunkFrames = 4800;
/** Seconds of source sound decoded ahead of the mix. */
const prefetchSeconds = 4;

/** Mixes `total` samples from the start in order, handing each chunk to `use`. */
async function mixThrough(
  session: ProjectSession,
  mixer: Mixer,
  blocks: AudioBlocks,
  from: number,
  until: number,
  wait: boolean,
  use: (samples: Float32Array, frames: number, at: number) => Promise<void> | void,
): Promise<number> {
  const request = (at: number) => {
    const missing = JSON.parse(mixer.missing(session, at, prefetchSeconds * mixer.rate())) as [
      string,
      number,
    ][];
    if (missing.length) blocks.request(mixer, missing);
  };
  let at = from;
  request(at);
  while (at < until) {
    const frames = Math.min(chunkFrames, until - at);
    if (!mixer.ready(session, at, frames)) {
      if (!wait) return at;
      await blocks.idle(30000);
      request(at);
      if (!mixer.ready(session, at, frames))
        throw new Error(`Sound at ${(at / mixer.rate()).toFixed(2)} s did not decode`);
      continue;
    }
    await use(mixer.mix(session, at, frames), frames, at);
    at += frames;
    if (at % (chunkFrames * 10) === 0) request(at);
  }
  return at;
}

/**
 * The export's sound: the timeline mixed offline by the mixer playback uses,
 * a chunk at a time, in order, as far as decoded sound allows. The export calls
 * `advance` after every frame, so sound and picture reach the file together.
 */
export class ExportAudio {
  private next = 0;

  constructor(
    private readonly session: ProjectSession,
    private readonly mixer: Mixer,
    private readonly blocks: AudioBlocks,
    private readonly sink: AudioTrackSink,
    /** Samples in the file. */
    readonly total: number,
  ) {}

  /** Samples mixed and encoded so far. */
  get position() {
    return this.next;
  }

  /**
   * Mixes and encodes whole chunks up to sample `until` (and the rest at the end).
   * Without `wait` it stops where decoded sound runs out; with it, it waits.
   */
  async advance(until: number, wait: boolean) {
    const end = until >= this.total ? this.total : until - (until % chunkFrames);
    if (this.next >= end) return;
    this.next = await mixThrough(
      this.session,
      this.mixer,
      this.blocks,
      this.next,
      end,
      wait,
      (samples, frames, at) => this.sink.encode(samples, frames, at),
    );
  }
}

/** Integrated loudness (LUFS) and true peak (dBTP) of the first `total` samples of the mix. */
export async function measureMix(
  session: ProjectSession,
  mixer: Mixer,
  blocks: AudioBlocks,
  total: number,
  progress: (done: number) => void,
  signal: AbortSignal,
): Promise<{ integrated: number; truePeak: number }> {
  const meter = new LoudnessMeter(mixer.rate(), mixer.channels());
  try {
    await mixThrough(session, mixer, blocks, 0, total, true, (samples, frames, at) => {
      if (signal.aborted) throw new DOMException('The export was cancelled', 'AbortError');
      meter.add(samples);
      progress(at + frames);
    });
    return { integrated: meter.integrated(), truePeak: meter.true_peak_db() };
  } finally {
    meter.free();
  }
}

/**
 * Sets the mixer's mastering so the export lands on `target` LUFS with true
 * peaks under the ceiling. The mix is measured first; when the gain alone would
 * push peaks past the ceiling, the limiter's own effect is measured too and the
 * gain corrected once. Returns what was measured and the gain chosen.
 */
export async function normalizeLoudness(
  session: ProjectSession,
  mixer: Mixer,
  blocks: AudioBlocks,
  total: number,
  target: number,
  progress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<LoudnessPlan> {
  mixer.clear_mastering();
  const first = await measureMix(
    session,
    mixer,
    blocks,
    total,
    (done) => progress((done / total) * 0.5),
    signal,
  );
  let gainDb = loudnessGain(first.integrated, target);
  let passes = 1;
  if (first.truePeak + gainDb > loudnessCeiling) {
    mixer.set_mastering(gainDb, loudnessCeiling);
    const limited = await measureMix(
      session,
      mixer,
      blocks,
      total,
      (done) => progress(0.5 + (done / total) * 0.5),
      signal,
    );
    gainDb += loudnessGain(limited.integrated, target);
    passes = 2;
  }
  progress(1);
  // A fresh limiter for the export itself.
  mixer.set_mastering(gainDb, loudnessCeiling);
  return {
    target,
    measured: first.integrated,
    truePeak: first.truePeak,
    gainDb,
    passes,
  };
}

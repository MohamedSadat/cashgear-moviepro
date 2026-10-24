import type { AudioBlocks } from '../media/audio-blocks';
import type { Mixer, ProjectSession } from '../pkg/cgv_wasm';
import type { AudioTrackSink } from './encoders';

/** Samples mixed and encoded at a time. */
const chunkFrames = 4800;
/** Seconds of source sound decoded ahead of the mix. */
const prefetchSeconds = 4;

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
    this.request();
    while (this.next < end) {
      const frames = Math.min(chunkFrames, end - this.next);
      if (!this.mixer.ready(this.session, this.next, frames)) {
        if (!wait) return;
        await this.blocks.idle(30000);
        this.request();
        if (!this.mixer.ready(this.session, this.next, frames))
          throw new Error(
            `Sound at ${(this.next / this.mixer.rate()).toFixed(2)} s did not decode`,
          );
        continue;
      }
      const samples = this.mixer.mix(this.session, this.next, frames);
      await this.sink.encode(samples, frames, this.next);
      this.next += frames;
    }
  }

  private request() {
    const missing = JSON.parse(
      this.mixer.missing(this.session, this.next, prefetchSeconds * this.mixer.rate()),
    ) as [string, number][];
    if (missing.length) this.blocks.request(this.mixer, missing);
  }
}

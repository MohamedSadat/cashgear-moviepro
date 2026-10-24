import { AudioSampleSink, type InputAudioTrack } from 'mediabunny';
import type { Mixer } from '../pkg/cgv_wasm';

/** Blocks decoded at once, so playback never waits behind a long queue. */
const maxConcurrent = 2;

/**
 * Decodes source audio for the mixer, one block (a second at the project rate)
 * at a time, in the order playback needs them. Media without decodable sound
 * gets silent blocks, so the mixer stops asking.
 */
export class AudioBlocks {
  private sinks = new Map<string, AudioSampleSink>();
  private pending = new Set<string>();
  private queue: [Mixer, string, number][] = [];
  private running = 0;
  private generation = 0;

  constructor(private readonly track: (media: string) => InputAudioTrack | null) {}

  /** Queues the blocks `missing` lists (from `Mixer.missing`), keeping their order. */
  request(mixer: Mixer, missing: [string, number][]) {
    for (const [media, block] of missing) {
      const key = media + ':' + block;
      if (this.pending.has(key)) continue;
      this.pending.add(key);
      this.queue.push([mixer, media, block]);
    }
    this.run();
  }

  /** Resolves once the queue is empty (tests and pre-roll). */
  async idle(timeoutMs = 5000) {
    const until = performance.now() + timeoutMs;
    while ((this.queue.length || this.running) && performance.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5));
  }

  /** Forgets a medium's decoder (removed, relinked or switched to a proxy). */
  forget(media: string) {
    this.sinks.delete(media);
    this.queue = this.queue.filter(([, id]) => id !== media);
    for (const key of [...this.pending]) if (key.startsWith(media + ':')) this.pending.delete(key);
  }

  clear() {
    this.generation++;
    this.sinks.clear();
    this.queue = [];
    this.pending.clear();
  }

  private run() {
    while (this.running < maxConcurrent && this.queue.length) {
      const [mixer, media, block] = this.queue.shift()!;
      const generation = this.generation;
      this.running++;
      void this.decode(mixer, media, block, generation)
        .catch(() => this.silence(mixer, media, block))
        .finally(() => {
          this.running--;
          this.pending.delete(media + ':' + block);
          this.run();
        });
    }
  }

  private silence(mixer: Mixer, media: string, block: number) {
    try {
      mixer.insert_block(media, block, mixer.rate(), 1, block, new Float32Array(0));
    } catch {
      // The mixer was replaced or freed; nothing to fill.
    }
  }

  private async decode(mixer: Mixer, media: string, block: number, generation: number) {
    const track = this.track(media);
    if (!track) return this.silence(mixer, media, block);
    let sink = this.sinks.get(media);
    if (!sink) {
      sink = new AudioSampleSink(track);
      this.sinks.set(media, sink);
    }
    const [start, end] = mixer.block_span(block);
    const chunks: Float32Array[][] = [];
    let first: number | null = null;
    let rate = 0;
    let channels = 0;
    let frames = 0;
    for await (const sample of sink.samples(start, end)) {
      try {
        if (first === null) {
          first = sample.timestamp;
          rate = sample.sampleRate;
          channels = sample.numberOfChannels;
        }
        const planes: Float32Array[] = [];
        for (let plane = 0; plane < channels; plane++) {
          const data = new Float32Array(sample.numberOfFrames);
          sample.copyTo(data, { planeIndex: plane, format: 'f32-planar' });
          planes.push(data);
        }
        chunks.push(planes);
        frames += sample.numberOfFrames;
      } finally {
        sample.close();
      }
    }
    if (generation !== this.generation) return;
    if (first === null) return this.silence(mixer, media, block);
    const data = new Float32Array(frames * channels);
    for (let channel = 0; channel < channels; channel++) {
      let at = channel * frames;
      for (const planes of chunks) {
        data.set(planes[channel], at);
        at += planes[channel].length;
      }
    }
    mixer.insert_block(media, block, rate, channels, first, data);
  }
}

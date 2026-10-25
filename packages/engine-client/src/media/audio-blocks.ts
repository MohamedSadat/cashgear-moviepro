import { AudioSampleSink, type InputAudioTrack } from 'mediabunny';
import { denoise, denoiseLeadIn, isDenoised, sourceOf } from '../audio/denoise';
import type { Mixer } from '../pkg/cgv_wasm';

/** Blocks decoded at once, so playback never waits behind a long queue. */
const maxConcurrent = 2;

/**
 * Decodes source audio for the mixer, one block (a second at the project rate)
 * at a time, in the order playback needs them. Media without decodable sound
 * gets silent blocks, so the mixer stops asking. Blocks of `<media>#nr` are
 * the medium's sound cleaned by the noise reduction module, which hears a
 * second before each block first.
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
    this.queue = this.queue.filter(([, id]) => sourceOf(id) !== media);
    for (const key of [...this.pending])
      if (sourceOf(key.slice(0, key.lastIndexOf(':'))) === media) this.pending.delete(key);
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
    const source = sourceOf(media);
    const cleaned = isDenoised(media);
    const track = this.track(source);
    if (!track) return this.silence(mixer, media, block);
    let sink = this.sinks.get(source);
    if (!sink) {
      sink = new AudioSampleSink(track);
      this.sinks.set(source, sink);
    }
    const [padded, end] = mixer.block_span(block);
    const start = cleaned ? Math.max(0, block - denoiseLeadIn) : padded;
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
    // Cleaned sound starts exactly at `start`, so the denoiser hears the same
    // lead-in whichever packet decoding began at, and blocks come out the same.
    const skip = cleaned ? Math.min(frames, Math.max(0, Math.round((start - first) * rate))) : 0;
    const kept = frames - skip;
    const data = new Float32Array(kept * channels);
    for (let channel = 0; channel < channels; channel++) {
      let at = channel * kept - skip;
      for (const planes of chunks) {
        const plane = planes[channel];
        if (at + plane.length > channel * kept) {
          const from = Math.max(0, channel * kept - at);
          data.set(plane.subarray(from), at + from);
        }
        at += plane.length;
      }
    }
    const begins = first + skip / rate;
    if (!cleaned) return mixer.insert_block(media, block, rate, channels, begins, data);
    try {
      // A copy goes to the worker, so the original is still here should it fail.
      const clean = await denoise(rate, channels, data.slice());
      if (generation !== this.generation) return;
      mixer.insert_block(media, block, clean.rate, channels, begins, clean.data);
    } catch (error) {
      // Without the module the clip plays as recorded rather than silent.
      console.warn('Noise reduction is unavailable:', error);
      mixer.insert_block(media, block, rate, channels, begins, data);
    }
  }
}

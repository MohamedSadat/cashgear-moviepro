// The audio worklet: plays the engine's ring buffer, one render quantum at a
// time, and records which ring frame it played when (the playback clock).
import { processorName, readQuantum, ringViews, type RingViews } from './ring';

// AudioWorkletGlobalScope members; the DOM and worker libraries do not declare them.
declare const currentTime: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  constructor(options?: { processorOptions?: unknown });
}

class RingPlayer extends AudioWorkletProcessor {
  private ring: RingViews;

  constructor(options: { processorOptions: { buffer: SharedArrayBuffer } }) {
    super(options);
    this.ring = ringViews(options.processorOptions.buffer);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0];
    if (output?.length) readQuantum(this.ring, output, currentTime);
    return true;
  }
}

registerProcessor(processorName, RingPlayer);

// The capture worklet: hands the microphone's sound to the page in batches,
// each stamped with the context frame of its first sample, and its peak level
// for the input meter. It runs in the playback context, so its frames and the
// ring player's are on one clock.

// AudioWorkletGlobalScope members; the DOM and worker libraries do not declare them.
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

/** Frames per message: about 85 ms at 48 kHz. */
const batch = 4096;

class Capture extends AudioWorkletProcessor {
  private planes: Float32Array[] = [];
  private filled = 0;
  private first = 0;
  private peak = 0;

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const input = inputs[0];
    for (const output of outputs[0] ?? []) output.fill(0);
    if (!input?.length) return true;
    if (this.planes.length !== input.length) {
      this.planes = input.map(() => new Float32Array(batch));
      this.filled = 0;
    }
    const frames = input[0].length;
    let at = 0;
    while (at < frames) {
      if (this.filled === 0) this.first = currentFrame + at;
      const take = Math.min(frames - at, batch - this.filled);
      input.forEach((channel, index) => {
        const part = channel.subarray(at, at + take);
        this.planes[index].set(part, this.filled);
        for (const value of part) this.peak = Math.max(this.peak, Math.abs(value));
      });
      this.filled += take;
      at += take;
      if (this.filled === batch) {
        const planes = this.planes;
        this.port.postMessage(
          { frame: this.first, planes, peak: this.peak },
          planes.map((plane) => plane.buffer),
        );
        this.planes = input.map(() => new Float32Array(batch));
        this.filled = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('cgv-capture', Capture);

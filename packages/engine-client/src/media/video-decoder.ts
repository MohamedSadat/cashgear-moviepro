import type { EncodedPacket } from 'mediabunny';
import { ManagedFrame } from './frames';

/** How long the decoder may sit on queued chunks without any output before we give up. */
const stallTimeoutMs = 5000;
/** Decoder outputs held at or past the current target. Each one pins a decoder surface. */
const maxHeldOutputs = 5;

/**
 * One WebCodecs VideoDecoder bound to one track. It remembers where in the
 * stream it is, so a reader can keep decoding forward instead of seeking.
 *
 * Decoders have a small, fixed pool of output surfaces, so outputs are never
 * left lying around: frames before `discardBefore` are closed the moment they
 * arrive, and at most a few later ones are held for the next read.
 */
export class VideoDecoderSession {
  private decoder: VideoDecoder;
  private held: ManagedFrame[] = [];
  private wakers: (() => void)[] = [];
  error: Error | null = null;
  /** The last packet fed since the last reset, in decode order. */
  lastFed: EncodedPacket | null = null;
  /** Presentation timestamp (µs) of the newest frame this decoder has output. */
  lastOutputUs = -Infinity;
  /** After a reset or flush, WebCodecs requires the next chunk to be a key frame. */
  needsKey = true;
  /** Outputs older than this (µs) are closed on arrival. */
  discardBefore = -Infinity;
  /** Frames output since the counter was last read (closed or held). */
  outputCount = 0;

  constructor(private readonly config: VideoDecoderConfig) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.outputCount++;
        this.lastOutputUs = Math.max(this.lastOutputUs, frame.timestamp);
        if (frame.timestamp < this.discardBefore || this.held.length >= maxHeldOutputs)
          frame.close();
        else this.held.push(ManagedFrame.wrap(frame));
        this.wake();
      },
      error: (error) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.wake();
      },
    });
    this.decoder.addEventListener('dequeue', () => this.wake());
    this.decoder.configure(config);
  }

  get closed() {
    return this.decoder.state === 'closed';
  }
  get queueSize() {
    return this.decoder.decodeQueueSize;
  }

  feed(packet: EncodedPacket) {
    this.decoder.decode(packet.toEncodedVideoChunk());
    this.lastFed = packet;
    this.needsKey = false;
  }

  /** Moves the discard line forward, closing held frames before it. */
  discardUntil(timestampUs: number) {
    this.discardBefore = timestampUs;
    this.held = this.held.filter((frame) => {
      if (frame.timestamp >= timestampUs) return true;
      frame.close();
      return false;
    });
  }

  /** Removes and returns the held frame with this timestamp, if the decoder has output it. */
  take(timestampUs: number): ManagedFrame | null {
    const index = this.held.findIndex((frame) => frame.timestamp === timestampUs);
    if (index < 0) return null;
    return this.held.splice(index, 1)[0];
  }

  /** Resolves on the next output, dequeue or error. Rejects if the decoder stalls. */
  waitForActivity(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wakers = this.wakers.filter((waker) => waker !== done);
        reject(new Error('The video decoder stopped producing frames.'));
      }, stallTimeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.wakers.push(done);
    });
  }

  /** Emits every queued frame. The next chunk must then be a key frame. */
  async flush() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.decoder.flush(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('The video decoder did not finish flushing.')),
            stallTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this.needsKey = true;
  }

  /** Drops everything queued or held, ready to start again from a key frame. */
  reset() {
    this.discardHeld();
    if (this.decoder.state === 'configured') {
      this.decoder.reset();
      this.decoder.configure(this.config);
    }
    this.lastFed = null;
    this.lastOutputUs = -Infinity;
    this.discardBefore = -Infinity;
    this.needsKey = true;
    this.error = null;
  }

  close() {
    this.discardHeld();
    if (this.decoder.state !== 'closed') this.decoder.close();
    this.wake();
  }

  private discardHeld() {
    for (const frame of this.held) frame.close();
    this.held = [];
  }

  private wake() {
    const wakers = this.wakers;
    this.wakers = [];
    for (const waker of wakers) waker();
  }
}

import type { EncodedPacket, EncodedPacketSink } from 'mediabunny';
import type { DecoderPool } from './decoder-pool';
import type { FrameCache } from './frame-cache';
import type { FrameIndex } from './frame-index';
import { detachFrame, ManagedFrame } from './frames';
import { VideoDecoderSession } from './video-decoder';

/** Chunks queued in the decoder before we wait for it to catch up. */
const maxQueuedChunks = 8;

export interface FrameResult {
  /** The caller's own reference; close it when done. */
  frame: ManagedFrame;
  /** Frames the decoder produced to reach this one (0 when it was already decoded). */
  decoded: number;
  /**
   * The frame is a hardware decoder's output, on the GPU: the browser converts it
   * correctly there. Cached copies are CPU frames, converted from their planes, and
   * so are hardware frames the browser would convert wrongly (see `paddingShows`).
   */
  gpu: boolean;
}

/**
 * Returns the exact frame N of one video track. A seek starts at the key frame
 * at or before frame N and decodes forward, discarding earlier frames; reading
 * forward from the previous position keeps decoding instead of seeking again.
 */
export class VideoReader {
  private queue: Promise<unknown> = Promise.resolve();
  /** Cache copies being read back from the GPU. */
  private copying = new Set<Promise<unknown>>();
  private epoch = 0;

  constructor(
    private readonly key: string,
    readonly sink: EncodedPacketSink,
    readonly index: FrameIndex,
    public config: VideoDecoderConfig,
    private readonly pool: DecoderPool<VideoDecoderSession>,
    private readonly cache: FrameCache<ManagedFrame>,
    /** Told when the hardware decoder failed and reading fell back to any decoder. */
    private readonly onHardwareFailure: () => void = () => {},
    /** The browser draws this track's hardware frames wrongly (see `paddingShows`). */
    private readonly padded = false,
  ) {}

  /** Reads are serialized: one decoder, one position. */
  frame(frameNumber: number): Promise<FrameResult> {
    const result = this.queue.then(() => this.read(frameNumber));
    this.queue = result.catch(() => {});
    return result;
  }

  /** Closes this track's decoder and forgets its cached frames. */
  release() {
    this.epoch++;
    this.pool.release(this.key);
    this.cache.deletePrefix(this.key + ':');
  }

  /** Resolves when no cache copy is still being made. */
  async settle() {
    while (this.copying.size) await Promise.all(this.copying);
  }

  private cacheKey(timestampUs: number) {
    return this.key + ':' + timestampUs;
  }

  private async read(frameNumber: number): Promise<FrameResult> {
    const target = this.index.timestampOf(frameNumber);
    const key = this.cacheKey(target);
    const cached = this.cache.get(key);
    if (cached) return { frame: cached.clone(), decoded: 0, gpu: false };

    const session = this.pool.acquire(this.key, () => new VideoDecoderSession(this.config));
    try {
      const { frame, decoded } = await this.decode(session, frameNumber, target);
      const gpu = this.config.hardwareAcceleration === 'prefer-hardware';
      // The caller gets the decoder's frame at once. The cache keeps a copy in
      // memory the page owns, so the decoder gets its surface back soon after.
      // A padded hardware frame waits for that copy instead: one readback, not two.
      const padded = gpu && this.padded;
      const copy = this.keepCopy(key, frame, padded);
      if (!padded) return { frame, decoded, gpu };
      const planes = await copy;
      if (!planes) return { frame, decoded, gpu };
      frame.close();
      return { frame: planes, decoded, gpu: false };
    } catch (error) {
      // A failed or stalled decoder is in an unknown state: start over next time.
      this.pool.release(this.key);
      // A hardware decoder the browser offered may still fail (a software GPU
      // process, say): read with whatever decoder the browser picks instead.
      if (this.config.hardwareAcceleration === 'prefer-hardware') {
        this.config = { ...this.config, hardwareAcceleration: 'no-preference' };
        this.onHardwareFailure();
        return this.read(frameNumber);
      }
      throw error;
    }
  }

  /** Caches a copy of `frame`; with `wanted`, resolves to a reference of its own. */
  private keepCopy(key: string, frame: ManagedFrame, wanted = false) {
    const epoch = this.epoch;
    const source = frame.clone();
    const job: Promise<ManagedFrame | null> = detachFrame(source.raw)
      .then((copy) => {
        const managed = ManagedFrame.wrap(copy);
        const mine = wanted ? managed.clone() : null;
        if (epoch === this.epoch) this.cache.put(key, managed);
        else managed.close();
        return mine;
      })
      .catch(() => null)
      .finally(() => {
        source.close();
        this.copying.delete(job);
      });
    this.copying.add(job);
    return job;
  }

  /** Returns the decoder-backed target frame; the caller must close it promptly. */
  private async decode(session: VideoDecoderSession, frameNumber: number, target: number) {
    const missing = () =>
      new Error(`Frame ${frameNumber} (${target} µs) is not in the decoded stream`);
    session.outputCount = 0;
    // Already output by the previous read's lookahead?
    session.discardUntil(target);
    let result = session.take(target);
    if (result) return { frame: result, decoded: 0 };

    const keyPacket = await this.sink.getKeyPacket((target + 0.5) / 1e6, {
      verifyKeyPackets: true,
    });
    if (!keyPacket) throw new Error(`No key frame before frame ${frameNumber}`);
    let first: EncodedPacket | null;
    const continuing =
      !session.needsKey &&
      session.lastFed !== null &&
      keyPacket.sequenceNumber <= session.lastFed.sequenceNumber &&
      target > session.lastOutputUs;
    if (continuing) {
      first = await this.sink.getNextPacket(session.lastFed!);
    } else {
      session.reset();
      session.discardUntil(target);
      first = keyPacket;
    }

    // The iterator reads packets ahead while the decoder works.
    const packets = first ? this.sink.packets(first) : null;
    const next = async () => (packets ? ((await packets.next()).value ?? null) : null);
    let packet = await next();
    let flushed = false;
    try {
      while (true) {
        if (session.error) throw session.error;
        result = session.take(target);
        if (result) return { frame: result, decoded: session.outputCount };
        // Outputs arrive in presentation order, so a later frame means the target was skipped.
        if (session.lastOutputUs > target) throw missing();
        if (packet && session.queueSize < maxQueuedChunks) {
          session.feed(packet);
          packet = await next();
          continue;
        }
        if (!packet && !flushed) {
          await session.flush();
          flushed = true;
          continue;
        }
        if (!packet) throw missing();
        await session.waitForActivity();
      }
    } finally {
      await packets?.return();
    }
  }
}

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
}

/**
 * Returns the exact frame N of one video track. A seek starts at the key frame
 * at or before frame N and decodes forward, discarding earlier frames; reading
 * forward from the previous position keeps decoding instead of seeking again.
 */
export class VideoReader {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly key: string,
    private readonly sink: EncodedPacketSink,
    readonly index: FrameIndex,
    private readonly config: VideoDecoderConfig,
    private readonly pool: DecoderPool<VideoDecoderSession>,
    private readonly cache: FrameCache<ManagedFrame>,
  ) {}

  /** Reads are serialized: one decoder, one position. */
  frame(frameNumber: number): Promise<FrameResult> {
    const result = this.queue.then(() => this.read(frameNumber));
    this.queue = result.catch(() => {});
    return result;
  }

  /** Closes this track's decoder and forgets its cached frames. */
  release() {
    this.pool.release(this.key);
    this.cache.deletePrefix(this.key + ':');
  }

  private cacheKey(timestampUs: number) {
    return this.key + ':' + timestampUs;
  }

  private async read(frameNumber: number): Promise<FrameResult> {
    const target = this.index.timestampOf(frameNumber);
    const cached = this.cache.get(this.cacheKey(target));
    if (cached) return { frame: cached.clone(), decoded: 0 };

    const session = this.pool.acquire(this.key, () => new VideoDecoderSession(this.config));
    try {
      const { frame, decoded } = await this.decode(session, frameNumber, target);
      // The cache keeps a copy so the decoder gets its surface back straight away.
      const copy = ManagedFrame.wrap(await detachFrame(frame.raw));
      frame.close();
      this.cache.put(this.cacheKey(target), copy);
      return { frame: copy.clone(), decoded };
    } catch (error) {
      // A failed or stalled decoder is in an unknown state: start over next time.
      this.pool.release(this.key);
      throw error;
    }
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
    let packet: EncodedPacket | null;
    const continuing =
      !session.needsKey &&
      session.lastFed !== null &&
      keyPacket.sequenceNumber <= session.lastFed.sequenceNumber &&
      target > session.lastOutputUs;
    if (continuing) {
      packet = await this.sink.getNextPacket(session.lastFed!);
    } else {
      session.reset();
      session.discardUntil(target);
      packet = keyPacket;
    }

    let flushed = false;
    while (true) {
      if (session.error) throw session.error;
      result = session.take(target);
      if (result) return { frame: result, decoded: session.outputCount };
      // Outputs arrive in presentation order, so a later frame means the target was skipped.
      if (session.lastOutputUs > target) throw missing();
      if (packet && session.queueSize < maxQueuedChunks) {
        session.feed(packet);
        packet = await this.sink.getNextPacket(packet);
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
  }
}

import type { EncodedPacket } from 'mediabunny';
import { copyPlanes, type FramePlanes } from './planes';
import {
  streamConfig,
  type LayerStream,
  type StreamFrame,
  type StreamSource,
} from './video-stream';

/** Decoded frames a reverse stream keeps, in bytes: two stretches of this much. */
const holdBytes = 96 * 1024 * 1024;
const minHold = 8;
const maxHold = 48;
const maxQueuedChunks = 8;
/** How long a decoder may sit on queued chunks without output before the stream fails. */
const stallTimeoutMs = 5000;

/** Frames `first` to `last` of the track, decoded. */
interface Stretch {
  first: number;
  last: number;
  frames: Map<number, FramePlanes>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Decodes one reversed clip's video ahead of the playhead, which runs through
 * the source frames in falling order. Decoders only run forwards, so the stream
 * decodes a stretch from the key frame before the frames it needs (a whole GOP,
 * or only its last frames when a GOP holds more than it keeps) and hands its
 * frames out last first, while the stretch before it decodes. A long GOP is
 * decoded again from its key frame for each stretch, which costs decoding but
 * never holds more than a few seconds of frames. Frames are kept as planes: a
 * decoder can hold only a few of its own outputs.
 */
export class ReverseStream implements LayerStream {
  /** Decoded stretches, highest first. */
  private stretches: Stretch[] = [];
  /** The frame the clip asked for last; frames above the one after it are let go. */
  private wanted: number;
  private decoding = false;
  private epoch = 0;
  private decoder: VideoDecoder | null = null;
  private readonly hold: number;
  private waiters: (() => void)[] = [];
  error: Error | null = null;
  closed = false;

  constructor(
    private readonly source: StreamSource,
    start: number,
  ) {
    this.wanted = start;
    const { codedWidth = 1920, codedHeight = 1080 } = source.config;
    const frameBytes = Math.max(1, codedWidth * codedHeight * 1.5);
    this.hold = Math.max(minHold, Math.min(maxHold, Math.floor(holdBytes / frameBytes)));
    void this.pump();
  }

  get hardware() {
    return this.source.hardware;
  }

  private find(frame: number): FramePlanes | null {
    for (const stretch of this.stretches) {
      const planes = stretch.frames.get(frame);
      if (planes) return planes;
    }
    return null;
  }

  has(frame: number) {
    return this.find(frame) !== null;
  }

  primed(frame: number) {
    return this.has(frame) && (frame === 0 || this.has(frame - 1));
  }

  peek(frame: number): StreamFrame | null {
    const planes = this.find(frame);
    return planes ? { kind: 'planes', planes } : null;
  }

  async peekWhenReady(frame: number, timeoutMs = 15000): Promise<StreamFrame | null> {
    try {
      return await this.frameWhenReady(frame, timeoutMs, false);
    } catch {
      return null;
    }
  }

  frameFor(frame: number): StreamFrame | null {
    if (this.closed) return null;
    const top = this.stretches[0]?.last ?? this.wanted;
    const bottom = this.stretches.at(-1)?.first ?? this.wanted;
    // Forwards, or far below what is decoding: start again there.
    if (frame > Math.max(top, this.wanted) || frame < bottom - 2 * this.hold) this.restart(frame);
    this.wanted = frame;
    // Frames the playhead has passed are let go, all but the one after it, which
    // a blended frame may still mix in.
    this.stretches = this.stretches.filter((stretch) => stretch.first <= frame + 1);
    for (const stretch of this.stretches)
      for (const number of stretch.frames.keys())
        if (number > frame + 1) stretch.frames.delete(number);
    void this.pump();
    return this.peek(frame);
  }

  async frameWhenReady(frame: number, timeoutMs = 15000, move = true): Promise<StreamFrame> {
    const until = performance.now() + timeoutMs;
    while (true) {
      const item = move ? this.frameFor(frame) : this.peek(frame);
      if (item) return item;
      if (this.error) throw this.error;
      if (this.closed) throw new Error('The decoder was closed');
      if (performance.now() > until) throw new Error(`Frame ${frame} was not decoded in time`);
      void this.pump();
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  hurry() {
    void this.pump();
  }

  /** Decodes the next stretch down, until two are ready. */
  async pump(): Promise<void> {
    if (this.decoding || this.closed || this.error || this.stretches.length >= 2) return;
    const lowest = this.stretches.at(-1);
    const last = lowest ? lowest.first - 1 : this.wanted;
    if (last < 0) return;
    this.decoding = true;
    const epoch = this.epoch;
    try {
      const stretch = await this.decodeStretch(last, epoch);
      if (stretch && epoch === this.epoch && !this.closed) this.stretches.push(stretch);
    } catch (error) {
      if (epoch === this.epoch && !this.closed)
        this.error = error instanceof Error ? error : new Error(message(error));
    } finally {
      this.decoding = false;
      this.wake();
    }
    if (epoch === this.epoch) void this.pump();
  }

  private restart(frame: number) {
    this.epoch++;
    this.stretches = [];
    this.wanted = frame;
    this.decoding = false;
    this.decoder?.close();
    this.decoder = null;
  }

  private wake() {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  /**
   * Frames up to `last`, decoded from the key frame before it: at most `hold`
   * of them, the last ones. Null when the stream moved on meanwhile.
   */
  private async decodeStretch(last: number, epoch: number): Promise<Stretch | null> {
    const { index, sink } = this.source;
    const key = await sink.getKeyPacket((index.timestampOf(last) + 0.5) / 1e6, {
      verifyKeyPackets: true,
    });
    if (epoch !== this.epoch) return null;
    if (!key) throw new Error(`No key frame before frame ${last}`);
    const keyFrame = index.frameAt(key.microsecondTimestamp + 1);
    const first = Math.max(keyFrame, last - this.hold + 1);
    const frames = new Map<number, FramePlanes>();
    const copies: Promise<void>[] = [];
    let newest = -1;
    let failure = null as Error | null;
    let wake: () => void = () => {};
    const decoder = new VideoDecoder({
      output: (frame) => {
        const number = index.frameAt(frame.timestamp);
        newest = Math.max(newest, number);
        if (number < first || number > last || frames.has(number) || epoch !== this.epoch) {
          frame.close();
        } else {
          copies.push(
            copyPlanes(frame)
              .then((planes) => void frames.set(number, planes))
              .finally(() => frame.close()),
          );
        }
        wake();
      },
      error: (error) => {
        failure = error instanceof Error ? error : new Error(String(error));
        wake();
      },
    });
    this.decoder?.close();
    this.decoder = decoder;
    decoder.addEventListener('dequeue', () => wake());
    try {
      decoder.configure(streamConfig(this.source));
      const activity = () =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('The video decoder stopped producing frames.')),
            stallTimeoutMs,
          );
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      const packets = sink.packets(key);
      let packet: EncodedPacket | null = (await packets.next()).value ?? null;
      try {
        // Outputs arrive in display order: once `last` is out, the stretch is done.
        while (newest < last) {
          if (failure) throw failure;
          if (epoch !== this.epoch || this.closed) return null;
          if (packet && decoder.decodeQueueSize < maxQueuedChunks) {
            decoder.decode(packet.toEncodedVideoChunk());
            packet = (await packets.next()).value ?? null;
            continue;
          }
          if (!packet) {
            await decoder.flush();
            break;
          }
          await activity();
        }
      } finally {
        await packets.return(undefined);
      }
      await Promise.all(copies);
    } finally {
      if (decoder.state !== 'closed') decoder.close();
      if (this.decoder === decoder) this.decoder = null;
    }
    if (epoch !== this.epoch) return null;
    if (failure) throw failure;
    return { first, last, frames };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.epoch++;
    this.stretches = [];
    this.decoder?.close();
    this.decoder = null;
    this.wake();
  }
}

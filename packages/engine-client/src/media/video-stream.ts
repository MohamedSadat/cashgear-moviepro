import type { EncodedPacket, EncodedPacketSink } from 'mediabunny';
import type { FrameIndex } from './frame-index';
import { ManagedFrame } from './frames';
import { copyPlanes, type FramePlanes } from './planes';
import type { PooledDecoder, StreamDecoders } from './stream-decoders';

/** What a playback stream decodes from: one video track. */
export interface StreamSource {
  /** Identifies the decoder setup (one medium): pooled decoders are shared by key. */
  key: string;
  sink: EncodedPacketSink;
  index: FrameIndex;
  config: VideoDecoderConfig;
  /**
   * A hardware decoder is available. Its outputs are GPU-backed, so the browser
   * converts them correctly on the GPU and they are drawn without a copy. Software
   * outputs are CPU-backed and are copied to planes for the compositor instead.
   */
  hardware: boolean;
  /** The browser draws its hardware frames wrongly: they are copied too (see `paddingShows`). */
  padded: boolean;
}

/** A decoded frame, ready to draw. */
export type StreamFrame =
  { kind: 'gpu'; frame: ManagedFrame } | { kind: 'planes'; planes: FramePlanes };

/**
 * What playback and export read a clip's frames through: a stream that decodes
 * ahead of the playhead, forwards ([`VideoStream`]) or backwards
 * ([`ReverseStream`](./reverse-stream.ts)).
 */
export interface LayerStream {
  error: Error | null;
  closed: boolean;
  /** It decodes in hardware. */
  readonly hardware: boolean;
  /** Frame `frame`, or null if not decoded yet; it stays valid until the next call. */
  frameFor(frame: number): StreamFrame | null;
  /** Export: frame `frame`, waiting for the decoder. */
  frameWhenReady(frame: number, timeoutMs?: number): Promise<StreamFrame>;
  /**
   * Frame `frame` if it is decoded, without moving the stream: the second frame
   * a blended slow-motion frame mixes in. Valid as long as `frameFor`'s result.
   */
  peek(frame: number): StreamFrame | null;
  /** Export: `peek`, waiting for the decoder. */
  peekWhenReady(frame: number, timeoutMs?: number): Promise<StreamFrame | null>;
  has(frame: number): boolean;
  /** `frame` and the one shown after it are decoded: safe to start playing. */
  primed(frame: number): boolean;
  hurry(): void;
  pump(tick?: boolean): Promise<void> | void;
  close(): void;
}

/** Frames held ahead. GPU frames pin decoder surfaces, so hold few. */
const holdGpu = 4;
const holdCpu = 6;
const maxQueuedChunks = 6;
/**
 * Packets fed per playback tick to a clip that has not started yet. Hardware
 * decoding shares the browser's GPU process with drawing, so a burst of decodes
 * for upcoming clips would delay the frames on screen.
 */
const upcomingPackets = 1;
/**
 * The least time between two end-of-track flushes, across all streams. A flush
 * makes a hardware decoder hand over its last frames at once, which keeps the
 * GPU process busy; tracks that end together would add those stalls up.
 */
const flushGapMs = 40;
let nextFlushAt = 0;
/** Frames behind the decoder after which a stream jumps ahead to a later key frame. */
const restartBehind = 60;

interface Ready {
  frame: number;
  item: StreamFrame;
}

function release(item: StreamFrame) {
  if (item.kind === 'gpu') item.frame.close();
}

/** The decoder configuration of a source: hardware when the browser has it. */
export function streamConfig(source: StreamSource): VideoDecoderConfig {
  return {
    ...source.config,
    hardwareAcceleration: source.hardware ? 'prefer-hardware' : 'prefer-software',
    // Frames come out as soon as they are decoded, not several packets later, so
    // the end of a clip needs no flush (a flush stalls the GPU process briefly).
    optimizeForLatency: true,
  };
}

/**
 * Decodes one clip's video ahead of the playhead during playback, on a decoder
 * borrowed from the pool. Frames come out in display order and wait until the
 * clip needs them; frames the playhead has passed are closed. The stream never
 * blocks: `frameFor` returns null when a frame is not decoded yet, and playback
 * drops it.
 */
export class VideoStream implements LayerStream {
  private pooled: PooledDecoder;
  private ready: Ready[] = [];
  /** The frame handed out last; it stays valid until the next `frameFor`. */
  private current: Ready | null = null;
  private copying = 0;
  private next: EncodedPacket | null = null;
  private feeding = false;
  /** Packets were fed since the last seek, so running out of them is the track's end. */
  private fed = false;
  private flushed = false;
  /** The end-of-track flush has finished: nothing is left in the decoder. */
  private drained = false;
  /** Set once the clip asks for frames; until then it decodes at a gentle pace. */
  private playing = false;
  private epoch = 0;
  /** Outputs before this frame are closed on arrival. */
  private wanted: number;
  /** Export: woken when a frame arrives, the decoder runs dry or the stream fails. */
  private waiters: (() => void)[] = [];
  /** The newest frame the decoder has output. */
  newest = -1;
  error: Error | null = null;
  closed = false;

  /**
   * `planes`: copy every frame to planes, even GPU-backed ones (the WebGL2
   * renderer cannot draw VideoFrames directly).
   */
  constructor(
    private readonly source: StreamSource,
    start: number,
    private readonly decoders: StreamDecoders,
    private readonly planes = false,
  ) {
    this.wanted = start;
    this.pooled = this.borrow();
    void this.seek(start);
  }

  private get decoder() {
    return this.pooled.decoder;
  }

  private borrow() {
    const pooled = this.decoders.acquire(this.source.key, streamConfig(this.source), {
      output: (frame) => this.onOutput(frame),
      error: (error) => {
        this.error = error;
        this.wake();
      },
    });
    pooled.decoder.ondequeue = () => void this.pump();
    return pooled;
  }

  private giveBack() {
    this.pooled.decoder.ondequeue = null;
    // A decoder with nothing queued goes straight back; otherwise it drains first.
    const empty = !this.fed || this.drained || this.newest >= this.source.index.frameCount - 1;
    this.decoders.release(this.pooled, empty && this.decoder.decodeQueueSize === 0);
  }

  /** Starts decoding at the key frame before `frame`. */
  private async seek(frame: number) {
    const epoch = ++this.epoch;
    const timestamp = this.source.index.timestampOf(frame);
    try {
      const key = await this.source.sink.getKeyPacket((timestamp + 0.5) / 1e6, {
        verifyKeyPackets: true,
      });
      if (this.closed || epoch !== this.epoch) return;
      if (!key) throw new Error(`No key frame before frame ${frame}`);
      this.next = key;
      this.fed = false;
      this.flushed = false;
      this.drained = false;
      void this.pump(true);
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
    }
  }

  private onOutput(frame: VideoFrame) {
    const number = this.source.index.frameAt(frame.timestamp);
    this.newest = Math.max(this.newest, number);
    if (this.closed || number < this.wanted) {
      frame.close();
      return;
    }
    const managed = ManagedFrame.wrap(frame);
    if (this.gpuFrames) {
      this.add({ frame: number, item: { kind: 'gpu', frame: managed } });
      return;
    }
    this.copying++;
    const epoch = this.epoch;
    void copyPlanes(frame)
      .then((planes) => {
        if (!this.closed && epoch === this.epoch && number >= this.wanted)
          this.add({ frame: number, item: { kind: 'planes', planes } });
      })
      .catch((error) => {
        this.error = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        managed.close();
        this.copying--;
        void this.pump();
      });
  }

  private add(entry: Ready) {
    this.ready.push(entry);
    this.ready.sort((a, b) => a.frame - b.frame);
    this.wake();
  }

  private wake() {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }

  private get held() {
    return this.ready.length + this.copying + (this.current ? 1 : 0);
  }

  /**
   * Feeds the decoder until enough frames are decoded ahead. A clip that has not
   * started gets `upcomingPackets` per playback tick (`tick`) and nothing more.
   */
  async pump(tick = false) {
    if (this.feeding || this.closed || this.error || (!this.playing && !tick)) return;
    this.feeding = true;
    const epoch = this.epoch;
    const limit = this.gpuFrames ? holdGpu : holdCpu;
    let budget = this.playing ? Infinity : upcomingPackets;
    try {
      while (
        this.next &&
        budget-- > 0 &&
        !this.closed &&
        epoch === this.epoch &&
        this.held < limit &&
        this.decoder.decodeQueueSize < maxQueuedChunks
      ) {
        const packet = this.next;
        this.decoder.decode(packet.toEncodedVideoChunk());
        this.fed = true;
        this.next = await this.source.sink.getNextPacket(packet);
      }
      // The end of the track: emit the frames the decoder still holds, if any.
      const allOut = this.newest >= this.source.index.frameCount - 1;
      if (
        this.fed &&
        !this.next &&
        !this.flushed &&
        !allOut &&
        !this.closed &&
        epoch === this.epoch
      ) {
        const wait = nextFlushAt - performance.now();
        if (wait > 0) {
          setTimeout(() => void this.pump(true), wait);
          return;
        }
        nextFlushAt = performance.now() + flushGapMs;
        this.flushed = true;
        await this.decoder.flush();
        this.drained = epoch === this.epoch;
      }
    } catch (error) {
      if (!this.closed && epoch === this.epoch)
        this.error = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.feeding = false;
      this.wake();
    }
  }

  /**
   * Export: frame `frame`, waiting for the decoder instead of dropping it. Like
   * `frameFor`, the result belongs to the stream until the next call.
   */
  async frameWhenReady(frame: number, timeoutMs = 15000): Promise<StreamFrame> {
    const until = performance.now() + timeoutMs;
    while (true) {
      const item = this.frameFor(frame);
      if (item) return item;
      if (this.error) throw this.error;
      if (this.closed) throw new Error('The decoder was closed');
      if (performance.now() > until) throw new Error(`Frame ${frame} was not decoded in time`);
      // A missed wake-up costs at most a moment.
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  /** Decodes at full speed from now on (before the clock starts, bursts cost nothing). */
  hurry() {
    if (this.playing) return;
    this.playing = true;
    void this.pump();
  }

  /** Decoder outputs are drawn as they are, not copied to planes. */
  private get gpuFrames() {
    return this.source.hardware && !this.planes && !this.source.padded;
  }

  /** The stream decodes in hardware. */
  get hardware() {
    return this.source.hardware;
  }

  /** True when `frame` is decoded and waiting. */
  has(frame: number) {
    return this.current?.frame === frame || this.ready.some((entry) => entry.frame === frame);
  }

  /** True when `frame` and the one after it (if any) are decoded: safe to start playing. */
  primed(frame: number) {
    return this.has(frame) && (this.has(frame + 1) || frame + 1 >= this.source.index.frameCount);
  }

  peek(frame: number): StreamFrame | null {
    if (this.current?.frame === frame) return this.current.item;
    return this.ready.find((entry) => entry.frame === frame)?.item ?? null;
  }

  async peekWhenReady(frame: number, timeoutMs = 15000): Promise<StreamFrame | null> {
    const until = performance.now() + timeoutMs;
    while (true) {
      const item = this.peek(frame);
      if (item) return item;
      // Past the end of the track, or beyond what the stream decodes: none.
      if (frame >= this.source.index.frameCount || this.drained) return null;
      if (this.error) throw this.error;
      if (this.closed) throw new Error('The decoder was closed');
      if (performance.now() > until) return null;
      void this.pump();
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  /**
   * Frame `frame`, or null if it is not decoded yet. Earlier frames are closed.
   * The result belongs to the stream and stays valid until the next call.
   */
  frameFor(frame: number): StreamFrame | null {
    this.playing = true;
    if (this.current?.frame === frame) return this.current.item;
    if (frame < this.wanted || frame > Math.max(this.newest, this.wanted) + restartBehind) {
      // Backwards, or far ahead of the decoder: start again from a key frame.
      this.restart(frame);
      return null;
    }
    this.wanted = frame;
    while (this.ready.length && this.ready[0].frame < frame) release(this.ready.shift()!.item);
    if (this.ready[0]?.frame !== frame) {
      void this.pump();
      return null;
    }
    if (this.current) release(this.current.item);
    this.current = this.ready.shift()!;
    void this.pump();
    return this.current.item;
  }

  private restart(frame: number) {
    this.epoch++;
    this.discard();
    this.wanted = frame;
    this.newest = -1;
    this.next = null;
    // The old decoder drains its queue on the way back to the pool.
    this.giveBack();
    this.pooled = this.borrow();
    void this.seek(frame);
  }

  private discard() {
    for (const entry of this.ready) release(entry.item);
    this.ready = [];
    if (this.current) release(this.current.item);
    this.current = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.epoch++;
    this.discard();
    this.giveBack();
    this.wake();
  }
}

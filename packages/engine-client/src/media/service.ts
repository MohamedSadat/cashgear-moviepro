import type { Input } from 'mediabunny';
import type { MediaLibrary } from '../pkg/cgv_wasm';
import { readBarcode } from './barcode';
import { DecoderPool } from './decoder-pool';
import { FrameCache } from './frame-cache';
import { openFrameCount, readPlanes, type ManagedFrame } from './frames';
import { probeMedia, probeVideo } from './probe';
import { ProjectService } from '../project/service';
import { copyToOpfs, openInput, sourceModified } from './sources';
import type {
  FrameReadback,
  ImportOutcome,
  ImportRequest,
  MediaItem,
  MediaSourceRef,
  MediaStats,
  MediaStatus,
} from './types';
import type { VideoDecoderSession } from './video-decoder';
import { VideoReader } from './video-reader';

/** Decoded frames kept for instant re-seeks. Decoder pools are small; so is this. */
const defaultCacheBudget = 256 * 1024 * 1024;
const decoderCapacity = 4;

interface OpenMedia {
  source: MediaSourceRef;
  input: Input | null;
  reader: VideoReader | null;
  /** Set when decoding goes through a desktop proxy instead of the original. */
  proxy: { source: MediaSourceRef; input: Input } | null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The engine worker's media side: the library (Rust, via WASM), open inputs,
 * one reader per video track, the shared decoder pool and frame cache.
 */
export class MediaService {
  private media = new Map<string, OpenMedia>();
  private cache = new FrameCache<ManagedFrame>(defaultCacheBudget);
  private pool = new DecoderPool<VideoDecoderSession>(decoderCapacity);

  constructor(private readonly library: MediaLibrary) {}

  snapshot(): MediaItem[] {
    return JSON.parse(this.library.snapshot());
  }

  async import(requests: ImportRequest[]): Promise<ImportOutcome[]> {
    const outcomes: ImportOutcome[] = [];
    for (const request of requests) {
      try {
        outcomes.push(await this.importOne(request));
      } catch (error) {
        outcomes.push({ id: request.id, error: message(error) });
      }
    }
    return outcomes;
  }

  private async importOne({ id, source }: ImportRequest): Promise<ImportOutcome> {
    if (this.media.has(id)) throw new Error('This file is already in the library');
    let ref = source;
    const modified = await sourceModified(ref);
    if (ref.kind === 'file') ref = { kind: 'opfs', path: await copyToOpfs(id, ref.file) };
    const probed = await probeMedia(id, ref, () => openInput(ref));
    let item: MediaItem;
    try {
      item = JSON.parse(this.library.add(JSON.stringify(probed.probe)));
    } catch (error) {
      probed.input?.dispose();
      throw error;
    }
    const video = probed.video;
    const reader =
      video && video.probe.decodable && video.config
        ? new VideoReader(id, video.sink, video.index, video.config, this.pool, this.cache)
        : null;
    this.media.set(id, { source: ref, input: probed.input, reader, proxy: null });
    return { id, item, source: ref, media: ProjectService.mediaRef(item, modified) };
  }

  setStatus(id: string, status: MediaStatus): MediaItem {
    return JSON.parse(this.library.set_status(id, JSON.stringify(status)));
  }

  /** Switches decoding of `id` to its desktop proxy file. */
  async attachProxy(id: string, source: MediaSourceRef): Promise<MediaItem> {
    const media = this.require(id);
    const input = await openInput(source);
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('The proxy has no video track');
      const video = await probeVideo(track);
      if (!video.probe.decodable || !video.config)
        throw new Error('The proxy itself cannot be decoded');
      media.reader?.release();
      media.proxy?.input.dispose();
      media.proxy = { source, input };
      media.reader = new VideoReader(
        id,
        video.sink,
        video.index,
        video.config,
        this.pool,
        this.cache,
      );
    } catch (error) {
      input.dispose();
      throw error;
    }
    return this.setStatus(id, { state: 'proxyReady' });
  }

  remove(id: string) {
    const media = this.media.get(id);
    if (!media) return false;
    media.reader?.release();
    media.input?.dispose();
    media.proxy?.input.dispose();
    this.media.delete(id);
    return this.library.remove(id);
  }

  /** Closes every item (switching projects). */
  clear() {
    for (const id of [...this.media.keys()]) this.remove(id);
  }

  /** The exact frame `frame` of a video item. The caller closes it. */
  async readFrame(id: string, frame: number) {
    const reader = this.require(id).reader;
    if (!reader) throw new Error('This item has no decodable video yet');
    return reader.frame(frame);
  }

  frameCount(id: string) {
    return this.require(id).reader?.index.frameCount ?? 0;
  }

  /**
   * Test support: decodes frame `frame` and reads its barcode and, optionally,
   * the raw I420 planes of `crop`, with no colour conversion. Closes it after.
   */
  async readback(
    id: string,
    frame: number,
    crop?: { x: number; y: number; width: number; height: number },
  ): Promise<FrameReadback> {
    const { frame: managed, decoded } = await this.readFrame(id, frame);
    try {
      const raw = managed.raw;
      const width = raw.visibleRect!.width;
      // The barcode strip is the top eighth: read a pair of luma rows through its middle.
      const strip = await readPlanes(raw, {
        x: 0,
        y: Math.floor(raw.visibleRect!.height / 16) & ~1,
        width,
        height: 2,
      });
      const planes = crop ? await readPlanes(raw, crop) : undefined;
      return {
        frame,
        timestampUs: managed.timestamp,
        barcode: readBarcode(strip.y.subarray(0, width), width),
        yuv: planes && Uint8Array.from([...planes.y, ...planes.u, ...planes.v]),
        decodedFrames: decoded,
        format: raw.format,
        colorSpace: raw.colorSpace.toJSON(),
      };
    } finally {
      managed.close();
    }
  }

  stats(): MediaStats {
    return {
      openFrames: openFrameCount(),
      cachedFrames: this.cache.size,
      cacheBytes: this.cache.bytes,
      cacheBudgetBytes: this.cache.budget,
      decoders: this.pool.size,
    };
  }

  /** Closes every cached frame and decoder. Open frames should then be zero. */
  releaseFrames() {
    this.cache.clear();
    this.pool.clear();
  }

  private require(id: string): OpenMedia {
    const media = this.media.get(id);
    if (!media) throw new Error(`No media with id ${id}`);
    return media;
  }
}

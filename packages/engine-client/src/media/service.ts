import type { EncodedPacketSink, Input, InputAudioTrack } from 'mediabunny';
import type { MediaLibrary } from '../pkg/cgv_wasm';
import { readBarcode } from './barcode';
import { DecoderPool } from './decoder-pool';
import { FrameCache } from './frame-cache';
import { openFrameCount, readPlanes, type ManagedFrame } from './frames';
import { paddingShows } from './padding';
import { probeAudio, probeMedia, probeVideo } from './probe';
import { ProjectService } from '../project/service';
import { copyToOpfs, openInput, readAll, sourceModified } from './sources';
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
import type { StreamSource } from './video-stream';

/** Decoded frames kept for instant re-seeks. Decoder pools are small; so is this. */
const defaultCacheBudget = 256 * 1024 * 1024;
const decoderCapacity = 4;
/**
 * Playback decodes frames up to this size in software when it can. Hardware
 * decoders on Windows stall the browser's GPU process when a clip ends (they
 * hand over their last frames at once), which costs frames during playback;
 * software decoding plays three 1080p30 tracks without a drop on the reference
 * machine. Larger frames and codecs without a software decoder (HEVC) use hardware.
 */
const softwarePixels = 1920 * 1088;

/**
 * How decoders are picked: playback by the rule above (`auto`); exports in
 * hardware unless its frames would be read back from the GPU (`fastest`); or
 * forced (diagnostics).
 */
export type DecodePreference = 'auto' | 'fastest' | 'software' | 'hardware';

interface OpenMedia {
  source: MediaSourceRef;
  input: Input | null;
  reader: VideoReader | null;
  /** Set when decoding goes through a desktop proxy instead of the original. */
  proxy: { source: MediaSourceRef; input: Input } | null;
  kind: MediaItem['kind'];
  /** Clockwise degrees that show the video upright. */
  rotation: number;
  /**
   * The decoders the browser has for the reader's track, its frame size, and
   * whether the browser draws its hardware frames wrongly (see `paddingShows`).
   */
  decoders: { hardware: boolean; software: boolean; pixels: number; padded: boolean };
  /** The decodable sound track, from the original or else the proxy. */
  audio: InputAudioTrack | null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function supports(config: VideoDecoderConfig, hardwareAcceleration: HardwareAcceleration) {
  try {
    const support = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration });
    return support.supported === true;
  } catch {
    return false;
  }
}

/** The browser's hardware and software decoders for `config`. Hardware frames stay on the GPU. */
async function decodersFor(
  sink: EncodedPacketSink,
  config: VideoDecoderConfig,
  width: number,
  height: number,
) {
  const hardware = await supports(config, 'prefer-hardware');
  // H.264 codes whole 16-pixel macroblocks: 1080p frames are 1088 rows high.
  const coded = /^avc[13]\./.test(config.codec) && (width % 16 !== 0 || height % 16 !== 0);
  return {
    hardware,
    software: await supports(config, 'prefer-software'),
    pixels: width * height,
    padded: hardware && coded && (await paddingShows(sink, config)),
  };
}

/**
 * The engine worker's media side: the library (Rust, via WASM), open inputs,
 * one reader per video track, the shared decoder pool and frame cache.
 */
export class MediaService {
  private media = new Map<string, OpenMedia>();
  private cache = new FrameCache<ManagedFrame>(defaultCacheBudget);
  private pool = new DecoderPool<VideoDecoderSession>(decoderCapacity);
  /** Told the id of a medium that was removed or now decodes differently. */
  onChange: (id: string) => void = () => {};
  /** Diagnostics: force playback to software or hardware decoders where possible. */
  decode: DecodePreference = 'auto';

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
    const decodable = video?.probe.decodable && video.config ? video : null;
    const decoders = decodable
      ? await decodersFor(
          decodable.sink,
          decodable.config!,
          video!.probe.codedWidth,
          video!.probe.codedHeight,
        )
      : { hardware: false, software: false, pixels: 0, padded: false };
    const reader = decodable
      ? new VideoReader(
          id,
          decodable.sink,
          decodable.index,
          this.readerConfig(decodable.config!, decoders),
          this.pool,
          this.cache,
          () => this.noHardware(id),
          decoders.padded,
        )
      : null;
    this.media.set(id, {
      source: ref,
      input: probed.input,
      reader,
      proxy: null,
      kind: item.kind,
      rotation: video?.probe.rotation ?? 0,
      decoders,
      audio: probed.audio?.probe.decodable ? probed.audio.track : null,
    });
    // Clips of this file may already be on the timeline (a project opened first).
    this.onChange(id);
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
      const decoders = await decodersFor(
        video.sink,
        video.config,
        video.probe.codedWidth,
        video.probe.codedHeight,
      );
      media.reader?.release();
      media.proxy?.input.dispose();
      media.proxy = { source, input };
      media.decoders = decoders;
      media.reader = new VideoReader(
        id,
        video.sink,
        video.index,
        this.readerConfig(video.config, decoders),
        this.pool,
        this.cache,
        () => this.noHardware(id),
        decoders.padded,
      );
      if (!media.audio) {
        const track = await input.getPrimaryAudioTrack();
        const audio = track ? await probeAudio(track) : null;
        media.audio = audio?.probe.decodable ? audio.track : null;
      }
    } catch (error) {
      input.dispose();
      throw error;
    }
    this.onChange(id);
    return this.setStatus(id, { state: 'proxyReady' });
  }

  remove(id: string) {
    const media = this.media.get(id);
    if (!media) return false;
    media.reader?.release();
    media.input?.dispose();
    media.proxy?.input.dispose();
    this.media.delete(id);
    this.onChange(id);
    return this.library.remove(id);
  }

  /** What playback streams decode from, or null when the video cannot be decoded. */
  streamSource(id: string): StreamSource | null {
    const media = this.media.get(id);
    if (!media?.reader) return null;
    const { sink, index, config } = media.reader;
    // A proxy decodes differently from its original: its decoders are not shared.
    const key = media.proxy ? id + ':proxy' : id;
    const hardware = this.useHardware(media.decoders);
    return { key, sink, index, config, hardware, padded: media.decoders.padded };
  }

  /**
   * The hardware decoder the browser offered for `id` failed: playback and
   * seeks use software or the browser's choice from now on.
   */
  noHardware(id: string) {
    const media = this.media.get(id);
    if (media) media.decoders = { ...media.decoders, hardware: false };
  }

  /** The decoder policy: software up to 1080p where the browser has it. */
  private useHardware({ hardware, software, pixels, padded }: OpenMedia['decoders']) {
    // Padded hardware frames are read back to be drawn right: software is quicker.
    if (this.decode === 'fastest') return hardware && !(padded && software);
    const preferHardware =
      this.decode === 'hardware' ||
      (this.decode === 'auto' && pixels > softwarePixels) ||
      !software;
    return hardware && preferHardware;
  }

  /**
   * Seeks decode in hardware where they can: decoding from a key frame up to the
   * wanted frame is quicker there, and a paused monitor does not mind the GPU
   * process stalls that cost playback frames. Frames are asked for as soon as
   * they are decoded, so a seek decodes up to its frame and not past it.
   */
  private readerConfig(config: VideoDecoderConfig, decoders: OpenMedia['decoders']) {
    const hardware = decoders.hardware && this.decode !== 'software';
    return {
      ...config,
      hardwareAcceleration: hardware ? ('prefer-hardware' as const) : ('no-preference' as const),
      optimizeForLatency: true,
    };
  }

  /** The frame showing at source time `flicks` (705.6 per microsecond), or -1. */
  frameNumber(id: string, flicks: number): number {
    const reader = this.media.get(id)?.reader;
    if (!reader || reader.index.frameCount === 0) return -1;
    // A microsecond of slack covers containers that round timestamps up.
    return reader.index.frameAt(Math.round(flicks / 705.6) + 1);
  }

  rotation(id: string): number {
    return this.media.get(id)?.rotation ?? 0;
  }

  audioTrack(id: string): InputAudioTrack | null {
    return this.media.get(id)?.audio ?? null;
  }

  /** True when the medium is open and has a picture to show. */
  hasPicture(id: string): boolean {
    const media = this.media.get(id);
    return !!media && (media.kind === 'image' || !!media.reader);
  }

  isStill(id: string): boolean {
    return this.media.get(id)?.kind === 'image';
  }

  /** Decodes a still image, scaled down to fit `maxSize`. The caller closes it. */
  async stillBitmap(id: string, maxSize: number): Promise<ImageBitmap> {
    const media = this.require(id);
    if (media.kind !== 'image') throw new Error(`${id} is not a still image`);
    const blob = new Blob([await readAll(media.source)]);
    const options: ImageBitmapOptions = {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'default',
    };
    const bitmap = await createImageBitmap(blob, options);
    if (bitmap.width <= maxSize && bitmap.height <= maxSize) return bitmap;
    const scale = maxSize / Math.max(bitmap.width, bitmap.height);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return createImageBitmap(blob, {
      ...options,
      resizeWidth: Math.max(1, Math.floor(size.width * scale)),
      resizeHeight: Math.max(1, Math.floor(size.height * scale)),
      resizeQuality: 'high',
    });
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
  async releaseFrames() {
    await Promise.all([...this.media.values()].map((media) => media.reader?.settle()));
    this.cache.clear();
    this.pool.clear();
  }

  private require(id: string): OpenMedia {
    const media = this.media.get(id);
    if (!media) throw new Error(`No media with id ${id}`);
    return media;
  }
}

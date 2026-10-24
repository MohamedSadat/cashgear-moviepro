import type { ManagedFrame } from '../media/frames';
import { copyPlanes } from '../media/planes';
import type { MediaService } from '../media/service';
import { StreamDecoders } from '../media/stream-decoders';
import { VideoStream } from '../media/video-stream';
import type { Engine } from '../pkg/cgv_wasm';
import type { LayerSource } from '../playback/draw';
import type { FramePlan, LayerPlan } from '../playback/types';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The sources of export frames. Each clip on screen gets a decoder stream, as
 * in playback, but every frame is waited for: nothing is dropped. Clips about
 * to start get their streams early, so their first frames are decoded by then.
 */
export class ExportFrames {
  private streams = new Map<number, { media: string; stream: VideoStream }>();
  private decoders = new StreamDecoders();
  private stills = new Map<string, Promise<{ width: number; height: number }>>();
  /** Frames read through the seek path, closed once the frame is composed. */
  private opened: ManagedFrame[] = [];

  constructor(
    private readonly engine: Engine,
    private readonly media: MediaService,
    /** Copy every frame to planes (WebGL2 and software GPUs cannot draw decoder frames). */
    private readonly planes: boolean,
  ) {}

  /** The sources of `plan`, bottom layer first; starts decoding the clips in `upcoming`. */
  async gather(plan: FramePlan, upcoming: LayerPlan[]): Promise<(LayerSource | null)[]> {
    this.release();
    const sources = await Promise.all(plan.layers.map((layer) => this.source(layer)));
    const keep = new Set<number>();
    for (const layer of [...plan.layers, ...upcoming]) {
      if (layer.still) {
        void this.still(layer.media).catch(() => {});
        continue;
      }
      if (this.stream(layer)) keep.add(layer.clip);
    }
    for (const [clip, { stream }] of this.streams) {
      if (keep.has(clip)) stream.hurry();
      else {
        stream.close();
        this.streams.delete(clip);
      }
    }
    return sources;
  }

  /** Closes frames read for the last composed frame. */
  release() {
    for (const frame of this.opened) frame.close();
    this.opened = [];
  }

  dispose() {
    this.release();
    for (const { stream } of this.streams.values()) stream.close();
    this.streams.clear();
    this.decoders.clear();
  }

  private stream(layer: LayerPlan): VideoStream | null {
    let entry = this.streams.get(layer.clip);
    if (entry && (entry.stream.error || entry.media !== layer.media)) {
      entry.stream.close();
      this.streams.delete(layer.clip);
      entry = undefined;
    }
    if (entry) return entry.stream;
    const source = this.media.streamSource(layer.media);
    if (!source) return null;
    const start = Math.max(0, this.media.frameNumber(layer.media, layer.sourceTime));
    const stream = new VideoStream(source, start, this.decoders, this.planes);
    this.streams.set(layer.clip, { media: layer.media, stream });
    return stream;
  }

  private still(id: string) {
    let load = this.stills.get(id);
    if (!load) {
      load = (async () => {
        const bitmap = await this.media.stillBitmap(id, this.engine.max_texture_size());
        try {
          this.engine.upload_still(id, bitmap);
          return { width: bitmap.width, height: bitmap.height };
        } finally {
          bitmap.close();
        }
      })();
      this.stills.set(id, load);
    }
    return load;
  }

  private async source(layer: LayerPlan): Promise<LayerSource | null> {
    const media = this.media;
    if (!media.hasPicture(layer.media)) return null;
    if (layer.still) return { kind: 'still', key: layer.media, ...(await this.still(layer.media)) };
    const number = media.frameNumber(layer.media, layer.sourceTime);
    if (number < 0) return null;
    const rotation = media.rotation(layer.media);
    const stream = this.stream(layer);
    if (stream) {
      try {
        const item = await stream.frameWhenReady(number);
        return item.kind === 'gpu'
          ? { kind: 'gpu', frame: item.frame.raw, rotation }
          : { kind: 'planes', planes: item.planes, rotation };
      } catch (error) {
        console.warn(`Clip ${layer.clip}: ${message(error)}; reading frame ${number} directly`);
        stream.close();
        this.streams.delete(layer.clip);
      }
    }
    // The seek path: slower, but it finds any frame the file has.
    const { frame, gpu } = await media.readFrame(layer.media, number);
    if (gpu && !this.planes) {
      this.opened.push(frame);
      return { kind: 'gpu', frame: frame.raw, rotation };
    }
    try {
      return { kind: 'planes', planes: await copyPlanes(frame.raw), rotation };
    } finally {
      frame.close();
    }
  }
}

import type { ManagedFrame } from '../media/frames';
import { copyPlanes } from '../media/planes';
import { ReverseStream } from '../media/reverse-stream';
import type { MediaService } from '../media/service';
import { StreamDecoders } from '../media/stream-decoders';
import { VideoStream, type LayerStream, type StreamFrame } from '../media/video-stream';
import { MatteReader } from '../ai/mattes';
import type { Engine } from '../pkg/cgv_wasm';
import { FLICKS_PER_SECOND } from '../project/types';
import type { FramePicture, LayerSource } from '../playback/draw';
import type { FramePlan, LayerPlan } from '../playback/types';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function picture(item: StreamFrame): FramePicture {
  return item.kind === 'gpu'
    ? { kind: 'gpu', frame: item.frame.raw }
    : { kind: 'planes', planes: item.planes };
}

/**
 * The sources of export frames. Each clip on screen gets a decoder stream, as
 * in playback, but every frame is waited for: nothing is dropped. Clips about
 * to start get their streams early, so their first frames are decoded by then.
 */
export class ExportFrames {
  private streams = new Map<number, { media: string; stream: LayerStream; reverse: boolean }>();
  private decoders = new StreamDecoders();
  private stills = new Map<string, Promise<{ width: number; height: number }>>();
  /** Frames read through the seek path, closed once the frame is composed. */
  private opened: ManagedFrame[] = [];
  private mattes = new MatteReader();

  constructor(
    private readonly engine: Engine,
    private readonly media: MediaService,
    /** Copy every frame to planes (WebGL2 and software GPUs cannot draw decoder frames). */
    private readonly planes: boolean,
  ) {}

  /** The sources of `plan`, bottom layer first; starts decoding the clips in `upcoming`. */
  async gather(plan: FramePlan, upcoming: LayerPlan[]): Promise<(LayerSource | null)[]> {
    this.release();
    const sources = await Promise.all(
      plan.layers.map(async (layer) => {
        const source = await this.source(layer);
        // Exports start only once every matte is made: wait for each one to load.
        if (source && layer.removeBackground) {
          const seconds = layer.sourceTime / FLICKS_PER_SECOND;
          await this.mattes.ensure(layer.media, seconds, 2);
          const matte = this.mattes.at(layer.media, seconds);
          if (matte) source.matte = matte;
        }
        return source;
      }),
    );
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

  private stream(layer: LayerPlan): LayerStream | null {
    let entry = this.streams.get(layer.clip);
    const reverse = !!layer.reverse;
    if (entry && (entry.stream.error || entry.media !== layer.media || entry.reverse !== reverse)) {
      entry.stream.close();
      this.streams.delete(layer.clip);
      entry = undefined;
    }
    if (entry) return entry.stream;
    const source = this.media.streamSource(layer.media);
    if (!source) return null;
    const start = Math.max(0, this.media.frameNumber(layer.media, layer.sourceTime));
    const stream = reverse
      ? new ReverseStream(source, start)
      : new VideoStream(source, start, this.decoders, this.planes);
    this.streams.set(layer.clip, { media: layer.media, stream, reverse });
    return stream;
  }

  /** Uploads still `key` (an image, or a frame of an animated one) once; its size. */
  private still(key: string) {
    let load = this.stills.get(key);
    if (!load) {
      load = (async () => {
        const bitmap = await this.media.stillBitmap(key, this.engine.max_texture_size());
        try {
          this.engine.upload_still(key, bitmap);
          return { width: bitmap.width, height: bitmap.height };
        } finally {
          bitmap.close();
        }
      })();
      this.stills.set(key, load);
    }
    return load;
  }

  private async source(layer: LayerPlan): Promise<LayerSource | null> {
    const media = this.media;
    if (!media.hasPicture(layer.media)) return null;
    if (layer.still) {
      const key = media.stillKey(layer.media, layer.sourceTime);
      return { kind: 'still', key, ...(await this.still(key)) };
    }
    const number = media.frameNumber(layer.media, layer.sourceTime);
    if (number < 0) return null;
    const rotation = media.rotation(layer.media);
    const blend = layer.blendFrames ? media.blendAt(layer.media, layer.sourceTime) : null;
    const stream = this.stream(layer);
    if (stream) {
      try {
        const item = picture(await stream.frameWhenReady(number));
        const other = blend ? await stream.peekWhenReady(blend.next) : null;
        const next =
          blend && other
            ? { ...picture(other), weight: blend.weight }
            : blend
              ? { ...(await this.read(layer, blend.next)), weight: blend.weight }
              : undefined;
        return { ...item, rotation, next };
      } catch (error) {
        console.warn(`Clip ${layer.clip}: ${message(error)}; reading frame ${number} directly`);
        stream.close();
        this.streams.delete(layer.clip);
      }
    }
    // The seek path: slower, but it finds any frame the file has.
    const shown = await this.read(layer, number);
    const next = blend
      ? { ...(await this.read(layer, blend.next)), weight: blend.weight }
      : undefined;
    return { ...shown, rotation, next };
  }

  /** Frame `number` of a layer's media through the seek path. */
  private async read(layer: LayerPlan, number: number): Promise<FramePicture> {
    const { frame, gpu } = await this.media.readFrame(layer.media, number);
    if (gpu && !this.planes) {
      this.opened.push(frame);
      return { kind: 'gpu', frame: frame.raw };
    }
    try {
      return { kind: 'planes', planes: await copyPlanes(frame.raw) };
    } finally {
      frame.close();
    }
  }
}

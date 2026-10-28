import { uploadLuts } from '../effects/assets';
import type { FramePlanes } from '../media/planes';
import type { Engine, ProjectSession } from '../pkg/cgv_wasm';
import type { FramePlan } from './types';

/** A decoded video frame: a decoder output, or its planes. */
export type FramePicture =
  { kind: 'gpu'; frame: VideoFrame } | { kind: 'planes'; planes: FramePlanes };

/** Slow motion with frame blending: the source frame after a layer's, mixed in by `weight`. */
export type NextFrame = FramePicture & { weight: number };

/** A frame's matte: one byte of coverage a texel over its upright picture. */
export interface LayerMatte {
  width: number;
  height: number;
  data: Uint8Array;
}

/** One layer's picture for a frame, with its matte when its background goes. */
export type LayerSource = (
  | { kind: 'gpu'; frame: VideoFrame; rotation: number; next?: NextFrame }
  | { kind: 'planes'; planes: FramePlanes; rotation: number; next?: NextFrame }
  | { kind: 'still'; key: string; width: number; height: number }
) & { matte?: LayerMatte };

function planeArguments(p: FramePlanes) {
  return [
    p.format,
    p.codedWidth,
    p.codedHeight,
    p.data,
    p.layout,
    p.colorSpace.matrix ?? undefined,
    p.colorSpace.fullRange ?? undefined,
    p.colorSpace.transfer ?? undefined,
  ] as const;
}

/**
 * Composes `planJson` (from `ProjectSession.plan_frame`, parsed as `plan`) with a
 * source per layer at `scale` of the project resolution: the GPU half of
 * `renderFrame(t)`, shared by preview and export. LUTs the effects read are
 * uploaded from `session` first. Shows the frame when `present` is set; returns
 * whether it did.
 */
export function drawFrame(
  engine: Engine,
  session: ProjectSession,
  planJson: string,
  plan: FramePlan,
  sources: (LayerSource | null)[],
  scale: number,
  present: boolean,
): boolean {
  uploadLuts(engine, session, plan);
  engine.begin(planJson);
  sources.forEach((source, index) => {
    if (!source) return;
    if (source.kind === 'gpu') {
      const frame = source.frame;
      engine.set_layer_frame(
        index,
        frame,
        frame.displayWidth,
        frame.displayHeight,
        source.rotation,
      );
    } else if (source.kind === 'planes') {
      const p = source.planes;
      engine.set_layer_planes(
        index,
        ...planeArguments(p),
        p.displayWidth,
        p.displayHeight,
        source.rotation,
      );
    } else engine.set_layer_still(index, source.key, source.width, source.height);
    const next = source.kind === 'still' ? undefined : source.next;
    if (next?.kind === 'gpu') engine.set_layer_next_frame(index, next.frame, next.weight);
    else if (next) engine.set_layer_next_planes(index, ...planeArguments(next.planes), next.weight);
    const matte = source.matte;
    if (matte) engine.set_layer_matte(index, matte.width, matte.height, matte.data);
  });

  return engine.compose(scale, present);
}

/**
 * The renderer draws hardware decoder frames directly: WebGPU on a hardware
 * adapter. WebGL2, and software adapters that cannot reach the decoder's
 * frames, take their planes instead.
 */
export function drawsGpuFrames(engine: Engine): boolean {
  const software = /swiftshader|warp|basic render|llvmpipe|software/i;
  return engine.backend() === 'WebGPU' && !software.test(engine.adapter_name());
}

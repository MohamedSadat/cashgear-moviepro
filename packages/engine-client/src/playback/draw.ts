import { uploadLuts } from '../effects/assets';
import type { FramePlanes } from '../media/planes';
import type { Engine, ProjectSession } from '../pkg/cgv_wasm';
import type { FramePlan } from './types';

/** One layer's picture for a frame. */
export type LayerSource =
  | { kind: 'gpu'; frame: VideoFrame; rotation: number }
  | { kind: 'planes'; planes: FramePlanes; rotation: number }
  | { kind: 'still'; key: string; width: number; height: number };

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
        p.format,
        p.codedWidth,
        p.codedHeight,
        p.data,
        p.layout,
        p.colorSpace.matrix ?? undefined,
        p.colorSpace.fullRange ?? undefined,
        p.colorSpace.transfer ?? undefined,
        p.displayWidth,
        p.displayHeight,
        source.rotation,
      );
    } else engine.set_layer_still(index, source.key, source.width, source.height);
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

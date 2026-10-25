import type { Engine, ProjectSession } from '../pkg/cgv_wasm';
import type { FramePlan } from '../playback/types';
import type { LookInfo } from './types';

// The built-in pack's files, by their path under the repository's assets folder.
const assets = '../../../../assets/';
const imageUrls = import.meta.glob<string>('../../../../assets/transitions/**/*.png', {
  query: '?url',
  import: 'default',
  eager: true,
});
const looks = import.meta.glob<() => Promise<string>>('../../../../assets/luts/*.cube', {
  query: '?raw',
  import: 'default',
});

/** Uploads every image the engine's effect packs read (luma-wipe gradients). */
export async function loadPackImages(engine: Engine): Promise<void> {
  const images = JSON.parse(engine.pack_images()) as { key: string; path: string }[];
  await Promise.all(
    images.map(async ({ key, path }) => {
      if (engine.has_image(key)) return;
      const url = imageUrls[assets + path];
      if (!url) throw new Error(`The effect image ${path} is missing from the build`);
      const blob = await (await fetch(url)).blob();
      // Gradients are data: no colour conversion on the way to the GPU.
      const bitmap = await createImageBitmap(blob, {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const { width, height } = bitmap;
      let pixels: Uint8ClampedArray;
      try {
        // As bytes: SwiftShader's WebGPU sometimes fails to copy grey bitmaps.
        const context = new OffscreenCanvas(width, height).getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        pixels = context.getImageData(0, 0, width, height).data;
      } finally {
        bitmap.close();
      }
      engine.upload_image(key, width, height, new Uint8Array(pixels.buffer));
    }),
  );
}

/** Uploads the project LUTs `plan` reads that the engine does not hold yet. */
export function uploadLuts(engine: Engine, session: ProjectSession, plan: FramePlan) {
  for (const lut of plan.luts ?? []) {
    if (engine.has_lut(lut.key)) continue;
    const values = session.lut_values(lut.id);
    if (values) engine.upload_lut(lut.key, lut.shape, lut.size, values);
  }
}

function lookId(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1, -'.cube'.length);
}

/** The `.cube` text of built-in look `id`. */
export async function lookText(id: string): Promise<string> {
  const load = looks[`${assets}luts/${id}.cube`];
  if (!load) throw new Error(`There is no built-in look ${id}`);
  return load();
}

let listed: Promise<LookInfo[]> | undefined;

/** The built-in looks, named by their files' titles. */
export function builtinLooks(): Promise<LookInfo[]> {
  listed ??= Promise.all(
    Object.keys(looks)
      .sort()
      .map(async (path) => {
        const id = lookId(path);
        const title = /^TITLE\s+"([^"]*)"/m.exec(await lookText(id));
        return { id, name: title?.[1] ?? id };
      }),
  );
  return listed;
}

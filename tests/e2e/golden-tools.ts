import { expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

// What golden render specs share: the comparison, its tolerance, rendering a
// frame through the engine's diagnostics, and building small test projects.

/**
 * What a render may differ by. GPUs pick mip levels and smooth edges a little
 * differently, so minified stills and rotated edges differ by a few levels. Measured
 * on Chrome and Edge (GTX 1650) and software WebGPU, WebGL2 on WARP and SwiftShader:
 * a mean difference of at most 0.2 levels, at most 0.54% of pixels off by more than
 * 8 and 0.32% by more than 16, never more than 44. A 55% instead of 50% opacity
 * gives a mean of 0.77 and 7.4% of pixels off by more than 8; a 2-pixel shift a
 * mean of 2.6 and 4.3% off by more than 16. Both fail; every real backend passes.
 */
export const tolerance = { mean: 0.35, over8: 0.015, over16: 0.01, worst: 64 };

export interface Comparison {
  /** Mean channel difference, in 8-bit levels. */
  mean: number;
  /** Shares of pixels with a channel off by more than 3, 8 and 16 levels. */
  over: [number, number, number];
  worst: number;
}

/** RGBA pixels, as a PNG or a read-back composition holds them. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

export function compare(actual: Pixels, expected: Pixels): Comparison {
  expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
  const bands = [0, 0, 0];
  let worst = 0;
  let total = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    let pixel = 0;
    for (let c = 0; c < 3; c++) {
      const difference = Math.abs(actual.data[i + c] - expected.data[i + c]);
      pixel = Math.max(pixel, difference);
      total += difference;
    }
    worst = Math.max(worst, pixel);
    [3, 8, 16].forEach((level, band) => (bands[band] += pixel > level ? 1 : 0));
  }
  const pixels = actual.data.length / 4;
  return {
    mean: total / (pixels * 3),
    over: bands.map((count) => count / pixels) as [number, number, number],
    worst,
  };
}

export function passes({ mean, over, worst }: Comparison) {
  return (
    mean <= tolerance.mean &&
    over[1] <= tolerance.over8 &&
    over[2] <= tolerance.over16 &&
    worst <= tolerance.worst
  );
}

/** The frame at `time` (flicks), composed at full quality, as a PNG. */
export async function render(page: Page, time: number): Promise<PNG> {
  const raw = await page.evaluate(async (time) => {
    const hooks = Reflect.get(window, '__cgv') as {
      client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
    };
    const pixels = (await hooks.client.api.renderPixels(time)) as {
      width: number;
      height: number;
      data: Uint8Array;
    };
    let text = '';
    for (let i = 0; i < pixels.data.length; i += 0x8000)
      text += String.fromCharCode(...pixels.data.subarray(i, i + 0x8000));
    return { width: pixels.width, height: pixels.height, data: btoa(text) };
  }, time);
  const png = new PNG({ width: raw.width, height: raw.height });
  Buffer.from(raw.data, 'base64').copy(png.data);
  return png;
}

/** The frame number in the barcode strip of an untransformed test clip, or -1. */
export function barcode(pixels: Pixels) {
  const y = Math.floor(pixels.height / 16);
  let value = 0;
  for (let bit = 0; bit < 16; bit++) {
    const x = Math.floor(((bit + 0.5) * pixels.width) / 16);
    const at = (y * pixels.width + x) * 4;
    const luma = (pixels.data[at] + pixels.data[at + 1] + pixels.data[at + 2]) / 3;
    if (luma > 180) value |= 1 << bit;
    else if (luma > 70) return -1;
  }
  return value;
}

/** Smooth value noise from 0 to 1, repeatable. */
function noise(x: number, y: number) {
  const hash = (i: number, j: number) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const i = Math.floor(x);
  const j = Math.floor(y);
  const u = (x - i) * (x - i) * (3 - 2 * (x - i));
  const v = (y - j) * (y - j) * (3 - 2 * (y - j));
  const a = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * u;
  const b = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * u;
  return a + (b - a) * v;
}

const mixRgb = (a: number[], b: number[], t: number) => a.map((c, i) => c + (b[i] - c) * t);

/**
 * Two synthetic pictures for effect tests: smooth gradients, soft and hard edges,
 * a hue strip and a grey ramp ("sunset"), and a dark, cool, detailed one ("city").
 * Generated here, so no photographs need licensing. They are made at the effect
 * projects' size, so no GPU's filtering takes part in what the effects see.
 */
export function scenePng(kind: 'sunset' | 'city', width = 480, height = 270): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      let rgb: number[];
      if (kind === 'sunset') {
        const sky =
          v < 0.3
            ? mixRgb([31, 59, 115], [224, 115, 90], v / 0.3)
            : mixRgb([224, 115, 90], [247, 196, 108], (v - 0.3) / 0.32);
        const sun = Math.hypot(u - 0.68, (v - 0.5) * 0.5625) / 0.07;
        rgb = mixRgb(sky, [255, 241, 194], Math.max(0, Math.min(1, (1.15 - sun) * 4)));
        const hill = 0.58 + 0.05 * Math.sin(u * 9) + 0.02 * Math.sin(u * 31);
        if (v > hill) rgb = mixRgb([60, 90, 46], [30, 52, 26], noise(u * 40, v * 40) * 0.6);
        if (v > 0.74) rgb = mixRgb([47, 111, 154], [23, 58, 87], (v - 0.74) / 0.16);
        if (v > 0.9) {
          // A hue strip above a grey ramp.
          const h = u * 6;
          const f = h - Math.floor(h);
          const segment = Math.floor(h) % 6;
          const hue = [
            [1, f, 0],
            [1 - f, 1, 0],
            [0, 1, f],
            [0, 1 - f, 1],
            [f, 0, 1],
            [1, 0, 1 - f],
          ][segment];
          rgb = v < 0.95 ? hue.map((c) => c * 255) : [u * 255, u * 255, u * 255];
        }
      } else {
        rgb = mixRgb([11, 16, 38], [122, 63, 125], v);
        const moon = Math.hypot(u - 0.22, (v - 0.24) * 0.5625) / 0.05;
        rgb = mixRgb(rgb, [232, 236, 255], Math.max(0, Math.min(1, (1.1 - moon) * 6)));
        const column = Math.floor(u * 14);
        const top = 0.35 + 0.4 * (((column * 53) % 7) / 7);
        if (v > top) {
          rgb = column % 2 ? [20, 26, 51] : [28, 36, 71];
          const wx = Math.floor(u * 140) % 3;
          const wy = Math.floor(v * 90) % 3;
          if (wx === 1 && wy === 1 && (column * 7 + Math.floor(v * 90)) % 5 < 2)
            rgb = [255, 211, 107];
        }
      }
      const i = (y * width + x) * 4;
      png.data[i] = Math.round(rgb[0]);
      png.data[i + 1] = Math.round(rgb[1]);
      png.data[i + 2] = Math.round(rgb[2]);
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

/** One frame at 30 fps, in flicks. */
export const FRAME = 23_520_000;

export type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
  project: {
    execute(command: unknown): Promise<{ created: number[] } | null>;
    importLook(id: string): Promise<number | null>;
  };
};

/** Runs a command; returns what it created. */
export async function run(page: Page, command: unknown): Promise<number[]> {
  const outcome = await page.evaluate(
    (command) => (Reflect.get(window, '__cgv') as Hooks).project.execute(command),
    command,
  );
  expect(outcome, JSON.stringify(command)).not.toBeNull();
  return outcome!.created;
}

export async function tracks(page: Page) {
  const snapshot = (await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
  )) as { project: { tracks: { id: number; clips: { id: number }[] }[] } };
  return snapshot.project.tracks;
}

/** An empty 480×270 project with its tracks (two, or `count`); returns their ids. */
export async function clear(page: Page, count = 2) {
  const before = await tracks(page);
  const clips = before.flatMap((track) => track.clips.map((clip) => clip.id));
  if (clips.length) await run(page, { type: 'delete', clips });
  for (let index = before.length; index < count; index++)
    await run(page, { type: 'addTrack', index });
  await run(page, {
    type: 'setSettings',
    settings: {
      width: 480,
      height: 270,
      frameRate: { num: 30, den: 1 },
      sampleRate: 48000,
      channels: 2,
    },
  });
  return (await tracks(page)).map((track) => track.id);
}

/**
 * Opens the app (`query` picks the backend) and imports synthetic pictures named
 * in `media` ("city…" or a sunset). Returns media ids by name.
 */
export async function setUp(page: Page, query: string, media: string[]) {
  await page.goto('/?diagnostic=1' + query);
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
  await page.getByTestId('media-file-input').setInputFiles(
    media.map((name) => ({
      name,
      mimeType: 'image/png',
      buffer: scenePng(name.startsWith('city') ? 'city' : 'sunset'),
    })),
  );
  for (const file of media)
    await expect(page.locator(`[data-testid="media-item"][data-name="${file}"]`)).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 60000 },
    );
  const snapshot = (await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
  )) as { project: { media: { id: string; name: string }[] } };
  return new Map(snapshot.project.media.map((item) => [item.name, item.id]));
}

/** A clip of still `name`, `frames` long. */
export const still = (ids: Map<string, string>, name: string, frames: number) => ({
  media: ids.get(name),
  duration: frames * FRAME,
});

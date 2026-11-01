import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { deepClips, distinctLevels, encodeRamp, rampFrames, rampLevels } from './deep-colour';
import { clear, run } from './golden-tools';

// Scopes and grading. The scopes of 75% colour bars land each bar on its
// vectorscope target and its luma within 1% on the waveform, on both backends;
// the Scopes panel draws them. A grade on the 10-bit ramp keeps at least 95% of
// its levels through a 10-bit readback, as a master reads it.
const root = process.cwd();
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin');
const ffmpeg = join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const FRAME = 23_520_000;
const levels = 256;
const columns = 384;

type Hooks = { client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> } };
interface Scopes {
  columns: number;
  luma: Uint32Array;
  vector: Uint32Array;
}

/** 75% bars, 1280×720: white, yellow, cyan, green, magenta, red and blue. */
function barsPng(): Buffer {
  const width = 1280;
  const height = 720;
  const level = 191;
  const colours = [
    [1, 1, 1],
    [1, 1, 0],
    [0, 1, 1],
    [0, 1, 0],
    [1, 0, 1],
    [1, 0, 0],
    [0, 0, 1],
  ];
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const colour = colours[Math.floor((x * colours.length) / width)];
      const at = (y * width + x) * 4;
      png.data[at] = colour[0] * level;
      png.data[at + 1] = colour[1] * level;
      png.data[at + 2] = colour[2] * level;
      png.data[at + 3] = 255;
    }
  return PNG.sync.write(png);
}

async function open(page: Page, query: string) {
  await page.goto('/?diagnostic=1' + query);
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
}

async function mediaId(page: Page, name: string) {
  const snapshot = (await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
  )) as { project: { media: { id: string; name: string }[] } };
  return snapshot.project.media.find((item) => item.name === name)!.id;
}

/** Draws the frame at `time`, then counts its scopes. */
async function scopes(page: Page, time: number): Promise<Scopes> {
  const raw = await page.evaluate(
    async ({ time, columns }) => {
      const api = (Reflect.get(window, '__cgv') as Hooks).client.api;
      await api.renderPixels(time);
      const scopes = (await api.readScopes(columns)) as Record<string, Uint32Array | number>;
      return {
        columns: scopes.columns as number,
        luma: Array.from(scopes.luma as Uint32Array),
        vector: Array.from(scopes.vector as Uint32Array),
      };
    },
    { time, columns },
  );
  return {
    columns: raw.columns,
    luma: Uint32Array.from(raw.luma),
    vector: Uint32Array.from(raw.vector),
  };
}

/** BT.709 75% targets (Cb, Cr), as `crates/cgv-render/src/scopes.rs` has them. */
function targets() {
  const kr = 0.2126;
  const kb = 0.0722;
  const kg = 1 - kr - kb;
  return (
    [
      ['R', 1, 0, 0],
      ['Mg', 1, 0, 1],
      ['B', 0, 0, 1],
      ['Cy', 0, 1, 1],
      ['G', 0, 1, 0],
      ['Yl', 1, 1, 0],
    ] as const
  ).map(([name, r, g, b]) => {
    const [R, G, B] = [r, g, b].map((value) => value * 0.75);
    const y = kr * R + kg * G + kb * B;
    return { name, cb: (B - y) / (2 * (1 - kb)), cr: (R - y) / (2 * (1 - kr)), y };
  });
}

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} scopes put 75% bars on their vectorscope targets and waveform levels`, async ({
    page,
  }) => {
    await open(page, backend === 'WebGL2' ? '&gpu=webgl2' : '');
    await page
      .getByTestId('media-file-input')
      .setInputFiles([{ name: 'bars.png', mimeType: 'image/png', buffer: barsPng() }]);
    await expect(page.locator('[data-testid="media-item"][data-name="bars.png"]')).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 60000 },
    );
    const [main] = await clear(page, 1);
    await run(page, {
      type: 'setSettings',
      settings: {
        width: 1280,
        height: 720,
        frameRate: { num: 30, den: 1 },
        sampleRate: 48000,
        channels: 2,
      },
    });
    await run(page, {
      type: 'append',
      track: main,
      clip: { media: await mediaId(page, 'bars.png'), duration: 30 * FRAME },
    });
    const counted = await scopes(page, 0);
    const total = counted.vector.reduce((sum, count) => sum + count, 0);
    for (const target of targets()) {
      const u = Math.min(255, Math.floor((target.cb + 0.5) * levels));
      const v = Math.min(255, Math.floor((target.cr + 0.5) * levels));
      let near = 0;
      for (let row = v - 2; row <= v + 2; row++)
        for (let col = u - 2; col <= u + 2; col++) near += counted.vector[row * levels + col] ?? 0;
      // A seventh of the frame is each bar; edges between bars may blend.
      expect(near / total, `${target.name} on its target`).toBeGreaterThan(0.12);
    }
    // The waveform: each bar's columns at its luma, within 1%.
    const weights = [1, 0.2126 + 0.7152, 0.7152 + 0.0722, 0.7152, 0.2126 + 0.0722, 0.2126, 0.0722];
    weights.forEach((weight, bar) => {
      const column = Math.floor(((bar + 0.5) * counted.columns) / weights.length);
      let busiest = 0;
      for (let level = 1; level < levels; level++)
        if (
          counted.luma[level * counted.columns + column] >
          counted.luma[busiest * counted.columns + column]
        )
          busiest = level;
      expect(Math.abs(busiest - 191.25 * weight), `bar ${bar}`).toBeLessThanOrEqual(2.56);
    });

    // The panel draws the vectorscope.
    await page.getByRole('tab', { name: 'Scopes' }).click();
    await page.getByTestId('scopes-mode').selectOption('vectorscope');
    await expect(page.getByTestId('scopes-canvas')).toHaveAttribute('data-mode', 'vectorscope');
    await expect
      .poll(async () =>
        page.getByTestId('scopes-canvas').evaluate((canvas: HTMLCanvasElement) => {
          const data = canvas
            .getContext('2d')!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let lit = 0;
          for (let i = 0; i < data.length; i += 4) if (data[i + 1] > 100) lit++;
          return lit;
        }),
      )
      .toBeGreaterThan(20);
  });
}

test('a grade keeps the 10-bit ramp at ten bits', async ({ page }, testInfo) => {
  test.skip(!existsSync(ffmpeg), 'FFmpeg is missing: run pnpm setup:ffmpeg');
  const dir = join(testInfo.project.outputDir, 'grading');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'ramp-vp9-10bit.webm');
  encodeRamp(
    ffmpeg,
    deepClips.find((clip) => clip.name === 'ramp-vp9-10bit.webm')!,
    1920,
    1080,
    file,
  );
  await open(page, '&decode=software');
  await page.getByTestId('media-file-input').setInputFiles([file]);
  await expect(
    page.locator('[data-testid="media-item"][data-name="ramp-vp9-10bit.webm"]'),
  ).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
  const [main] = await clear(page, 1);
  await run(page, {
    type: 'setSettings',
    settings: {
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      sampleRate: 48000,
      channels: 2,
    },
  });
  const [clip] = await run(page, {
    type: 'append',
    track: main,
    clip: {
      media: await mediaId(page, 'ramp-vp9-10bit.webm'),
      duration: rampFrames * FRAME,
      audio: false,
    },
  });
  // A gentle midtone lift with a warm push in the highlights.
  await run(page, {
    type: 'addEffect',
    clip,
    effect: {
      kind: 'color-wheels',
      params: { gamma_master: 0.05, gain_hue: 40, gain_amount: 0.1 },
    },
  });
  const row = await page.evaluate(async () => {
    const api = (Reflect.get(window, '__cgv') as Hooks).client.api;
    const deep = (await api.renderYuv10(0, 1920, 1080, 'yuv422p10le')) as { data: Uint8Array };
    const luma = new Uint16Array(deep.data.buffer, deep.data.byteOffset, 1920 * 1080);
    return Array.from(luma.subarray(540 * 1920, 541 * 1920));
  });
  expect(distinctLevels(row)).toBeGreaterThanOrEqual(Math.ceil(0.95 * rampLevels));
  // The grade did something: the middle of the ramp is brighter than it was.
  expect(row[960]).toBeGreaterThan(64 + 438 + 4);
});

test('a drag on a colour wheel or a curve is one undo step', async ({ page }) => {
  await open(page, '');
  await page
    .getByTestId('media-file-input')
    .setInputFiles([{ name: 'bars.png', mimeType: 'image/png', buffer: barsPng() }]);
  await expect(page.locator('[data-testid="media-item"][data-name="bars.png"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 60000 },
  );
  const [main] = await clear(page, 1);
  const [clip] = await run(page, {
    type: 'append',
    track: main,
    clip: { media: await mediaId(page, 'bars.png'), duration: 30 * FRAME },
  });
  await run(page, { type: 'addEffect', clip, effect: { kind: 'color-wheels' } });
  await run(page, { type: 'addEffect', clip, effect: { kind: 'curves' } });
  await page.evaluate(
    (id) =>
      (Reflect.get(window, '__cgv') as { editor: { select(ids: number[]): void } }).editor.select([
        id,
      ]),
    clip,
  );
  const state = () =>
    page.evaluate(async () => {
      const api = (Reflect.get(window, '__cgv') as Hooks).client.api;
      const snapshot = (await api.projectSnapshot()) as {
        undoLabel: string | null;
        project: {
          tracks: { clips: { effects: { kind: string; params: Record<string, number> }[] }[] }[];
        };
      };
      const effects = snapshot.project.tracks.flatMap((track) => track.clips)[0].effects;
      return { label: snapshot.undoLabel, effects };
    });
  const before = await state();

  // The lift wheel: from the centre towards blue, in several moves.
  const wheel = page.getByTestId('wheel-lift').locator('svg');
  await wheel.scrollIntoViewIfNeeded();
  const box = (await wheel.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  for (let step = 1; step <= 5; step++)
    await page.mouse.move(centre.x - step * 6, centre.y + step * 4);
  await page.mouse.up();
  await expect.poll(async () => (await state()).label).toBe('Change lift');
  const wheels = (await state()).effects.find((effect) => effect.kind === 'color-wheels')!;
  expect(wheels.params.lift_amount).toBeGreaterThan(0.3);

  // The luma curve's middle point, dragged up.
  const curve = page.getByTestId('curves').locator('svg');
  await curve.scrollIntoViewIfNeeded();
  const area = (await curve.boundingBox())!;
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 5; step++)
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2 - step * 6);
  await page.mouse.up();
  await expect.poll(async () => (await state()).label).toBe('Change the luma curve');
  const curves = (await state()).effects.find((effect) => effect.kind === 'curves')!;
  expect(curves.params.luma_2).toBeGreaterThan(0.6);

  // One undo takes back the whole curve drag, and one more the whole wheel drag.
  const undo = () =>
    page.evaluate(() =>
      (Reflect.get(window, '__cgv') as { project: { undo(): Promise<void> } }).project.undo(),
    );
  await undo();
  await expect.poll(async () => (await state()).label).toBe('Change lift');
  await undo();
  await expect
    .poll(async () => JSON.stringify((await state()).effects))
    .toBe(JSON.stringify(before.effects));
});

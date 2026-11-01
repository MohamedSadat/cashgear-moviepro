import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { FRAME, clear, render, run, type Pixels } from './golden-tools';

// Secondary correction. The HSL qualifier selects a chart's target hue with its
// edges where its settings put them, grades only what it selects, and a window on
// the effect limits it to a shape, on both backends. Goldens of its result and its
// matte view are in effects.spec.ts.
const WIDTH = 720;
const HEIGHT = 90;

function hsv(hue: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360;
  const sector = h / 60;
  const x = 1 - Math.abs((sector % 2) - 1);
  const [r, g, b] =
    sector < 1
      ? [1, x, 0]
      : sector < 2
        ? [x, 1, 0]
        : sector < 3
          ? [0, 1, x]
          : sector < 4
            ? [0, x, 1]
            : sector < 5
              ? [x, 0, 1]
              : [1, 0, x];
  return [r * 255, g * 255, b * 255];
}

/** Every hue across the picture, at full saturation and value: half a degree a column. */
function hueChart(): Buffer {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b] = hsv(((x + 0.5) * 360) / WIDTH);
      const at = (y * WIDTH + x) * 4;
      png.data[at] = Math.round(r);
      png.data[at + 1] = Math.round(g);
      png.data[at + 2] = Math.round(b);
      png.data[at + 3] = 255;
    }
  return PNG.sync.write(png);
}

async function setUpChart(page: Page, query: string) {
  await page.goto('/?diagnostic=1' + query);
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
  await page
    .getByTestId('media-file-input')
    .setInputFiles([{ name: 'hues.png', mimeType: 'image/png', buffer: hueChart() }]);
  await expect(page.locator('[data-testid="media-item"][data-name="hues.png"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 60000 },
  );
  const [main] = await clear(page, 1);
  await run(page, {
    type: 'setSettings',
    settings: {
      width: WIDTH,
      height: HEIGHT,
      frameRate: { num: 30, den: 1 },
      sampleRate: 48000,
      channels: 2,
    },
  });
  const { project } = await page.evaluate(() =>
    Reflect.get(window, '__cgv').client.api.projectSnapshot(),
  );
  const [clip] = await run(page, {
    type: 'append',
    track: main,
    clip: { media: project.media[0].id, duration: 30 * FRAME },
  });
  return clip;
}

const green = { r: 0, g: 1, b: 0, a: 1 };

/** The colour at the middle row of the column showing `hue`. */
function at(pixels: Pixels, hue: number, row = HEIGHT / 2) {
  const x = Math.min(WIDTH - 1, Math.floor((hue * WIDTH) / 360));
  const i = (Math.floor(row) * pixels.width + x) * 4;
  return [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]];
}

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} the qualifier selects the hue range its settings say, and grades only that`, async ({
    page,
  }) => {
    const clip = await setUpChart(page, backend === 'WebGL2' ? '&gpu=webgl2' : '');
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
    const plain = await render(page, 0);
    // Green is hue 120: whole within 30 degrees, gone 15 degrees past that.
    const [effect] = await run(page, {
      type: 'addEffect',
      clip,
      effect: {
        kind: 'hsl-qualifier',
        params: { color: green, hue_range: 30, hue_soft: 15, view: 'matte' },
      },
    });
    const matte = await render(page, 0);
    const level = (hue: number) => at(matte, hue)[0];
    for (const hue of [91, 100, 120, 140, 149])
      expect(level(hue), `hue ${hue}`).toBeGreaterThan(250);
    for (const hue of [10, 74, 166, 200, 300]) expect(level(hue), `hue ${hue}`).toBeLessThan(5);
    // Half way down each soft edge.
    for (const hue of [82.5, 157.5]) {
      const halfway = level(hue);
      expect(halfway, `hue ${hue}: ${halfway}`).toBeGreaterThan(100);
      expect(halfway, `hue ${hue}: ${halfway}`).toBeLessThan(155);
    }

    // The grade: inside the selection it turns the hue; outside nothing changes.
    await run(page, {
      type: 'setEffectParams',
      clip,
      effect,
      params: { view: 'result', hue_shift: 120 },
    });
    const graded = await render(page, 0);
    const blue = at(graded, 120);
    expect(blue[2]).toBeGreaterThan(240);
    expect(blue[1]).toBeLessThan(20);
    for (const hue of [10, 60, 200, 300])
      for (const channel of [0, 1, 2])
        expect(Math.abs(at(graded, hue)[channel] - at(plain, hue)[channel])).toBeLessThanOrEqual(1);

    // A window limits it: the left half of the picture keeps its green.
    await run(page, {
      type: 'setEffectMasks',
      clip,
      effect,
      masks: [
        {
          id: 0,
          shape: 'rectangle',
          mode: 'add',
          x: 0.5,
          y: 0.25,
          width: 2,
          height: 0.5,
          rotation: 0,
          roundness: 0,
          feather: 0,
          expansion: 0,
          opacity: 1,
        },
      ],
    });
    const windowed = await render(page, 0);
    expect(at(windowed, 120, HEIGHT / 4)[2], 'inside the window').toBeGreaterThan(240);
    const below = at(windowed, 120, (3 * HEIGHT) / 4);
    expect(below[1], 'below the window').toBeGreaterThan(240);
    expect(below[2], 'below the window').toBeLessThan(20);
  });
}

test('a window goes on an effect from the inspector, as one undo step', async ({ page }) => {
  const clip = await setUpChart(page, '');
  await run(page, {
    type: 'addEffect',
    clip,
    effect: { kind: 'hsl-qualifier', params: { color: green, hue_shift: 120 } },
  });
  const canvas = page.getByTestId('timeline-canvas');
  const box = (await canvas.boundingBox())!;
  const { scale, scrollTime } = await canvas.evaluate((element) => ({
    scale: Number((element as HTMLElement).dataset.scale),
    scrollTime: Number((element as HTMLElement).dataset.scrollTime),
  }));
  const header = (await page.locator('[data-testid="track"][data-main="true"]').boundingBox())!;
  await page.mouse.click(
    box.x + ((15 * FRAME - scrollTime) / 705_600_000) * scale,
    header.y + header.height / 2 + 8,
  );
  const panel = page.getByTestId('effect-window');
  await panel.getByRole('button', { name: 'Ellipse' }).click();
  const snapshot = () =>
    page.evaluate(() => Reflect.get(window, '__cgv').client.api.projectSnapshot());
  await expect.poll(async () => (await snapshot()).undoLabel).toBe('Change effect mask');
  const effect = (await snapshot()).project.tracks[0].clips[0].effects[0];
  expect(effect.masks[0].shape).toBe('ellipse');
  await expect(panel.getByRole('button', { name: 'Edit on monitor' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByTestId('undo').click();
  await expect
    .poll(async () => (await snapshot()).project.tracks[0].clips[0].effects[0].masks ?? [])
    .toEqual([]);
});

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { compare, passes, render, tolerance, type Comparison } from './golden-tools';

// Golden renders: fixture projects rendered through renderFrame(t) and read back,
// compared with reference PNGs on both GPU backends. References come from the
// reference machine's WebGPU (UPDATE_GOLDEN=1 on the chrome project); every
// backend, CI's software GPUs included, must match them within the tolerance.
const root = process.cwd();
const mediaDir = join(root, 'tests/media');
const goldenDir = join(root, 'tests/golden');
const FRAME = 23_520_000;
const update = process.env.UPDATE_GOLDEN === '1';

interface Layer {
  media: string;
  length: number;
  transform?: Partial<Record<string, number>>;
  crop?: Partial<Record<string, number>>;
  opacity?: number;
}
interface Fixture {
  name: string;
  size?: [number, number];
  frame: number;
  layers: Layer[];
}
const { fixtures, media: mediaFiles } = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/golden.json'), 'utf8'),
) as { fixtures: Fixture[]; media: string[] };

/** A 512×288 RGBA image whose alpha ramps left to right over a colour gradient. */
function alphaPng() {
  const png = new PNG({ width: 512, height: 288 });
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      png.data[i] = Math.round((x / (png.width - 1)) * 255);
      png.data[i + 1] = Math.round((y / (png.height - 1)) * 255);
      png.data[i + 2] = 200;
      // Fully clear at the left, opaque at the right, with a hard notch in the middle.
      const notch = Math.abs(x - 256) < 16 && Math.abs(y - 144) < 16;
      png.data[i + 3] = notch ? 0 : Math.round((x / (png.width - 1)) * 255);
    }
  return PNG.sync.write(png);
}

type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
  project: { execute(command: unknown): Promise<{ created: number[] } | null> };
};

async function run(page: Page, command: unknown): Promise<number[]> {
  const outcome = await page.evaluate(
    (command) => (Reflect.get(window, '__cgv') as Hooks).project.execute(command),
    command,
  );
  expect(outcome, JSON.stringify(command)).not.toBeNull();
  return outcome!.created;
}

async function snapshot(page: Page) {
  return (await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
  )) as {
    project: {
      media: { id: string; name: string }[];
      tracks: { id: number; clips: { id: number }[] }[];
    };
  };
}

/** Replaces the project's clips with `fixture` and renders its frame. */
async function build(page: Page, fixture: Fixture, ids: Map<string, string>) {
  const { project } = await snapshot(page);
  const clips = project.tracks.flatMap((track) => track.clips.map((clip) => clip.id));
  if (clips.length) await run(page, { type: 'delete', clips });
  const [width, height] = fixture.size ?? [480, 270];
  await run(page, {
    type: 'setSettings',
    settings: { width, height, frameRate: { num: 30, den: 1 }, sampleRate: 48000, channels: 2 },
  });
  let tracks = (await snapshot(page)).project.tracks;
  while (tracks.length < fixture.layers.length) {
    await run(page, { type: 'addTrack', index: tracks.length });
    tracks = (await snapshot(page)).project.tracks;
  }
  for (const [index, layer] of fixture.layers.entries()) {
    const [clip] = await run(page, {
      type: 'append',
      track: tracks[index].id,
      clip: { media: ids.get(layer.media), duration: layer.length * FRAME },
    });
    const properties: Record<string, unknown> = {};
    if (layer.transform)
      properties.transform = {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        ...layer.transform,
      };
    if (layer.crop) properties.crop = { left: 0, top: 0, right: 0, bottom: 0, ...layer.crop };
    if (layer.opacity !== undefined) properties.opacity = layer.opacity;
    if (Object.keys(properties).length)
      await run(page, { type: 'setClipProperties', clip, properties });
  }
  return render(page, fixture.frame * FRAME);
}

async function setUp(page: Page, query: string) {
  await page.goto('/?diagnostic=1' + query);
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
  // Playwright takes all paths or all buffers; the alpha still only exists in memory.
  const types: Record<string, string> = { mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg' };
  await page.getByTestId('media-file-input').setInputFiles(
    mediaFiles.map((name) => ({
      name,
      mimeType: types[name.split('.').pop()!],
      buffer: name === 'alpha.png' ? alphaPng() : readFileSync(join(mediaDir, name)),
    })),
  );
  for (const file of mediaFiles)
    await expect(page.locator(`[data-testid="media-item"][data-name="${file}"]`)).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 60000 },
    );
  const { project } = await snapshot(page);
  return new Map(project.media.map((media) => [media.name, media.id]));
}

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} golden renders of transform, crop and opacity match the references`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(240000);
    const ids = await setUp(page, backend === 'WebGL2' ? '&gpu=webgl2' : '');
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
    const writing = update && backend === 'WebGPU' && testInfo.project.name === 'chrome';
    const results: Record<string, Comparison> = {};
    const outDir = testInfo.outputPath('renders');
    mkdirSync(outDir, { recursive: true });
    for (const fixture of fixtures) {
      const rendered = await build(page, fixture, ids);
      writeFileSync(join(outDir, fixture.name + '.png'), PNG.sync.write(rendered));
      const file = join(goldenDir, fixture.name + '.png');
      if (writing) {
        writeFileSync(file, PNG.sync.write(rendered));
        continue;
      }
      results[fixture.name] = compare(rendered, PNG.sync.read(readFileSync(file)));
    }
    const report = { backend, project: testInfo.project.name, tolerance, results, controls: {} };
    const save = () =>
      writeFileSync(testInfo.outputPath('comparison.json'), JSON.stringify(report, null, 2));
    save();
    await testInfo.attach('golden-comparison', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    if (writing) return;

    // The tolerance has teeth: 55% instead of 50% opacity fails, as does a 2-pixel shift.
    const opacity = fixtures.find((fixture) => fixture.name === 'opacity')!;
    const off = await build(
      page,
      { ...opacity, layers: [opacity.layers[0], { ...opacity.layers[1], opacity: 0.55 }] },
      ids,
    );
    const golden = (name: string) => PNG.sync.read(readFileSync(join(goldenDir, name + '.png')));
    const offResult = compare(off, golden('opacity'));
    const transform = fixtures.find((fixture) => fixture.name === 'transform')!;
    const moved = await build(
      page,
      {
        ...transform,
        layers: [
          transform.layers[0],
          {
            ...transform.layers[1],
            transform: { ...transform.layers[1].transform, x: 62 },
          },
        ],
      },
      ids,
    );
    const movedResult = compare(moved, golden('transform'));
    report.controls = { opacity55: offResult, shifted2px: movedResult };
    save();
    for (const [name, result] of Object.entries(results))
      expect(passes(result), `${name}: ${JSON.stringify(result)}`).toBe(true);
    expect(passes(offResult), JSON.stringify(offResult)).toBe(false);
    expect(passes(movedResult), JSON.stringify(movedResult)).toBe(false);
  });
}

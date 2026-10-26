import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { cellProperties, pipTransform, splitLayouts } from '../../packages/ui/src/layouts/layouts';
import { centredRect, framingTransform } from '../../packages/ui/src/monitor/geometry';
import { newMask, penPoints } from '../../packages/ui/src/masks/shapes';
import {
  clear,
  compare,
  FRAME,
  passes,
  render,
  run,
  setUp,
  still,
  tolerance,
  type Comparison,
} from './golden-tools';

// Golden renders of the creative tools on both GPU backends: every blend mode,
// masks (shapes, modes, feather, keyframes), picture in picture, split screens
// (a slanted one masked) and Ken Burns. Layouts and framing use the UI's own
// presets. References come from the reference machine's WebGPU
// (UPDATE_GOLDEN=1 on the chrome project).
const root = process.cwd();
const goldenDir = join(root, 'tests/golden/creative');
const update = process.env.UPDATE_GOLDEN === '1';
const media = ['sunset.png', 'city.png'];
const frame = { width: 480, height: 270 };

const blendModes = [
  'multiply',
  'screen',
  'overlay',
  'softLight',
  'hardLight',
  'add',
  'darken',
  'lighten',
  'difference',
  'exclusion',
  'colorDodge',
  'colorBurn',
];

type Build = (page: Page, ids: Map<string, string>) => Promise<number>;

/** The city over the sunset, on the top track; returns the top clip. */
async function layered(page: Page, ids: Map<string, string>, properties?: unknown) {
  const [main, top] = await clear(page);
  await run(page, { type: 'append', track: main, clip: still(ids, 'sunset.png', 60) });
  const [clip] = await run(page, {
    type: 'overwrite',
    track: top,
    at: 0,
    clip: { ...still(ids, 'city.png', 60), properties },
  });
  return clip;
}

async function addMask(page: Page, clip: number, mask: object) {
  const [id] = await run(page, { type: 'addMask', clip, mask });
  return id;
}

function fixtures(): { name: string; build: Build }[] {
  const list: { name: string; build: Build }[] = blendModes.map((mode) => ({
    name: `blend-${mode}`,
    build: async (page, ids) => {
      await layered(page, ids, { blendMode: mode });
      return 12;
    },
  }));
  list.push(
    {
      name: 'blend-under-opacity',
      build: async (page, ids) => {
        await layered(page, ids, { blendMode: 'overlay', opacity: 0.6 });
        return 12;
      },
    },
    {
      name: 'mask-rectangle',
      build: async (page, ids) => {
        const clip = await layered(page, ids);
        await addMask(page, clip, {
          ...newMask('rectangle'),
          x: 0.45,
          width: 0.5,
          height: 0.6,
          rotation: 15,
          roundness: 0.3,
          feather: 0.06,
        });
        return 12;
      },
    },
    {
      name: 'mask-ellipse-inverted',
      build: async (page, ids) => {
        const clip = await layered(page, ids);
        await addMask(page, clip, {
          ...newMask('ellipse'),
          x: 0.6,
          y: 0.45,
          width: 0.4,
          height: 0.5,
          invert: true,
          expansion: 0.03,
          feather: 0.02,
        });
        return 12;
      },
    },
    {
      name: 'mask-paths',
      build: async (page, ids) => {
        const clip = await layered(page, ids);
        await addMask(page, clip, {
          ...newMask('polygon'),
          x: 0.3,
          width: 0.45,
          height: 0.7,
          feather: 0.015,
        });
        await addMask(page, clip, {
          ...newMask('pen'),
          x: 0.72,
          y: 0.55,
          width: 0.35,
          height: 0.5,
          rotation: -20,
          points: penPoints().map((point, i) => (i === 1 ? { ...point, x: 0.8 } : point)),
        });
        return 12;
      },
    },
    {
      name: 'mask-modes',
      build: async (page, ids) => {
        const clip = await layered(page, ids);
        await addMask(page, clip, { ...newMask('ellipse'), x: 0.4, width: 0.6, height: 0.8 });
        await addMask(page, clip, {
          ...newMask('rectangle'),
          mode: 'subtract',
          x: 0.4,
          width: 0.2,
          height: 0.2,
          feather: 0.01,
        });
        await addMask(page, clip, {
          ...newMask('ellipse'),
          mode: 'intersect',
          x: 0.55,
          width: 0.6,
          height: 0.9,
          opacity: 0.8,
        });
        return 12;
      },
    },
    {
      name: 'mask-keyframed',
      build: async (page, ids) => {
        const clip = await layered(page, ids);
        const mask = await addMask(page, clip, {
          ...newMask('ellipse'),
          width: 0.3,
          height: 0.5,
          feather: 0.03,
        });
        for (const [time, x, feather] of [
          [0, 0.25, 0],
          [30, 0.75, 0.06],
        ]) {
          await run(page, {
            type: 'setKeyframe',
            clip,
            property: `masks.${mask}.x`,
            time: time * FRAME,
            value: x,
            interpolation: { kind: 'linear' },
          });
          await run(page, {
            type: 'setKeyframe',
            clip,
            property: `masks.${mask}.feather`,
            time: time * FRAME,
            value: feather,
            interpolation: { kind: 'linear' },
          });
        }
        return 12;
      },
    },
    {
      name: 'mask-after-effects',
      build: async (page, ids) => {
        const clip = await layered(page, ids);
        await run(page, {
          type: 'addEffect',
          clip,
          effect: { kind: 'gaussian-blur', params: { radius: 0.02 } },
        });
        await addMask(page, clip, { ...newMask('rectangle'), roundness: 1 });
        return 12;
      },
    },
    {
      name: 'picture-in-picture',
      build: async (page, ids) => {
        await layered(page, ids, {
          transform: pipTransform(frame, frame, 'bottomRight', 1 / 3),
        });
        return 12;
      },
    },
  );
  for (const layout of [splitLayouts[0], splitLayouts[2], splitLayouts[splitLayouts.length - 1]])
    list.push({
      name: `split-${layout.id}`,
      build: async (page, ids) => {
        const trackIds = await clear(page, layout.cells.length);
        for (const [index, cell] of layout.cells.entries()) {
          const { properties, mask } = cellProperties(frame, frame, cell);
          const [clip] = await run(page, {
            type: 'overwrite',
            track: trackIds[index],
            at: 0,
            clip: { ...still(ids, media[index % 2], 60), properties },
          });
          if (mask) await addMask(page, clip, mask);
        }
        return 12;
      },
    });
  list.push({
    name: 'ken-burns',
    build: async (page, ids) => {
      const [main] = await clear(page);
      const [clip] = await run(page, {
        type: 'append',
        track: main,
        clip: still(ids, 'sunset.png', 60),
      });
      const start = framingTransform(frame, frame, centredRect(frame, frame, 1));
      const end = framingTransform(frame, frame, { x: 0.45, y: 0.3, w: 0.5, h: 0.5 });
      for (const [time, values] of [
        [0, start],
        [30, end],
      ] as const)
        for (const [setting, value] of Object.entries(values))
          await run(page, {
            type: 'setKeyframe',
            clip,
            property: `transform.${setting}`,
            time: time * FRAME,
            value,
            interpolation: { kind: 'easeInOut' },
          });
      return 18;
    },
  });
  return list;
}

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} golden renders of blend modes, masks, layouts and Ken Burns match the references`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(300000);
    const ids = await setUp(page, backend === 'WebGL2' ? '&gpu=webgl2' : '', media);
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
    const writing = update && backend === 'WebGPU' && testInfo.project.name === 'chrome';
    const outDir = testInfo.outputPath('renders');
    mkdirSync(outDir, { recursive: true });
    if (writing) mkdirSync(goldenDir, { recursive: true });
    // The city alone over the sunset, to check every tool changes the picture.
    await layered(page, ids);
    const plain = await render(page, 12 * FRAME);

    const results: Record<string, Comparison> = {};
    const changes: Record<string, Comparison> = {};
    for (const fixture of fixtures()) {
      const at = await fixture.build(page, ids);
      const rendered = await render(page, at * FRAME);
      writeFileSync(join(outDir, fixture.name + '.png'), PNG.sync.write(rendered));
      changes[fixture.name] = compare(rendered, plain);
      const file = join(goldenDir, fixture.name + '.png');
      if (writing) {
        writeFileSync(file, PNG.sync.write(rendered));
        continue;
      }
      results[fixture.name] = compare(rendered, PNG.sync.read(readFileSync(file)));
    }
    const report = { backend, project: testInfo.project.name, tolerance, results, changes };
    await testInfo.attach('creative-comparison', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    for (const [name, change] of Object.entries(changes))
      expect(passes(change), `${name} must change the picture`).toBe(false);
    if (writing) return;
    for (const [name, result] of Object.entries(results))
      expect(passes(result), `${name}: ${JSON.stringify(result)}`).toBe(true);
  });
}

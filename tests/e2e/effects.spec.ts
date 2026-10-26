import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
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
  type Hooks,
} from './golden-tools';

// Golden renders of every built-in effect and transition, and of adjustment layers,
// keyframes and effect stacks, on both GPU backends. References come from the
// reference machine's WebGPU (UPDATE_GOLDEN=1 on the chrome project). Every catalogue
// item must have a fixture, and every effect must visibly change the picture.
const root = process.cwd();
const goldenDir = join(root, 'tests/golden/effects');
const update = process.env.UPDATE_GOLDEN === '1';

interface EffectFixture {
  name: string;
  params: Record<string, unknown>;
}
interface TransitionFixture extends EffectFixture {
  kind: string;
}
const { media, effects, transitions } = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/effects.json'), 'utf8'),
) as { media: string[]; effects: EffectFixture[]; transitions: TransitionFixture[] };

interface Catalogued {
  id: string;
  type: 'effect' | 'transition' | 'audio';
  variants?: { id: string }[];
}

/** `params` with `$look:<id>` replaced by a project LUT of that built-in look. */
async function resolve(page: Page, params: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.startsWith('$look:')) {
      const id = await page.evaluate(
        (look) => (Reflect.get(window, '__cgv') as Hooks).project.importLook(look),
        value.slice(6),
      );
      expect(id).not.toBeNull();
      out[key] = `lut-${id}`;
    } else out[key] = value;
  }
  return out;
}

/** What each fixture builds, and the frame it is shown at. */
type Build = (page: Page, ids: Map<string, string>) => Promise<number>;

function fixtures(): { name: string; build: Build; kind: 'effect' | 'transition' | 'other' }[] {
  const [first, second] = media;
  const list: { name: string; build: Build; kind: 'effect' | 'transition' | 'other' }[] = [];
  for (const fixture of effects)
    list.push({
      name: fixture.name,
      kind: 'effect',
      build: async (page, ids) => {
        const [main] = await clear(page);
        const [clip] = await run(page, {
          type: 'append',
          track: main,
          clip: still(ids, first, 60),
        });
        const params = await resolve(page, fixture.params);
        await run(page, { type: 'addEffect', clip, effect: { kind: fixture.name, params } });
        return 12;
      },
    });
  for (const fixture of transitions)
    list.push({
      name: fixture.name,
      kind: 'transition',
      build: async (page, ids) => {
        const [main] = await clear(page);
        const [a] = await run(page, { type: 'append', track: main, clip: still(ids, first, 30) });
        const [b] = await run(page, { type: 'append', track: main, clip: still(ids, second, 30) });
        await run(page, {
          type: 'addTransition',
          track: main,
          from: a,
          to: b,
          transition: { kind: fixture.kind, duration: 30 * FRAME, params: fixture.params },
        });
        return 26;
      },
    });
  list.push(
    {
      name: 'adjustment-layer',
      kind: 'other',
      build: async (page, ids) => {
        const [main, top] = await clear(page);
        await run(page, { type: 'append', track: main, clip: still(ids, first, 60) });
        const [layer] = await run(page, {
          type: 'append',
          track: top,
          clip: { kind: 'adjustment', duration: 60 * FRAME },
        });
        await run(page, { type: 'addEffect', clip: layer, effect: { kind: 'black-white' } });
        await run(page, { type: 'addEffect', clip: layer, effect: { kind: 'vignette' } });
        await run(page, {
          type: 'setClipProperties',
          clip: layer,
          properties: { opacity: 0.6 },
        });
        return 12;
      },
    },
    {
      name: 'keyframes',
      kind: 'other',
      build: async (page, ids) => {
        const [main] = await clear(page);
        const [clip] = await run(page, {
          type: 'append',
          track: main,
          clip: still(ids, first, 60),
        });
        const key = (property: string, frame: number, value: number, ease = 'easeInOut') =>
          run(page, {
            type: 'setKeyframe',
            clip,
            property,
            time: frame * FRAME,
            value,
            interpolation: { kind: ease },
          });
        await key('transform.scaleX', 0, 0.4);
        await key('transform.scaleX', 30, 1);
        await key('transform.scaleY', 0, 0.4);
        await key('transform.scaleY', 30, 1);
        await key('transform.rotation', 0, 0, 'linear');
        await key('transform.rotation', 30, 40, 'linear');
        await key('transform.x', 0, -120, 'easeOut');
        await key('transform.x', 30, 0, 'easeOut');
        const [vignette] = await run(page, {
          type: 'addEffect',
          clip,
          effect: { kind: 'vignette' },
        });
        await key(`effects.${vignette}.amount`, 0, 0, 'hold');
        await key(`effects.${vignette}.amount`, 10, 0.9, 'linear');
        return 12;
      },
    },
    {
      name: 'effect-stack',
      kind: 'other',
      build: async (page, ids) => {
        const [main] = await clear(page);
        const [clip] = await run(page, {
          type: 'append',
          track: main,
          clip: still(ids, first, 60),
        });
        for (const [kind, params] of [
          ['exposure', { stops: 0.5 }],
          ['gaussian-blur', { radius: 0.01 }],
          ['pixelate', { size: 0.08 }],
          ['vignette', { amount: 0.6 }],
        ] as const)
          await run(page, { type: 'addEffect', clip, effect: { kind, params } });
        return 12;
      },
    },
    {
      name: 'fade-in-over-a-track',
      kind: 'other',
      build: async (page, ids) => {
        const [main, top] = await clear(page);
        await run(page, { type: 'append', track: main, clip: still(ids, second, 60) });
        const [clip] = await run(page, {
          type: 'overwrite',
          track: top,
          at: 0,
          clip: still(ids, first, 60),
        });
        await run(page, {
          type: 'setClipProperties',
          clip,
          properties: {
            transform: {
              x: 60,
              y: 0,
              scaleX: 0.6,
              scaleY: 0.6,
              rotation: 10,
              anchorX: 0.5,
              anchorY: 0.5,
            },
          },
        });
        await run(page, {
          type: 'addTransition',
          track: top,
          to: clip,
          transition: { kind: 'luma-wipe', duration: 20 * FRAME, params: { gradient: 'iris' } },
        });
        return 8;
      },
    },
  );
  return list;
}

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} golden renders of every effect and transition match the references`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(600000);
    const ids = await setUp(page, backend === 'WebGL2' ? '&gpu=webgl2' : '', media);
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
    const writing = update && backend === 'WebGPU' && testInfo.project.name === 'chrome';
    const all = fixtures();

    // Every built-in effect and transition (each variant) has a fixture.
    const catalog = (await page.evaluate(() =>
      (Reflect.get(window, '__cgv') as Hooks).client.api.effectsCatalog(),
    )) as Catalogued[];
    const names = new Set(all.map((fixture) => fixture.name));
    // Sound effects have no picture to compare.
    const items = catalog
      .filter((entry) => entry.type !== 'audio')
      .flatMap((entry) =>
        entry.type === 'transition' && entry.variants?.length
          ? entry.variants.map((variant) => variant.id)
          : [entry.id],
      );
    expect(items.filter((item) => !names.has(item))).toEqual([]);
    expect(items.length).toBeGreaterThanOrEqual(40);

    const outDir = testInfo.outputPath('renders');
    mkdirSync(outDir, { recursive: true });
    if (writing) mkdirSync(goldenDir, { recursive: true });
    // The unchanged picture and the plain cut, to check every effect does something.
    const [main] = await clear(page);
    await run(page, { type: 'append', track: main, clip: still(ids, media[0], 60) });
    const plain = await render(page, 12 * FRAME);

    const results: Record<string, Comparison> = {};
    const changes: Record<string, Comparison> = {};
    for (const fixture of all) {
      const frame = await fixture.build(page, ids);
      const rendered = await render(page, frame * FRAME);
      writeFileSync(join(outDir, fixture.name + '.png'), PNG.sync.write(rendered));
      if (fixture.kind !== 'other') changes[fixture.name] = compare(rendered, plain);
      const file = join(goldenDir, fixture.name + '.png');
      if (writing) {
        writeFileSync(file, PNG.sync.write(rendered));
        continue;
      }
      results[fixture.name] = compare(rendered, PNG.sync.read(readFileSync(file)));
    }
    const report = { backend, project: testInfo.project.name, tolerance, results, changes };
    writeFileSync(testInfo.outputPath('comparison.json'), JSON.stringify(report, null, 2));
    await testInfo.attach('effects-comparison', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    for (const [name, change] of Object.entries(changes))
      expect(passes(change), `${name} must change the picture: ${JSON.stringify(change)}`).toBe(
        false,
      );
    if (writing) return;
    for (const [name, result] of Object.entries(results))
      expect(passes(result), `${name}: ${JSON.stringify(result)}`).toBe(true);
  });
}

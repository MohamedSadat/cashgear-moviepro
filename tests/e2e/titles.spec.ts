import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { PNG } from 'pngjs';
import { compare, passes, render, scenePng, tolerance, type Comparison } from './golden-tools';

// Phase 7: titles. Golden renders of English, Arabic and mixed text at several
// sizes and turns, outlines, shadows, boxes, shapes and reveals, on both GPU
// backends; the engine's layout against Chrome's own (HarfBuzz and ICU) for the
// same fonts and words; sharpness at 400% and in a 4K export; and every template
// added with one click and edited. References come from the reference machine's
// WebGPU (UPDATE_GOLDEN=1 on the chrome project).
const root = process.cwd();
const goldenDir = join(root, 'tests/golden/titles');
const resultsDir = join(root, 'bench/results');
const fontsDir = join(root, 'assets/fonts');
const FRAME = 23_520_000;
const update = process.env.UPDATE_GOLDEN === '1';
const software = process.env.GPU_TEST_SOFTWARE === '1';
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin');
const ffmpeg = join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

type Element = Record<string, unknown> & { id: number; type: 'text' | 'shape' };
interface Fixture {
  name: string;
  elements: Element[];
  /** A template in assets/titles, designed at 1920×1080 and drawn at half size. */
  template?: string;
  transform?: Record<string, number>;
}
const { fixtures } = JSON.parse(readFileSync(join(root, 'tests/fixtures/titles.json'), 'utf8')) as {
  fixtures: Fixture[];
};

type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
  project: { execute(command: unknown): Promise<{ created: number[] } | null> };
  exporter: {
    start(settings: unknown, options?: { download?: boolean }): Promise<boolean>;
    settled(): Promise<{ state: string; result?: unknown; message?: string }>;
    dismiss(): void;
  };
};

async function open(page: Page, query = '') {
  await page.goto('/?diagnostic=1' + query);
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      !['Opening…', undefined].includes(
        document.querySelector('[data-testid="project-name"]')?.textContent ?? undefined,
      ) &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
}

async function run(page: Page, command: unknown): Promise<number[]> {
  const outcome = await page.evaluate(
    (command) => (Reflect.get(window, '__cgv') as Hooks).project.execute(command),
    command,
  );
  expect(outcome, JSON.stringify(command).slice(0, 300)).not.toBeNull();
  return outcome!.created;
}

interface Snapshot {
  project: {
    media: { id: string; name: string }[];
    tracks: {
      id: number;
      clips: { id: number; kind?: string; title?: { elements: Element[] } }[];
    }[];
  };
}
const snapshot = (page: Page) =>
  page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
  ) as Promise<Snapshot>;

/** An empty project of `width` × `height` with its two tracks. */
async function clear(page: Page, width: number, height: number) {
  const clips = (await snapshot(page)).project.tracks.flatMap((t) => t.clips.map((c) => c.id));
  if (clips.length) await run(page, { type: 'delete', clips });
  await run(page, {
    type: 'setSettings',
    settings: { width, height, frameRate: { num: 30, den: 1 }, sampleRate: 48000, channels: 2 },
  });
  return (await snapshot(page)).project.tracks.map((track) => track.id);
}

/** A template's elements scaled by `k` (as the editor fits them to a project). */
function scaled(elements: Element[], k: number): Element[] {
  const n = (value: unknown) => (typeof value === 'number' ? value * k : value);
  return elements.map((e) => {
    const out: Element = { ...e, x: n(e.x), y: n(e.y) };
    for (const key of ['size', 'wrap', 'letterSpacing', 'width', 'height', 'radius'])
      if (key in e) out[key] = n(e[key]);
    const stroke = e.stroke as { width: number } | undefined;
    if (stroke) out.stroke = { ...stroke, width: stroke.width * k };
    const shadow = e.shadow as { x: number; y: number; blur: number } | undefined;
    if (shadow) out.shadow = { ...shadow, x: shadow.x * k, y: shadow.y * k, blur: shadow.blur * k };
    const box = e.background as { padding: number; radius?: number } | undefined;
    if (box) out.background = { ...box, padding: box.padding * k, radius: (box.radius ?? 0) * k };
    return out;
  });
}

async function importSunset(page: Page) {
  await page.getByTestId('media-file-input').setInputFiles({
    name: 'sunset.png',
    mimeType: 'image/png',
    buffer: scenePng('sunset'),
  });
  await expect(page.locator('[data-testid="media-item"][data-name="sunset.png"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 60000 },
  );
  return (await snapshot(page)).project.media.find((m) => m.name === 'sunset.png')!.id;
}

function record(name: string, testInfo: TestInfo, value: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const text = JSON.stringify(value, null, 2);
  writeFileSync(join(resultsDir, `${name}-${testInfo.project.name}.json`), text + '\n');
  return testInfo.attach(name, { body: text, contentType: 'application/json' });
}

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} golden renders of titles match the references`, async ({ page }, testInfo) => {
    test.setTimeout(300000);
    await open(page, backend === 'WebGL2' ? '&gpu=webgl2' : '');
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
    const writing = update && backend === 'WebGPU' && testInfo.project.name === 'chrome';
    const sunset = await importSunset(page);
    const outDir = testInfo.outputPath('renders');
    mkdirSync(outDir, { recursive: true });
    if (writing) mkdirSync(goldenDir, { recursive: true });
    const results: Record<string, Comparison> = {};
    for (const fixture of fixtures) {
      const [main, top] = await clear(page, 960, 540);
      await run(page, {
        type: 'append',
        track: main,
        clip: { media: sunset, duration: 60 * FRAME },
      });
      const elements = fixture.template
        ? scaled(
            JSON.parse(
              readFileSync(join(root, 'assets/titles', fixture.template + '.json'), 'utf8'),
            ).elements,
            0.5,
          )
        : fixture.elements;
      const [clip] = await run(page, {
        type: 'append',
        track: top,
        clip: { kind: 'title', duration: 60 * FRAME, title: { elements } },
      });
      if (fixture.transform)
        await run(page, {
          type: 'setClipProperties',
          clip,
          properties: { transform: fixture.transform },
        });
      const rendered = await render(page, 12 * FRAME);
      writeFileSync(join(outDir, fixture.name + '.png'), PNG.sync.write(rendered));
      const file = join(goldenDir, fixture.name + '.png');
      if (writing) {
        writeFileSync(file, PNG.sync.write(rendered));
        continue;
      }
      results[fixture.name] = compare(rendered, PNG.sync.read(readFileSync(file)));
    }
    const report = { backend, project: testInfo.project.name, tolerance, results };
    await testInfo.attach('titles-comparison', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    await record(`titles-golden-${backend.toLowerCase()}`, testInfo, report);
    if (writing) return;
    const failing = Object.entries(results).filter(([, result]) => !passes(result));
    expect(failing, JSON.stringify(failing)).toEqual([]);
  });
}

/** Words drawn by the engine and by Chrome's canvas with the same font file. */
const layouts: {
  name: string;
  text: string;
  family: string;
  file: string;
  weight: number;
  rtl: boolean;
}[] = [
  {
    name: 'english',
    text: 'Hello World',
    family: 'Inter',
    file: 'inter/Inter-Variable.ttf',
    weight: 700,
    rtl: false,
  },
  {
    name: 'arabic',
    text: 'مرحبا بالعالم',
    family: 'Cairo',
    file: 'cairo/Cairo-Variable.ttf',
    weight: 700,
    rtl: true,
  },
  {
    name: 'mixed-latin-first',
    text: 'Hi مرحبا 42',
    family: 'Cairo',
    file: 'cairo/Cairo-Variable.ttf',
    weight: 700,
    rtl: false,
  },
  {
    name: 'mixed-arabic-first',
    text: 'مرحبا Hello 2026',
    family: 'Cairo',
    file: 'cairo/Cairo-Variable.ttf',
    weight: 700,
    rtl: true,
  },
  {
    name: 'naskh-dots',
    text: 'السلام عليكم',
    family: 'Noto Naskh Arabic',
    file: 'noto-naskh-arabic/NotoNaskhArabic-Variable.ttf',
    weight: 400,
    rtl: true,
  },
  {
    name: 'lam-alef',
    text: 'لا إله إلا',
    family: 'Noto Naskh Arabic',
    file: 'noto-naskh-arabic/NotoNaskhArabic-Variable.ttf',
    weight: 400,
    rtl: true,
  },
  {
    name: 'harakat',
    text: 'مُحَمَّدٌ رَسُولُ',
    family: 'Amiri',
    file: 'amiri/Amiri-Regular.ttf',
    weight: 400,
    rtl: true,
  },
  {
    name: 'arabic-digits',
    text: 'كتاب ١٢٣ book',
    family: 'Amiri',
    file: 'amiri/Amiri-Regular.ttf',
    weight: 400,
    rtl: true,
  },
  {
    name: 'kufi-mixed',
    text: 'عرض CashGear خاص',
    family: 'Noto Kufi Arabic',
    file: 'noto-kufi-arabic/NotoKufiArabic-Variable.ttf',
    weight: 600,
    rtl: true,
  },
];

/** Ink of a white-on-black RGBA picture: true where it is more than half lit. */
function ink(data: Uint8Array, width: number, height: number) {
  const mask = new Uint8Array(width * height);
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (data[at] + data[at + 1] + data[at + 2] > 3 * 127) {
        mask[y * width + x] = 1;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  return { mask, left, right, top, bottom, width, height };
}

/**
 * How two ink masks agree once their bounds' corners are matched: the share of
 * each one's ink within a pixel of the other's (two rasterisers place edges a
 * fraction of a pixel apart), and the plain intersection over union.
 */
function agreement(a: ReturnType<typeof ink>, b: ReturnType<typeof ink>) {
  const dx = b.left - a.left;
  const dy = b.top - a.top;
  const at = (m: ReturnType<typeof ink>, x: number, y: number) =>
    x >= 0 && y >= 0 && x < m.width && y < m.height && m.mask[y * m.width + x] === 1;
  const near = (m: ReturnType<typeof ink>, x: number, y: number) => {
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) if (at(m, x + ox, y + oy)) return true;
    return false;
  };
  let inkA = 0;
  let inkB = 0;
  let aNearB = 0;
  let bNearA = 0;
  let both = 0;
  let either = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const inA = at(a, x, y);
      const inB = at(b, x + dx, y + dy);
      if (inA) {
        inkA++;
        if (near(b, x + dx, y + dy)) aNearB++;
      }
      if (inB) {
        inkB++;
        if (near(a, x, y)) bNearA++;
      }
      if (inA && inB) both++;
      if (inA || inB) either++;
    }
  return {
    matched: Math.min(aNearB / Math.max(1, inkA), bNearA / Math.max(1, inkB)),
    iou: either ? both / either : 1,
  };
}

test('mixed Arabic and English titles shape and order as Chrome lays them out', async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await open(page);
  const width = 1600;
  const height = 300;
  const results: Record<
    string,
    { iou: number; widths: [number, number]; heights: [number, number] }
  > = {};
  for (const sample of layouts) {
    const [, top] = await clear(page, width, height);
    await run(page, {
      type: 'append',
      track: top,
      clip: {
        kind: 'title',
        duration: 30 * FRAME,
        title: {
          elements: [
            {
              id: 1,
              x: 0,
              y: 0,
              fill: { r: 1, g: 1, b: 1 },
              type: 'text',
              text: sample.text,
              font: { family: sample.family, weight: sample.weight },
              size: 96,
            },
          ],
        },
      },
    });
    const ours = await render(page, 5 * FRAME);
    // Chrome's own text: the same file as a FontFace, on a canvas.
    const bytes = readFileSync(join(fontsDir, sample.file)).toString('base64');
    const theirs = await page.evaluate(
      async ({ bytes, sample, width, height }) => {
        const data = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
        const face = new FontFace(`Reference ${sample.name}`, data, {
          weight: sample.family === 'Amiri' ? '400' : '100 900',
        });
        await face.load();
        document.fonts.add(face);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#fff';
        ctx.font = `${sample.weight} 96px "Reference ${sample.name}"`;
        ctx.direction = sample.rtl ? 'rtl' : 'ltr';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(sample.text, width / 2, height / 2);
        const pixels = ctx.getImageData(0, 0, width, height).data;
        let text = '';
        for (let i = 0; i < pixels.length; i += 0x8000)
          text += String.fromCharCode(...pixels.subarray(i, i + 0x8000));
        return btoa(text);
      },
      { bytes, sample, width, height },
    );
    const reference = new Uint8Array(Buffer.from(theirs, 'base64'));
    const a = ink(ours.data, width, height);
    const b = ink(reference, width, height);
    const png = new PNG({ width, height });
    png.data = Buffer.from(reference);
    writeFileSync(testInfo.outputPath(`${sample.name}-chrome.png`), PNG.sync.write(png));
    writeFileSync(testInfo.outputPath(`${sample.name}-engine.png`), PNG.sync.write(ours));
    results[sample.name] = {
      ...agreement(a, b),
      widths: [a.right - a.left + 1, b.right - b.left + 1],
      heights: [a.bottom - a.top + 1, b.bottom - b.top + 1],
    };
  }
  await record('title-layout', testInfo, results);
  // A wrong order, form or mark moves whole letters: far more than a pixel.
  for (const [name, result] of Object.entries(results)) {
    expect(result.matched, name).toBeGreaterThan(0.98);
    expect(Math.abs(result.widths[0] - result.widths[1]), name).toBeLessThanOrEqual(2);
    expect(Math.abs(result.heights[0] - result.heights[1]), name).toBeLessThanOrEqual(2);
  }
});

/** The pixels from 10% to 90% across an edge of light ink on black, along `row`. */
function edgeWidth(data: Uint8Array, width: number, row: number, from = 0): number {
  const lum = (x: number) => {
    const at = (row * width + x) * 4;
    return (data[at] + data[at + 1] + data[at + 2]) / 3;
  };
  let peak = 0;
  for (let x = from; x < width; x++) peak = Math.max(peak, lum(x));
  let x = from;
  while (x < width && lum(x) < 0.1 * peak) x++;
  const start = x;
  while (x < width && lum(x) < 0.9 * peak) x++;
  return x - start + 1;
}

test('text stays sharp at 400% while a picture of it blurs', async ({ page }, testInfo) => {
  await open(page);
  const [, top] = await clear(page, 1920, 1080);
  const element = {
    id: 1,
    x: 0,
    y: 0,
    fill: { r: 1, g: 1, b: 1 },
    type: 'text',
    text: 'I',
    font: { family: 'Inter', weight: 700 },
    size: 120,
  };
  const [clip] = await run(page, {
    type: 'append',
    track: top,
    clip: { kind: 'title', duration: 30 * FRAME, title: { elements: [element] } },
  });
  const at1 = await render(page, 5 * FRAME);
  const one = edgeWidth(at1.data, 1920, 540);
  await run(page, {
    type: 'setClipProperties',
    clip,
    properties: { transform: { scaleX: 4, scaleY: 4 } },
  });
  const at4 = await render(page, 5 * FRAME);
  const four = edgeWidth(at4.data, 1920, 540);
  // The control: a picture of the same frame, scaled up 4× by the GPU.
  await run(page, { type: 'delete', clips: [clip] });
  await page.getByTestId('media-file-input').setInputFiles({
    name: 'letter.png',
    mimeType: 'image/png',
    buffer: PNG.sync.write(at1),
  });
  await expect(page.locator('[data-testid="media-item"][data-name="letter.png"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 60000 },
  );
  const letter = (await snapshot(page)).project.media.find((m) => m.name === 'letter.png')!.id;
  const [still] = await run(page, {
    type: 'append',
    track: top,
    clip: { media: letter, duration: 30 * FRAME },
  });
  await run(page, {
    type: 'setClipProperties',
    clip: still,
    properties: { transform: { scaleX: 4, scaleY: 4 } },
  });
  const blurred = await render(page, 5 * FRAME);
  const control = edgeWidth(blurred.data, 1920, 540);
  writeFileSync(testInfo.outputPath('title-400.png'), PNG.sync.write(at4));
  writeFileSync(testInfo.outputPath('picture-400.png'), PNG.sync.write(blurred));
  await record('title-sharpness', testInfo, { edge1x: one, edge4x: four, picture4x: control });
  expect(one).toBeLessThanOrEqual(2);
  expect(four).toBeLessThanOrEqual(2);
  expect(control).toBeGreaterThanOrEqual(4);
});

test('a 4K export keeps title edges sharp', async ({ page }, testInfo) => {
  test.skip(
    !existsSync(ffmpeg) && process.env.CGV_REQUIRE_FFMPEG !== '1',
    'FFmpeg is missing: run pnpm setup:ffmpeg',
  );
  test.setTimeout(software ? 10 * 60_000 : 3 * 60_000);
  await open(page);
  const [, top] = await clear(page, 3840, 2160);
  await run(page, {
    type: 'append',
    track: top,
    clip: {
      kind: 'title',
      duration: 30 * FRAME,
      title: {
        elements: [
          {
            id: 1,
            x: 0,
            y: 0,
            fill: { r: 1, g: 1, b: 1 },
            type: 'text',
            text: 'Hi 4K عنوان',
            font: { family: 'Cairo', weight: 700 },
            size: 240,
          },
        ],
      },
    },
  });
  const file = testInfo.outputPath('title-4k.mp4');
  const download = page.waitForEvent('download', { timeout: 10 * 60_000 });
  const started = await page.evaluate(
    (settings) =>
      (Reflect.get(window, '__cgv') as Hooks).exporter.start(settings, { download: true }),
    {
      format: 'mp4',
      width: 3840,
      height: 2160,
      frameRate: { num: 30, den: 1 },
      video: { codec: 'avc', bitrate: 60e6 },
      audio: null,
    },
  );
  expect(started).toBe(true);
  const status = await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).exporter.settled(),
  );
  expect(status, JSON.stringify(status)).toMatchObject({ state: 'done' });
  await (await download).saveAs(file);
  // Frame 15's luma, as the file stores it.
  const luma = spawnSync(
    ffmpeg,
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      'select=eq(n\\,15),format=gray',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 1 << 28 },
  ).stdout as Buffer;
  expect(luma.length).toBe(3840 * 2160);
  const rgba = new Uint8Array(3840 * 2160 * 4);
  for (let i = 0; i < luma.length; i++) rgba.fill(luma[i], i * 4, i * 4 + 3);
  // The left edge of the first letter's stem, along the middle row.
  const exported = edgeWidth(rgba, 3840, 1080);
  const preview = await render(page, 15 * FRAME);
  const drawn = edgeWidth(preview.data, 3840, 1080);
  await record('title-4k-sharpness', testInfo, { exported, preview: drawn });
  expect(drawn).toBeLessThanOrEqual(2);
  // H.264 keeps a step within three pixels at this bitrate.
  expect(exported).toBeLessThanOrEqual(3);
});

test('every title template adds with one click and stays editable', async ({ page }, testInfo) => {
  test.setTimeout(240000);
  await open(page);
  await page.getByTestId('library-tab-titles').click();
  const items = page.getByTestId('title-item');
  await expect(items.first()).toBeVisible();
  const ids = await items.evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.key!));
  const templates = ids.filter((id) => !id.startsWith('shape-'));
  expect(templates).toHaveLength(30);
  const timings: Record<string, number> = {};
  for (const id of ids) {
    const before = (await snapshot(page)).project.tracks.flatMap((t) => t.clips).length;
    const started = Date.now();
    await page.locator(`[data-testid="title-item"][data-key="${id}"]`).dblclick();
    await expect
      .poll(async () => (await snapshot(page)).project.tracks.flatMap((t) => t.clips).length)
      .toBe(before + 1);
    timings[id] = Date.now() - started;
    // Selected and shown in the inspector, with its elements.
    await expect(page.getByTestId('title-elements')).toBeVisible();
    const clip = (await snapshot(page)).project.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.kind === 'title')!;
    const text = clip.title!.elements.find((e) => e.type === 'text');
    if (text) {
      await page.locator(`[data-testid="title-element"][data-element-id="${text.id}"]`).click();
      const box = page.getByTestId('title-text');
      await box.fill(`Edited ${id}`);
      await box.blur();
      await expect
        .poll(async () => {
          const now = (await snapshot(page)).project.tracks
            .flatMap((t) => t.clips)
            .find((c) => c.id === clip.id);
          return now?.title?.elements.some((e) => e.text === `Edited ${id}`);
        })
        .toBe(true);
    }
    // It draws: the frame a second and a half in is not black.
    const frame = await render(page, clip.start + 45 * FRAME);
    let lit = 0;
    for (let i = 0; i < frame.data.length; i += 4)
      if (frame.data[i] + frame.data[i + 1] > 60) lit++;
    expect(lit, id).toBeGreaterThan(200);
    await run(page, { type: 'delete', clips: [clip.id] });
  }
  await record('title-templates', testInfo, {
    count: templates.length,
    shapes: ids.length - 30,
    timings,
  });
});

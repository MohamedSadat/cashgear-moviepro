import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { FRAME, clear, render, run, type Pixels } from './golden-tools';

// A file's colour interpretation. A chart encoded with the BT.601 matrix but tagged
// BT.709, and one in full range but tagged limited, match honestly tagged
// references within one 8-bit level once their interpretation is corrected, in the
// monitor on both backends and in exports. The charts are drawn and encoded here by
// the pinned FFmpeg, losslessly, so nothing else moves the levels.
const root = process.cwd();
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin');
const ffmpeg = join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const WIDTH = 640;
const HEIGHT = 360;

test.skip(
  !existsSync(ffmpeg) && process.env.CGV_REQUIRE_FFMPEG !== '1',
  'FFmpeg is missing: run pnpm setup:ffmpeg',
);

interface Tags {
  /** What the samples really are. */
  matrix: string;
  range: 'tv' | 'pc';
  /** What the file says they are. */
  taggedMatrix: string;
  taggedRange: 'tv' | 'pc';
}

const clips: Record<string, Tags> = {
  'bt601-true.webm': { matrix: 'bt601', range: 'tv', taggedMatrix: 'smpte170m', taggedRange: 'tv' },
  'bt601-as-709.webm': { matrix: 'bt601', range: 'tv', taggedMatrix: 'bt709', taggedRange: 'tv' },
  'full-true.webm': { matrix: 'bt709', range: 'pc', taggedMatrix: 'bt709', taggedRange: 'pc' },
  'full-as-limited.webm': {
    matrix: 'bt709',
    range: 'pc',
    taggedMatrix: 'bt709',
    taggedRange: 'tv',
  },
};

/** Saturated and mid colours in flat bars: big enough that no filter reaches their middles. */
const colours = [
  [191, 191, 191],
  [191, 191, 0],
  [0, 191, 191],
  [0, 191, 0],
  [191, 0, 191],
  [191, 0, 0],
  [0, 0, 191],
  [90, 140, 200],
];

function chart(): Buffer {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const colour = colours[Math.floor((x * colours.length) / WIDTH)];
      const at = (y * WIDTH + x) * 4;
      png.data[at] = colour[0];
      png.data[at + 1] = colour[1];
      png.data[at + 2] = colour[2];
      png.data[at + 3] = 255;
    }
  return PNG.sync.write(png);
}

/** Encodes the chart losslessly with these samples, under these tags. */
function makeClips(dir: string) {
  mkdirSync(dir, { recursive: true });
  const source = join(dir, 'chart.png');
  if (!existsSync(source)) writeFileSync(source, chart());
  return Object.entries(clips).map(([name, tags]) => {
    const file = join(dir, name);
    if (existsSync(file)) return file;
    const made = spawnSync(
      ffmpeg,
      [
        '-v',
        'error',
        '-y',
        '-loop',
        '1',
        '-i',
        source,
        '-t',
        '1',
        '-r',
        '30',
        '-vf',
        `scale=in_range=pc:out_color_matrix=${tags.matrix}:out_range=${tags.range},format=yuv420p,` +
          `setparams=colorspace=${tags.taggedMatrix}:range=${tags.taggedRange}:color_primaries=bt709:color_trc=bt709`,
        '-c:v',
        'libvpx-vp9',
        '-lossless',
        '1',
        '-cpu-used',
        '8',
        '-row-mt',
        '1',
        '-color_range',
        tags.taggedRange,
        '-colorspace',
        tags.taggedMatrix,
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        file,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (made.status !== 0) throw new Error(`FFmpeg failed: ${made.stderr}`);
    return file;
  });
}

async function open(page: Page, query: string, files: string[]) {
  await page.goto('/?diagnostic=1' + query);
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
  await page.getByTestId('media-file-input').setInputFiles(files);
  for (const name of Object.keys(clips))
    await expect(page.locator(`[data-testid="media-item"][data-name="${name}"]`)).toHaveAttribute(
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
  const ids = new Map<string, string>(
    project.media.map((media: { name: string; id: string }) => [media.name, media.id]),
  );
  return { main, ids };
}

/** Each bar's colour at its middle. */
function bars(pixels: Pixels): number[][] {
  return Array.from({ length: 8 }, (_, bar) => {
    const x = Math.floor(((bar + 0.5) * pixels.width) / 8);
    const at = (Math.floor(pixels.height / 2) * pixels.width + x) * 4;
    return [pixels.data[at], pixels.data[at + 1], pixels.data[at + 2]];
  });
}

/** The largest difference of any channel of any bar. */
function difference(a: number[][], b: number[][]) {
  return Math.max(...a.flatMap((bar, i) => bar.map((value, c) => Math.abs(value - b[i][c]))));
}

/** Shows `name` alone and reads its bars. */
async function shown(page: Page, main: number, ids: Map<string, string>, name: string) {
  const { project } = await page.evaluate(() =>
    Reflect.get(window, '__cgv').client.api.projectSnapshot(),
  );
  const existing = project.tracks[0].clips.map((clip: { id: number }) => clip.id);
  if (existing.length) await run(page, { type: 'delete', clips: existing });
  await run(page, {
    type: 'append',
    track: main,
    clip: { media: ids.get(name), duration: 15 * FRAME, audio: false },
  });
  return bars(await render(page, 5 * FRAME));
}

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} a file's colour reads as it is set to, whatever its tags say`, async ({
    page,
  }, testInfo) => {
    const files = makeClips(join(testInfo.project.outputDir, 'colour-tags'));
    const { main, ids } = await open(page, backend === 'WebGL2' ? '&gpu=webgl2' : '', files);
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);

    // The wrong matrix shows, and setting the right one mends it.
    const trueMatrix = await shown(page, main, ids, 'bt601-true.webm');
    console.log(`${backend} reference: off the chart by ${difference(trueMatrix, colours)}`);
    expect(difference(trueMatrix, colours)).toBeLessThanOrEqual(2);
    const wrongMatrix = await shown(page, main, ids, 'bt601-as-709.webm');
    console.log(`${backend} wrong matrix: off by ${difference(wrongMatrix, trueMatrix)}`);
    expect(difference(wrongMatrix, trueMatrix)).toBeGreaterThan(8);
    await run(page, {
      type: 'setMediaColour',
      media: ids.get('bt601-as-709.webm'),
      colour: { matrix: 'bt601' },
    });

    // It is one undo step, there and back.
    const settings = async () => {
      const state = await page.evaluate(() =>
        Reflect.get(window, '__cgv').client.api.projectSnapshot(),
      );
      return Object.keys(state.project.mediaColour ?? {}).length;
    };
    await page.getByTestId('undo').click();
    await expect.poll(settings).toBe(0);
    await page.getByTestId('redo').click();
    await expect.poll(settings).toBe(1);

    const mended = await shown(page, main, ids, 'bt601-as-709.webm');
    console.log(`${backend} mended matrix: off by ${difference(mended, trueMatrix)}`);
    expect(difference(mended, trueMatrix)).toBeLessThanOrEqual(1);

    // The same for range.
    const trueRange = await shown(page, main, ids, 'full-true.webm');
    console.log(
      `${backend} full-range reference: off the chart by ${difference(trueRange, colours)}`,
    );
    expect(difference(trueRange, colours)).toBeLessThanOrEqual(2);
    const wrongRange = await shown(page, main, ids, 'full-as-limited.webm');
    console.log(`${backend} wrong range: off by ${difference(wrongRange, trueRange)}`);
    expect(difference(wrongRange, trueRange)).toBeGreaterThan(8);
    await run(page, {
      type: 'setMediaColour',
      media: ids.get('full-as-limited.webm'),
      colour: { fullRange: true },
    });
    const mendedRange = await shown(page, main, ids, 'full-as-limited.webm');
    console.log(`${backend} mended range: off by ${difference(mendedRange, trueRange)}`);
    expect(difference(mendedRange, trueRange)).toBeLessThanOrEqual(1);
  });
}

test("the inspector sets a file's colour, as one undo step", async ({ page }, testInfo) => {
  const files = makeClips(join(testInfo.project.outputDir, 'colour-tags'));
  const { main, ids } = await open(page, '', files);
  await shown(page, main, ids, 'bt601-as-709.webm');
  const canvas = page.getByTestId('timeline-canvas');
  const box = (await canvas.boundingBox())!;
  const { scale, scrollTime } = await canvas.evaluate((element) => ({
    scale: Number((element as HTMLElement).dataset.scale),
    scrollTime: Number((element as HTMLElement).dataset.scrollTime),
  }));
  const header = (await page.locator('[data-testid="track"][data-main="true"]').boundingBox())!;
  await page.mouse.click(
    box.x + ((5 * FRAME - scrollTime) / 705_600_000) * scale,
    header.y + header.height / 2 + 8,
  );
  const colour = async () => {
    const state = await page.evaluate(() =>
      Reflect.get(window, '__cgv').client.api.projectSnapshot(),
    );
    return state.project.mediaColour?.[ids.get('bt601-as-709.webm')!] ?? null;
  };
  await page.getByLabel('File colour matrix').selectOption('bt601');
  await expect.poll(colour).toEqual({ matrix: 'bt601' });
  await page.getByLabel('File colour range').selectOption('full');
  await expect.poll(colour).toEqual({ matrix: 'bt601', fullRange: true });
  await page.getByTestId('undo').click();
  await expect.poll(colour).toEqual({ matrix: 'bt601' });
  // Going back to the tags leaves no setting behind.
  await page.getByLabel('File colour matrix').selectOption('');
  await expect.poll(colour).toBeNull();
});

test('an export reads the colour as it is set to', async ({ page }, testInfo) => {
  test.setTimeout(360000);
  const dir = join(testInfo.project.outputDir, 'colour-tags');
  const files = makeClips(dir);
  const { main, ids } = await open(page, '', files);
  await run(page, {
    type: 'setMediaColour',
    media: ids.get('bt601-as-709.webm'),
    colour: { matrix: 'bt601' },
  });
  await run(page, {
    type: 'setMediaColour',
    media: ids.get('full-as-limited.webm'),
    colour: { fullRange: true },
  });

  /**
   * Exports `name` alone and reads each bar's Y'CbCr from the file's planes. FFmpeg's
   * conversion to RGB rounds differently from one saturated bar to the next, by more
   * than the difference this measures.
   */
  const exported = async (name: string) => {
    await shown(page, main, ids, name);
    const download = page.waitForEvent('download', { timeout: 180000 });
    const started = await page.evaluate(
      (settings) => Reflect.get(window, '__cgv').exporter.start(settings, { download: true }),
      {
        format: 'webm',
        width: WIDTH,
        height: HEIGHT,
        frameRate: { num: 30, den: 1 },
        video: { codec: 'vp9', bitrate: 40e6 },
        audio: null,
      },
    );
    expect(started).toBe(true);
    const status = await page.evaluate(() => Reflect.get(window, '__cgv').exporter.settled());
    expect(status, JSON.stringify(status)).toMatchObject({ state: 'done' });
    const file = join(dir, `${name}.export.webm`);
    await (await download).saveAs(file);
    await page.evaluate(() => Reflect.get(window, '__cgv').exporter.dismiss());
    const frame = join(dir, `${name}.export.yuv`);
    const decoded = spawnSync(
      ffmpeg,
      [
        '-v',
        'error',
        '-y',
        '-i',
        file,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        frame,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (decoded.status !== 0) throw new Error(`FFmpeg failed: ${decoded.stderr}`);
    const planes = readFileSync(frame);
    const chroma = (WIDTH / 2) * (HEIGHT / 2);
    return Array.from({ length: 8 }, (_, bar) => {
      const x = Math.floor(((bar + 0.5) * WIDTH) / 8);
      const y = Math.floor(HEIGHT / 2);
      const at = Math.floor(y / 2) * (WIDTH / 2) + Math.floor(x / 2);
      return [
        planes[y * WIDTH + x],
        planes[WIDTH * HEIGHT + at],
        planes[WIDTH * HEIGHT + chroma + at],
      ];
    });
  };
  /** What the chart's bars are in BT.709 limited range, which exports are. */
  const chartPlanes = colours.map(([r, g, b]) => {
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return [
      Math.round(16 + 219 * luma),
      Math.round(128 + (224 * (b / 255 - luma)) / 1.8556),
      Math.round(128 + (224 * (r / 255 - luma)) / 1.5748),
    ];
  });
  const reference = await exported('bt601-true.webm');
  const mended = await exported('bt601-as-709.webm');
  console.log(
    `Export, mended matrix: off by ${difference(mended, reference)}, ` +
      `off the chart by ${difference(mended, chartPlanes)}`,
  );
  expect(difference(mended, reference)).toBeLessThanOrEqual(1);
  expect(difference(mended, chartPlanes)).toBeLessThanOrEqual(2);
  const rangeReference = await exported('full-true.webm');
  const mendedRange = await exported('full-as-limited.webm');
  console.log(
    `Export, mended range: off by ${difference(mendedRange, rangeReference)}, ` +
      `off the chart by ${difference(mendedRange, chartPlanes)}`,
  );
  expect(difference(mendedRange, rangeReference)).toBeLessThanOrEqual(1);
  expect(difference(mendedRange, chartPlanes)).toBeLessThanOrEqual(2);
});

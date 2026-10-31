import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { deepClips, distinctLevels, encodeRamp, rampFrames, rampLevels } from './deep-colour';

// 10-bit media (deep-colour.ts): which decoders the browser has for each codec,
// what pixel format their frames come in, and how many of the ramp's 877 luma
// levels reach the composition, read back at 8 bits as the preview shows it and
// at 10 bits as a 10-bit export reads it. Software decoders give 10-bit planes,
// which must keep at least 95% of the levels on both backends; hardware decoders
// hand their frames over at 8 bits (decisions, 2026-11-01), which is recorded.
// Results go to bench/results/deep-colour-*.json.
const root = process.cwd();
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin');
const ffmpeg = join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const FRAME = 23_520_000;
const sizes = [
  [1920, 1080],
  [3840, 2160],
] as const;

test.skip(
  !existsSync(ffmpeg) && process.env.CGV_REQUIRE_FFMPEG !== '1',
  'FFmpeg is missing: run pnpm setup:ffmpeg',
);

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

let made: string[] | null = null;

/** The ramp in every codec at 1080p and 4K, made once per run. */
function testSet(dir: string) {
  if (made) return made;
  mkdirSync(dir, { recursive: true });
  made = [];
  for (const [width, height] of sizes)
    for (const clip of deepClips) {
      const file = join(dir, `${height}p-${clip.name}`);
      encodeRamp(ffmpeg, clip, width, height, file);
      made.push(file);
    }
  return made;
}

interface Measured {
  name: string;
  status: string;
  format?: string | null;
  colorSpace?: unknown;
  /** Distinct green levels along the middle row of the composition, read back at 8 bits. */
  levels8?: number;
  /** Distinct luma codes along the middle row of a 10-bit 4:2:2 readback. */
  levels10?: number;
  error?: string;
}

const cases = [
  { decode: 'software', backend: 'WebGPU' },
  { decode: 'software', backend: 'WebGL2' },
  { decode: 'hardware', backend: 'WebGPU' },
] as const;

for (const { decode, backend } of cases) {
  test(`10-bit media in ${decode} decoders on ${backend}: the levels that reach the composition`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(300000);
    const files = testSet(join(testInfo.project.outputDir, 'deep-colour'));
    await page.goto(
      `/?diagnostic=1&decode=${decode}` + (backend === 'WebGL2' ? '&gpu=webgl2' : ''),
    );
    await page.waitForFunction(
      () =>
        !!Reflect.get(window, '__cgv')?.client &&
        document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy ===
          'false',
    );
    await page.getByTestId('media-file-input').setInputFiles(files);
    const settled = ['ready', 'unsupported', 'proxyReady', 'proxyFailed', 'failed'];
    for (const file of files) {
      const name = file.slice(file.lastIndexOf(file.includes('\\') ? '\\' : '/') + 1);
      await expect
        .poll(
          () =>
            page
              .locator(`[data-testid="media-item"][data-name="${name}"]`)
              .getAttribute('data-status'),
          { timeout: 60000 },
        )
        .toMatch(new RegExp(`^(${settled.join('|')})$`));
    }
    const media = (
      (await page.evaluate(() =>
        (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
      )) as { project: { media: { id: string; name: string }[] } }
    ).project.media;
    const statuses = new Map(
      await Promise.all(
        files.map(async (file) => {
          const name = file.slice(file.lastIndexOf(file.includes('\\') ? '\\' : '/') + 1);
          const status = await page
            .locator(`[data-testid="media-item"][data-name="${name}"]`)
            .getAttribute('data-status');
          return [name, status ?? 'missing'] as const;
        }),
      ),
    );

    const measured: Measured[] = [];
    for (const { id, name } of media) {
      const entry: Measured = { name, status: statuses.get(name) ?? 'missing' };
      measured.push(entry);
      if (entry.status !== 'ready' && entry.status !== 'proxyReady') continue;
      try {
        const frame = (await page.evaluate(
          (id) => (Reflect.get(window, '__cgv') as Hooks).client.api.readFrame(id, 0),
          id,
        )) as { format: string | null; colorSpace: unknown };
        entry.format = frame.format;
        entry.colorSpace = frame.colorSpace;
        const [width, height] = name.startsWith('2160p') ? sizes[1] : sizes[0];
        await run(page, {
          type: 'setSettings',
          settings: {
            width,
            height,
            frameRate: { num: 30, den: 1 },
            sampleRate: 48000,
            channels: 2,
          },
        });
        const tracks = (
          (await page.evaluate(() =>
            (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
          )) as { project: { tracks: { id: number; clips: { id: number }[] }[] } }
        ).project.tracks;
        const clips = tracks.flatMap((track) => track.clips.map((clip) => clip.id));
        if (clips.length) await run(page, { type: 'delete', clips });
        await run(page, {
          type: 'append',
          track: tracks[0].id,
          clip: { media: id, duration: rampFrames * FRAME, audio: false },
        });
        const rows = await page.evaluate(
          async ([width, height]) => {
            const api = (Reflect.get(window, '__cgv') as Hooks).client.api;
            const pixels = (await api.renderPixels(0)) as { width: number; data: Uint8Array };
            const y = Math.floor(height / 2);
            const eight = Array.from(
              { length: pixels.width },
              (_, x) => pixels.data[(y * pixels.width + x) * 4 + 1],
            );
            const deep = (await api.renderYuv10(0, width, height, 'yuv422p10le')) as {
              data: Uint8Array;
            };
            const luma = new Uint16Array(deep.data.buffer, deep.data.byteOffset, width * height);
            return { eight, ten: Array.from(luma.subarray(y * width, (y + 1) * width)) };
          },
          [width, height],
        );
        entry.levels8 = distinctLevels(rows.eight);
        entry.levels10 = distinctLevels(rows.ten);
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
      }
    }
    console.log(JSON.stringify(measured, null, 2));
    const out = join(root, 'bench/results');
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, `deep-colour-${decode}-${backend.toLowerCase()}-${testInfo.project.name}.json`),
      JSON.stringify({ rampLevels, decode, backend, measured }, null, 2) + '\n',
    );
    const decoded = measured.filter((m) => m.status === 'ready');
    expect(decoded.length, 'VP9 and AV1 decode on the web').toBeGreaterThanOrEqual(4);
    for (const m of decoded) {
      expect(m.error, m.name).toBeUndefined();
      // Through 8 bits the ramp keeps at most 256 levels.
      expect(m.levels8!, m.name).toBeLessThanOrEqual(256);
      if (m.format?.includes('P10'))
        expect(m.levels10!, m.name).toBeGreaterThanOrEqual(Math.ceil(0.95 * rampLevels));
    }
    if (decode === 'software') for (const m of decoded) expect(m.format, m.name).toBe('I420P10');
  });
}

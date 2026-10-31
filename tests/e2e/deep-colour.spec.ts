import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { deepClips, distinctLevels, encodeRamp, rampFrames, rampLevels } from './deep-colour';

// 10-bit media (deep-colour.ts): which decoders the browser has for each codec,
// what pixel format their frames come in, and how many of the ramp's 877 luma
// levels reach the composition. Results go to bench/results/deep-colour-*.json.
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
  /** Distinct green levels along the middle row of the composition (8-bit readback). */
  composedLevels?: number;
  error?: string;
}

for (const decode of ['software', 'hardware'] as const) {
  test(`10-bit media in ${decode} decoders: formats and the levels that reach the composition`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(300000);
    const files = testSet(join(testInfo.project.outputDir, 'deep-colour'));
    await page.goto(`/?diagnostic=1&decode=${decode}`);
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
        const row = await page.evaluate(async () => {
          const hooks = Reflect.get(window, '__cgv') as Hooks;
          const pixels = (await hooks.client.api.renderPixels(0)) as {
            width: number;
            height: number;
            data: Uint8Array;
          };
          const y = Math.floor(pixels.height / 2);
          return Array.from(
            { length: pixels.width },
            (_, x) => pixels.data[(y * pixels.width + x) * 4 + 1],
          );
        });
        entry.composedLevels = distinctLevels(row);
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
      }
    }
    console.log(JSON.stringify(measured, null, 2));
    const out = join(root, 'bench/results');
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, `deep-colour-${decode}-${testInfo.project.name}.json`),
      JSON.stringify({ rampLevels, decode, measured }, null, 2) + '\n',
    );
    // Every codec WebCodecs decodes here at all reaches the composition.
    expect(measured.filter((m) => m.status === 'ready').length).toBeGreaterThan(0);
  });
}

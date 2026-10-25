import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { PNG } from 'pngjs';
import { render } from './golden-tools';

// Phase 7: animated overlays. GIF, animated WebP and APNG files whose frames carry
// their own number as a barcode are put on a 30 fps timeline, where they loop. The
// frame each shows, paused, while playing and in an export decoded by FFmpeg, must
// be the one its time on the timeline calls for. Stickers are added from their tab.
const root = process.cwd();
const resultsDir = join(root, 'bench/results');
const FLICKS = 705_600_000;
const FRAME = FLICKS / 30;
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin');
const ffmpeg = join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const software = process.env.GPU_TEST_SOFTWARE === '1';
/** The test animation: 24 frames of 100 ms, 320×180, 8 bits across its middle. */
const frames = 24;
const frameMs = 100;
const [width, height] = [320, 180];
const bits = 8;
/** Where the overlay starts on the timeline, and how long its clip lasts (three loops' worth). */
const startFrame = 10;
const lengthFrames = 90;

test.skip(
  !existsSync(ffmpeg) && process.env.CGV_REQUIRE_FFMPEG !== '1',
  'FFmpeg is missing: run pnpm setup:ffmpeg',
);

type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
  project: { execute(command: unknown): Promise<{ created: number[] } | null> };
  exporter: {
    start(settings: unknown, options?: { download?: boolean }): Promise<boolean>;
    settled(): Promise<{ state: string; message?: string }>;
    dismiss(): void;
  };
};

async function open(page: Page) {
  await page.goto('/?diagnostic=1');
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      !['Opening…', undefined].includes(
        document.querySelector('[data-testid="project-name"]')?.textContent ?? undefined,
      ) &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
}

const call = (page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ({ method, args }) =>
      (Reflect.get(window, '__cgv') as Hooks).client.api[method](...args) as Promise<never>,
    { method, args },
  );

async function run(page: Page, command: unknown): Promise<number[]> {
  const outcome = await page.evaluate(
    (command) => (Reflect.get(window, '__cgv') as Hooks).project.execute(command),
    command,
  );
  expect(outcome, JSON.stringify(command)).not.toBeNull();
  return outcome!.created;
}

interface Snapshot {
  project: {
    media: { id: string; name: string; duration: number; location: { kind: string } }[];
    tracks: { id: number; clips: { id: number; media: string; duration: number }[] }[];
  };
}
const snapshot = (page: Page) => call(page, 'projectSnapshot') as Promise<Snapshot>;

/** Writes the animation's frames, then each format from them. */
function makeAnimations(dir: string) {
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < frames; index++) {
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bit = Math.floor((x * bits) / width);
        const on = (index >> bit) & 1;
        const at = (y * width + x) * 4;
        png.data.fill(on ? 255 : 0, at, at + 3);
        png.data[at + 3] = 255;
      }
    writeFileSync(join(dir, `${String(index).padStart(3, '0')}.png`), PNG.sync.write(png));
  }
  const input = [
    '-v',
    'error',
    '-y',
    '-framerate',
    String(1000 / frameMs),
    '-i',
    join(dir, '%03d.png'),
  ];
  const files = {
    'count.gif': ['-loop', '0'],
    'count.webp': ['-c:v', 'libwebp_anim', '-lossless', '1', '-loop', '0'],
    'count.png': ['-f', 'apng', '-plays', '0'],
  };
  for (const [name, args] of Object.entries(files)) {
    const result = spawnSync(ffmpeg, [...input, ...args, join(dir, name)]);
    expect(result.status, String(result.stderr)).toBe(0);
  }
  return Object.keys(files).map((name) => join(dir, name));
}

/** The number in a frame's barcode, from RGBA (or grey) pixels of `w` × `h`. */
function readCode(data: Uint8Array, w: number, h: number, channels = 4) {
  let value = 0;
  for (let bit = 0; bit < bits; bit++) {
    const x = Math.floor(((bit + 0.5) * w) / bits);
    const at = (Math.floor(h / 2) * w + x) * channels;
    if (data[at] > 128) value |= 1 << bit;
  }
  return value;
}

/** The overlay frame timeline frame `frame` calls for: its loop wraps every 2.4 s. */
const expected = (frame: number) =>
  Math.floor((((frame - startFrame) / 30) * 1000) / frameMs) % frames;

function record(name: string, testInfo: TestInfo, value: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const text = JSON.stringify(value, null, 2);
  writeFileSync(join(resultsDir, `${name}-${testInfo.project.name}.json`), text + '\n');
  return testInfo.attach(name, { body: text, contentType: 'application/json' });
}

test('animated overlays play in sync with the timeline', async ({ page }, testInfo) => {
  test.setTimeout(software ? 15 * 60_000 : 5 * 60_000);
  await open(page);
  const files = makeAnimations(testInfo.outputPath('animations'));
  await page.getByTestId('media-file-input').setInputFiles(files);
  for (const file of files) {
    const name = file.split(/[\\/]/).pop()!;
    await expect(page.locator(`[data-testid="media-item"][data-name="${name}"]`)).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 60000 },
    );
  }
  const report: Record<string, unknown> = {};
  for (const file of files) {
    const name = file.split(/[\\/]/).pop()!;
    const media = (await snapshot(page)).project.media.find((m) => m.name === name)!;
    // One loop: 24 frames of 100 ms.
    expect(media.duration, name).toBe(frames * frameMs * 705_600);
    // A 480×270 project with the overlay alone on its top track.
    const clips = (await snapshot(page)).project.tracks.flatMap((t) => t.clips.map((c) => c.id));
    if (clips.length) await run(page, { type: 'delete', clips });
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
    const top = (await snapshot(page)).project.tracks[1].id;
    await run(page, {
      type: 'overwrite',
      track: top,
      at: startFrame * FRAME,
      clip: { media: media.id, duration: lengthFrames * FRAME },
    });
    // Paused: every frame of the clip shows the frame its time calls for.
    const wrong: number[] = [];
    for (let frame = startFrame; frame < startFrame + lengthFrames; frame++) {
      const shown = await render(page, frame * FRAME);
      if (readCode(shown.data, shown.width, shown.height) !== expected(frame)) wrong.push(frame);
    }
    // Playing: paused at random moments, the frame playback drew shows the right one.
    const playing: { frame: number; code: number }[] = [];
    await call(page, 'setQuality', 'full');
    for (let sample = 0; sample < 4; sample++) {
      await call(page, 'seekAndWait', (startFrame + 2) * FRAME);
      await page.getByTestId('play-toggle').click();
      await expect(page.getByTestId('transport')).toHaveAttribute('data-starting', 'false', {
        timeout: 15000,
      });
      await page.waitForTimeout(300 + sample * 450);
      await page.getByTestId('play-toggle').click();
      await expect(page.getByTestId('transport')).toHaveAttribute('data-playing', 'false');
      const { frame } = (await call(page, 'playbackState')) as { frame: number };
      const composed = (await call(page, 'readComposition')) as {
        width: number;
        height: number;
        data: Uint8Array;
      };
      const data = new Uint8Array(Object.values(composed.data));
      playing.push({ frame, code: readCode(data, composed.width, composed.height) });
    }
    // Exported: every frame of the file, decoded by FFmpeg.
    const target = testInfo.outputPath(`${name}.mp4`);
    const download = page.waitForEvent('download', { timeout: 10 * 60_000 });
    const started = await page.evaluate(
      (settings) =>
        (Reflect.get(window, '__cgv') as Hooks).exporter.start(settings, { download: true }),
      {
        format: 'mp4',
        width: 480,
        height: 270,
        frameRate: { num: 30, den: 1 },
        video: { codec: 'avc', bitrate: 4e6 },
        audio: null,
      },
    );
    expect(started).toBe(true);
    const status = await page.evaluate(() =>
      (Reflect.get(window, '__cgv') as Hooks).exporter.settled(),
    );
    expect(status, JSON.stringify(status)).toMatchObject({ state: 'done' });
    await (await download).saveAs(target);
    await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).exporter.dismiss());
    const grey = spawnSync(
      ffmpeg,
      ['-v', 'error', '-i', target, '-vf', 'format=gray', '-f', 'rawvideo', '-'],
      { maxBuffer: 1 << 28 },
    ).stdout as Buffer;
    const size = 480 * 270;
    const exportedWrong: number[] = [];
    for (let frame = startFrame; frame < startFrame + lengthFrames; frame++) {
      const plane = new Uint8Array(grey.buffer, grey.byteOffset + frame * size, size);
      if (readCode(plane, 480, 270, 1) !== expected(frame)) exportedWrong.push(frame);
    }
    report[name] = {
      pausedWrong: wrong,
      playing: playing.map((p) => ({ ...p, expected: expected(p.frame) })),
      exportedWrong,
      exportedFrames: grey.length / size,
    };
    expect(wrong, `${name} paused`).toEqual([]);
    for (const p of playing)
      expect(p.code, `${name} playing at ${p.frame}`).toBe(expected(p.frame));
    expect(exportedWrong, `${name} exported`).toEqual([]);
  }
  await record('overlay-sync', testInfo, report);
});

test('stickers add from their tab, loop and come back with the project', async ({ page }) => {
  await open(page);
  await page.getByTestId('library-tab-stickers').click();
  const items = page.getByTestId('sticker-item');
  await expect(items).toHaveCount(30);
  await page.locator('[data-testid="sticker-item"][data-key="heart"]').dblclick();
  await expect
    .poll(async () => (await snapshot(page)).project.tracks.flatMap((t) => t.clips).length)
    .toBe(1);
  const project = (await snapshot(page)).project;
  const media = project.media.find((m) => m.id === 'sticker-heart')!;
  expect(media.location).toEqual({ kind: 'pack', path: 'stickers/heart.webp' });
  // Two seconds a loop (WebP keeps whole milliseconds a frame), in a five-second clip.
  expect(Math.abs(media.duration - 2 * FLICKS)).toBeLessThanOrEqual(2 * 705_600);
  const clip = project.tracks.flatMap((t) => t.clips)[0];
  expect(clip.duration).toBe(5 * FLICKS);
  // It moves: frames half a beat apart differ.
  const a = await render(page, 0);
  const b = await render(page, 6 * FRAME);
  let differ = 0;
  for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) > 24) differ++;
  expect(differ).toBeGreaterThan(500);
  // Adding it again reuses the same media.
  await page.locator('[data-testid="sticker-item"][data-key="heart"]').dblclick();
  await expect
    .poll(async () => (await snapshot(page)).project.tracks.flatMap((t) => t.clips).length)
    .toBe(2);
  expect((await snapshot(page)).project.media.filter((m) => m.id === 'sticker-heart')).toHaveLength(
    1,
  );
  // After a reload the project finds its sticker in the app again.
  const before = await render(page, 6 * FRAME);
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('project-bar')).toHaveAttribute('data-busy', 'false');
  await page.reload();
  await open(page);
  await expect(page.locator('[data-testid="media-item"][data-name="heart.webp"]')).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 60000 },
  );
  const again = await render(page, 6 * FRAME);
  let same = 0;
  for (let i = 0; i < before.data.length; i += 4)
    if (Math.abs(again.data[i] - before.data[i]) <= 4) same++;
  expect(same / (before.data.length / 4)).toBeGreaterThan(0.99);
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Clip } from '../../packages/engine-client/src/project/types';
import { rampPresets, spanAt } from '../../packages/ui/src/speed/timing';
import { barcode, FRAME, render, run } from './golden-tools';

// Phase 9 timing: ramps, reverse and holds show the frames the model maps them
// to; sound keeps its pitch from a quarter speed to four times; a ramp plays in
// real time. CI's software GPUs and decoders check function only.
const mediaDir = join(process.cwd(), 'tests/media');
const software = process.env.GPU_TEST_SOFTWARE === '1';
/** The pitch a changed speed may drift by, in cents. */
const maxCents = 10;

interface Settings {
  format: string;
  width: number;
  height: number;
  frameRate: { num: number; den: number };
  video: { codec: string; bitrate: number } | null;
  audio: { codec: string; bitrate: number } | null;
}
type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
  exporter: {
    start(settings: Settings, options?: { download?: boolean }): Promise<boolean>;
    settled(): Promise<{ state: string }>;
    dismiss(): void;
  };
};

async function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ method, args }) =>
      (Reflect.get(window, '__cgv') as Hooks).client.api[method](...args) as Promise<T>,
    { method, args },
  );
}

async function project(page: Page) {
  return (
    await call<{ project: { tracks: { id: number; clips: Clip[] }[]; mainTrack: number } }>(
      page,
      'projectSnapshot',
    )
  ).project;
}

async function open(page: Page, files: string[]) {
  await page.goto('/?diagnostic=1');
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
  await page.getByTestId('media-file-input').setInputFiles(files.map((f) => join(mediaDir, f)));
  for (const name of files)
    await expect(page.locator(`[data-testid="media-item"][data-name="${name}"]`)).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 60000 },
    );
  const snapshot = await call<{ project: { media: { id: string; name: string }[] } }>(
    page,
    'projectSnapshot',
  );
  return new Map(snapshot.project.media.map((media) => [media.name, media.id]));
}

/** An empty project at `width`×`height`, 30 fps; returns its track ids. */
async function empty(page: Page, width: number, height: number) {
  const before = await project(page);
  const clips = before.tracks.flatMap((track) => track.clips.map((clip) => clip.id));
  if (clips.length) await run(page, { type: 'delete', clips });
  await run(page, {
    type: 'setSettings',
    settings: { width, height, frameRate: { num: 30, den: 1 }, sampleRate: 48000, channels: 2 },
  });
  return (await project(page)).tracks.map((track) => track.id);
}

/** The media frame (at 30 fps) clip `clip` shows `offset` into it, as the model samples it. */
function sourceFrame(clip: Clip, offset: number): { frame: number; near: boolean } {
  const time = clip.freeze
    ? clip.sourceIn
    : clip.reverse
      ? clip.sourceIn + spanAt(clip, clip.duration) - spanAt(clip, offset + FRAME / 2)
      : clip.sourceIn + spanAt(clip, offset);
  const frame = Math.floor(time / FRAME);
  // Within a few flicks of a frame boundary the model's integer sums may round the other way.
  return { frame, near: time - frame * FRAME < 64 || (frame + 1) * FRAME - time < 64 };
}

test('ramps, reverse and holds show the frames their timing maps to', async ({ page }) => {
  test.setTimeout(240000);
  const ids = await open(page, ['h264-1080p30-aac.mp4']);
  const [main] = await empty(page, 640, 360);
  const media = ids.get('h264-1080p30-aac.mp4');
  const [ramped] = await run(page, {
    type: 'append',
    track: main,
    clip: { media, duration: 90 * FRAME },
  });
  await run(page, {
    type: 'setRamp',
    clip: ramped,
    points: rampPresets.find((preset) => preset.id === 'montage')!.shape,
  });
  const [reversed] = await run(page, {
    type: 'append',
    track: main,
    clip: { media, sourceIn: 150 * FRAME, duration: 60 * FRAME },
  });
  await run(page, { type: 'setReverse', clip: reversed, reverse: true });
  await run(page, { type: 'setSpeed', clip: reversed, speed: { num: 3, den: 2 } });
  await run(page, { type: 'freezeFrame', clip: ramped, at: 17 * FRAME, duration: 12 * FRAME });
  const clips = (await project(page)).tracks.find((t) => t.id === main)!.clips;
  expect(clips.map((clip) => [!!clip.freeze, !!clip.reverse])).toEqual([
    [false, false],
    [true, false],
    [false, false],
    [false, true],
  ]);
  const end = clips[clips.length - 1].start + clips[clips.length - 1].duration;
  const misses: string[] = [];
  let checked = 0;
  for (let time = 0; time < end; time += FRAME) {
    const clip = clips.find((c) => c.start <= time && time < c.start + c.duration)!;
    const expected = sourceFrame(clip, time - clip.start);
    const shown = barcode(await render(page, time));
    checked++;
    if (shown !== expected.frame && !(expected.near && Math.abs(shown - expected.frame) === 1))
      misses.push(`frame ${time / FRAME}: shows ${shown}, maps to ${expected.frame}`);
  }
  expect(checked).toBeGreaterThan(90);
  expect(misses).toEqual([]);
});

/** The left channel of a 16-bit PCM WAV file, and its rate. */
function readWav(file: string): { left: Float32Array; rate: number } {
  const bytes = readFileSync(file);
  let at = 12;
  let rate = 0;
  let channels = 0;
  while (at < bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(at + 10);
      rate = bytes.readUInt32LE(at + 12);
    } else if (id === 'data') {
      // A streamed file may leave the data size too large.
      const frames = Math.floor(Math.min(size, bytes.length - at - 8) / (2 * channels));
      const left = new Float32Array(frames);
      for (let i = 0; i < frames; i++)
        left[i] = bytes.readInt16LE(at + 8 + i * 2 * channels) / 32768;
      return { left, rate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`No sound in ${file}`);
}

/** The strength of frequency `f` in a Hann-windowed stretch of `x` (Goertzel). */
function strength(x: Float32Array, from: number, length: number, f: number, rate: number) {
  const coefficient = 2 * Math.cos((2 * Math.PI * f) / rate);
  let s1 = 0;
  let s2 = 0;
  for (let n = 0; n < length; n++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (length - 1));
    const s0 = x[from + n] * w + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
}

/**
 * The pitch near `around` Hz in each quarter second of `x` loud enough to measure
 * (the test tone fades in and out), as cents from `around`.
 */
function pitches(x: Float32Array, rate: number, around: number): number[] {
  const length = rate / 4;
  const cents: number[] = [];
  for (let from = rate / 8; from + length <= x.length - rate / 8; from += length / 2) {
    let energy = 0;
    for (let n = 0; n < length; n++) energy += x[from + n] * x[from + n];
    if (Math.sqrt(energy / length) < 0.12) continue;
    let best = around;
    let top = -1;
    for (let f = around * 0.85; f <= around * 1.15; f += 1) {
      const value = strength(x, from, length, f, rate);
      if (value > top) [top, best] = [value, f];
    }
    const coarse = best;
    for (let step = -100; step <= 100; step++) {
      const f = coarse + step * 0.02;
      const value = strength(x, from, length, f, rate);
      if (value > top) [top, best] = [value, f];
    }
    cents.push(1200 * Math.log2(best / around));
  }
  return cents;
}

async function exportWav(page: Page, file: string) {
  const download = page.waitForEvent('download', { timeout: 5 * 60_000 });
  const settings: Settings = {
    format: 'wav',
    width: 640,
    height: 360,
    frameRate: { num: 30, den: 1 },
    video: null,
    audio: { codec: 'pcm-s16', bitrate: 0 },
  };
  expect(
    await page.evaluate(
      (settings) =>
        (Reflect.get(window, '__cgv') as Hooks).exporter.start(settings, { download: true }),
      settings,
    ),
  ).toBe(true);
  const status = await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).exporter.settled(),
  );
  expect(status.state, JSON.stringify(status)).toBe('done');
  await (await download).saveAs(file);
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).exporter.dismiss());
}

test('sound keeps its pitch from a quarter speed to four times, and on a ramp', async ({
  page,
}, testInfo) => {
  test.setTimeout(software ? 15 * 60_000 : 5 * 60_000);
  const ids = await open(page, ['tone-48k-stereo.wav']);
  const media = ids.get('tone-48k-stereo.wav');
  const cases: { name: string; speed?: [number, number]; ramp?: boolean; keepPitch?: boolean }[] = [
    { name: '0.25x', speed: [1, 4] },
    { name: '0.5x', speed: [1, 2] },
    { name: '2x', speed: [2, 1] },
    { name: '4x', speed: [4, 1] },
    { name: 'ramp', ramp: true },
    // Without keeping pitch, twice the speed is an octave up (measured there).
    { name: '2x-varispeed', speed: [2, 1], keepPitch: false },
  ];
  const report: Record<string, number[]> = {};
  for (const item of cases) {
    const [track] = await empty(page, 640, 360);
    const [clip] = await run(page, {
      type: 'append',
      track,
      clip: { media, duration: 150 * FRAME, video: false, audio: true },
    });
    if (item.speed)
      await run(page, {
        type: 'setSpeed',
        clip,
        speed: { num: item.speed[0], den: item.speed[1] },
      });
    if (item.ramp)
      await run(page, {
        type: 'setRamp',
        clip,
        points: [
          { at: 0, speed: 0.5 },
          { at: 1, speed: 2 },
        ],
      });
    if (item.keepPitch === false)
      await run(page, { type: 'setClipProperties', clip, properties: { keepPitch: false } });
    const file = testInfo.outputPath(`${item.name}.wav`);
    await exportWav(page, file);
    const { left, rate } = readWav(file);
    // Without keeping pitch the tone moves with the speed.
    const shift = item.keepPitch === false ? item.speed![0] / item.speed![1] : 1;
    report[item.name] = pitches(left, rate, 440 * shift);
  }
  await testInfo.attach('pitch-cents', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  for (const [name, cents] of Object.entries(report)) {
    expect(cents.length, name).toBeGreaterThanOrEqual(2);
    for (const value of cents) expect(Math.abs(value), name).toBeLessThan(maxCents);
  }
});

test('a speed ramp plays in real time at 1080p', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  const ids = await open(page, ['h264-1080p30-aac.mp4']);
  const [main] = await empty(page, software ? 640 : 1920, software ? 360 : 1080);
  const media = ids.get('h264-1080p30-aac.mp4');
  for (const preset of ['montage', 'hero']) {
    const [clip] = await run(page, {
      type: 'append',
      track: main,
      clip: { media, duration: 300 * FRAME },
    });
    await run(page, {
      type: 'setRamp',
      clip,
      points: rampPresets.find((item) => item.id === preset)!.shape,
    });
  }
  await call(page, 'setQuality', 'full');
  await call(page, 'seekAndWait', 0);
  const transport = page.getByTestId('transport');
  await page.getByTestId('play-toggle').click();
  await expect(transport).toHaveAttribute('data-starting', 'false', { timeout: 10000 });
  const started = await call<{ time: number }>(page, 'playbackState');
  const wallStart = Date.now();
  await page.waitForTimeout(8000);
  const stats = await call<{ dropped: number; presented: number; level: number }>(
    page,
    'playbackStats',
  );
  const ended = await call<{ time: number }>(page, 'playbackState');
  const wall = (Date.now() - wallStart) / 1000;
  await page.getByTestId('play-toggle').click();
  const advanced = (ended.time - started.time) / (FRAME * 30);
  await testInfo.attach('ramp-playback', {
    body: JSON.stringify({ wall, advanced, stats, software }, null, 2),
    contentType: 'application/json',
  });
  const summary = JSON.stringify({ wall, advanced, stats });
  expect(advanced, summary).toBeGreaterThan(software ? 0.5 : wall * 0.9);
  if (software) return;
  expect(stats.level).toBe(0);
  expect(stats.dropped).toBe(0);
  expect(stats.presented).toBeGreaterThanOrEqual(Math.floor(advanced * 30) - 1);
});

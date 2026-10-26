import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { barcode, compare, passes, type Pixels } from './golden-tools';

// Phase 3: one renderFrame(t) for preview and export, real-time multitrack
// playback with the sound card as master clock, seeks, shuttle and frame steps.
// CI runs on software GPUs and software decoders: its timings are functional
// checks only, never performance results.
const mediaDir = join(process.cwd(), 'tests/media');
const resultsDir = join(process.cwd(), 'bench/results');
const FLICKS = 705_600_000;
const FRAME = 23_520_000; // one frame at 30 fps
const software = process.env.GPU_TEST_SOFTWARE === '1';
/** Seconds of three-track playback measured (60 on the reference machine). */
const realtimeSeconds = Number(process.env.CGV_REALTIME_SECONDS ?? (software ? 10 : 60));
/** Seconds of A/V sync measured (10 minutes for the exit criterion: CGV_DRIFT_SECONDS=600). */
const driftSeconds = Number(process.env.CGV_DRIFT_SECONDS ?? 60);

interface Stats {
  presented: number;
  dropped: number;
  late: number;
  renderMs: { mean: number; max: number };
  gpuMs: { mean: number; max: number };
  offset: {
    count: number;
    meanMs: number;
    maxAbsMs: number;
    p50AbsMs: number;
    p95AbsMs: number;
    p99AbsMs: number;
  };
  audio: { running: boolean; underruns: number; bufferedMs: number; sampleRate: number } | null;
  clock: 'audio' | 'wall' | null;
  level: number;
  compositionFormat: string;
}
interface State {
  playing: boolean;
  starting: boolean;
  rate: number;
  time: number;
  frame: number;
  clock: string | null;
}
interface Api {
  projectSnapshot(): {
    project: { media: { id: string; name: string }[]; tracks: { id: number }[] };
  };
  playbackStats(): Stats;
  playbackState(): State;
  setQuality(mode: string): void;
  seekAndWait(time: number): { ms: number };
  releaseFrames(): void;
  mediaStats(): { openFrames: number };
}
interface Hooks {
  client: {
    api: Record<string, (...args: unknown[]) => Promise<unknown>>;
  };
  project: {
    execute(command: unknown): Promise<{ created: number[] } | null>;
    importLook(id: string): Promise<number | null>;
  };
}

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

/** Calls an engine API method in the page. */
function call<K extends keyof Api>(
  page: Page,
  method: K,
  ...args: Parameters<Api[K]>
): Promise<ReturnType<Api[K]>> {
  return page.evaluate(
    ({ method, args }) =>
      (Reflect.get(window, '__cgv') as Hooks).client.api[method](...args) as Promise<never>,
    { method, args },
  );
}

/** A composition read back in the page, sent to Node as base64. */
async function pixels(page: Page, method: 'renderPixels' | 'readComposition', time = 0) {
  const raw = await page.evaluate(
    async ({ method, time }) => {
      const api = (Reflect.get(window, '__cgv') as Hooks).client.api;
      const pixels = (await api[method](time)) as Pixels;
      let text = '';
      for (let i = 0; i < pixels.data.length; i += 0x8000)
        text += String.fromCharCode(...pixels.data.subarray(i, i + 0x8000));
      return { width: pixels.width, height: pixels.height, data: btoa(text) };
    },
    { method, time },
  );
  return {
    width: raw.width,
    height: raw.height,
    data: new Uint8Array(Buffer.from(raw.data, 'base64')),
  };
}

async function run(page: Page, command: unknown): Promise<number[]> {
  const outcome = await page.evaluate(
    (command) => (Reflect.get(window, '__cgv') as Hooks).project.execute(command),
    command,
  );
  expect(outcome, JSON.stringify(command)).not.toBeNull();
  return outcome!.created;
}

/** Imports test clips and returns their media ids, in order. */
async function importFiles(page: Page, files: string[]) {
  await page
    .getByTestId('media-file-input')
    .setInputFiles(files.map((file) => join(mediaDir, file)));
  for (const file of files)
    await expect(page.locator(`[data-testid="media-item"][data-name="${file}"]`)).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 60000 },
    );
  const { project } = await call(page, 'projectSnapshot');
  return files.map((file) => project.media.find((media) => media.name === file)!.id);
}

async function settings(page: Page, width: number, height: number) {
  await run(page, {
    type: 'setSettings',
    settings: { width, height, frameRate: { num: 30, den: 1 }, sampleRate: 48000, channels: 2 },
  });
}

async function tracks(page: Page, count: number): Promise<number[]> {
  let { project } = await call(page, 'projectSnapshot');
  while (project.tracks.length < count) {
    await run(page, { type: 'addTrack', index: project.tracks.length });
    ({ project } = await call(page, 'projectSnapshot'));
  }
  return project.tracks.map((track) => track.id);
}

/** Puts `copies` back-to-back 300-frame copies of `media` on `track`; returns the clips. */
async function fill(page: Page, track: number, media: string, copies: number) {
  const ids: number[] = [];
  for (let i = 0; i < copies; i++)
    ids.push(
      ...(await run(page, { type: 'append', track, clip: { media, duration: 300 * FRAME } })),
    );
  return ids;
}

function record(testInfo: TestInfo, name: string, body: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const text = JSON.stringify(body, null, 2);
  writeFileSync(join(resultsDir, `${name}-${testInfo.project.name}.json`), text + '\n');
  return testInfo.attach(name, { body: text, contentType: 'application/json' });
}

/** Plays with the Play button for `seconds` after the clock starts, then pauses. */
async function playFor(page: Page, seconds: number) {
  const transport = page.getByTestId('transport');
  await page.getByTestId('play-toggle').click();
  await expect(transport).toHaveAttribute('data-playing', 'true');
  await expect(transport).toHaveAttribute('data-starting', 'false', { timeout: 10000 });
  const started = await call(page, 'playbackState');
  const wallStart = Date.now();
  await page.waitForTimeout(seconds * 1000);
  const stats = await call(page, 'playbackStats');
  const ended = await call(page, 'playbackState');
  const wall = (Date.now() - wallStart) / 1000;
  await page.getByTestId('play-toggle').click();
  await expect(transport).toHaveAttribute('data-playing', 'false');
  return { stats, wall, advanced: (ended.time - started.time) / FLICKS };
}

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  const query = backend === 'WebGL2' ? '&gpu=webgl2' : '';

  test(`${backend} renderFrame(t) shows the exact source frame at any seek`, async ({ page }) => {
    test.setTimeout(180000);
    await open(page, query);
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
    const [h264, vp9] = await importFiles(page, ['h264-1080p30-aac.mp4', 'vp9-720p25-opus.webm']);
    await settings(page, 480, 270);
    const [bottom, top] = await tracks(page, 2);
    await fill(page, bottom, h264, 1);
    await run(page, { type: 'append', track: top, clip: { media: vp9, duration: 240 * FRAME } });
    await run(page, { type: 'setTrackHidden', track: top, hidden: true });
    // Frames in any order, including the first and last.
    for (const frame of [0, 299, 150, 1, 31, 30, 77, 298, 200, 2]) {
      const shown = await pixels(page, 'renderPixels', frame * FRAME + FRAME / 3);
      expect(barcode(shown), `frame ${frame}`).toBe(frame);
    }
    // Same input, same output: frame 77 again after seeking elsewhere.
    const first = await pixels(page, 'renderPixels', 77 * FRAME);
    await pixels(page, 'renderPixels', 200 * FRAME);
    const again = await pixels(page, 'renderPixels', 77 * FRAME);
    expect(Buffer.compare(Buffer.from(first.data), Buffer.from(again.data))).toBe(0);
    // A 25 fps clip on a 30 fps timeline shows the source frame of that moment.
    await run(page, { type: 'setTrackHidden', track: top, hidden: false });
    for (const frame of [0, 1, 6, 12, 99, 239]) {
      const shown = await pixels(page, 'renderPixels', frame * FRAME);
      expect(barcode(shown), `timeline frame ${frame}`).toBe(Math.floor((frame * 25) / 30));
    }
    await call(page, 'releaseFrames');
    expect((await call(page, 'mediaStats')).openFrames).toBe(0);
  });
}

test('the frame drawn while playing matches the frame drawn when paused', async ({
  page,
}, testInfo) => {
  await open(page);
  const [h264] = await importFiles(page, ['h264-1080p30-aac.mp4']);
  await settings(page, 480, 270);
  const [track] = await tracks(page, 1);
  await fill(page, track, h264, 1);
  await call(page, 'setQuality', 'full');
  await playFor(page, 1.5);
  // Pausing at full quality keeps the frame playback drew: read it back as it is,
  // then draw the same frame the paused way.
  const { frame, time } = await call(page, 'playbackState');
  const playing = await pixels(page, 'readComposition');
  const paused = await pixels(page, 'renderPixels', time);
  expect(barcode(playing)).toBe(frame);
  expect(barcode(paused)).toBe(frame);
  let worst = 0;
  let total = 0;
  for (let i = 0; i < playing.data.length; i++) {
    if (i % 4 === 3) continue;
    const difference = Math.abs(playing.data[i] - paused.data[i]);
    worst = Math.max(worst, difference);
    total += difference;
  }
  const mean = total / ((playing.data.length / 4) * 3);
  await record(testInfo, 'play-vs-paused', { frame, worst, mean, software });
  // While playing, hardware frames are converted by the browser on the GPU; paused
  // frames by the compositor from their planes. Both must agree.
  expect(mean).toBeLessThan(1.5);
  expect(worst).toBeLessThanOrEqual(24);
});

test('frames coded taller than they show keep the colour of their last row', async ({
  page,
}, testInfo) => {
  const ffmpeg = join(
    process.env.CGV_FFMPEG_DIR ?? join(process.cwd(), '.tools/ffmpeg/bin'),
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
  );
  test.skip(
    !existsSync(ffmpeg) && process.env.CGV_REQUIRE_FFMPEG !== '1',
    'FFmpeg is missing: run pnpm setup:ffmpeg',
  );
  // 1080p H.264 is coded 1088 rows high. Chrome converted such hardware frames
  // with the padding's chroma in their last row, a quarter weaker.
  const clip = testInfo.outputPath('red-1080p.mp4');
  const filter =
    'color=c=0xC02020:s=1920x1080:r=30,format=yuv420p,' +
    'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv';
  const made = spawnSync(ffmpeg, [
    ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', filter],
    ...['-t', '1', '-c:v', 'libopenh264', '-b:v', '4M', clip],
  ]);
  expect(made.status, made.stderr.toString()).toBe(0);
  await open(page);
  await page.getByTestId('media-file-input').setInputFiles(clip);
  await expect(page.getByTestId('media-item')).toHaveAttribute('data-status', 'ready', {
    timeout: 60000,
  });
  const { project } = await call(page, 'projectSnapshot');
  const [track] = await tracks(page, 1);
  await run(page, {
    type: 'append',
    track,
    clip: { media: project.media[0].id, duration: 30 * FRAME },
  });
  const rows = (shown: Pixels) =>
    [1078, 1079].map((row) => {
      const sum = [0, 0, 0];
      for (let x = 0; x < shown.width; x++)
        for (let c = 0; c < 3; c++) sum[c] += shown.data[(row * shown.width + x) * 4 + c];
      return sum.map((value) => value / shown.width);
    });
  // First from the decoder (hardware where it can), then from the frame cache.
  for (const source of ['decoder', 'cache']) {
    const [above, last] = rows(await pixels(page, 'renderPixels', 5 * FRAME));
    for (let c = 0; c < 3; c++)
      expect(Math.abs(last[c] - above[c]), `${source}, channel ${c}`).toBeLessThanOrEqual(1);
  }
});

test('seeks show the frame within 100 ms', async ({ page }, testInfo) => {
  await open(page);
  const [h264] = await importFiles(page, ['h264-1080p30-aac.mp4']);
  const [track] = await tracks(page, 1);
  await fill(page, track, h264, 1);
  const timed = (time: number) =>
    page.evaluate(async (time) => {
      const api = (Reflect.get(window, '__cgv') as Hooks).client.api;
      const started = performance.now();
      await api.seekAndWait(time);
      return performance.now() - started;
    }, time);
  // 30 different frames, each decoded from its key frame (one a second).
  const frames = Array.from({ length: 30 }, (_, i) => (i * 97 + 13) % 300);
  const uncached: number[] = [];
  for (const frame of frames) {
    await timed(0);
    uncached.push(await timed(frame * FRAME));
  }
  // The same frames again, now from the frame cache.
  const cached: number[] = [];
  for (const frame of frames) cached.push(await timed(frame * FRAME));
  const summary = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      max: sorted[sorted.length - 1],
    };
  };
  const result = { cached: summary(cached), uncached: summary(uncached), software };
  await record(testInfo, 'seek-latency', result);
  // Software GPUs and decoders are no measure of speed: there seeks only have to work.
  if (software) return;
  // The exit criterion: a frame of cached media shows within 100 ms.
  expect(result.cached.max).toBeLessThan(100);
  // Uncached seeks decode up to 29 frames from the key frame before them (about
  // 60 ms median, 95 to 100 ms at p95 here): a guard against regressions only.
  expect(result.uncached.p95).toBeLessThan(150);
});

test('three stacked 1080p30 tracks play in real time at full resolution', async ({
  page,
}, testInfo) => {
  test.setTimeout((realtimeSeconds + 120) * 1000);
  await open(page, process.env.CGV_DECODE ? '&decode=' + process.env.CGV_DECODE : '');
  const [h264] = await importFiles(page, ['h264-1080p30-aac.mp4']);
  const ids = await tracks(page, 3);
  const copies = Math.ceil((realtimeSeconds + 5) / 10);
  const clips: number[][] = [];
  for (const track of ids) clips.push(await fill(page, track, h264, copies));
  // Every layer shows: the upper two are half transparent.
  for (const clip of [...clips[1], ...clips[2]])
    await run(page, { type: 'setClipProperties', clip, properties: { opacity: 0.5 } });
  await call(page, 'setQuality', 'full');
  const { stats, wall, advanced } = await playFor(page, realtimeSeconds);
  await record(testInfo, 'realtime-3x1080p30', {
    seconds: realtimeSeconds,
    wall,
    advanced,
    stats,
    software,
  });
  expect(stats.level).toBe(0);
  if (software) {
    // CI's software GPU takes about a second per frame of three 1080p layers, so
    // the page sees playback start and stop up to a frame late: only check that
    // the clock ran and frames were shown.
    expect(advanced).toBeGreaterThan(wall * 0.5);
    expect(stats.presented).toBeGreaterThanOrEqual(3);
    return;
  }
  // Real time on the reference machine: every frame shown.
  expect(advanced).toBeGreaterThan(wall * 0.9);
  expect(stats.dropped).toBe(0);
  expect(stats.presented).toBeGreaterThanOrEqual(Math.floor(advanced * 30) - 1);
});

test('five stacked effects on a 1080p30 clip play in real time at full resolution', async ({
  page,
}, testInfo) => {
  test.setTimeout((realtimeSeconds + 120) * 1000);
  await open(page, process.env.CGV_DECODE ? '&decode=' + process.env.CGV_DECODE : '');
  const [h264] = await importFiles(page, ['h264-1080p30-aac.mp4']);
  // A software GPU cannot draw five effects at 1080p fast enough to move the
  // playhead at all on CI: there the same stack runs on a 640×360 project.
  if (software) await settings(page, 640, 360);
  const [track] = await tracks(page, 1);
  const clips = await fill(page, track, h264, Math.ceil((realtimeSeconds + 5) / 10));
  const lut = await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).project.importLook('teal-orange'),
  );
  expect(lut).not.toBeNull();
  // Each clip blurs (about 11 pixels of deviation at 1080p, both passes), sharpens,
  // grades through a LUT, darkens its corners and adds grain.
  const stack = [
    ['gaussian-blur', { radius: 0.03 }],
    ['sharpen', { amount: 1 }],
    ['lut', { lut: `lut-${lut}` }],
    ['vignette', { amount: 0.5 }],
    ['noise', { amount: 0.1 }],
  ] as const;
  for (const clip of clips)
    for (const [kind, params] of stack)
      await run(page, { type: 'addEffect', clip, effect: { kind, params } });
  await call(page, 'setQuality', 'full');
  const { stats, wall, advanced } = await playFor(page, realtimeSeconds);
  await record(testInfo, 'realtime-5-effects-1080p30', {
    seconds: realtimeSeconds,
    wall,
    advanced,
    effects: stack.map(([kind]) => kind),
    stats,
    software,
  });
  expect(stats.level).toBe(0);
  if (software) {
    // Software GPUs check function only.
    expect(advanced).toBeGreaterThan(1);
    expect(stats.presented).toBeGreaterThanOrEqual(3);
    return;
  }
  expect(advanced).toBeGreaterThan(wall * 0.9);
  expect(stats.dropped).toBe(0);
  expect(stats.presented).toBeGreaterThanOrEqual(Math.floor(advanced * 30) - 1);
});

test('a keyframed transform plays smoothly and as drawn when paused', async ({
  page,
}, testInfo) => {
  const seconds = 10;
  test.setTimeout((seconds + 120) * 1000);
  await open(page);
  const [h264] = await importFiles(page, ['h264-1080p30-aac.mp4']);
  const [track] = await tracks(page, 1);
  const clips = await fill(page, track, h264, Math.ceil((seconds + 5) / 10));
  // Each clip moves across, grows and turns, and its vignette fades in.
  const keys: [string, number, number, string][] = [
    ['transform.x', 0, -480, 'easeInOut'],
    ['transform.x', 300, 480, 'linear'],
    ['transform.scaleX', 0, 0.5, 'easeOut'],
    ['transform.scaleX', 300, 1, 'linear'],
    ['transform.scaleY', 0, 0.5, 'easeOut'],
    ['transform.scaleY', 300, 1, 'linear'],
    ['transform.rotation', 0, -20, 'linear'],
    ['transform.rotation', 300, 20, 'linear'],
  ];
  for (const clip of clips) {
    const [vignette] = await run(page, {
      type: 'addEffect',
      clip,
      effect: { kind: 'vignette' },
    });
    for (const [property, frame, value, kind] of [
      ...keys,
      [`effects.${vignette}.amount`, 0, 0, 'linear'],
      [`effects.${vignette}.amount`, 300, 1, 'linear'],
    ] as const)
      await run(page, {
        type: 'setKeyframe',
        clip,
        property,
        time: frame * FRAME,
        value,
        interpolation: { kind },
      });
  }
  await call(page, 'setQuality', 'full');
  const { stats, wall, advanced } = await playFor(page, seconds);
  // Pausing at full quality keeps the frame playback drew.
  const { frame, time } = await call(page, 'playbackState');
  const playing = await pixels(page, 'readComposition');
  const paused = await pixels(page, 'renderPixels', time);
  // The paused frame matches the one playback drew, within the golden tolerance.
  const difference = compare(playing, paused);
  await record(testInfo, 'keyframed-transform', {
    seconds,
    wall,
    advanced,
    frame,
    difference,
    stats,
    software,
  });
  expect(frame).toBeGreaterThan(30);
  expect(passes(difference), JSON.stringify(difference)).toBe(true);
  if (software) return;
  expect(stats.level).toBe(0);
  expect(advanced).toBeGreaterThan(wall * 0.9);
  expect(stats.dropped).toBe(0);
  expect(stats.presented).toBeGreaterThanOrEqual(Math.floor(advanced * 30) - 1);
});

test('picture and sound stay within one frame while playing', async ({ page }, testInfo) => {
  test.setTimeout((driftSeconds + 120) * 1000);
  await open(page);
  const [h264] = await importFiles(page, ['h264-1080p30-aac.mp4']);
  const [track] = await tracks(page, 1);
  await fill(page, track, h264, Math.ceil((driftSeconds + 5) / 10));
  const { stats, wall, advanced } = await playFor(page, driftSeconds);
  await record(testInfo, 'av-sync', {
    seconds: driftSeconds,
    wall,
    advanced,
    clockVersusWallPpm: ((advanced - wall) / wall) * 1e6,
    stats,
    software,
  });
  expect(advanced).toBeGreaterThan(wall * 0.9);
  if (software && stats.clock !== 'audio') {
    // A CI runner may have no sound device: playback then follows the wall clock.
    testInfo.annotations.push({
      type: 'no sound device',
      description: `Playback followed the wall clock: ${stats.fallback ?? 'no sound output'}`,
    });
    return;
  }
  expect(stats.clock).toBe('audio');
  expect(stats.audio?.running).toBe(true);
  // Software GPUs draw far fewer than 30 frames a second, so how long a frame stays
  // on screen, not sync, would dominate their offsets: the numbers are recorded only.
  if (software) return;
  expect(stats.audio?.underruns).toBe(0);
  // Sampled at every display refresh: the frame on screen against the sound heard.
  expect(stats.offset.count).toBeGreaterThan(driftSeconds * 20);
  expect(stats.offset.maxAbsMs).toBeLessThan(1000 / 30);
});

test('J, K, L, the arrow keys and Space drive the transport', async ({ page }) => {
  await open(page);
  const [h264] = await importFiles(page, ['h264-1080p30-aac.mp4']);
  const [track] = await tracks(page, 1);
  await fill(page, track, h264, 2);
  const transport = page.getByTestId('transport');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowRight');
  await expect(transport).toHaveAttribute('data-frame', '1');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(transport).toHaveAttribute('data-frame', '11');
  await page.keyboard.press('ArrowLeft');
  await expect(transport).toHaveAttribute('data-frame', '10');
  await expect(page.getByTestId('timecode')).toHaveText('00:00:00:10');
  await page.keyboard.press('l');
  await expect(transport).toHaveAttribute('data-rate', '1');
  await expect(transport).toHaveAttribute('data-starting', 'false');
  await page.keyboard.press('l');
  await expect(transport).toHaveAttribute('data-rate', '2');
  await expect(page.getByTestId('shuttle-rate')).toHaveText(/2×/);
  await expect(transport).toHaveAttribute('data-starting', 'false');
  await expect
    .poll(async () => Number(await transport.getAttribute('data-frame')))
    .toBeGreaterThan(20);
  await page.keyboard.press('k');
  await expect(transport).toHaveAttribute('data-playing', 'false');
  const stopped = Number(await transport.getAttribute('data-frame'));
  expect(stopped).toBeGreaterThan(20);
  await page.keyboard.press('j');
  await expect(transport).toHaveAttribute('data-rate', '-1');
  await expect
    .poll(async () => Number(await transport.getAttribute('data-frame')))
    .toBeLessThan(stopped - 3);
  await page.keyboard.press('k');
  await expect(transport).toHaveAttribute('data-playing', 'false');
  expect(Number(await transport.getAttribute('data-frame'))).toBeLessThan(stopped);
  await page.keyboard.press('End');
  await expect(transport).toHaveAttribute('data-frame', '599');
  await page.keyboard.press('Home');
  await expect(transport).toHaveAttribute('data-frame', '0');
  await page.keyboard.press('Space');
  await expect(transport).toHaveAttribute('data-playing', 'true');
  await page.keyboard.press('Space');
  await expect(transport).toHaveAttribute('data-playing', 'false');
  // The scrub bar moves the playhead.
  await page.getByTestId('scrub').fill('120');
  await expect(transport).toHaveAttribute('data-frame', '120');
  await expect(page.getByTestId('timecode')).toHaveText('00:00:04:00');
});

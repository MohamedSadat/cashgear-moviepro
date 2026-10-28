import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, normalize, sep } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { PNG } from 'pngjs';
import { normalizeArabic, normalizeEnglish, wordErrors } from './wer';

// Phase 10: the AI tools on material with known answers. Silences and scene
// cuts come from generated sound and video, beats from the bundled music beds
// (made on a grid), captions from FLEURS read speech and its transcripts, and
// background removal from a public-domain NASA clip of people talking. Models
// are served from tests/models (pnpm fetch-models) by a local server, as
// Hugging Face serves them; a test whose model or media is missing is skipped.
const root = process.cwd();
const mediaDir = join(root, 'tests/media');
const modelDir = join(root, 'tests/models');
const resultsDir = join(root, 'bench/results');
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin');
const ffmpeg = join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const needFfmpeg = !existsSync(ffmpeg) && process.env.CGV_REQUIRE_FFMPEG !== '1';
const software = process.env.GPU_TEST_SOFTWARE === '1';
const SECOND = 705_600_000;
/** A frame at 30 fps, the rate of every project here. */
const FRAME = 23_520_000;

interface Clip {
  id: number;
  media: string;
  start: number;
  duration: number;
  sourceIn: number;
  beats?: number[];
  caption?: { language: string };
  title?: { elements: { type: string; text?: string }[] };
  removeBackground?: boolean;
}
interface Snapshot {
  project: {
    media: { id: string; name: string }[];
    tracks: { id: number; name: string; hidden?: boolean; clips: Clip[] }[];
  };
}
interface Stats {
  presented: number;
  dropped: number;
  late: number;
  renderMs: unknown;
  recentDrops: { frame: number; missed: number; undecoded: number }[];
}
interface Job {
  label: string;
  progress: number | null;
  cancel(): void;
}
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
  project: {
    execute(command: unknown): Promise<{ created: number[] } | null>;
    addToTimeline(id: string): Promise<void>;
    undo(): Promise<void>;
    notices: string[];
  };
  editor: { select(ids: number[]): void };
  playback: { seekFrame(frame: number): void };
  ai: {
    jobs: Job[];
    detectBeats(id: number): Promise<void>;
    splitScenes(id: number): Promise<void>;
    setRemoveBackground(id: number, on: boolean): Promise<void>;
    unfinishedCutouts(): Promise<Clip[]>;
  };
  captions: {
    install(): Promise<void>;
    generate(id: number, language: string | null, style: string): Promise<void>;
  };
  exporter: {
    start(settings: Settings, options?: { download?: boolean }): Promise<boolean>;
    settled(): Promise<{ state: string; message?: string }>;
    dismiss(): void;
  };
};

const registry = JSON.parse(
  readFileSync(join(root, 'packages/engine-client/src/ai/models.json'), 'utf8'),
) as { models: { id: string; files: { path: string; size: number }[] }[] };

/** Whether every file of model `id` is in tests/models at its size. */
function hasModel(id: string) {
  const model = registry.models.find((m) => m.id === id);
  return !!model?.files.every((file) => {
    const path = join(modelDir, id, file.path);
    return existsSync(path) && statSync(path).size === file.size;
  });
}

const hasMedia = (...names: string[]) => names.every((name) => existsSync(join(mediaDir, name)));

// tests/models over HTTP, with the headers a cross-origin-isolated page needs.
let server: Server | null = null;
let modelBase = '';
test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://models').pathname);
    const file = normalize(join(modelDir, path));
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    };
    if (!file.startsWith(modelDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, headers).end();
      return;
    }
    response.writeHead(200, {
      ...headers,
      'Content-Type': 'application/octet-stream',
      'Content-Length': statSync(file).size,
    });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  modelBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server?.close());

async function open(page: Page, query = '') {
  await page.goto(`/?diagnostic=1&models=${encodeURIComponent(modelBase)}${query}`);
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="engine-status"]')?.dataset.state ===
        'ready' &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(
    () => (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot() as Promise<Snapshot>,
  );
}

async function run(page: Page, command: unknown): Promise<number[]> {
  const outcome = await page.evaluate(
    (command) => (Reflect.get(window, '__cgv') as Hooks).project.execute(command),
    command,
  );
  expect(outcome, JSON.stringify(command)).not.toBeNull();
  return outcome!.created;
}

function call<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([name, args]) =>
      (Reflect.get(window, '__cgv') as Hooks).client.api[name as string](
        ...(args as unknown[]),
      ) as Promise<T>,
    [name, args] as const,
  );
}

async function clips(page: Page, track?: number): Promise<Clip[]> {
  const { project } = await snapshot(page);
  return project.tracks
    .filter((t) => track === undefined || t.id === track)
    .flatMap((t) => t.clips)
    .sort((a, b) => a.start - b.start);
}

/** Imports files by path; returns their media ids in order. */
async function importFiles(page: Page, files: string[]) {
  await page.getByTestId('media-file-input').setInputFiles(files);
  const names = files.map((file) =>
    file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1),
  );
  for (const name of names)
    await expect(page.locator(`[data-testid="media-item"][data-name="${name}"]`)).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 60000 },
    );
  const { project } = await snapshot(page);
  return names.map((name) => project.media.find((media) => media.name === name)!.id);
}

async function setSize(page: Page, width: number, height: number) {
  await run(page, {
    type: 'setSettings',
    settings: { width, height, frameRate: { num: 30, den: 1 }, sampleRate: 48000, channels: 2 },
  });
}

function select(page: Page, id: number) {
  return page.evaluate((id) => (Reflect.get(window, '__cgv') as Hooks).editor.select([id]), id);
}

function jobs(page: Page) {
  return page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).ai.jobs.map(({ label, progress }) => ({
      label,
      progress,
    })),
  );
}

async function idle(page: Page, timeout: number) {
  await page.waitForFunction(
    () => (Reflect.get(window, '__cgv') as Hooks).ai.jobs.length === 0,
    null,
    { timeout, polling: 250 },
  );
}

/** Plays for `seconds` after the clock starts, then pauses; returns the stats. */
async function playFor(page: Page, seconds: number) {
  const transport = page.getByTestId('transport');
  await call(page, 'resetPlaybackStats');
  await page.getByTestId('play-toggle').click();
  await expect(transport).toHaveAttribute('data-playing', 'true');
  await expect(transport).toHaveAttribute('data-starting', 'false', { timeout: 10000 });
  await call(page, 'resetPlaybackStats');
  await page.waitForTimeout(seconds * 1000);
  const stats = await call<Stats>(page, 'playbackStats');
  await page.getByTestId('play-toggle').click();
  await expect(transport).toHaveAttribute('data-playing', 'false');
  const { presented, dropped, late, renderMs, recentDrops } = stats;
  return { presented, dropped, late, renderMs, drops: recentDrops };
}

function record(testInfo: TestInfo, name: string, body: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const text = JSON.stringify(body, null, 2);
  writeFileSync(join(resultsDir, `${name}-${testInfo.project.name}.json`), text + '\n');
  return testInfo.attach(name, { body: text, contentType: 'application/json' });
}

/** The preview at timeline time `time`, as RGBA bytes. */
async function preview(page: Page, time: number) {
  const raw = await page.evaluate(async (time) => {
    const api = (Reflect.get(window, '__cgv') as Hooks).client.api;
    const pixels = (await api.renderPixels(time)) as {
      width: number;
      height: number;
      data: Uint8Array;
    };
    let text = '';
    for (let i = 0; i < pixels.data.length; i += 0x8000)
      text += String.fromCharCode(...pixels.data.subarray(i, i + 0x8000));
    return { width: pixels.width, height: pixels.height, data: btoa(text) };
  }, time);
  return { width: raw.width, height: raw.height, data: Buffer.from(raw.data, 'base64'), step: 4 };
}

type Picture = Awaited<ReturnType<typeof preview>>;

/** The mean of a box's channels (fractions of the picture), and how many of its pixels are black. */
function region(picture: Picture, x0: number, y0: number, x1: number, y1: number) {
  let sum = 0;
  let black = 0;
  let count = 0;
  for (let y = Math.floor(y0 * picture.height); y < Math.floor(y1 * picture.height); y++)
    for (let x = Math.floor(x0 * picture.width); x < Math.floor(x1 * picture.width); x++) {
      const i = (y * picture.width + x) * picture.step;
      const [r, g, b] = [picture.data[i], picture.data[i + 1], picture.data[i + 2]];
      sum += (r + g + b) / 3;
      if (Math.max(r, g, b) < 12) black++;
      count++;
    }
  return { mean: sum / count, black: black / count };
}

/** The mean absolute difference of two pictures' RGB, where `where` holds. */
function difference(a: Picture, b: Picture, where: (i: number) => boolean = () => true) {
  let sum = 0;
  let count = 0;
  for (let p = 0; p < a.width * a.height; p++) {
    if (!where(p)) continue;
    for (let c = 0; c < 3; c++) sum += Math.abs(a.data[p * a.step + c] - b.data[p * b.step + c]);
    count += 3;
  }
  return count ? sum / count : 0;
}

/** A picture as PNG bytes, for the test's output. */
function png(picture: Picture) {
  const out = new PNG({ width: picture.width, height: picture.height });
  for (let p = 0; p < picture.width * picture.height; p++) {
    for (let c = 0; c < 3; c++) out.data[p * 4 + c] = picture.data[p * picture.step + c];
    out.data[p * 4 + 3] = 255;
  }
  return PNG.sync.write(out);
}

/** WAV bytes of mono float samples, as 16-bit PCM. */
function wav(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) =>
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2),
  );
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Something like speech in a quiet room: a voice of eight harmonics, gliding
 * around 140 Hz, in syllables of 4.5 a second with breath noise, during `talk`;
 * the room's hiss, about -60 dBFS, throughout.
 */
function speechLike(talk: [number, number][], seconds: number, rate = 48000) {
  const out = new Float32Array(Math.round(seconds * rate));
  let seed = 7;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 31 - 1;
  };
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    phase += (2 * Math.PI * (140 + 15 * Math.sin(2 * Math.PI * 0.7 * t))) / rate;
    let s = 0.0017 * noise();
    const span = talk.find(([from, to]) => t >= from && t < to);
    if (span) {
      const syllable = 0.35 + 0.65 * Math.sin(Math.PI * 4.5 * (t - span[0])) ** 2;
      let voice = 0;
      for (let h = 1; h <= 8; h++) voice += Math.sin(h * phase) / h;
      s += syllable * (0.12 * voice + 0.02 * noise());
    }
    out[i] = s;
  }
  return out;
}

test('silence removal cuts out long pauses, keeping short ones and padding', async ({
  page,
}, testInfo) => {
  // Pauses of 0.8 s (leading), 0.3 s (kept: under the 0.5 s minimum), 1 s, 2 s
  // and 1 s (trailing). Each cut keeps 0.15 s of quiet beside the speech.
  const talk: [number, number][] = [
    [0.8, 3.0],
    [3.3, 5.0],
    [6.0, 7.5],
    [9.5, 11.0],
  ];
  const kept = [
    [0.65, 5.15],
    [5.85, 7.65],
    [9.35, 11.15],
  ];
  const file = testInfo.outputPath('pauses.wav');
  writeFileSync(file, wav(speechLike(talk, 12), 48000));
  await open(page);
  const [media] = await importFiles(page, [file]);
  await page.evaluate(
    (id) => (Reflect.get(window, '__cgv') as Hooks).project.addToTimeline(id),
    media,
  );
  const [clip] = await clips(page);
  await select(page, clip.id);
  await page.getByTestId('side-tab-inspector').click();
  await page.getByTestId('remove-silences').click();
  await expect.poll(async () => (await clips(page)).length, { timeout: 60000 }).toBe(3);
  const pieces = (await clips(page)).map((c) => ({
    start: c.start / SECOND,
    duration: c.duration / SECOND,
    sourceIn: c.sourceIn / SECOND,
  }));
  await record(testInfo, 'ai-silences', { kept, pieces });
  let at = 0;
  pieces.forEach((piece, i) => {
    const [from, to] = kept[i];
    // Cuts land on frames; levels are measured every 10 ms.
    expect(Math.abs(piece.sourceIn - from), `piece ${i} in`).toBeLessThan(0.045);
    expect(Math.abs(piece.sourceIn + piece.duration - to), `piece ${i} out`).toBeLessThan(0.045);
    // The pieces close up.
    expect(Math.abs(piece.start - at), `piece ${i} start`).toBeLessThan(1e-6);
    at += piece.duration;
  });
  // One undo step brings the clip back whole.
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).project.undo());
  const back = await clips(page);
  expect(back.map((c) => [c.sourceIn, c.duration])).toEqual([[0, clip.duration]]);
});

/**
 * Six shots with known cuts at frames 60, 135, 180, 270 and 375: a fast pan
 * (no cut), a white flash frame (no cut) and a half-second dissolve (no cut).
 */
function makeScenes(file: string) {
  const result = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1280x720:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      "testsrc=s=2560x720:r=30:d=2.5,crop=1280:720:'n*12':0",
      '-f',
      'lavfi',
      '-i',
      'smptehdbars=s=1280x720:r=30:d=1.5',
      '-f',
      'lavfi',
      '-i',
      "cellauto=s=1280x720:r=30:rule=110,trim=duration=3,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,45)'",
      '-f',
      'lavfi',
      '-i',
      'gradients=s=1280x720:r=30:d=2:speed=0.02',
      '-f',
      'lavfi',
      '-i',
      'rgbtestsrc=s=1280x720:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'mandelbrot=s=1280x720:r=30:end_scale=0.3,trim=duration=2',
      '-filter_complex',
      '[4:v][5:v]xfade=transition=fade:duration=0.5:offset=1.5[e];' +
        '[0:v][1:v][2:v][3:v][e][6:v]concat=n=6:v=1:a=0,format=yuv420p,' +
        'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[v]',
      '-map',
      '[v]',
      '-c:v',
      'libopenh264',
      '-b:v',
      '6M',
      '-g',
      '90',
      file,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error('FFmpeg failed: ' + result.stderr);
}

test('scene detection splits at every cut and nowhere else, and caches', async ({
  page,
}, testInfo) => {
  test.skip(needFfmpeg, 'FFmpeg is missing: run pnpm setup:ffmpeg');
  test.setTimeout(300000);
  const file = testInfo.outputPath('scenes.mp4');
  makeScenes(file);
  await open(page);
  const [media] = await importFiles(page, [file]);
  await page.evaluate(
    (id) => (Reflect.get(window, '__cgv') as Hooks).project.addToTimeline(id),
    media,
  );
  const [clip] = await clips(page);
  const split = () =>
    page.evaluate(async (id) => {
      const t0 = performance.now();
      await (Reflect.get(window, '__cgv') as Hooks).ai.splitScenes(id);
      return performance.now() - t0;
    }, clip.id);
  const first = await split();
  const shots = (await clips(page)).map((c) => [c.start / FRAME, c.duration / FRAME]);
  // Again, from the analysis cached the first time.
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).project.undo());
  expect(await clips(page)).toHaveLength(1);
  const again = await split();
  await record(testInfo, 'ai-scenes', { shots, ms: { first, again } });
  expect(shots).toEqual([
    [0, 60],
    [60, 75],
    [135, 45],
    [180, 90],
    [270, 105],
    [375, 60],
  ]);
  expect((await clips(page)).length).toBe(6);
  expect(again).toBeLessThan(first / 3);
});

test('beat markers fall on the music beds’ beats', async ({ page }, testInfo) => {
  test.setTimeout(300000);
  const { sounds } = JSON.parse(readFileSync(join(root, 'assets/sounds/sounds.json'), 'utf8')) as {
    sounds: { id: string; kind: string; bpm?: number; seconds: number; file: string }[];
  };
  const beds = sounds.filter((sound) => sound.kind === 'music' && sound.bpm);
  await open(page);
  const ids = await importFiles(
    page,
    beds.map((bed) => join(root, 'assets', bed.file)),
  );
  const track = (await snapshot(page)).project.tracks[1].id;
  const placed: number[] = [];
  for (const [i, bed] of beds.entries())
    placed.push(
      ...(await run(page, {
        type: 'append',
        track,
        clip: { media: ids[i], duration: Math.floor(bed.seconds * 30) * FRAME },
      })),
    );
  await page.evaluate(async (placed) => {
    for (const id of placed) await (Reflect.get(window, '__cgv') as Hooks).ai.detectBeats(id);
  }, placed);
  const found = new Map((await clips(page, track)).map((c) => [c.id, c.beats ?? []]));
  const report: Record<
    string,
    { bpm: number; beats: number; found: number; f: number; levels: number }
  > = {};
  for (const [i, bed] of beds.entries()) {
    // Whole bars, then a tail of 2 to 4 s for the reverb to ring out.
    const period = 60 / bed.bpm!;
    const tail = [2, 2.5, 3, 4].find((t) => {
      const bars = (bed.seconds - t) / (4 * period);
      return Math.abs(bars - Math.round(bars)) < 1e-3;
    })!;
    const length = bed.seconds - tail;
    const grid = (spacing: number) =>
      Array.from({ length: Math.round(length / spacing) }, (_, k) => k * spacing);
    const beats = found.get(placed[i])!.map((t) => t / SECOND);
    // F-measure with matches within 70 ms, the usual tolerance for beat tracking.
    const fMeasure = (truth: number[]) => {
      const used = new Set<number>();
      let hits = 0;
      for (const t of truth) {
        const k = beats.findIndex((b, j) => !used.has(j) && Math.abs(b - t) <= 0.07);
        if (k >= 0) {
          used.add(k);
          hits++;
        }
      }
      const precision = beats.length ? hits / beats.length : 0;
      const recall = hits / truth.length;
      return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    };
    // Twice or half the written tempo is the same music to a listener (and to a
    // cut snapping to it): the usual "allowed metrical levels".
    const f = fMeasure(grid(period));
    const levels = Math.max(f, fMeasure(grid(period / 2)), fMeasure(grid(period * 2)));
    report[bed.id] = { bpm: bed.bpm!, beats: grid(period).length, found: beats.length, f, levels };
  }
  await record(testInfo, 'ai-beats', report);
  // Ambient Drift has no beat to hear, only a pad each bar and a bell each half
  // bar, four and two seconds apart: its markers are recorded, not checked.
  for (const [id, { levels }] of Object.entries(report))
    if (id !== 'ambient-drift')
      expect(levels, `${id}: ${JSON.stringify(report[id])}`).toBeGreaterThanOrEqual(0.9);
});

/** The captions on the timeline, in order, as one text. */
async function captionText(page: Page) {
  return (await clips(page))
    .filter((clip) => clip.caption)
    .map((clip) => clip.title?.elements.find((e) => e.type === 'text')?.text ?? '')
    .join(' ');
}

interface Reference {
  language: string;
  seconds: number;
  utterances: { start: number; end: number; text: string }[];
}
const reference = (language: string) =>
  JSON.parse(readFileSync(join(mediaDir, `speech-${language}.json`), 'utf8')) as Reference;

function scoreCaptions(language: string, text: string) {
  const normalize = language === 'ar' ? normalizeArabic : normalizeEnglish;
  const truth = reference(language)
    .utterances.map((u) => u.text)
    .join(' ');
  return wordErrors(normalize(truth), normalize(text));
}

test('captions from speech: download the model, caption, edit, save SRT and VTT', async ({
  page,
}, testInfo) => {
  test.skip(!hasModel('whisper-tiny'), 'Whisper tiny is missing: run pnpm fetch-models');
  test.skip(!hasMedia('speech-en.m4a', 'speech-en.json'), 'The speech set is missing');
  test.setTimeout(15 * 60_000);
  await open(page, '&captionModel=whisper-tiny');
  const [media] = await importFiles(page, [join(mediaDir, 'speech-en.m4a')]);
  await page.evaluate(
    (id) => (Reflect.get(window, '__cgv') as Hooks).project.addToTimeline(id),
    media,
  );
  const [speech] = await clips(page);
  await select(page, speech.id);
  await page.getByTestId('side-tab-captions').click();
  await expect(page.getByTestId('caption-model')).toContainText('It downloads once');
  await page.getByTestId('download-caption-model').click();
  await expect(page.getByTestId('caption-model')).toContainText('Downloaded', { timeout: 120000 });
  await page.getByTestId('caption-language').selectOption('en');
  const started = Date.now();
  await page.getByTestId('generate-captions').click();
  await expect(page.getByTestId('caption-row').first()).toBeVisible({ timeout: 10 * 60_000 });
  const seconds = (Date.now() - started) / 1000;
  const rows = await page.getByTestId('caption-row').count();
  const text = await captionText(page);
  const score = scoreCaptions('en', text);
  await record(testInfo, 'ai-captions-tiny', { rows, seconds, score, text });
  // Lines a few seconds long, in order, inside the speech.
  const captions = (await clips(page)).filter((clip) => clip.caption);
  expect(captions.length).toBe(rows);
  expect(rows).toBeGreaterThan(24);
  for (const clip of captions) {
    expect(clip.duration / SECOND).toBeLessThan(8);
    expect(clip.start + clip.duration).toBeLessThanOrEqual(speech.duration + FRAME);
  }
  // The small model is a smoke test: its words are mostly right.
  expect(score.wer).toBeLessThan(0.35);

  // Fixing a line by hand.
  const first = page.getByTestId('caption-row').first().locator('textarea');
  await first.fill('Unfortunately, studying traffic flow is difficult');
  await first.press('Enter');
  await expect
    .poll(async () => (await captionText(page)).startsWith('Unfortunately, studying traffic flow'))
    .toBe(true);

  // Subtitle files of the same lines.
  const save = async (format: 'srt' | 'vtt') => {
    const download = page.waitForEvent('download');
    await page.getByTestId(`export-${format}`).click();
    const file = testInfo.outputPath(`captions.${format}`);
    await (await download).saveAs(file);
    return readFileSync(file, 'utf8');
  };
  const srt = await save('srt');
  const cues = srt.trim().split(/\n\n/);
  expect(cues).toHaveLength(rows);
  expect(cues[0]).toMatch(/^1\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\nUnfortunately/);
  const vtt = await save('vtt');
  expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
  expect(vtt.match(/ --> /g)).toHaveLength(rows);
});

for (const language of ['en', 'ar'] as const) {
  test(`captions of ${language === 'en' ? 'English' : 'Arabic'} speech need few corrections`, async ({
    page,
  }, testInfo) => {
    // The shipped model: about 560 MB, so it runs where it has been fetched.
    test.skip(
      !hasModel('whisper-large-v3-turbo'),
      'Whisper large-v3-turbo is missing: run pnpm fetch-models whisper-large-v3-turbo',
    );
    test.skip(!hasMedia(`speech-${language}.m4a`), 'The speech set is missing');
    test.setTimeout(60 * 60_000);
    const warnings: string[] = [];
    page.on('console', (m) => m.type() === 'warning' && warnings.push(m.text().split('\n')[0]));
    await open(page);
    const [media] = await importFiles(page, [join(mediaDir, `speech-${language}.m4a`)]);
    await page.evaluate(
      (id) => (Reflect.get(window, '__cgv') as Hooks).project.addToTimeline(id),
      media,
    );
    const [speech] = await clips(page);
    await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).captions.install());
    const seconds = await page.evaluate(
      async ([id, language]) => {
        const t0 = performance.now();
        await (Reflect.get(window, '__cgv') as Hooks).captions.generate(id, language, 'boxed');
        return (performance.now() - t0) / 1000;
      },
      [speech.id, language] as const,
    );
    const text = await captionText(page);
    const score = scoreCaptions(language, text);
    const audio = reference(language).seconds;
    await record(testInfo, `ai-wer-${language}`, {
      model: 'whisper-large-v3-turbo',
      seconds,
      realTime: audio / seconds,
      runtime: warnings.find((w) => /Whisper/.test(w)) ?? 'WebGPU',
      score,
      text,
    });
    // Logged limits (decisions, Phase 10): 10% for English, 20% for Arabic.
    expect(score.wer).toBeLessThanOrEqual(language === 'en' ? 0.1 : 0.2);
  });
}

/** Frame `index` of a video file as RGB bytes. */
function decodeFrame(file: string, index: number): Picture {
  const result = spawnSync(
    ffmpeg,
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `trim=start_frame=${index}:end_frame=${index + 1},` +
        'scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 1 << 24 },
  );
  if (result.status !== 0) throw new Error('FFmpeg failed: ' + String(result.stderr));
  return { width: 1280, height: 720, data: result.stdout, step: 3 };
}

test('background removal previews at 720p and exports from the cached mattes', async ({
  page,
}, testInfo) => {
  test.skip(!hasModel('selfie-landscape'), 'The segmentation model is missing: pnpm fetch-models');
  test.skip(!hasMedia('iss-message.webm'), 'The people clip is missing: pnpm fetch-test-media');
  test.skip(needFfmpeg, 'FFmpeg is missing: run pnpm setup:ffmpeg');
  test.setTimeout(10 * 60_000);
  await open(page);
  const [media] = await importFiles(page, [join(mediaDir, 'iss-message.webm')]);
  await setSize(page, 1280, 720);
  const main = (await snapshot(page)).project.tracks[0].id;
  // Eight seconds of the crew talking, from 5 s in.
  const [clip] = await run(page, {
    type: 'append',
    track: main,
    clip: { media, sourceIn: 5 * SECOND, duration: 8 * SECOND },
  });
  const shown = 4 * SECOND;
  const before = await preview(page, shown);
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).playback.seekFrame(30));
  const plain = await playFor(page, 5);

  await select(page, clip);
  await page.getByTestId('side-tab-inspector').click();
  const started = Date.now();
  // The box shows the clip's setting, which changes once the command lands.
  await page.getByTestId('remove-background').click();
  await expect(page.getByTestId('remove-background')).toBeChecked();
  await idle(page, 5 * 60_000);
  const jobSeconds = (Date.now() - started) / 1000;
  expect((await clips(page))[0].removeBackground).toBe(true);
  expect(
    await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).ai.unfinishedCutouts()),
  ).toEqual([]);

  const after = await preview(page, shown);
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).playback.seekFrame(30));
  const cut = await playFor(page, 5);
  // The station behind the crew goes; the face in the middle stays as it was.
  const corners = [region(after, 0, 0, 0.12, 0.2), region(after, 0.88, 0, 1, 0.2)];
  // The face of the astronaut speaking, in the middle.
  const face = {
    before: region(before, 0.52, 0.45, 0.56, 0.55),
    after: region(after, 0.52, 0.45, 0.56, 0.55),
  };
  const whole = region(after, 0, 0, 1, 1);
  const faceChange = difference(before, after, (p) => {
    const x = (p % after.width) / after.width;
    const y = Math.floor(p / after.width) / after.height;
    return x > 0.52 && x < 0.56 && y > 0.45 && y < 0.55;
  });

  // The export decodes nothing new for the mattes: it reads the ones made.
  let jobsSeen = 0;
  const watch = setInterval(
    () =>
      void jobs(page).then(
        (list) => (jobsSeen = Math.max(jobsSeen, list.length)),
        () => {},
      ),
    200,
  );
  const download = page.waitForEvent('download', { timeout: 10 * 60_000 });
  const settings: Settings = {
    format: 'mp4',
    width: 1280,
    height: 720,
    frameRate: { num: 30, den: 1 },
    video: { codec: 'avc', bitrate: 8_000_000 },
    audio: { codec: 'aac', bitrate: 128_000 },
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
  clearInterval(watch);
  expect(status, JSON.stringify(status)).toMatchObject({ state: 'done' });
  const file = testInfo.outputPath('cutout.mp4');
  await (await download).saveAs(file);
  const exported = decodeFrame(file, shown / FRAME);
  const exportChange = difference(after, exported);
  const exportedCorners = [region(exported, 0, 0, 0.12, 0.2), region(exported, 0.88, 0, 1, 0.2)];

  for (const [name, picture] of Object.entries({ before, after, exported }))
    writeFileSync(testInfo.outputPath(`${name}.png`), png(picture));
  const report = {
    jobSeconds,
    matteFps: (8 * 59.94) / jobSeconds,
    playback: { plain, cut },
    corners,
    exportedCorners,
    face,
    faceChange,
    removed: whole.black,
    exportChange,
    jobsDuringExport: jobsSeen,
  };
  await record(testInfo, 'ai-cutout', report);
  for (const corner of [...corners, ...exportedCorners]) expect(corner.black).toBeGreaterThan(0.95);
  expect(region(before, 0, 0, 0.12, 0.2).black).toBeLessThan(0.5);
  expect(faceChange).toBeLessThan(6);
  expect(whole.black).toBeGreaterThan(0.25);
  expect(whole.black).toBeLessThan(0.85);
  expect(exportChange).toBeLessThan(4);
  expect(jobsSeen).toBe(0);
  // Preview keeps up: no more than a few more frames dropped than without the cut.
  if (!software) {
    expect(cut.presented).toBeGreaterThan(plain.presented * 0.95);
    expect(cut.dropped).toBeLessThanOrEqual(plain.dropped + Math.max(3, plain.presented * 0.02));
  }
});

test('an AI job blocks neither playback nor editing, and cancels', async ({ page }, testInfo) => {
  test.skip(!hasModel('selfie-landscape'), 'The segmentation model is missing: pnpm fetch-models');
  test.skip(
    !hasMedia('iss-message.webm', 'h264-1080p30-aac.mp4'),
    'Test media is missing: pnpm fetch-test-media',
  );
  test.setTimeout(10 * 60_000);
  await open(page);
  const [h264, people] = await importFiles(page, [
    join(mediaDir, 'h264-1080p30-aac.mp4'),
    join(mediaDir, 'iss-message.webm'),
  ]);
  await setSize(page, 640, 360);
  const [main, top] = (await snapshot(page)).project.tracks.map((t) => t.id);
  const [shot] = await run(page, {
    type: 'append',
    track: main,
    clip: { media: h264, duration: 300 * FRAME },
  });
  // The whole people clip on a hidden track: its mattes take a minute or more to make.
  const [hidden] = await run(page, {
    type: 'append',
    track: top,
    clip: { media: people, duration: 90 * SECOND, audio: false },
  });
  await run(page, { type: 'setTrackHidden', track: top, hidden: true });

  /** Round trips of 20 edits: the shot's volume, up and down. */
  const edit = async () => {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      await run(page, {
        type: 'setClipProperties',
        clip: shot,
        properties: { volumeDb: i % 2 ? -3 : 0 },
      });
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { median: times[10], worst: times[19] };
  };
  const measure = async () => {
    await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).playback.seekFrame(0));
    return { playback: await playFor(page, 5), edits: await edit() };
  };
  const quiet = await measure();

  void page.evaluate(
    (id) => (Reflect.get(window, '__cgv') as Hooks).ai.setRemoveBackground(id, true),
    hidden,
  );
  await expect
    .poll(async () => (await jobs(page))[0]?.progress ?? 0, { timeout: 60000 })
    .toBeGreaterThan(0);
  const busy = await measure();
  const running = await jobs(page);
  expect(running, 'the job outlasts the measurement').toHaveLength(1);

  // Cancel: the job stops, the clip keeps its setting, and an export would wait.
  await page.getByTestId('side-tab-inspector').click();
  await select(page, hidden);
  await page.getByTestId('ai-job').getByRole('button', { name: 'Cancel' }).click();
  await idle(page, 30000);
  // Shown again, the clip holds an export up until its mattes are made.
  await run(page, { type: 'setTrackHidden', track: top, hidden: false });
  const waiting = await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).ai.unfinishedCutouts(),
  );
  await record(testInfo, 'ai-busy', { quiet, busy, job: running[0] });
  expect(waiting.map((c) => c.id)).toEqual([hidden]);
  expect(busy.playback.presented).toBeGreaterThan(quiet.playback.presented * 0.95);
  expect(busy.playback.dropped).toBeLessThanOrEqual(
    quiet.playback.dropped + Math.max(3, quiet.playback.presented * 0.02),
  );
  expect(busy.edits.median).toBeLessThan(Math.max(50, quiet.edits.median * 2));
});

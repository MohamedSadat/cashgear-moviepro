import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

// Phase 8: sound. Exports normalised to a loudness target are measured with
// FFmpeg's ebur128 filter; the mixer's meters are compared with FFmpeg's astats
// and ebur128 on the same test signals; ducking is checked in an exported WAV for
// depth and clicks. Signals are made here, so no recordings need licensing.
const root = process.cwd();
const resultsDir = join(root, 'bench/results');
const FRAME = 23_520_000; // one frame at 30 fps
const RATE = 48_000;
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin');
const exe = (name: string) => join(ffmpegDir, process.platform === 'win32' ? name + '.exe' : name);
const ffmpeg = exe('ffmpeg');
const hasFfmpeg = existsSync(ffmpeg);

test.skip(
  !hasFfmpeg && process.env.CGV_REQUIRE_FFMPEG !== '1',
  'FFmpeg is missing: run pnpm setup:ffmpeg',
);

interface Settings {
  format: string;
  width: number;
  height: number;
  frameRate: { num: number; den: number };
  video: { codec: string; bitrate: number } | null;
  audio: { codec: string; bitrate: number; loudness?: number | null } | null;
}
interface LoudnessPlan {
  target: number;
  measured: number;
  truePeak: number;
  gainDb: number;
  passes: number;
}
type Status =
  | { state: 'done'; result: { loudness: LoudnessPlan | null; elapsedMs: number } }
  | { state: 'failed' | 'cancelled' | 'idle' | 'running'; message?: string };
interface Level {
  peak: [number, number];
  rms: [number, number];
}
interface Reading {
  sample: number;
  momentary: number;
  shortTerm: number;
  integrated: number;
  master: Level;
  tracks: { id: number; level: Level }[];
}
type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
  project: { execute(command: unknown): Promise<{ created: number[] } | null> };
  meters: { take(): Reading[] };
  exporter: {
    start(settings: Settings, options?: { download?: boolean }): Promise<boolean>;
    settled(): Promise<Status>;
    dismiss(): void;
  };
};

// ---- Signals ----

/** A repeatable random number from 0 to 1. */
function random(seed: number) {
  let state = (seed * 0x9e3779b9) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** A 16-bit PCM WAV file of planar channels. */
function wav(file: string, channels: Float32Array[]) {
  const frames = channels[0].length;
  const count = channels.length;
  const data = Buffer.alloc(frames * count * 2);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < count; c++) {
      const value = Math.max(-1, Math.min(1, channels[c][i]));
      data.writeInt16LE(Math.round(value * 32767), (i * count + c) * 2);
    }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(count, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * count * 2, 28);
  header.writeUInt16LE(count * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

const seconds = (s: number) => Math.round(s * RATE);
const db = (value: number) => Math.pow(10, value / 20);

function sine(frames: number, frequency: number, amplitude: number, phase = 0) {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++)
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE + phase);
  return out;
}

/** Pink noise (Paul Kellet's filter) scaled to an RMS level in dBFS. */
function pink(frames: number, rmsDb: number, seed: number) {
  const next = random(seed);
  const out = new Float32Array(frames);
  let [b0, b1, b2, b3, b4, b5, b6] = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < frames; i++) {
    const white = next() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
  }
  let squares = 0;
  for (const x of out) squares += x * x;
  const scale = db(rmsDb) / Math.sqrt(squares / frames);
  for (let i = 0; i < frames; i++) out[i] *= scale;
  return out;
}

/**
 * Speech-like sound: bursts of band-limited noise shaped like syllables, with
 * pauses between phrases, at about `level` dBFS RMS while speaking.
 */
function speechLike(frames: number, level: number, seed: number) {
  const next = random(seed);
  const noise = pink(frames, level, seed + 1);
  const out = new Float32Array(frames);
  let at = 0;
  while (at < frames) {
    const phrase = seconds(1 + next() * 2);
    for (let syllable = at; syllable < Math.min(frames, at + phrase);) {
      const length = seconds(0.12 + next() * 0.18);
      for (let i = 0; i < length && syllable + i < frames; i++)
        out[syllable + i] = noise[syllable + i] * Math.sin((Math.PI * i) / length) * 1.6;
      syllable += length + seconds(0.03);
    }
    at += phrase + seconds(0.3 + next() * 0.6);
  }
  return out;
}

/** Chords of four tones with noisy beats, dense like mastered music. */
function musicLike(frames: number, seed: number) {
  const next = random(seed);
  const out = new Float32Array(frames);
  const chords = [
    [220, 277.2, 329.6, 440],
    [196, 246.9, 293.7, 392],
    [174.6, 220, 261.6, 349.2],
    [164.8, 207.7, 246.9, 329.6],
  ];
  const beat = seconds(0.5);
  for (let i = 0; i < frames; i++) {
    const chord = chords[Math.floor(i / seconds(2)) % chords.length];
    let value = 0;
    for (const f of chord) value += 0.12 * Math.sin((2 * Math.PI * f * i) / RATE);
    const sinceBeat = i % beat;
    value += (next() * 2 - 1) * 0.5 * Math.exp(-sinceBeat / seconds(0.03));
    out[i] = value;
  }
  return out;
}

// ---- The app ----

async function open(page: Page) {
  await page.goto('/?diagnostic=1');
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
}

async function execute(page: Page, command: unknown): Promise<number[]> {
  const outcome = await page.evaluate(
    (command) => (Reflect.get(window, '__cgv') as Hooks).project.execute(command),
    command,
  );
  expect(outcome, JSON.stringify(command)).not.toBeNull();
  return outcome!.created;
}

interface Snapshot {
  project: {
    media: { id: string; name: string }[];
    tracks: { id: number; clips: { id: number }[] }[];
  };
}

async function snapshot(page: Page) {
  return (await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
  )) as Snapshot;
}

/** Imports files (paths) and returns media ids by file name. */
async function importFiles(page: Page, paths: string[]) {
  await page.getByTestId('media-file-input').setInputFiles(paths);
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop()!;
    await expect(page.locator(`[data-testid="media-item"][data-name="${name}"]`)).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 60000 },
    );
  }
  const { project } = await snapshot(page);
  return new Map(project.media.map((media) => [media.name, media.id]));
}

/** Empties the timeline, sets 1080p30 at 48 kHz stereo and gives it `count` tracks. */
async function clear(page: Page, count: number) {
  const { project } = await snapshot(page);
  const clips = project.tracks.flatMap((track) => track.clips.map((clip) => clip.id));
  if (clips.length) await execute(page, { type: 'delete', clips });
  await execute(page, {
    type: 'setSettings',
    settings: {
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      sampleRate: RATE,
      channels: 2,
    },
  });
  let tracks = (await snapshot(page)).project.tracks;
  while (tracks.length < count) {
    await execute(page, { type: 'addTrack', index: tracks.length });
    tracks = (await snapshot(page)).project.tracks;
  }
  return tracks.map((track) => track.id);
}

async function append(page: Page, track: number, media: string, frames: number) {
  const [clip] = await execute(page, {
    type: 'append',
    track,
    clip: { media, duration: frames * FRAME },
  });
  return clip;
}

/** Exports with `settings` to a download saved as `file`. */
async function exportTo(page: Page, settings: Settings, file: string) {
  const download = page.waitForEvent('download', { timeout: 10 * 60_000 });
  const started = await page.evaluate(
    (settings) =>
      (Reflect.get(window, '__cgv') as Hooks).exporter.start(settings, { download: true }),
    settings,
  );
  expect(started).toBe(true);
  const status = await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).exporter.settled(),
  );
  expect(status, JSON.stringify(status)).toMatchObject({ state: 'done' });
  await (await download).saveAs(file);
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).exporter.dismiss());
  return (status as Extract<Status, { state: 'done' }>).result;
}

function record(name: string, testInfo: TestInfo, value: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const text = JSON.stringify(value, null, 2);
  writeFileSync(join(resultsDir, `${name}-${testInfo.project.name}.json`), text + '\n');
  return testInfo.attach(name, { body: text, contentType: 'application/json' });
}

/** FFmpeg's EBU R128 summary of a file: integrated loudness and true peak. */
function ebur128(file: string) {
  const result = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      file,
      '-filter_complex',
      'ebur128=peak=true',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  const summary = result.stderr.slice(result.stderr.lastIndexOf('Summary:'));
  const integrated = /I:\s+(-?[\d.]+) LUFS/.exec(summary);
  const peak = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary);
  if (!integrated || !peak) throw new Error('No ebur128 summary: ' + result.stderr.slice(-1500));
  return { integrated: Number(integrated[1]), truePeak: Number(peak[1]) };
}

const signals = join(root, 'test-results/signals');

test.describe('loudness', () => {
  test('exports hit the loudness target within 1 LU', async ({ page }, testInfo) => {
    test.setTimeout(600000);
    mkdirSync(signals, { recursive: true });
    const speech = speechLike(seconds(30), -34, 11);
    const music = musicLike(seconds(20), 12);
    // Quiet with sharp peaks: raising it to -14 LUFS needs the limiter.
    const dynamic = new Float32Array(seconds(20));
    dynamic.set(speechLike(seconds(20), -40, 13));
    for (let at = seconds(1); at < dynamic.length; at += seconds(1.7))
      for (let i = 0; i < 400; i++) dynamic[at + i] += 0.6 * Math.sin(i * 0.4) * Math.exp(-i / 80);
    const files = {
      speech: wav(join(signals, 'loudness-speech.wav'), [speech, speech]),
      music: wav(join(signals, 'loudness-music.wav'), [music, music.map((x) => x * 0.9)]),
      dynamic: wav(join(signals, 'loudness-dynamic.wav'), [dynamic, dynamic]),
    };
    await open(page);
    const ids = await importFiles(page, Object.values(files));
    const cases = [
      { signal: 'speech', target: -14, format: 'mp4' },
      { signal: 'speech', target: -23, format: 'wav' },
      { signal: 'music', target: -14, format: 'mp4' },
      { signal: 'music', target: -16, format: 'wav' },
      { signal: 'dynamic', target: -14, format: 'wav' },
      { signal: 'dynamic', target: -14, format: 'mp4' },
    ] as const;
    const results = [];
    for (const { signal, target, format } of cases) {
      const [track] = await clear(page, 2);
      const name = `loudness-${signal}.wav`;
      const length = { speech: 30, music: 20, dynamic: 20 }[signal] * 30;
      await append(page, track, ids.get(name)!, length);
      const before = ebur128(files[signal]);
      const file = testInfo.outputPath(`${signal}${target}.${format}`);
      const result = await exportTo(
        page,
        {
          format,
          width: 1280,
          height: 720,
          frameRate: { num: 30, den: 1 },
          video: format === 'mp4' ? { codec: 'avc', bitrate: 2e6 } : null,
          audio: {
            codec: format === 'mp4' ? 'aac' : 'pcm-s16',
            bitrate: format === 'mp4' ? 192_000 : 0,
            loudness: target,
          },
        },
        file,
      );
      const after = ebur128(file);
      results.push({
        signal,
        format,
        target,
        source: before,
        plan: result.loudness,
        export: after,
      });
      expect(result.loudness?.target).toBe(target);
      // The mixer measured what FFmpeg measures in the source.
      expect(Math.abs(result.loudness!.measured - before.integrated)).toBeLessThan(0.2);
      expect(Math.abs(after.integrated - target), `${signal} ${format}`).toBeLessThanOrEqual(1);
      // Peaks stay under -1 dBTP (AAC may overshoot a little).
      expect(after.truePeak).toBeLessThanOrEqual(format === 'wav' ? -0.9 : -0.3);
    }
    // The quiet, peaky case needed the limiter's effect measured too.
    expect(results.find((r) => r.signal === 'dynamic')?.plan?.passes).toBe(2);
    await record('loudness', testInfo, results);
  });
});

/** FFmpeg's astats of a file: peak and RMS level of each channel, in dBFS. */
function astats(file: string) {
  const result = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      file,
      '-af',
      'astats=measure_overall=none',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  const channels: { peak: number; rms: number }[] = [];
  for (const block of result.stderr.split(/Channel: \d+/).slice(1)) {
    const peak = /Peak level dB: (-?[\d.]+)/.exec(block);
    const rms = /RMS level dB: (-?[\d.]+)/.exec(block);
    if (peak && rms) channels.push({ peak: Number(peak[1]), rms: Number(rms[1]) });
  }
  if (channels.length < 2) throw new Error('No astats: ' + result.stderr.slice(-1500));
  return channels;
}

/** FFmpeg's momentary loudness every 100 ms (time in seconds, LUFS), and the integrated total. */
function ebur128Frames(file: string) {
  const result = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  const pattern = /t:\s*([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+|nan)/g;
  const frames = [...result.stderr.matchAll(pattern)].map((match) => ({
    time: Number(match[1]),
    momentary: Number(match[2]),
  }));
  return { frames, integrated: ebur128(file).integrated };
}

const dbOf = (value: number) => 20 * Math.log10(Math.max(value, 1e-10));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Plays the timeline from the start until it stops at its end; returns the meter readings. */
async function playThrough(page: Page, length: number) {
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).client.api.seek(0));
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).meters.take());
  const transport = page.getByTestId('transport');
  await page.getByTestId('play-toggle').click();
  await expect(transport).toHaveAttribute('data-playing', 'true');
  await expect(transport).toHaveAttribute('data-starting', 'false', { timeout: 10000 });
  // Half way, the master meter on screen shows the level.
  await page.waitForTimeout((length / 2) * 1000);
  const shown = await page.getByTestId('meter-master').evaluate((element) => ({
    peakL: Number(element.dataset.peakL),
    peakR: Number(element.dataset.peakR),
  }));
  await expect(transport).toHaveAttribute('data-playing', 'false', {
    timeout: (length + 15) * 1000,
  });
  const readings = await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).meters.take());
  return { readings, shown };
}

test.describe('meters', () => {
  test('meters match a reference meter on test signals', async ({ page }, testInfo) => {
    test.setTimeout(300000);
    mkdirSync(signals, { recursive: true });
    const frames = seconds(6);
    const gating = new Float32Array(seconds(12));
    gating.set(sine(seconds(3), 1000, db(-36)));
    gating.set(sine(seconds(6), 1000, db(-23)), seconds(3));
    gating.set(sine(seconds(3), 1000, db(-36)), seconds(9));
    const cases = [
      { name: 'sine', channels: [sine(frames, 997, db(-20)), sine(frames, 997, db(-20))] },
      { name: 'split', channels: [sine(frames, 1000, db(-6)), sine(frames, 440, db(-18))] },
      { name: 'pink', channels: [pink(seconds(8), -18, 21), pink(seconds(8), -18, 22)] },
      // EBU Tech 3341 case 3, shortened: the quiet parts are gated out.
      { name: 'gating', channels: [gating, gating] },
    ];
    const files = cases.map(({ name, channels }) =>
      wav(join(signals, `meter-${name}.wav`), channels),
    );
    await open(page);
    // The mixer's meters show while playing.
    await page.getByTestId('side-tab-mixer').click();
    await expect(page.getByTestId('mixer-master')).toBeVisible();
    const ids = await importFiles(page, files);
    const results = [];
    for (const [index, { name, channels }] of cases.entries()) {
      const [track] = await clear(page, 2);
      const length = channels[0].length / RATE;
      await append(page, track, ids.get(`meter-${name}.wav`)!, Math.round(length * 30));
      const { readings, shown } = await playThrough(page, length);
      // The page hears the meters about 30 times a second.
      expect(readings.length, name).toBeGreaterThan(length * 20);
      // Readings away from the clip's edges and the meters' first 300 ms.
      const settled = readings.filter(
        (r) => r.sample > 0.5 * RATE && r.sample < (length - 0.2) * RATE,
      );
      const reference = astats(files[index]);
      const loudness = ebur128Frames(files[index]);
      const ours = [0, 1].map((channel) => ({
        peak: dbOf(Math.max(...readings.map((r) => r.master.peak[channel]))),
        // The power average of the 300 ms readings.
        rms:
          10 *
          Math.log10(
            settled.reduce((sum, r) => sum + r.master.rms[channel] ** 2, 0) / settled.length,
          ),
      }));
      const momentary = median(
        settled.filter((r) => r.sample > 1.5 * RATE).map((r) => r.momentary),
      );
      const theirsMomentary = median(
        loudness.frames
          .filter((f) => f.time > 1.5 && f.time < length - 0.2)
          .map((f) => f.momentary),
      );
      const last = readings[readings.length - 1];
      results.push({
        name,
        ours,
        reference,
        momentary,
        theirsMomentary,
        integrated: last.integrated,
        theirsIntegrated: loudness.integrated,
        shown,
      });
      const tolerance = name === 'pink' ? 0.15 : 0.05;
      for (const channel of [0, 1]) {
        const label = `${name} channel ${channel + 1}`;
        expect
          .soft(Math.abs(ours[channel].peak - reference[channel].peak), label)
          .toBeLessThan(tolerance);
        // The gating case changes level, so a 300 ms RMS is not the whole file's.
        if (name !== 'gating')
          expect
            .soft(Math.abs(ours[channel].rms - reference[channel].rms), label)
            .toBeLessThan(tolerance);
      }
      if (name !== 'gating')
        expect.soft(Math.abs(momentary - theirsMomentary), `${name} momentary`).toBeLessThan(0.2);
      expect
        .soft(Math.abs(last.integrated - loudness.integrated), `${name} integrated`)
        .toBeLessThan(0.2);
      // One track: its own meter reads as the master does.
      const trackPeak = Math.max(...readings.map((r) => r.tracks[0]?.level.peak[0] ?? 0));
      const masterPeak = Math.max(...readings.map((r) => r.master.peak[0]));
      expect.soft(Math.abs(dbOf(trackPeak) - dbOf(masterPeak)), `${name} track`).toBeLessThan(0.01);
      if (name === 'sine') {
        expect.soft(Math.abs(shown.peakL + 20), 'the meter on screen').toBeLessThan(0.2);
        expect.soft(Math.abs(shown.peakR + 20), 'the meter on screen').toBeLessThan(0.2);
      }
    }
    await record('meters', testInfo, results);
  });
});

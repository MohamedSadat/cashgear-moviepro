import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

// Phase 8 exit criterion: recorded voiceover lines up within one frame of the
// playhead. The timeline plays a click track into a virtual audio cable (VB-CABLE:
// what goes into its "CABLE Input" comes out of its "CABLE Output" microphone),
// and the voiceover records the cable's other end, so the take goes through a
// real output device and a real microphone input, latencies and all. The placed
// take is exported alone and its clicks are found in the file, then compared
// with the clicks of the timeline exported the same way.
//
// It needs the cable (set CGV_LOOPBACK_OUTPUT and CGV_LOOPBACK_INPUT to use
// other devices), so it runs on the reference machine and skips elsewhere.
const root = process.cwd();
const resultsDir = join(root, 'bench/results');
const FRAME = 23_520_000;
const FLICKS = 705_600_000;
const RATE = 48_000;
const software = process.env.GPU_TEST_SOFTWARE === '1';
const signals = join(root, 'test-results/signals');
const outputName = process.env.CGV_LOOPBACK_OUTPUT ?? 'CABLE Input';
const inputName = process.env.CGV_LOOPBACK_INPUT ?? 'CABLE Output';

test.skip(software, 'Needs real sound devices');

// The permission prompt is answered yes; the devices stay real.
test.use({
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  },
});

type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
  project: { execute(command: unknown): Promise<{ created: number[] } | null> };
  voiceover: {
    phase: string;
    open(options?: { stream?: MediaStream }): Promise<void>;
    record(): void;
    stop(): Promise<void>;
  };
  exporter: {
    start(settings: unknown, options?: { download?: boolean }): Promise<boolean>;
    settled(): Promise<{ state: string }>;
    dismiss(): void;
  };
};

interface Snapshot {
  project: {
    media: { id: string; name: string }[];
    tracks: {
      id: number;
      name: string;
      clips: { id: number; start: number; duration: number; sourceIn: number }[];
    }[];
  };
}

function wav(file: string, samples: Float32Array) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => data.writeInt16LE(Math.round(value * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

/** The first channel of a 16-bit PCM WAV file, as numbers from -1 to 1. */
function readWav(file: string): Float32Array {
  const bytes = readFileSync(file);
  let at = 12;
  let channels = 1;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') channels = bytes.readUInt16LE(at + 10);
    if (id === 'data') {
      // The size may be larger than what follows; read what is there.
      const frames = Math.floor(Math.min(size, bytes.length - at - 8) / (2 * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++)
        out[i] = bytes.readInt16LE(at + 8 + i * 2 * channels) / 32768;
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('No data in ' + file);
}

/** Where each click starts: the first sample over a tenth of its peak near each second. */
function onsets(samples: Float32Array, seconds: number[]) {
  return seconds.map((second) => {
    const from = Math.max(0, Math.round((second - 0.3) * RATE));
    const to = Math.min(samples.length, Math.round((second + 0.3) * RATE));
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
    if (peak < 0.01) return null;
    for (let i = from; i < to; i++) if (Math.abs(samples[i]) > peak * 0.1) return i / RATE;
    return null;
  });
}

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

async function snapshot(page: Page) {
  return (await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
  )) as Snapshot;
}

async function exportWav(page: Page, file: string) {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  const settings = {
    format: 'wav',
    width: 1280,
    height: 720,
    frameRate: { num: 30, den: 1 },
    video: null,
    audio: { codec: 'pcm-s16', bitrate: 0, loudness: null },
  };
  const started = await page.evaluate(
    (settings) =>
      (Reflect.get(window, '__cgv') as Hooks).exporter.start(settings, { download: true }),
    settings,
  );
  expect(started).toBe(true);
  const status = await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).exporter.settled(),
  );
  expect(status.state).toBe('done');
  await (await download).saveAs(file);
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).exporter.dismiss());
}

function record(name: string, testInfo: TestInfo, value: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const text = JSON.stringify(value, null, 2);
  writeFileSync(join(resultsDir, `${name}-${testInfo.project.name}.json`), text + '\n');
  return testInfo.attach(name, { body: text, contentType: 'application/json' });
}

test('recorded voiceover lines up within one frame of the playhead', async ({ page }, testInfo) => {
  test.setTimeout(180000);
  mkdirSync(signals, { recursive: true });
  const seconds = 10;
  const samples = new Float32Array(seconds * RATE);
  for (let at = RATE; at < samples.length; at += RATE)
    for (let i = 0; i < 480; i++)
      samples[at + i] =
        0.6 * Math.sin((2 * Math.PI * 2000 * i) / RATE) * Math.sin((Math.PI * i) / 480);
  const file = wav(join(signals, 'loopback-clicks.wav'), samples);
  await open(page);
  await page.getByTestId('media-file-input').setInputFiles([file]);
  await expect(
    page.locator('[data-testid="media-item"][data-name="loopback-clicks.wav"]'),
  ).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
  let { project } = await snapshot(page);
  const media = project.media.find((m) => m.name === 'loopback-clicks.wav')!.id;
  await execute(page, {
    type: 'append',
    track: project.tracks[0].id,
    clip: { media, duration: seconds * 30 * FRAME },
  });
  // The take starts 1.5 s in, so the first click it hears is at 2 s.
  await page.evaluate(
    (time) => (Reflect.get(window, '__cgv') as Hooks).client.api.seek(time),
    45 * FRAME + 1,
  );

  // Playback into the cable, the voiceover from its other end.
  const captured = await page.evaluate(
    async ({ outputName, inputName }) => {
      const unlock = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of unlock.getTracks()) track.stop();
      const devices = await navigator.mediaDevices.enumerateDevices();
      const sink = devices.find((d) => d.kind === 'audiooutput' && d.label.includes(outputName));
      const mic = devices.find((d) => d.kind === 'audioinput' && d.label.includes(inputName));
      if (!sink || !mic)
        return {
          ok: false,
          reason: `no "${outputName}" output or "${inputName}" input among ${devices
            .map((d) => d.label)
            .join(', ')}`,
        };
      const hooks = Reflect.get(window, '__cgv') as Hooks & {
        client: { setOutputDevice(id: string): Promise<void> };
      };
      await hooks.client.setOutputDevice(sink.deviceId);
      await (
        hooks.voiceover as unknown as { open(options: { deviceId: string }): Promise<void> }
      ).open({ deviceId: mic.deviceId });
      return { ok: true, label: `${sink.label} → ${mic.label}` };
    },
    { outputName, inputName },
  );
  test.skip(!captured.ok, `No loopback: ${captured.reason}`);
  await expect(page.getByTestId('voiceover-panel')).toHaveAttribute('data-phase', 'ready');
  await page.getByTestId('voiceover-record').click();
  await expect(page.getByTestId('voiceover-panel')).toHaveAttribute('data-phase', 'recording', {
    timeout: 5000,
  });
  await page.waitForTimeout(6500);
  await page.getByTestId('voiceover-stop').click();
  await expect(page.getByTestId('voiceover-panel')).toHaveAttribute('data-phase', 'ready', {
    timeout: 30000,
  });
  ({ project } = await snapshot(page));
  const take = project.tracks.find((t) => t.name === 'Voiceover');
  expect(take?.clips.length).toBe(1);
  const clip = take!.clips[0];
  expect(clip.start).toBe(45 * FRAME);

  // The timeline's clicks, then the take's alone, as exported files.
  const voice = project.tracks.find((t) => t.name === 'Voiceover')!.id;
  const original = testInfo.outputPath('timeline.wav');
  await execute(page, { type: 'setTrackMuted', track: voice, muted: true });
  await exportWav(page, original);
  await execute(page, { type: 'setTrackMuted', track: voice, muted: false });
  await execute(page, { type: 'setTrackSound', track: voice, sound: { solo: true } });
  const recorded = testInfo.outputPath('voiceover.wav');
  await exportWav(page, recorded);

  const takeEnd = (clip.start + clip.duration) / FLICKS;
  const expected = [2, 3, 4, 5, 6, 7].filter((s) => s + 0.1 < takeEnd);
  const reference = onsets(readWav(original), expected);
  const heard = onsets(readWav(recorded), expected);
  const offsets = expected.map((second, i) =>
    reference[i] !== null && heard[i] !== null ? (heard[i]! - reference[i]!) * 1000 : null,
  );
  const found = offsets.filter((value): value is number => value !== null);
  await record('voiceover-alignment', testInfo, {
    devices: captured.label,
    clicks: expected,
    reference,
    heard,
    offsetsMs: offsets,
    worstMs: Math.max(...found.map(Math.abs)),
    meanMs: found.reduce((sum, value) => sum + value, 0) / found.length,
    frameMs: 1000 / 30,
  });
  expect(found.length, JSON.stringify(offsets)).toBe(expected.length);
  for (const offset of found) expect(Math.abs(offset)).toBeLessThan(1000 / 30);
});

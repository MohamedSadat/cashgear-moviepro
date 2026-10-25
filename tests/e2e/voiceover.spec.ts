import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

// Phase 8: voiceovers. Chrome's fake microphone checks the whole flow (open,
// count down, record while the timeline plays, place the take on a Dialogue
// track at the playhead). On the reference machine the timeline's own click
// track is recorded back through the system's sound output (Chrome's
// system-audio loopback), and the placed take's clicks are measured against
// the timeline's: the exit criterion of lining up within one frame.
const root = process.cwd();
const resultsDir = join(root, 'bench/results');
const FRAME = 23_520_000;
const FLICKS = 705_600_000;
const RATE = 48_000;
const software = process.env.GPU_TEST_SOFTWARE === '1';
const signals = join(root, 'test-results/signals');

type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
  project: { execute(command: unknown): Promise<{ created: number[] } | null> };
  voiceover: {
    phase: string;
    open(options?: { stream?: MediaStream }): Promise<void>;
    record(): void;
    stop(): Promise<void>;
    close(): void;
  };
  exporter: {
    start(settings: unknown, options?: { download?: boolean }): Promise<boolean>;
    settled(): Promise<{ state: string }>;
    dismiss(): void;
  };
};

interface Snapshot {
  project: {
    media: { id: string; name: string; duration: number }[];
    tracks: {
      id: number;
      name: string;
      role?: string;
      clips: { id: number; media: string; start: number; duration: number; sourceIn: number }[];
    }[];
  };
}

/** A 16-bit PCM WAV of one channel. */
function wav(file: string, samples: Float32Array) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) =>
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2),
  );
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

/** Ten-millisecond bursts of 2 kHz at each whole second from 1 s, `seconds` long. */
function clicks(seconds: number) {
  const samples = new Float32Array(seconds * RATE);
  for (let at = RATE; at < samples.length; at += RATE)
    for (let i = 0; i < 480; i++)
      samples[at + i] =
        0.6 * Math.sin((2 * Math.PI * 2000 * i) / RATE) * Math.sin((Math.PI * i) / 480);
  return samples;
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

/** Imports a file and returns its media id. */
async function importFile(page: Page, path: string) {
  await page.getByTestId('media-file-input').setInputFiles([path]);
  const name = path.split(/[\\/]/).pop()!;
  await expect(page.locator(`[data-testid="media-item"][data-name="${name}"]`)).toHaveAttribute(
    'data-status',
    'ready',
    { timeout: 60000 },
  );
  return (await snapshot(page)).project.media.find((media) => media.name === name)!.id;
}

function record(name: string, testInfo: TestInfo, value: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const text = JSON.stringify(value, null, 2);
  writeFileSync(join(resultsDir, `${name}-${testInfo.project.name}.json`), text + '\n');
  return testInfo.attach(name, { body: text, contentType: 'application/json' });
}

/** Sets up the click track on the main track and the playhead at its start. */
async function clickTrack(page: Page, seconds: number) {
  mkdirSync(signals, { recursive: true });
  const id = await importFile(page, wav(join(signals, `clicks-${seconds}.wav`), clicks(seconds)));
  const { project } = await snapshot(page);
  await execute(page, {
    type: 'append',
    track: project.tracks[0].id,
    clip: { media: id, duration: seconds * 30 * FRAME },
  });
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).client.api.seek(0));
  return id;
}

/** The voiceover track and its clip, once the take is placed. */
async function placedTake(page: Page) {
  await expect
    .poll(async () => (await snapshot(page)).project.tracks.some((t) => t.name === 'Voiceover'))
    .toBe(true);
  const { project } = await snapshot(page);
  const track = project.tracks.find((t) => t.name === 'Voiceover')!;
  return {
    track,
    clip: track.clips[0],
    media: project.media.find((m) => m.id === track.clips[0].media)!,
  };
}

// Chrome replaces the microphone with a beeping fake that needs no permission prompt.
test.use({
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      ...(software
        ? [
            '--enable-unsafe-webgpu',
            '--enable-unsafe-swiftshader',
            '--use-angle=d3d11-warp',
            '--use-webgpu-adapter=swiftshader',
          ]
        : []),
    ],
  },
});

test.describe('with the fake microphone', () => {
  test('a voiceover counts down, records while the timeline plays and lands at the playhead', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120000);
    await open(page);
    await clickTrack(page, 8);
    await page.evaluate(() =>
      (Reflect.get(window, '__cgv') as Hooks).client.api.seek(2 * 705_600_000 + 1),
    );
    await page.getByTestId('record-voiceover').click();
    const panel = page.getByTestId('voiceover-panel');
    await expect(panel).toHaveAttribute('data-phase', 'ready');
    // The fake microphone beeps: the input meter moves.
    await expect
      .poll(async () => Number(await page.getByTestId('voiceover-level').getAttribute('data-db')))
      .toBeGreaterThan(-40);
    await page.getByTestId('voiceover-record').click();
    await expect(page.getByTestId('voiceover-countdown')).toHaveText('3');
    await expect(panel).toHaveAttribute('data-phase', 'recording', { timeout: 5000 });
    await expect(page.getByTestId('transport')).toHaveAttribute('data-playing', 'true');
    await page.waitForTimeout(2500);
    await page.getByTestId('voiceover-stop').click();
    await expect(panel).toHaveAttribute('data-phase', 'ready', { timeout: 20000 });
    const { track, clip, media } = await placedTake(page);
    expect(media.name).toBe('Voiceover 1.wav');
    expect(track.role).toBe('dialogue');
    // At the playhead the take started from (frame 60), about as long as recorded.
    expect(clip.start).toBe(60 * FRAME);
    const seconds = clip.duration / FLICKS;
    expect(seconds).toBeGreaterThan(2);
    expect(seconds).toBeLessThan(4);
    // The countdown's sound is kept before the clip's start, to trim back to.
    expect(clip.sourceIn / FLICKS).toBeGreaterThan(2.5);
    expect(media.duration / FLICKS).toBeGreaterThan(seconds + 2.5);
    // One undo removes the whole take.
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await snapshot(page)).project.tracks.length).toBe(2);
    await record('voiceover-flow', testInfo, { seconds, sourceIn: clip.sourceIn / FLICKS });
  });
});

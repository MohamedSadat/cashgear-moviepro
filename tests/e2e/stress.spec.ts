import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test';

// Phase 11 exit criterion: a one-hour project of 1,000 clips edits, plays and
// exports without crashes or memory growth. The page's memory (its workers'
// included) is read with measureUserAgentSpecificMemory, which waits for a garbage
// collection. CGV_STRESS_MINUTES sets the length (60 by default). On software GPUs
// it runs only when that is set: there a minute's export takes over ten.
const software = process.env.GPU_TEST_SOFTWARE === '1';
const minutes = Number(process.env.CGV_STRESS_MINUTES ?? 60);
const FRAME = 23_520_000; // one frame at 30 fps
/** 3.6 s: a thousand of them make an hour. */
const clipFrames = 108;
const clipCount = Math.round((minutes * 60 * 30) / clipFrames);
const mediaDir = join(process.cwd(), 'tests/media');
const resultsDir = join(process.cwd(), 'bench/results');
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(process.cwd(), '.tools/ffmpeg/bin');
const ffprobe = join(ffmpegDir, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

type Hooks = {
  client: {
    api: {
      projectSnapshot(): Promise<{
        project: {
          mainTrack: number;
          media: { id: string; name: string }[];
          tracks: { id: number; clips: { id: number; start: number; duration: number }[] }[];
        };
      }>;
    };
  };
  project: {
    execute(command: unknown): Promise<{ created: number[] } | null>;
    executeGroup(label: string, commands: unknown[]): Promise<unknown[] | null>;
    undo(): Promise<void>;
    redo(): Promise<void>;
  };
  exporter: {
    start(settings: unknown, options: { download: boolean }): Promise<boolean>;
    settled(): Promise<{ state: string; message?: string; result?: { frames: number } }>;
    dismiss(): void;
    status: { state: string; progress?: { fraction: number } | null };
  };
};

const hooks = (page: Page) => page.evaluateHandle(() => Reflect.get(window, '__cgv') as Hooks);

interface Memory {
  /** The page's and its workers' JavaScript and WASM, after a garbage collection. */
  js: number;
  /** The browser's processes' private memory: the GPU's, with frames and textures, too. */
  processes: number | null;
  /** The same by kind of process (browser, renderer, GPU, utility). */
  byKind?: Record<string, number>;
}

/** What the app holds, in MB. */
async function memory(page: Page): Promise<Memory> {
  const bytes = await page.evaluate(async () => {
    const measure = (
      performance as Performance & {
        measureUserAgentSpecificMemory(): Promise<{ bytes: number }>;
      }
    ).measureUserAgentSpecificMemory;
    return (await measure.call(performance)).bytes;
  });
  if (process.platform !== 'win32') return { js: Math.round(bytes / 1e6), processes: null };
  const cdp = await page.context().browser()!.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  await cdp.detach();
  const kinds = new Map(processInfo.map((info) => [info.id, info.type]));
  const listed = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-Process -Id ${[...kinds.keys()].join(',')} -ErrorAction SilentlyContinue | ` +
        'ForEach-Object { "$($_.Id) $($_.PrivateMemorySize64)" }',
    ],
    { encoding: 'utf8' },
  );
  const byKind: Record<string, number> = {};
  for (const line of listed.stdout.trim().split(/\r?\n/)) {
    const [id, size] = line.split(' ').map(Number);
    const kind = kinds.get(id) ?? 'other';
    byKind[kind] = (byKind[kind] ?? 0) + Math.round(size / 1e6);
  }
  const processes = Object.values(byKind).reduce((sum, size) => sum + size, 0);
  return { js: Math.round(bytes / 1e6), processes, byKind };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

function record(testInfo: TestInfo, body: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const text = JSON.stringify(body, null, 2);
  writeFileSync(join(resultsDir, `stress-${testInfo.project.name}.json`), text + '\n');
  return testInfo.attach('stress', { body: text, contentType: 'application/json' });
}

test('a one-hour project of 1,000 clips edits, plays and exports without crashes or memory growth', async () => {
  const testInfo = test.info();
  test.skip(software && !process.env.CGV_STRESS_MINUTES, 'set CGV_STRESS_MINUTES on software GPUs');
  test.setTimeout((15 + minutes * 1.5) * 60_000);
  // A profile of its own, as users have: in Playwright's incognito contexts the
  // browser keeps OPFS, where the export is written, in its own memory.
  const profile = await mkdtemp(join(tmpdir(), 'cgv-stress-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: testInfo.project.use.channel,
    args: testInfo.project.use.launchOptions?.args,
    viewport: { width: 1280, height: 800 },
  });
  try {
    await stress(context.pages()[0] ?? (await context.newPage()), testInfo);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
});

async function stress(page: Page, testInfo: TestInfo) {
  await page.goto('http://127.0.0.1:4173/?diagnostic=1');
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      !['Opening…', undefined].includes(
        document.querySelector('[data-testid="project-name"]')?.textContent ?? undefined,
      ) &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
  await page.getByTestId('media-file-input').setInputFiles(join(mediaDir, 'h264-1080p30-aac.mp4'));
  await expect(page.locator('[data-testid="media-item"]')).toHaveAttribute('data-status', 'ready', {
    timeout: 60_000,
  });
  const samples: ({ at: string } & Memory)[] = [];
  const sample = async (at: string) => samples.push({ at, ...(await memory(page)) });
  await sample('empty');

  // Build: clips of the 10 s clip from different points, with their sound.
  const started = Date.now();
  const built = await page.evaluate(
    async ({ count, frames, FRAME }) => {
      const hooks = Reflect.get(window, '__cgv') as Hooks;
      const { project } = await hooks.client.api.projectSnapshot();
      const media = project.media[0].id;
      const commands = Array.from({ length: count }, (_, i) => ({
        type: 'append',
        track: project.mainTrack,
        clip: { media, sourceIn: ((i * 37) % (300 - frames)) * FRAME, duration: frames * FRAME },
      }));
      for (let i = 0; i < commands.length; i += 100) {
        await hooks.project.executeGroup('Build', commands.slice(i, i + 100));
      }
      const after = await hooks.client.api.projectSnapshot();
      const main = after.project.tracks.find((track) => track.id === project.mainTrack)!;
      const last = main.clips.at(-1)!;
      return { clips: main.clips.length, end: (last.start + last.duration) / FRAME / 30 };
    },
    { count: clipCount, frames: clipFrames, FRAME },
  );
  expect(built.clips).toBe(clipCount);
  const buildSeconds = (Date.now() - started) / 1000;
  await sample('built');

  // Edit: splits and ripple deletes across the hour, then undo and redo them all.
  const edits = await page.evaluate(
    async ({ FRAME, end }) => {
      const hooks = Reflect.get(window, '__cgv') as Hooks;
      const times: number[] = [];
      let seed = 7;
      const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
      const timed = async (run: () => Promise<unknown>) => {
        const before = performance.now();
        await run();
        times.push(performance.now() - before);
      };
      for (let i = 0; i < 150; i++) {
        const at = Math.round(random() * end * 30) * FRAME;
        await timed(() => hooks.project.execute({ type: 'split', at }));
      }
      for (let i = 0; i < 50; i++) {
        const { project } = await hooks.client.api.projectSnapshot();
        const main = project.tracks.find((track) => track.id === project.mainTrack)!;
        const clip = main.clips[Math.floor(random() * main.clips.length)];
        await timed(() => hooks.project.execute({ type: 'rippleDelete', clips: [clip.id] }));
      }
      for (let i = 0; i < 200; i++) await timed(() => hooks.project.undo());
      for (let i = 0; i < 200; i++) await timed(() => hooks.project.redo());
      const sorted = [...times].sort((a, b) => a - b);
      return {
        count: times.length,
        medianMs: sorted[sorted.length >> 1],
        p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        maxMs: sorted.at(-1),
      };
    },
    { FRAME, end: built.end },
  );
  await sample('edited');
  const end = await page.evaluate(async (FRAME) => {
    const hooks = Reflect.get(window, '__cgv') as Hooks;
    const { project } = await hooks.client.api.projectSnapshot();
    const main = project.tracks.find((track) => track.id === project.mainTrack)!;
    const last = main.clips.at(-1)!;
    return (last.start + last.duration) / FRAME / 30;
  }, FRAME);

  // Play a few seconds at five places across the hour.
  const transport = page.getByTestId('transport');
  for (const fraction of [0.05, 0.3, 0.5, 0.75, 0.95]) {
    await page.evaluate(
      (time) => Reflect.get(window, '__cgv').client.api.seek(time),
      Math.round(fraction * end * 30) * FRAME,
    );
    await page.getByTestId('play-toggle').click();
    await expect(transport).toHaveAttribute('data-playing', 'true');
    // Pausing while playback still starts is ignored: wait for its clock first.
    await expect(transport).toHaveAttribute('data-starting', 'false', { timeout: 15_000 });
    await page.waitForTimeout(3000);
    await page.getByTestId('play-toggle').click();
    await expect(transport).toHaveAttribute('data-playing', 'false');
  }
  await sample('played');

  // Export the hour: 1080p H.264 at 2 Mbit/s, so the file stays under a gigabyte.
  const download = page.waitForEvent('download', { timeout: (5 + minutes * 5) * 60_000 });
  const exportStarted = Date.now();
  const handle = await hooks(page);
  await handle.evaluate((hooks) =>
    hooks.exporter.start(
      {
        format: 'mp4',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        video: { codec: 'avc', bitrate: 2e6 },
        audio: { codec: 'aac', bitrate: 128000, loudness: null },
      },
      { download: true },
    ),
  );
  const during: ({ fraction: number } & Memory)[] = [];
  for (;;) {
    // The hooks object is replaced as the page renders: read the current one.
    const status = await page.evaluate(() => {
      const { exporter } = Reflect.get(window, '__cgv') as Hooks;
      return { state: exporter.status.state, fraction: exporter.status.progress?.fraction ?? 0 };
    });
    if (status.state !== 'running') break;
    during.push({ fraction: status.fraction, ...(await memory(page)) });
    await page.waitForTimeout(minutes < 15 ? 5000 : 20_000);
  }
  const status = await handle.evaluate((hooks) => hooks.exporter.settled());
  expect(status, JSON.stringify(status)).toMatchObject({ state: 'done' });
  const exportSeconds = (Date.now() - exportStarted) / 1000;
  const file = testInfo.outputPath('stress.mp4');
  await (await download).saveAs(file);
  await handle.evaluate((hooks) => hooks.exporter.dismiss());
  await sample('exported');

  let seconds: number | null = null;
  if (existsSync(ffprobe)) {
    const probe = spawnSync(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { encoding: 'utf8' },
    );
    seconds = Number(probe.stdout.trim());
  }
  rmSync(file, { force: true });

  // Memory in the export's last third against its first: no growth beyond noise.
  const third = Math.max(1, Math.floor(during.length / 3));
  const trend = (pick: (sample: Memory) => number | null) => ({
    early: median(during.slice(0, third).map((sample) => pick(sample) ?? 0)),
    late: median(during.slice(-third).map((sample) => pick(sample) ?? 0)),
  });
  const js = trend((sample) => sample.js);
  const processes = trend((sample) => sample.processes);
  const result = {
    minutes,
    clips: clipCount,
    software,
    browser: page.context().browser()?.version(),
    buildSeconds,
    edits,
    exportSeconds,
    seconds: end,
    realTime: end / exportSeconds,
    exportedSeconds: seconds,
    memoryMb: { samples, during, js, processes },
  };
  await record(testInfo, result);
  if (seconds !== null) expect(Math.abs(seconds - end)).toBeLessThan(1);
  expect(during.length).toBeGreaterThan(2);
  expect(js.late - js.early).toBeLessThan(Math.max(64, js.early * 0.1));
  expect(processes.late - processes.early).toBeLessThan(Math.max(256, processes.early * 0.15));
  // After the export the page is back near where it was before it.
  const before = samples.find((sample) => sample.at === 'played')!.js;
  expect(samples.at(-1)!.js).toBeLessThan(before + Math.max(64, before * 0.15));
  if (!software) expect(edits.medianMs).toBeLessThan(50);
}

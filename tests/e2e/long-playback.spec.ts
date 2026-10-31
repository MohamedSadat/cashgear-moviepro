import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 11 stress test: hours of continuous playback without a crash, a stall or
// memory growth. A ten-minute edit of 3.6 s cuts with music under it plays in a
// loop for CGV_PLAYBACK_HOURS (8 on the reference machine); the results file is
// rewritten every sample, so a run cut short still reports. Skipped unless set.
const hours = Number(process.env.CGV_PLAYBACK_HOURS ?? 0);
const FRAME = 23_520_000;
const loopMinutes = 10;
const sampleMs = 5 * 60_000;
const mediaDir = join(process.cwd(), 'tests/media');
const resultsDir = join(process.cwd(), 'bench/results');

type Stats = { presented: number; dropped: number; late: number };

async function processMemory(page: Page): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  const cdp = await page.context().browser()!.newBrowserCDPSession();
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  await cdp.detach();
  const ids = processInfo.map((info) => info.id).join(',');
  const sum = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum`,
    ],
    {
      encoding: 'utf8',
      // Windows PowerShell started from PowerShell 7 cannot load its modules with PS 7's path.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
      ),
    },
  );
  return Math.round(Number(sum.stdout.trim()) / 1e6);
}

test('hours of playback run without a crash, a stall or memory growth', async ({
  page,
}, testInfo) => {
  test.skip(!hours, 'set CGV_PLAYBACK_HOURS to run it');
  test.setTimeout((hours * 60 + 15) * 60_000);
  await page.goto('/?diagnostic=1');
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
  await page
    .getByTestId('media-file-input')
    .setInputFiles(['h264-1080p30-aac.mp4', 'tone-48k-stereo.wav'].map((f) => join(mediaDir, f)));
  await expect(page.locator('[data-testid="media-item"][data-status="ready"]')).toHaveCount(2, {
    timeout: 60_000,
  });
  const end = await page.evaluate(
    async ({ FRAME, minutes }) => {
      const hooks = Reflect.get(window, '__cgv');
      const { project } = await hooks.client.api.projectSnapshot();
      const video = project.media.find((m: { name: string }) => m.name.endsWith('.mp4')).id;
      const tone = project.media.find((m: { name: string }) => m.name.endsWith('.wav')).id;
      const count = Math.round((minutes * 60 * 30) / 108);
      await hooks.project.executeGroup(
        'Build',
        Array.from({ length: count }, (_, i) => ({
          type: 'append',
          track: project.mainTrack,
          clip: { media: video, sourceIn: ((i * 37) % 192) * FRAME, duration: 108 * FRAME },
        })),
      );
      const [{ created }] = await hooks.project.executeGroup('Music', [
        { type: 'addTrack', index: project.tracks.length },
      ]);
      // The tone under the cuts, five seconds at a time.
      await hooks.project.executeGroup(
        'Music',
        Array.from({ length: Math.round((minutes * 60) / 5) }, (_, i) => ({
          type: 'overwrite',
          track: created[0],
          at: i * 150 * FRAME,
          clip: { media: tone, duration: 150 * FRAME, video: false },
        })),
      );
      return count * 108 * FRAME;
    },
    { FRAME, minutes: loopMinutes },
  );

  const transport = page.getByTestId('transport');
  const started = Date.now();
  const samples: { minutes: number; loops: number; processes: number | null; js: number }[] = [];
  const totals = { presented: 0, dropped: 0, late: 0 };
  let loops = 0;
  const save = () => {
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(
      join(resultsDir, `long-playback-${testInfo.project.name}.json`),
      JSON.stringify(
        { hours, loopMinutes, browser: page.context().browser()?.version(), totals, samples },
        null,
        2,
      ),
    );
  };
  let nextSample = 0;
  while (Date.now() - started < hours * 3600_000) {
    // Each loop plays the edit from the start to the end.
    await page.evaluate(() => Reflect.get(window, '__cgv').client.api.resetPlaybackStats());
    await page.evaluate(() => Reflect.get(window, '__cgv').client.api.seek(0));
    await page.getByTestId('play-toggle').click();
    await expect(transport).toHaveAttribute('data-playing', 'true');
    for (;;) {
      await page.waitForTimeout(10_000);
      const elapsed = Date.now() - started;
      if (elapsed >= nextSample) {
        nextSample += sampleMs;
        const js = await page.evaluate(async () => {
          const measure = (
            performance as Performance & {
              measureUserAgentSpecificMemory(): Promise<{ bytes: number }>;
            }
          ).measureUserAgentSpecificMemory;
          return Math.round((await measure.call(performance)).bytes / 1e6);
        });
        samples.push({
          minutes: Math.round(elapsed / 60_000),
          loops,
          processes: await processMemory(page),
          js,
        });
        save();
      }
      // Playback stops by itself at the end of the edit.
      if ((await transport.getAttribute('data-playing')) !== 'true') break;
      if (Date.now() - started >= hours * 3600_000) break;
    }
    const stats = (await page.evaluate(() =>
      Reflect.get(window, '__cgv').client.api.playbackStats(),
    )) as Stats;
    totals.presented += stats.presented;
    totals.dropped += stats.dropped;
    totals.late += stats.late;
    loops++;
    if ((await transport.getAttribute('data-playing')) === 'true') {
      await page.getByTestId('play-toggle').click();
    }
  }
  save();
  expect(end).toBeGreaterThan(0);
  // Every loop played through: about 30 frames a second of it.
  expect(totals.presented).toBeGreaterThan(hours * 3600 * 30 * 0.9);
  const first = samples.find((sample) => sample.minutes >= 30) ?? samples[0];
  const last = samples.at(-1)!;
  expect(last.js - first.js).toBeLessThan(Math.max(64, first.js * 0.15));
  if (first.processes !== null && last.processes !== null) {
    expect(last.processes - first.processes).toBeLessThan(Math.max(256, first.processes * 0.15));
  }
});

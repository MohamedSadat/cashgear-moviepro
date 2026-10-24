import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

// Phase 4 exit criterion: the timeline scrolls and zooms at 60 fps with 500 clips.
// Each animation frame sends one wheel event to the canvas, as a trackpad or
// mouse wheel does, and the page records when frames happen and how long each
// timeline draw takes. CI's software GPUs give functional results only.
const mediaDir = join(process.cwd(), 'tests/media');
const resultsDir = join(process.cwd(), 'bench/results');
const software = process.env.GPU_TEST_SOFTWARE === '1';
const FRAME = 23_520_000;

function record(testInfo: TestInfo, name: string, body: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const text = JSON.stringify(body, null, 2);
  writeFileSync(join(resultsDir, `${name}-${testInfo.project.name}.json`), text + '\n');
  return testInfo.attach(name, { body: text, contentType: 'application/json' });
}

async function open(page: Page) {
  await page.goto('/?diagnostic=1');
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      !!Reflect.get(window, '__cgvTimeline') &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
}

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
}

interface Run {
  frames: number;
  /** Milliseconds between animation frames. */
  interval: { mean: number; p95: number; max: number; slow: number };
  /** Milliseconds each timeline draw took. */
  draw: { mean: number; p95: number; max: number; count: number };
  slowFrames: { i: number; interval: number; scale: number; draw: number | null }[];
  moved: boolean;
}

/** Sends one wheel event per animation frame for `frames` frames and measures. */
function measure(page: Page, kind: 'scroll' | 'zoom', frames: number): Promise<Run> {
  return page.evaluate(
    async ({ kind, frames }) => {
      const timeline = Reflect.get(window, '__cgvTimeline');
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="timeline-canvas"]')!;
      const box = canvas.getBoundingClientRect();
      const before = { ...timeline.view };
      // The draw times of this run only.
      timeline.stats.drawMs.length = 0;
      const stamps: number[] = [];
      const scales: number[] = [];
      await new Promise<void>((done) => {
        const tick = (now: number) => {
          stamps.push(now);
          scales.push(timeline.view.scale);
          const i = stamps.length;
          if (i > frames) return done();
          const zoom = kind === 'zoom';
          // Zoom in for half the run, then out again; scroll right all the way.
          const delta = zoom ? (i <= frames / 2 ? -40 : 40) : 60;
          canvas.dispatchEvent(
            new WheelEvent('wheel', {
              deltaY: delta,
              deltaMode: 0,
              shiftKey: !zoom,
              ctrlKey: zoom,
              clientX: box.left + box.width * 0.4,
              clientY: box.top + box.height * 0.5,
              bubbles: true,
              cancelable: true,
            }),
          );
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const intervals = stamps.slice(1).map((t, i) => t - stamps[i]);
      const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
      const p95 = (values: number[]) => sorted(values)[Math.floor(values.length * 0.95)] ?? 0;
      const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);
      const draws: number[] = [...timeline.stats.drawMs];
      const refresh = sorted(intervals)[Math.floor(intervals.length / 2)];
      const after = timeline.view;
      return {
        frames: intervals.length,
        interval: {
          mean: mean(intervals),
          p95: p95(intervals),
          max: Math.max(...intervals),
          // Frames that took more than one and a half refreshes.
          slow: intervals.filter((value) => value > refresh * 1.5).length,
        },
        draw: { mean: mean(draws), p95: p95(draws), max: Math.max(...draws), count: draws.length },
        // The slow frames, with the zoom they ran at and the draw time just before them.
        slowFrames: intervals
          .map((interval, i) => ({ i, interval, scale: scales[i], draw: draws[i] ?? null }))
          .filter((frame) => frame.interval > refresh * 1.5)
          .slice(0, 20),
        moved:
          kind === 'zoom'
            ? after.scale !== before.scale || Math.abs(after.scrollTime - before.scrollTime) > 0
            : after.scrollTime > before.scrollTime,
      };
    },
    { kind, frames },
  );
}

test('the timeline scrolls and zooms at 60 fps with 500 clips', async ({ page }, testInfo) => {
  test.setTimeout(240000);
  await open(page);
  await importFiles(page, ['h264-1080p30-aac.mp4', 'tone-48k-stereo.wav', 'still-1280x720.jpg']);
  const ids = await page.evaluate(async () => {
    const hooks = Reflect.get(window, '__cgv');
    const { project } = await hooks.client.api.projectSnapshot();
    return { tracks: project.tracks.map((t: { id: number }) => t.id), media: project.media };
  });
  // Four tracks of 125 clips: video on the main track, stills and video above,
  // sound on top. Two seconds each, so every clip has a filmstrip or waveform.
  const media = (name: string) =>
    ids.media.find((m: { name: string; id: string }) => m.name === name)!.id;
  const built = await page.evaluate(
    async ({ tracks, video, sound, still, frame }) => {
      const hooks = Reflect.get(window, '__cgv');
      const commands: unknown[] = [
        { type: 'addTrack', index: tracks.length },
        { type: 'addTrack', index: tracks.length + 1 },
      ];
      const created = await hooks.project.executeGroup('Tracks', commands);
      const all = [...tracks, created[0].created[0], created[1].created[0]];
      const clips: unknown[] = [];
      all.forEach((track: number, index: number) => {
        for (let i = 0; i < 125; i++) {
          const media = index === 0 ? video : index === 3 ? sound : i % 2 ? still : video;
          // Source points spread over each file: 10 s of video, 5 s of sound.
          const room = media === video ? 240 : media === sound ? 90 : 0;
          const sourceIn = room ? ((i * 7) % room) * frame : 0;
          clips.push({
            type: 'overwrite',
            track,
            at: i * 60 * frame,
            clip: { media, sourceIn, duration: 60 * frame },
          });
        }
      });
      await hooks.project.executeGroup('Build 500 clips', clips);
      const { project } = await hooks.client.api.projectSnapshot();
      return project.tracks.reduce(
        (sum: number, t: { clips: unknown[] }) => sum + t.clips.length,
        0,
      );
    },
    {
      tracks: ids.tracks,
      video: media('h264-1080p30-aac.mp4'),
      sound: media('tone-48k-stereo.wav'),
      still: media('still-1280x720.jpg'),
      frame: FRAME,
    },
  );
  expect(built).toBe(500);
  await expect(page.getByTestId('clip')).toHaveCount(500);

  // Show the whole edit first: all 500 clips on screen.
  await page.evaluate(() => Reflect.get(window, '__cgvTimeline').fit());
  await page.waitForTimeout(1000);
  // The first pass decodes each thumbnail and uploads it to the GPU once; it is
  // recorded as the cold run. The measured runs follow, as in an editing session.
  const cold = { zoom: await measure(page, 'zoom', 240), scroll: { frames: 0 } };
  const reset = () =>
    page.evaluate(() => {
      const timeline = Reflect.get(window, '__cgvTimeline');
      timeline.setView({ ...timeline.view, scale: 40, scrollTime: 0 });
    });
  await reset();
  cold.scroll = await measure(page, 'scroll', 300);
  await page.evaluate(() => Reflect.get(window, '__cgvTimeline').fit());
  await page.waitForTimeout(500);
  const zoomRun = await measure(page, 'zoom', 240);
  await reset();
  await page.waitForTimeout(500);
  const scrollRun = await measure(page, 'scroll', 300);
  const result = {
    clips: built,
    software,
    browser: page.context().browser()?.version(),
    zoom: zoomRun,
    scroll: scrollRun,
    cold,
  };
  await record(testInfo, 'timeline-500-clips', result);
  console.log(JSON.stringify(result));

  for (const run of [zoomRun, scrollRun]) {
    expect(run.moved).toBe(true);
    expect(run.draw.count).toBeGreaterThan(run.frames * (software ? 0.1 : 0.9));
    if (software) continue;
    // 60 fps: frames keep the display's pace, and drawing leaves most of a frame free.
    expect(run.interval.p95).toBeLessThan(20);
    expect(run.interval.slow / run.frames).toBeLessThan(0.02);
    expect(run.draw.p95).toBeLessThan(8);
  }
});

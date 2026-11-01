import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FRAME, render, run, type Pixels } from './golden-tools';
import { angleSeconds, makeAngles, startFrames, startSeconds } from './multicam';

// Multicam clips. Four angles with known offsets sync by their sound within 1 ms
// and by their timecode within a frame; the angle viewer plays all four at 1080p30
// without dropped frames on the reference machine; keys 1 to 4 during playback cut
// on the frame showing, one undo step each; and a multicam clip flattens.
// Results go to bench/results/multicam-*.json.
const root = process.cwd();
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin');
const ffmpeg = join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const software = process.env.GPU_TEST_SOFTWARE === '1';
const SECOND = 705_600_000;

test.skip(
  !existsSync(ffmpeg) && process.env.CGV_REQUIRE_FFMPEG !== '1',
  'FFmpeg is missing: run pnpm setup:ffmpeg',
);

interface SavedClip {
  id: number;
  start: number;
  duration: number;
  sourceIn: number;
  angles?: { picture: number; sound: number };
  sequence?: number;
}
interface SavedTrack {
  clips: SavedClip[];
}
interface Saved {
  tracks: SavedTrack[];
  sequences?: { id: number; name: string; multicam?: boolean; tracks: SavedTrack[] }[];
}

/** The project as its file holds it: every sequence's tracks too. */
async function saved(page: Page): Promise<Saved> {
  const { text } = await page.evaluate(() => Reflect.get(window, '__cgv').client.api.projectSave());
  return JSON.parse(text).project;
}

function record(name: string, value: unknown) {
  const dir = join(root, 'bench/results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `multicam-${name}.json`), JSON.stringify(value, null, 2));
}

/** An empty 1080p30 project with the four angles on four tracks, and their ids. */
async function placeAngles(page: Page, testDir: string, query = '') {
  const files = makeAngles(ffmpeg, testDir);
  await page.goto('/?diagnostic=1' + query);
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
  await page.getByTestId('media-file-input').setInputFiles(files);
  for (const index of [1, 2, 3, 4])
    await expect(
      page.locator(`[data-testid="media-item"][data-name="angle-${index}.mov"]`),
    ).toHaveAttribute('data-status', 'ready', { timeout: 120000 });
  const snapshot = await page.evaluate(() =>
    Reflect.get(window, '__cgv').client.api.projectSnapshot(),
  );
  await run(page, { type: 'setMagnetic', magnetic: false });
  for (let index = snapshot.project.tracks.length; index < 4; index++)
    await run(page, { type: 'addTrack', index });
  const { project } = await page.evaluate(() =>
    Reflect.get(window, '__cgv').client.api.projectSnapshot(),
  );
  const ids: number[] = [];
  for (const [index, name] of ['1', '2', '3', '4'].entries()) {
    const media = project.media.find(
      (item: { name: string }) => item.name === `angle-${name}.mov`,
    ).id;
    const [clip] = await run(page, {
      type: 'append',
      track: project.tracks[index].id,
      clip: { media, duration: (angleSeconds - 1) * 30 * FRAME },
    });
    ids.push(clip);
  }
  return ids;
}

/** Selects every clip and makes a multicam clip from the timeline's menu. */
async function makeMulticam(page: Page, sync: 'sound' | 'timecode' | 'in') {
  await page.getByTestId('timeline-canvas').hover();
  await page.keyboard.press('Control+A');
  const canvas = page.getByTestId('timeline-canvas');
  const box = (await canvas.boundingBox())!;
  const { scale, scrollTime } = await canvas.evaluate((element) => ({
    scale: Number((element as HTMLElement).dataset.scale),
    scrollTime: Number((element as HTMLElement).dataset.scrollTime),
  }));
  const { project } = await page.evaluate(() =>
    Reflect.get(window, '__cgv').client.api.projectSnapshot(),
  );
  const header = (await page
    .locator(
      `[data-testid="track"][data-track-id="${project.tracks[project.tracks.length - 1].id}"]`,
    )
    .boundingBox())!;
  await page.mouse.click(
    box.x + ((SECOND - scrollTime) / SECOND) * scale,
    header.y + header.height / 2 + 8,
    { button: 'right' },
  );
  await page.getByRole('menuitem', { name: 'Make multicam clip…' }).click();
  const dialog = page.getByTestId('multicam-dialog');
  await expect(dialog).toContainText('Angle 4');
  await dialog.getByTestId('multicam-sync').selectOption(sync);
  await dialog.getByTestId('multicam-make').click();
  await expect(dialog).toHaveCount(0, { timeout: 120000 });
}

/** How far each angle's media is from the first's at one moment, in seconds. */
function offsets(project: Saved) {
  const sequence = project.sequences!.find((item) => item.multicam)!;
  const at = (track: SavedTrack) => {
    const clip = track.clips[0];
    return clip.sourceIn - clip.start;
  };
  const first = at(sequence.tracks[0]);
  return sequence.tracks.map((track) => (at(track) - first) / SECOND);
}

test('four angles sync by their sound within 1 ms, and by their timecode within a frame', async ({
  page,
}, testInfo) => {
  test.setTimeout(300000);
  const dir = join(testInfo.project.outputDir, 'multicam-set');
  await placeAngles(page, dir);
  await makeMulticam(page, 'sound');
  const bySound = offsets(await saved(page));
  const expected = startSeconds.map((start) => startSeconds[0] - start);
  const errors = bySound.map((offset, index) => Math.abs(offset - expected[index]));
  console.log(`By sound: ${JSON.stringify(bySound)}, off by ${JSON.stringify(errors)} s`);
  record('sync', { expected, bySound, errors });
  for (const error of errors) expect(error).toBeLessThan(0.001);

  // Undo, and sync the same clips by the timecodes the files carry.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await saved(page)).sequences?.length ?? 0).toBe(0);
  await makeMulticam(page, 'timecode');
  const byTimecode = offsets(await saved(page));
  const frames = startFrames.map((frame) => (startFrames[0] - frame) / 30);
  console.log(`By timecode: ${JSON.stringify(byTimecode)}`);
  for (const [index, offset] of byTimecode.entries())
    expect(Math.abs(offset - frames[index])).toBeLessThan(1 / 600);
});

test('the angle viewer shows four angles, keys cut on the frame showing, and it flattens', async ({
  page,
}, testInfo) => {
  test.setTimeout(300000);
  const dir = join(testInfo.project.outputDir, 'multicam-set');
  await placeAngles(page, dir);
  await makeMulticam(page, 'in');

  // The viewer: each angle's hue in its quarter, and the program angle outlined.
  await page.getByTestId('angle-view').click();
  await expect(page.getByTestId('angle-view')).toHaveAttribute('aria-pressed', 'true');
  const grid = await render(page, 30 * FRAME);
  const quarter = (pixels: Pixels, column: number, row: number) => {
    const x = Math.floor(((column + 0.5) * pixels.width) / 2);
    const y = Math.floor(((row + 0.75) * pixels.height) / 2);
    const at = (y * pixels.width + x) * 4;
    return [pixels.data[at], pixels.data[at + 1], pixels.data[at + 2]];
  };
  const samples = [
    quarter(grid, 0, 0),
    quarter(grid, 1, 0),
    quarter(grid, 0, 1),
    quarter(grid, 1, 1),
  ];
  console.log(`Quarters: ${JSON.stringify(samples)}`);
  expect(new Set(samples.map((sample) => sample.join())).size).toBe(4);
  // The outline: selection yellow along the first angle's top edge.
  const edge = (Math.floor(grid.height / 200) * grid.width + Math.floor(grid.width / 4)) * 4;
  const outline = [grid.data[edge], grid.data[edge + 1], grid.data[edge + 2]];
  expect(outline[0]).toBeGreaterThan(200);
  expect(outline[2]).toBeLessThan(120);

  // Play all four at once.
  await page.evaluate(() => Reflect.get(window, '__cgv').client.api.resetPlaybackStats());
  await page.getByTestId('play-toggle').click();
  await page.waitForTimeout(6000);
  const stats = await page.evaluate(async () => ({
    stats: await Reflect.get(window, '__cgv').client.api.playbackStats(),
    state: await Reflect.get(window, '__cgv').client.api.playbackState(),
  }));
  console.log(`Angle viewer: ${JSON.stringify(stats)}`);
  record(`viewer-${testInfo.project.name}`, stats);
  if (!software) {
    expect(stats.stats.dropped).toBe(0);
    expect(stats.stats.presented).toBeGreaterThan(150);
  } else {
    expect(stats.stats.presented).toBeGreaterThan(0);
  }

  // Keys during playback cut on the frame showing when pressed.
  await page.evaluate(() => {
    const pressed: number[] = [];
    Reflect.set(window, '__pressed', pressed);
    window.addEventListener(
      'keydown',
      () => {
        const transport = document.querySelector<HTMLElement>('[data-testid="transport"]')!;
        pressed.push(Number(transport.dataset.frame));
      },
      true,
    );
  });
  await page.getByTestId('timeline-canvas').hover();
  for (const key of ['2', '3', '4']) {
    await page.waitForTimeout(500);
    // A software GPU can show one frame for longer than that, and a cut needs a new frame.
    await page.waitForFunction(() => {
      const shown = document.querySelector<HTMLElement>('[data-testid="transport"]')!;
      const pressed = Reflect.get(window, '__pressed') as number[];
      return Number(shown.dataset.frame) > (pressed[pressed.length - 1] ?? -1);
    });
    await page.keyboard.press(key);
  }
  await page.waitForTimeout(300);
  await page.getByTestId('play-toggle').click();
  const pressed = await page.evaluate<number[]>(() => Reflect.get(window, '__pressed'));
  await expect.poll(async () => (await saved(page)).tracks[0].clips.length).toBe(4);
  const parts = (await saved(page)).tracks[0].clips;
  const cuts = parts.slice(1).map((clip) => clip.start / FRAME);
  console.log(`Pressed on frames ${pressed}, cuts on ${cuts}`);
  record(`cuts-${testInfo.project.name}`, { pressed, cuts });
  expect(parts.map((clip) => clip.angles?.picture)).toEqual([0, 1, 2, 3]);
  for (const [index, cut] of cuts.entries())
    expect(Math.abs(cut - pressed[index])).toBeLessThanOrEqual(1);

  // Each cut is one undo step.
  for (const remaining of [3, 2, 1]) {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => (await saved(page)).tracks[0].clips.length).toBe(remaining);
  }

  // Back on the program: one angle fills the frame, and it flattens to plain clips.
  await page.getByTestId('angle-view').click();
  await run(page, {
    type: 'setAngles',
    clip: (await saved(page)).tracks[0].clips[0].id,
    picture: 1,
    sound: 2,
  });
  // The whole frame is the second angle now, in that angle's hue.
  const single = await render(page, 30 * FRAME);
  const whole = quarter(single, 0, 0);
  expect(whole.join()).not.toBe(samples[0].join());
  await run(page, { type: 'breakApart', clip: (await saved(page)).tracks[0].clips[0].id });
  const flat = (await saved(page)).tracks.flatMap((track) => track.clips);
  expect(flat.every((clip) => clip.sequence === undefined)).toBe(true);
  expect(flat).toHaveLength(2);
});

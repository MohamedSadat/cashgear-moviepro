import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 4: the editing timeline. Every flow uses the mouse and keyboard; tests
// read the result from the page (the accessible clip list and the engine
// snapshot) and find clips on the canvas through the diagnostic timeline handle.
const mediaDir = join(process.cwd(), 'tests/media');
const FRAME = 23_520_000; // one frame at 30 fps, in flicks
const SECOND = 705_600_000;

interface ClipRow {
  id: number;
  track: number;
  start: number;
  duration: number;
}

interface TrackRow {
  id: number;
  main: boolean;
  locked: boolean;
}

type Snapshot = {
  project: {
    magnetic: boolean;
    mainTrack: number;
    markers: { time: number }[];
    tracks: {
      id: number;
      muted: boolean;
      hidden: boolean;
      locked: boolean;
      name: string;
      clips: {
        id: number;
        start: number;
        duration: number;
        link: number | null;
        speed: { num: number; den: number };
        opacity: number;
        volumeDb: number;
        transform: { scaleX: number; x: number };
        crop: { left: number };
        kind?: 'adjustment';
        effects?: { id: number; kind: string; enabled: boolean; params: Record<string, unknown> }[];
        keyframes?: Record<string, { time: number; value: number }[]>;
      }[];
      transitions?: { id: number; kind: string; duration: number }[];
    }[];
    luts: { id: number; name: string }[];
  };
  undoLabel: string | null;
};

/** Opens the app; `diagnostic` also exposes the engine snapshot for checks. */
async function open(page: Page, diagnostic = true) {
  await page.goto(diagnostic ? '/?diagnostic=1' : '/');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="timeline-canvas"]')?.hasAttribute('data-scale') &&
      document.querySelector<HTMLElement>('[data-testid="engine-status"]')?.dataset.state ===
        'ready' &&
      !['Opening…', undefined].includes(
        document.querySelector('[data-testid="project-name"]')?.textContent ?? undefined,
      ) &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
}

async function importFiles(page: Page, files: string[]) {
  const before = await page.getByTestId('media-item').count();
  await page
    .getByTestId('media-file-input')
    .setInputFiles(files.map((file) => join(mediaDir, file)));
  await expect(page.getByTestId('media-item')).toHaveCount(before + files.length, {
    timeout: 60000,
  });
  for (const file of files)
    await expect(page.locator(`[data-testid="media-item"][data-name="${file}"]`)).toHaveAttribute(
      'data-status',
      'ready',
    );
}

/** The clips as the accessible list on the page shows them, in track then time order. */
function clips(page: Page): Promise<ClipRow[]> {
  return page.getByTestId('clip').evaluateAll((items) =>
    items.map((item) => {
      const data = (item as HTMLElement).dataset;
      return {
        id: Number(data.clipId),
        track: Number(data.trackId),
        start: Number(data.start),
        duration: Number(data.duration),
      };
    }),
  );
}

/** The track headers, top track first. */
function tracks(page: Page): Promise<TrackRow[]> {
  return page.getByTestId('track').evaluateAll((items) =>
    items.map((item) => {
      const data = (item as HTMLElement).dataset;
      return {
        id: Number(data.trackId),
        main: data.main === 'true',
        locked: data.locked === 'true',
      };
    }),
  );
}

const onTrack = (rows: ClipRow[], track: number) => rows.filter((clip) => clip.track === track);

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => Reflect.get(window, '__cgv').client.api.projectSnapshot());
}

/** Where `time` is on screen, from the zoom and scroll the canvas shows. */
async function xAt(page: Page, time: number): Promise<number> {
  const canvas = page.getByTestId('timeline-canvas');
  const box = (await canvas.boundingBox())!;
  const { scale, scrollTime } = await canvas.evaluate((element) => ({
    scale: Number((element as HTMLElement).dataset.scale),
    scrollTime: Number((element as HTMLElement).dataset.scrollTime),
  }));
  return box.x + ((time - scrollTime) / SECOND) * scale;
}

/** The middle of track `id` on screen: beside its header. */
async function yAt(page: Page, track: number): Promise<number> {
  const box = await page.locator(`[data-testid="track"][data-track-id="${track}"]`).boundingBox();
  expect(box, `track ${track} has a header`).not.toBeNull();
  return box!.y + box!.height / 2;
}

/** Just inside the drop zone above the tracks, which makes a new track. */
async function newTrackY(page: Page): Promise<number> {
  const box = (await page.locator('.cgv-timeline-drop-hint').boundingBox())!;
  return box.y + box.height / 2;
}

async function press(page: Page, keys: string) {
  await page.keyboard.press(keys);
}

async function fit(page: Page) {
  await press(page, 'Shift+Z');
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(from[0] + Math.sign(to[0] - from[0]) * 6, from[1], { steps: 2 });
  await page.mouse.move(...to, { steps: 8 });
  await page.mouse.up();
}

/** Drags a library item onto the timeline canvas at client (`x`, `y`) and waits for its clip. */
async function dragMedia(page: Page, name: string, x: number, y: number) {
  const canvas = page.getByTestId('timeline-canvas');
  const box = (await canvas.boundingBox())!;
  const count = await page.getByTestId('clip').count();
  await page
    .locator(`[data-testid="media-item"][data-name="${name}"]`)
    .dragTo(canvas, { targetPosition: { x: x - box.x, y: y - box.y } });
  await expect(page.getByTestId('clip')).toHaveCount(count + 1);
}

async function clickClip(page: Page, clip: ClipRow, modifiers: ('Control' | 'Shift')[] = []) {
  const x = (await xAt(page, clip.start + clip.duration / 2)) | 0;
  const y = await yAt(page, clip.track);
  await page.mouse.click(x, y + 8, { modifiers });
}

async function addToTimeline(page: Page, name: string, times = 1) {
  const button = page.getByRole('button', { name: `Add ${name} to the timeline` });
  for (let i = 0; i < times; i++) {
    const count = (await clips(page)).length;
    await button.click();
    await expect(page.getByTestId('clip')).toHaveCount(count + 1);
  }
}

test.describe.configure({ timeout: 180000 });

test('media dragged onto the timeline lands on the main track, another track or a new one', async ({
  page,
}) => {
  await open(page);
  await importFiles(page, ['h264-1080p30-aac.mp4', 'vp9-720p25-opus.webm', 'still-1280x720.jpg']);
  const [top, main] = await tracks(page);
  expect(main.main).toBe(true);
  const mainY = await yAt(page, main.id);

  // Wherever it is dropped, the first clip on the magnetic main track starts at 0.
  await dragMedia(page, 'h264-1080p30-aac.mp4', await xAt(page, 3 * SECOND), mainY);
  await expect(page.getByTestId('clip')).toHaveCount(1);
  await fit(page);
  // Dropped over the second half of the clip: it goes after it, at the cut.
  await dragMedia(page, 'vp9-720p25-opus.webm', await xAt(page, 7 * SECOND), mainY);
  await expect(page.getByTestId('clip')).toHaveCount(2);
  let rows = onTrack(await clips(page), main.id);
  expect(rows.map((clip) => [clip.start, clip.duration])).toEqual([
    [0, 300 * FRAME],
    [300 * FRAME, 240 * FRAME],
  ]);
  // Dropped over the first half of the first clip: it goes before it.
  await dragMedia(page, 'still-1280x720.jpg', await xAt(page, 2 * SECOND), mainY);
  rows = onTrack(await clips(page), main.id);
  expect(rows.map((clip) => clip.duration)).toEqual([5 * SECOND, 300 * FRAME, 240 * FRAME]);

  // On another track a clip goes where it is dropped (to the frame).
  await dragMedia(
    page,
    'still-1280x720.jpg',
    await xAt(page, 4 * SECOND + 10 * FRAME),
    await yAt(page, top.id),
  );
  // Within a frame: the pointer moves in whole pixels.
  const [dropped] = onTrack(await clips(page), top.id);
  expect(Math.abs(dropped.start - (4 * SECOND + 10 * FRAME))).toBeLessThanOrEqual(FRAME);
  expect(dropped.start % FRAME).toBe(0);

  // Above the top track, a drop makes a new track.
  await dragMedia(page, 'vp9-720p25-opus.webm', await xAt(page, 1 * SECOND), await newTrackY(page));
  await expect(page.getByTestId('track')).toHaveCount(3);
  const [added] = await tracks(page);
  await expect
    .poll(async () => Math.abs(onTrack(await clips(page), added.id)[0]?.start - 1 * SECOND))
    .toBeLessThanOrEqual(FRAME);
  // One undo removes the track and its clip together.
  await press(page, 'Control+z');
  await expect(page.getByTestId('track')).toHaveCount(2);
});

test('clips move, trim, split and delete with the mouse and keys, and each step undoes', async ({
  page,
}) => {
  await open(page);
  await importFiles(page, ['h264-1080p30-aac.mp4', 'vp9-720p25-opus.webm']);
  await addToTimeline(page, 'h264-1080p30-aac.mp4');
  await addToTimeline(page, 'vp9-720p25-opus.webm');
  await addToTimeline(page, 'h264-1080p30-aac.mp4');
  await fit(page);
  const [, main] = await tracks(page);
  const y = (await yAt(page, main.id)) + 8;
  const states = [await clips(page)];
  const [a, b, c] = states[0];

  // Drag the first clip until the pointer passes the middle of the second: they swap.
  await drag(page, [(await xAt(page, 5 * SECOND)) | 0, y], [(await xAt(page, 16 * SECOND)) | 0, y]);
  await expect
    .poll(async () => (await clips(page)).map((clip) => clip.id))
    .toEqual([b.id, a.id, c.id]);
  states.push(await clips(page));

  // Trim the end of the middle clip by 3 s: the main track closes up behind it.
  const middleEnd = 8 * SECOND + 10 * SECOND;
  const grab = (await xAt(page, middleEnd)) - 2;
  await drag(page, [grab, y], [(await xAt(page, middleEnd - 3 * SECOND)) - 2, y]);
  await expect
    .poll(async () => (await clips(page)).map((clip) => clip.duration))
    .toEqual([b.duration, 7 * SECOND, c.duration]);
  states.push(await clips(page));

  // The blade splits the last clip where it is clicked.
  await press(page, 'c');
  await expect(page.getByTestId('timeline')).toHaveAttribute('data-tool', 'blade');
  const splitAt = 15 * SECOND + 4 * SECOND;
  await page.mouse.click((await xAt(page, splitAt)) | 0, y);
  await expect(page.getByTestId('clip')).toHaveCount(4);
  await press(page, 'v');
  states.push(await clips(page));

  // Select the first clip and delete it; then ripple-delete the next.
  const rows = await clips(page);
  await clickClip(page, rows[0]);
  await press(page, 'Delete');
  await expect(page.getByTestId('clip')).toHaveCount(3);
  states.push(await clips(page));
  await clickClip(page, (await clips(page))[0]);
  await press(page, 'Shift+Delete');
  await expect(page.getByTestId('clip')).toHaveCount(2);
  states.push(await clips(page));
  expect((await clips(page))[0].start).toBe(0);

  // Undo walks back through every state, and redo forward again.
  for (const state of states.slice(0, -1).reverse()) {
    await press(page, 'Control+z');
    await expect.poll(() => clips(page)).toEqual(state);
  }
  for (const state of states.slice(1)) {
    await press(page, 'Control+y');
    await expect.poll(() => clips(page)).toEqual(state);
  }
});

test('copied clips paste at the playhead with their links, as one undo step', async ({ page }) => {
  await open(page);
  await importFiles(page, ['h264-1080p30-aac.mp4', 'still-1280x720.jpg']);
  await addToTimeline(page, 'h264-1080p30-aac.mp4');
  await addToTimeline(page, 'still-1280x720.jpg');
  await fit(page);
  const first = (await clips(page))[0];

  // Detach the first clip's sound from its right-click menu.
  const x = (await xAt(page, 2 * SECOND)) | 0;
  await page.mouse.click(x, (await yAt(page, first.track)) + 8, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Detach audio' }).click();
  await expect(page.getByTestId('track')).toHaveCount(3);
  const [, main, sound] = await tracks(page);
  expect(main.main).toBe(true);
  await expect(page.getByTestId('clip')).toHaveCount(3);

  // Clicking the picture selects its sound too; copy, move the playhead, paste.
  await page.mouse.click(x, (await yAt(page, main.id)) + 8);
  await press(page, 'Control+c');
  const ruler = (await page.getByTestId('timeline-canvas').boundingBox())!.y + 14;
  await page.mouse.click((await xAt(page, 12 * SECOND)) | 0, ruler);
  await expect(page.getByTestId('timecode')).toHaveText(/^00:00:1[12]:/);
  await press(page, 'Control+v');
  await expect(page.getByTestId('clip')).toHaveCount(5);
  const state = await snapshot(page);
  expect(state.undoLabel).toBe('Paste');
  const mainClips = state.project.tracks.find((track) => track.id === main.id)!.clips;
  const soundClips = state.project.tracks.find((track) => track.id === sound.id)!.clips;
  // 12 s is nearest the cut at 10 s, so the copy goes in there, and its sound beside it.
  expect(mainClips.map((clip) => clip.start)).toEqual([0, 10 * SECOND, 20 * SECOND]);
  expect(soundClips.map((clip) => clip.start)).toEqual([0, 10 * SECOND]);
  expect(mainClips[1].link).not.toBeNull();
  expect(mainClips[1].link).toBe(soundClips[1].link);
  expect(mainClips[1].link).not.toBe(mainClips[0].link);
  await press(page, 'Control+z');
  await expect(page.getByTestId('clip')).toHaveCount(3);
});

test('clips snap to markers and edges, and snapping turns off', async ({ page }) => {
  await open(page);
  await importFiles(page, ['h264-1080p30-aac.mp4', 'still-1280x720.jpg']);
  await addToTimeline(page, 'h264-1080p30-aac.mp4');
  await fit(page);
  const [top] = await tracks(page);
  const ruler = (await page.getByTestId('timeline-canvas').boundingBox())!.y + 14;
  // A marker at 6 s, from the playhead.
  await page.mouse.click((await xAt(page, 6 * SECOND)) | 0, ruler);
  await expect(page.getByTestId('timecode')).toHaveText(/^00:00:0[56]:/);
  await press(page, 'm');
  await expect(page.getByTestId('marker')).toHaveCount(1);
  const marker = Number(await page.getByTestId('marker').getAttribute('data-time'));

  // A still dropped close to the marker on the free track snaps onto it.
  await dragMedia(
    page,
    'still-1280x720.jpg',
    (await xAt(page, marker)) + 5,
    await yAt(page, top.id),
  );
  expect(onTrack(await clips(page), top.id).map((clip) => clip.start)).toEqual([marker]);

  // Dragging it near the end of the video snaps its start to that edge.
  const still = onTrack(await clips(page), top.id)[0];
  const y = (await yAt(page, top.id)) + 8;
  const from = (await xAt(page, still.start + SECOND)) | 0;
  await drag(
    page,
    [from, y],
    [from + ((await xAt(page, 10 * SECOND)) - (await xAt(page, marker))) - 4, y],
  );
  await expect
    .poll(async () => onTrack(await clips(page), top.id).map((clip) => clip.start))
    .toEqual([10 * SECOND]);

  // A marker dragged along the ruler snaps to the same edge.
  const flag = (await xAt(page, marker)) | 0;
  await drag(page, [flag, ruler + 8], [((await xAt(page, 10 * SECOND)) | 0) + 4, ruler + 8]);
  await expect(page.getByTestId('marker')).toHaveAttribute('data-time', String(10 * SECOND));

  // With snapping off, a drag lands where the pointer goes.
  await fit(page);
  await press(page, 'n');
  await expect(page.getByTestId('timeline')).toHaveAttribute('data-snapping', 'false');
  const now = (await xAt(page, 11 * SECOND)) | 0;
  await drag(page, [now, y], [now - 6, y]);
  await expect
    .poll(async () => onTrack(await clips(page), top.id)[0].start)
    .toBeLessThan(10 * SECOND);
  expect(onTrack(await clips(page), top.id)[0].start % FRAME).toBe(0);
});

test('track headers lock, mute, hide and rename, and the main track stays', async ({ page }) => {
  await open(page);
  const [top, main] = await tracks(page);
  await page.getByRole('button', { name: 'Mute Track 2' }).click();
  await page.getByRole('button', { name: 'Hide Track 2' }).click();
  await page.getByRole('button', { name: 'Lock Track 1' }).click();
  let state = await snapshot(page);
  const find = (id: number) => state.project.tracks.find((track) => track.id === id)!;
  expect([find(top.id).muted, find(top.id).hidden, find(main.id).locked]).toEqual([
    true,
    true,
    true,
  ]);

  await page.locator(`[data-testid="track"][data-track-id="${top.id}"] .cgv-track-name`).dblclick();
  await page.getByRole('textbox', { name: 'Name of Track 2' }).fill('Titles');
  await press(page, 'Enter');
  await expect(page.getByRole('button', { name: 'Mute Titles', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Unmute Titles', exact: true })).toHaveCount(1);

  // The main track's menu cannot delete it; another track's can.
  const header = page.locator(`[data-testid="track"][data-track-id="${main.id}"]`);
  await header.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'The main track stays' })).toBeDisabled();
  await press(page, 'Escape');
  await page.locator(`[data-testid="track"][data-track-id="${top.id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete track' }).click();
  await expect(page.getByTestId('track')).toHaveCount(1);
  for (let i = 0; i < 5; i++) await press(page, 'Control+z');
  state = await snapshot(page);
  expect(
    state.project.tracks.map((track) => [track.locked, track.muted, track.hidden, track.name]),
  ).toEqual([
    [false, false, false, ''],
    [false, false, false, ''],
  ]);
});

test('the inspector changes picture, sound and speed as undoable steps', async ({ page }) => {
  await open(page);
  await importFiles(page, ['h264-1080p30-aac.mp4']);
  await addToTimeline(page, 'h264-1080p30-aac.mp4');
  await fit(page);
  await clickClip(page, (await clips(page))[0]);
  const inspector = page.getByTestId('inspector');
  await expect(inspector).toHaveAttribute('data-clip-id', String((await clips(page))[0].id));

  const type = async (testId: string, value: string) => {
    const input = inspector.getByTestId(testId).locator('input');
    await input.fill(value);
    await input.press('Enter');
  };
  await type('field-scale', '50');
  await type('field-x', '120');
  await type('field-crop-left', '10');
  await type('field-volume', '-6');
  let clip = (await snapshot(page)).project.tracks[0].clips[0];
  expect([clip.transform.scaleX, clip.transform.x, clip.crop.left, clip.volumeDb]).toEqual([
    0.5, 120, 0.1, -6,
  ]);

  // Dragging a label scrubs the value: one undo step for the whole drag.
  const label = inspector.getByTestId('field-opacity').locator('.cgv-field-label');
  // Typing in the fields below scrolled the inspector.
  await label.scrollIntoViewIfNeeded();
  const box = (await label.boundingBox())!;
  await drag(page, [box.x + 10, box.y + box.height / 2], [box.x - 50, box.y + box.height / 2]);
  clip = (await snapshot(page)).project.tracks[0].clips[0];
  expect(clip.opacity).toBeLessThan(0.8);
  expect((await snapshot(page)).undoLabel).toBe('Change opacity');

  await inspector.getByRole('button', { name: '2×' }).click();
  clip = (await snapshot(page)).project.tracks[0].clips[0];
  expect([clip.speed, clip.duration]).toEqual([{ num: 2, den: 1 }, 150 * FRAME]);

  for (let i = 0; i < 6; i++) await press(page, 'Control+z');
  clip = (await snapshot(page)).project.tracks[0].clips[0];
  expect([clip.transform.scaleX, clip.opacity, clip.volumeDb, clip.speed.num]).toEqual([
    1, 1, 0, 1,
  ]);
});

test('shortcut settings change keys and switch presets', async ({ page }) => {
  await open(page);
  await importFiles(page, ['h264-1080p30-aac.mp4']);
  await addToTimeline(page, 'h264-1080p30-aac.mp4');
  for (let i = 0; i < 30; i++) await press(page, 'ArrowRight');
  await expect(page.getByTestId('timecode')).toHaveText('00:00:01:00');

  await page.getByTestId('open-shortcuts').click();
  const dialog = page.getByTestId('shortcuts-dialog');
  await dialog.getByRole('button', { name: 'Change the key for Split at the playhead' }).click();
  await press(page, 's');
  await expect(dialog.locator('[data-action="split"] kbd')).toHaveText(['S']);
  await dialog.getByRole('button', { name: 'Done' }).click();

  await press(page, 's');
  await expect(page.getByTestId('clip')).toHaveCount(2);
  await press(page, 'ArrowRight');
  await press(page, 'Control+b'); // no longer a split
  await expect(page.getByTestId('clip')).toHaveCount(2);

  // The Premiere-like preset splits with Ctrl+K; the choice is kept for next time.
  await page.getByTestId('open-shortcuts').click();
  await page.getByRole('combobox', { name: 'Shortcut preset' }).selectOption('premiere');
  await expect(dialog.locator('[data-action="split"] kbd')).toHaveText(['Ctrl+K']);
  await expect(dialog.locator('[data-action="trimStartToPlayhead"] kbd')).toHaveText(['Q']);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await press(page, 'Control+k');
  await expect(page.getByTestId('clip')).toHaveCount(3);
  await press(page, 'Control+s');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await open(page);
  await page.getByTestId('open-shortcuts').click();
  await expect(dialog.getByRole('combobox', { name: 'Shortcut preset' })).toHaveValue('premiere');
  await expect(dialog.locator('[data-action="split"] kbd')).toHaveText(['Ctrl+K']);
});

test('a five-minute edit with 30 clips is built with the mouse and keyboard alone', async ({
  page,
}) => {
  test.setTimeout(300000);
  // No diagnostic hooks: only what a person sees, the mouse and the keyboard.
  await open(page, false);
  await importFiles(page, [
    'h264-1080p30-aac.mp4',
    'still-1920x1080.png',
    'still-1280x720.jpg',
    'tone-44k-stereo.mp3',
  ]);
  const [, main] = await tracks(page);

  // 24 ten-second video clips on the main track, added from the library.
  await addToTimeline(page, 'h264-1080p30-aac.mp4', 24);
  await fit(page);
  // Two stills dragged onto the end of the main track, then stretched to 30 s each.
  for (let i = 0; i < 2; i++) {
    const end = Math.max(...onTrack(await clips(page), main.id).map((c) => c.start + c.duration));
    await dragMedia(
      page,
      'still-1920x1080.png',
      (await xAt(page, end)) + 2,
      await yAt(page, main.id),
    );
    await fit(page);
    const still = onTrack(await clips(page), main.id).at(-1)!;
    const edge = (await xAt(page, still.start + still.duration)) | 0;
    const y = (await yAt(page, main.id)) + 8;
    await drag(page, [edge - 2, y], [(await xAt(page, still.start + 32 * SECOND)) | 0, y]);
    await expect
      .poll(async () => onTrack(await clips(page), main.id).at(-1)!.duration)
      .toBeGreaterThanOrEqual(31 * SECOND);
    await fit(page);
  }
  // Two title stills on a new track above, then two music clips on another.
  await dragMedia(page, 'still-1280x720.jpg', await xAt(page, 20 * SECOND), await newTrackY(page));
  await expect(page.getByTestId('track')).toHaveCount(3);
  const titles = (await tracks(page))[0];
  await dragMedia(
    page,
    'still-1280x720.jpg',
    await xAt(page, 120 * SECOND),
    await yAt(page, titles.id),
  );
  await dragMedia(page, 'tone-44k-stereo.mp3', await xAt(page, 0), await newTrackY(page));
  await expect(page.getByTestId('track')).toHaveCount(4);
  const music = (await tracks(page))[0];
  await dragMedia(
    page,
    'tone-44k-stereo.mp3',
    await xAt(page, 200 * SECOND),
    await yAt(page, music.id),
  );

  // Reorder: the third clip goes after the fifth.
  const y = (await yAt(page, main.id)) + 8;
  await drag(
    page,
    [(await xAt(page, 25 * SECOND)) | 0, y],
    [(await xAt(page, 47 * SECOND)) | 0, y],
  );
  // Markers at two moments, and the music turned down in the inspector.
  const ruler = (await page.getByTestId('timeline-canvas').boundingBox())!.y + 14;
  for (const [at, shown] of [
    [30, /^00:00:(29|30):/],
    [150, /^00:02:(29|30):/],
  ] as const) {
    await page.mouse.click((await xAt(page, at * SECOND)) | 0, ruler);
    await expect(page.getByTestId('timecode')).toHaveText(shown);
    const markers = await page.getByTestId('marker').count();
    await press(page, 'm');
    await expect(page.getByTestId('marker')).toHaveCount(markers + 1);
  }
  await clickClip(page, onTrack(await clips(page), music.id)[0]);
  const volume = page.getByTestId('inspector').getByTestId('field-volume').locator('input');
  await volume.fill('-12');
  await volume.press('Enter');

  const rows = await clips(page);
  expect(rows).toHaveLength(30);
  const end = Math.max(...rows.map((clip) => clip.start + clip.duration));
  expect(end).toBeGreaterThanOrEqual(300 * SECOND);
  await expect(page.getByTestId('marker')).toHaveCount(2);
  await expect(page.getByTestId('duration')).toHaveText(/^00:05:/);
  // The main track has no gaps, and the edit plays.
  const mainRows = onTrack(rows, main.id);
  expect(mainRows).toHaveLength(26);
  mainRows.reduce((at, clip) => {
    expect(clip.start).toBe(at);
    return at + clip.duration;
  }, 0);
});

// ---- Phase 6: effects, transitions and keyframes ----

/** The top and height on screen of track `id`'s row, from its header. */
async function rowBox(page: Page, track: number) {
  const box = await page.locator(`[data-testid="track"][data-track-id="${track}"]`).boundingBox();
  expect(box, `track ${track} has a header`).not.toBeNull();
  return box!;
}

/** Drags a library item (effect, transition or adjustment layer) onto the canvas at (`x`, `y`). */
async function dragItem(page: Page, key: string, x: number, y: number) {
  const canvas = page.getByTestId('timeline-canvas');
  const box = (await canvas.boundingBox())!;
  await page
    .locator(`[data-key="${key}"]`)
    .dragTo(canvas, { targetPosition: { x: x - box.x, y: y - box.y } });
}

/** Clicks the ruler at `time`, which moves the playhead there. */
async function seekTo(page: Page, time: number) {
  const ruler = (await page.getByTestId('timeline-canvas').boundingBox())!.y + 14;
  await page.mouse.click((await xAt(page, time)) | 0, ruler);
}

/** Leaves any inspector field, so keys reach the shortcut map. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function clipOf(page: Page, id: number) {
  const { project } = await snapshot(page);
  return project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === id)!;
}

test('effects drop onto clips, stack in the inspector and animate with the stopwatch', async ({
  page,
}) => {
  await open(page);
  await importFiles(page, ['h264-1080p30-aac.mp4']);
  await addToTimeline(page, 'h264-1080p30-aac.mp4');
  await fit(page);
  const [row] = await clips(page);
  await page.getByTestId('library-tab-effects').click();
  await expect(page.getByTestId('effect-browser').getByTestId('effect-item')).not.toHaveCount(0);
  const kinds = async () => ((await clipOf(page, row.id)).effects ?? []).map((e) => e.kind);

  // Dropped on the clip, then double-clicked with the clip selected.
  const middle = await xAt(page, row.start + row.duration / 2);
  await dragItem(page, 'builtin/vignette', middle, await yAt(page, row.track));
  await expect.poll(kinds).toEqual(['vignette']);
  await clickClip(page, row);
  await page.locator('[data-key="builtin/sepia"]').dblclick();
  await expect.poll(kinds).toEqual(['vignette', 'sepia']);

  // The inspector stacks them: a setting changes, and one turns off.
  const inspector = page.getByTestId('inspector');
  const panels = inspector.getByTestId('effect-panel');
  await expect(panels).toHaveCount(2);
  const amount = panels.first().getByTestId('param-amount').locator('input');
  await amount.fill('80');
  await amount.press('Enter');
  // The switch shows the project, so it turns off once the command lands.
  const sepia = inspector.getByRole('checkbox', { name: 'Sepia on' });
  await sepia.click();
  await expect(sepia).not.toBeChecked();
  const effects = (await clipOf(page, row.id)).effects!;
  expect(effects.map((e) => [e.kind, e.enabled])).toEqual([
    ['vignette', true],
    ['sepia', false],
  ]);
  expect(effects[0].params.amount).toBeCloseTo(0.8);

  // The stopwatch keys Position X at the playhead; a change later adds a key.
  await blur(page);
  await press(page, 'Home');
  await inspector.getByRole('button', { name: 'Animate Position X' }).click();
  await blur(page);
  for (let i = 0; i < 3; i++) await press(page, 'Shift+ArrowRight');
  await expect(page.getByTestId('timecode')).toHaveText(/^00:00:01:00/);
  const x = inspector.getByTestId('field-x').locator('input');
  await x.fill('200');
  await x.press('Enter');
  const keys = async () => (await clipOf(page, row.id)).keyframes?.['transform.x'] ?? [];
  await expect
    .poll(async () => (await keys()).map((key) => [key.time, key.value]))
    .toEqual([
      [0, 0],
      [30 * FRAME, 200],
    ]);

  // The selected clip shows its keys on the canvas; dragging one moves it in time.
  const top = (await rowBox(page, row.track)).y;
  const from = (await xAt(page, 30 * FRAME)) | 0;
  await drag(page, [from, top + 9], [((await xAt(page, 60 * FRAME)) | 0) + 1, top + 9]);
  await expect.poll(async () => (await keys())[1]?.time).toBeGreaterThan(45 * FRAME);
  expect((await keys()).map((key) => key.value)).toEqual([0, 200]);

  // Each step undoes: the move, the key, the stopwatch, the switch, the amount, both effects.
  for (let i = 0; i < 7; i++) await press(page, 'Control+z');
  await expect.poll(kinds).toEqual([]);
  expect((await clipOf(page, row.id)).keyframes ?? {}).toEqual({});
});

test('transitions drop on cuts, change length at their edges, and Ctrl+D adds the default', async ({
  page,
}) => {
  await open(page);
  await importFiles(page, ['h264-1080p30-aac.mp4']);
  await addToTimeline(page, 'h264-1080p30-aac.mp4', 3);
  await fit(page);
  const [a, b, c] = await clips(page);
  await page.getByTestId('library-tab-transitions').click();
  const transitions = page.getByTestId('transition');

  // A wipe dropped on the first cut: one second, centred on it.
  await dragItem(
    page,
    'builtin/wipe:wipe-left',
    await xAt(page, b.start),
    await yAt(page, a.track),
  );
  await expect(transitions).toHaveCount(1);
  const first = transitions.first();
  await expect(first).toHaveAttribute('data-kind', 'wipe');
  await expect(first).toHaveAttribute('data-from', String(a.id));
  await expect(first).toHaveAttribute('data-to', String(b.id));
  await expect(first).toHaveAttribute('data-duration', String(SECOND));
  await expect(first).toHaveAttribute('data-alignment', 'center');

  // Its inspector changes the type and where it sits.
  const inspector = page.getByTestId('transition-inspector');
  await expect(inspector).toBeVisible();
  await inspector.getByLabel('Transition type').selectOption('builtin/cross-dissolve');
  await expect(first).toHaveAttribute('data-kind', 'cross-dissolve');
  await inspector.getByLabel('Alignment').selectOption('end');
  await expect(first).toHaveAttribute('data-alignment', 'end');

  // Ending at the cut, its start edge drags earlier: one undo step.
  const box = await rowBox(page, a.track);
  const band = box.y + box.height - 8;
  const start = (await xAt(page, b.start - SECOND)) | 0;
  await drag(page, [start + 2, band], [start - 60, band]);
  await expect
    .poll(async () => Number(await first.getAttribute('data-duration')))
    .toBeGreaterThan(SECOND);
  expect((await snapshot(page)).undoLabel).toMatch(/transition/i);

  // Delete removes the selected transition; undo brings it back.
  await blur(page);
  await press(page, 'Delete');
  await expect(transitions).toHaveCount(0);
  await press(page, 'Control+z');
  await expect(transitions).toHaveCount(1);

  // Ctrl+D puts the default transition on the cut nearest the playhead.
  await seekTo(page, c.start + 5 * FRAME);
  await expect(page.getByTestId('timecode')).toHaveText(/^00:00:20:0/);
  await press(page, 'Control+d');
  await expect(transitions).toHaveCount(2);
  const added = page.locator(`[data-testid="transition"][data-to="${c.id}"]`);
  await expect(added).toHaveAttribute('data-kind', 'cross-dissolve');
  await expect(added).toHaveAttribute('data-from', String(b.id));
  // Clips keep their places: a transition never changes the edit's length.
  expect((await clips(page)).map((clip) => [clip.start, clip.duration])).toEqual(
    [a, b, c].map((clip) => [clip.start, clip.duration]),
  );
});

test('an adjustment layer grades the tracks below through an imported LUT', async ({ page }) => {
  await open(page);
  await importFiles(page, ['h264-1080p30-aac.mp4']);
  await addToTimeline(page, 'h264-1080p30-aac.mp4');
  await fit(page);
  /** The mean red level of the frame at one second, read in the page. */
  const red = () =>
    page.evaluate(async (time) => {
      const api = Reflect.get(window, '__cgv').client.api;
      const pixels = (await api.renderPixels(time)) as { data: Uint8Array };
      let total = 0;
      for (let i = 0; i < pixels.data.length; i += 4) total += pixels.data[i];
      return total / (pixels.data.length / 4);
    }, SECOND);
  const plain = await red();
  const [video] = await clips(page);

  // Double-clicking the adjustment layer puts five seconds of it above the clip,
  // at the playhead.
  await blur(page);
  await press(page, 'Home');
  await expect(page.getByTestId('timecode')).toHaveText(/^00:00:00:00/);
  await page.getByTestId('library-tab-effects').click();
  await page.locator('[data-testid="effect-item"][data-key="adjustment"]').dblclick();
  await expect(page.getByTestId('clip')).toHaveCount(2);
  const layer = (await clips(page)).find((clip) => clip.track !== video.track)!;
  expect([layer.start, layer.duration]).toEqual([0, 5 * SECOND]);
  expect((await clipOf(page, layer.id)).kind).toBe('adjustment');

  // A LUT effect on it, graded by an inverting .cube file imported in the inspector.
  await clickClip(page, layer);
  await page.locator('[data-key="builtin/lut"]').dblclick();
  await expect(page.getByTestId('inspector').getByTestId('effect-panel')).toHaveCount(1);
  const cube = ['TITLE "Invert"', 'LUT_3D_SIZE 2'];
  for (let i = 0; i < 8; i++)
    cube.push([i & 1, (i >> 1) & 1, (i >> 2) & 1].map((v) => 1 - v).join(' '));
  await page.getByTestId('lut-file-input').setInputFiles({
    name: 'invert.cube',
    mimeType: 'text/plain',
    buffer: Buffer.from(cube.join('\n') + '\n'),
  });
  await expect
    .poll(async () => (await snapshot(page)).project.luts.map((lut) => lut.name))
    .toEqual(['invert.cube']);
  const { luts } = (await snapshot(page)).project;
  await expect
    .poll(async () => (await clipOf(page, layer.id)).effects?.[0].params.lut)
    .toBe(`lut-${luts[0].id}`);
  // The picture below is inverted: its mean red turns around.
  expect(Math.abs((await red()) - (255 - plain))).toBeLessThan(3);
});

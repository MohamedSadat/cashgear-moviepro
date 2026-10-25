import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 8: editing sound with the mouse. Fade handles and the volume line on
// the timeline, sound effects with presets and noise reduction in the
// inspector, the mixer's strips, and music from the Music tab. Every step is
// an engine command, so each one undoes.
const mediaDir = join(process.cwd(), 'tests/media');
const SECOND = 705_600_000;
const FRAME = 23_520_000;
/** The volume line spans -60 to +24 dB over a sound-only clip's 39-pixel waveform. */
const volumeFloor = -60;
const volumeTop = 24;

type Clip = {
  id: number;
  start: number;
  duration: number;
  volumeDb: number;
  fadeIn?: number;
  fadeOut?: number;
  denoise?: number;
  audioEffects?: { id: number; kind: string; params: Record<string, unknown> }[];
  keyframes?: Record<string, { time: number; value: number }[]>;
};
type Snapshot = {
  project: {
    media: { id: string; name: string; location: { kind: string; path?: string } }[];
    tracks: {
      id: number;
      name: string;
      role?: string;
      solo?: boolean;
      volumeDb?: number;
      pan?: number;
      ducking?: { amountDb: number };
      clips: Clip[];
    }[];
  };
};

async function open(page: Page) {
  await page.goto('/?diagnostic=1');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="timeline-canvas"]')?.hasAttribute('data-scale') &&
      document.querySelector<HTMLElement>('[data-testid="engine-status"]')?.dataset.state ===
        'ready' &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => Reflect.get(window, '__cgv').client.api.projectSnapshot());
}

async function clip(page: Page, id: number) {
  return (await snapshot(page)).project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
}

async function xAt(page: Page, time: number) {
  const canvas = page.getByTestId('timeline-canvas');
  const box = (await canvas.boundingBox())!;
  const { scale, scrollTime } = await canvas.evaluate((element) => ({
    scale: Number((element as HTMLElement).dataset.scale),
    scrollTime: Number((element as HTMLElement).dataset.scrollTime),
  }));
  return box.x + ((time - scrollTime) / SECOND) * scale;
}

async function scale(page: Page) {
  return Number(await page.getByTestId('timeline-canvas').getAttribute('data-scale'));
}

/** The waveform of a sound-only clip on track `id`: its top on screen and height. */
async function soundBox(page: Page, track: number) {
  const row = (await page
    .locator(`[data-testid="track"][data-track-id="${track}"]`)
    .boundingBox())!;
  // Rows are 58 px: 2 px in, a 15 px name bar, the waveform to 2 px from the bottom.
  return { y: row.y + 17, h: 39 };
}

const volumeY = (box: { y: number; h: number }, db: number) =>
  box.y + (1 - (db - volumeFloor) / (volumeTop - volumeFloor)) * box.h;

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(...to, { steps: 6 });
  await page.mouse.up();
}

/** A click with a modifier key held (the mouse API has no modifiers of its own). */
async function clickWith(page: Page, key: 'Control' | 'Alt', x: number, y: number) {
  await page.keyboard.down(key);
  await page.mouse.click(x, y);
  await page.keyboard.up(key);
}

async function undoTo(page: Page, check: () => Promise<boolean>) {
  for (let i = 0; i < 20 && !(await check()); i++) {
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(50);
  }
  expect(await check()).toBe(true);
}

test('fades and volume drag on the timeline; sound effects and noise reduction in the inspector', async ({
  page,
}) => {
  test.setTimeout(120000);
  await open(page);
  await page.getByTestId('media-file-input').setInputFiles([join(mediaDir, 'tone-48k-stereo.wav')]);
  await expect(
    page.locator('[data-testid="media-item"][data-name="tone-48k-stereo.wav"]'),
  ).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
  await page.getByRole('button', { name: 'Add tone-48k-stereo.wav to the timeline' }).click();
  await expect(page.getByTestId('clip')).toHaveCount(1);
  await page.keyboard.press('Shift+Z');
  const { project } = await snapshot(page);
  const track = project.tracks.find((t) => t.clips.length)!;
  const id = track.clips[0].id;
  const box = await soundBox(page, track.id);
  // Select it.
  const start = (await clip(page, id)).start;
  const length = (await clip(page, id)).duration;
  await page.mouse.click((await xAt(page, start + length / 2)) | 0, box.y + 30);
  await expect(page.getByTestId('inspector')).toHaveAttribute('data-clip-id', String(id));

  // The fade-in handle sits 10 px in; dragging it 80 px right makes a fade.
  const handleX = (await xAt(page, start)) + 10;
  await drag(page, [handleX, box.y + 5], [handleX + 70, box.y + 5]);
  const fadeIn = (await clip(page, id)).fadeIn ?? 0;
  const pixels = ((fadeIn / SECOND) * (await scale(page))) | 0;
  expect(fadeIn % FRAME).toBe(0);
  expect(Math.abs(pixels - 80)).toBeLessThan(4);
  await expect(page.getByTestId('field-fade-in').locator('input')).toHaveValue(
    (fadeIn / SECOND).toFixed(2),
  );

  // The volume line drags down: 0 dB to about -18 dB.
  const middle = (await xAt(page, start + length / 2)) | 0;
  await drag(page, [middle, volumeY(box, 0)], [middle, volumeY(box, -18)]);
  const volume = (await clip(page, id)).volumeDb;
  expect(Math.abs(volume + 18)).toBeLessThan(2.5);

  // Ctrl-click on the line adds a volume keyframe there; Alt-click takes it away.
  const keyX = (await xAt(page, start + length * 0.75)) | 0;
  await clickWith(page, 'Control', keyX, volumeY(box, volume));
  await expect.poll(async () => (await clip(page, id)).keyframes?.volumeDb?.length ?? 0).toBe(1);
  const key = (await clip(page, id)).keyframes!.volumeDb[0];
  expect(Math.abs(key.value - volume)).toBeLessThan(0.11);
  await clickWith(page, 'Alt', (await xAt(page, start + key.time)) | 0, volumeY(box, key.value));
  await expect.poll(async () => (await clip(page, id)).keyframes?.volumeDb?.length ?? 0).toBe(0);

  // A sound effect from the inspector, with a preset.
  const inspector = page.getByTestId('inspector');
  await inspector.getByLabel('Add a sound effect').selectOption({ label: 'Equalizer' });
  const panel = inspector.getByTestId('audio-effect-stack').getByTestId('effect-panel');
  await expect(panel).toHaveCount(1);
  await panel.getByLabel('Equalizer preset').selectOption({ label: 'Voice clarity' });
  await expect
    .poll(async () => (await clip(page, id)).audioEffects?.[0]?.params.presenceGain)
    .toBe(4);
  await expect(panel.locator('.cgv-effect-title')).toHaveText('Voice clarity');
  // Noise reduction at half.
  const denoise = inspector.getByTestId('field-denoise').locator('input');
  await denoise.fill('50');
  await denoise.press('Enter');
  await expect.poll(async () => (await clip(page, id)).denoise).toBe(0.5);

  // Every step undoes, back to the plain clip.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await undoTo(page, async () => {
    const plain = await clip(page, id);
    return !plain.fadeIn && plain.volumeDb === 0 && !plain.audioEffects?.length && !plain.denoise;
  });
});

test('the mixer sets roles, solo, volume and pan, and music from the Music tab ducks', async ({
  page,
}) => {
  test.setTimeout(120000);
  await open(page);
  await page.getByTestId('media-file-input').setInputFiles([join(mediaDir, 'tone-48k-mono.aac')]);
  await expect(
    page.locator('[data-testid="media-item"][data-name="tone-48k-mono.aac"]'),
  ).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
  await page.getByRole('button', { name: 'Add tone-48k-mono.aac to the timeline' }).click();
  const dialogueTrack = (await snapshot(page)).project.tracks.find((t) => t.clips.length)!.id;

  await page.getByTestId('side-tab-mixer').click();
  const strip = (track: number) =>
    page.locator(`[data-testid="mixer-strip"][data-track-id="${track}"]`);
  await expect(page.getByTestId('mixer-strip')).toHaveCount(2);
  await strip(dialogueTrack).getByTestId('mixer-role').selectOption('dialogue');

  // A music bed from the Music tab lands on a new Music track.
  await page.getByTestId('library-tab-music').click();
  await page.locator('[data-testid="sound-item"][data-key="lofi-evening"]').dblclick();
  await expect(page.getByTestId('mixer-strip')).toHaveCount(3);
  let { project } = await snapshot(page);
  const music = project.tracks.find((t) => t.name === 'Music')!;
  expect(music.role).toBe('music');
  expect(project.media.find((m) => m.id === 'sound-lofi-evening')?.location).toMatchObject({
    kind: 'pack',
    path: 'sounds/lofi-evening.webm',
  });
  // Its strip shows ducking, which lowers it 12 dB by default.
  await expect(strip(music.id).getByTestId('mixer-ducking')).toBeVisible();
  const amount = strip(music.id).getByTestId('mixer-duck-amount').locator('input');
  await amount.fill('18');
  await amount.press('Enter');

  const volume = strip(music.id).getByTestId('mixer-volume').locator('input');
  await volume.fill('-6');
  await volume.press('Enter');
  const pan = strip(music.id).getByTestId('mixer-pan').locator('input');
  await pan.fill('-40');
  await pan.press('Enter');
  await strip(music.id).getByTestId('mixer-solo').click();
  await expect(strip(dialogueTrack)).toHaveAttribute('data-silenced', 'true');
  ({ project } = await snapshot(page));
  const mixed = project.tracks.find((t) => t.id === music.id)!;
  expect([mixed.volumeDb, mixed.pan, mixed.solo, mixed.ducking?.amountDb]).toEqual([
    -6,
    -0.4,
    true,
    18,
  ]);
  // The track header's solo toggle says so too.
  await expect(
    page.locator(`[data-testid="track"][data-track-id="${music.id}"]`).getByRole('button', {
      name: /Unsolo/,
    }),
  ).toHaveAttribute('aria-pressed', 'true');

  // Playing, the mixer's meters move for the soloed music only.
  await page.evaluate(() => Reflect.get(window, '__cgv').meters.take());
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('transport')).toHaveAttribute('data-starting', 'false', {
    timeout: 10000,
  });
  const stats = (await page.evaluate(() =>
    Reflect.get(window, '__cgv').client.api.playbackStats(),
  )) as { clock: string | null };
  // Without a sound device, playback follows the wall clock and nothing is metered.
  test.skip(stats.clock !== 'audio', 'No sound device: playback follows the wall clock');
  await page.waitForTimeout(1500);
  await page.getByTestId('play-toggle').click();
  const readings = (await page.evaluate(() => Reflect.get(window, '__cgv').meters.take())) as {
    tracks: { id: number; level: { peak: [number, number] } }[];
  }[];
  const peaks = (id: number) =>
    Math.max(
      0,
      ...readings.flatMap((r) => r.tracks.filter((t) => t.id === id).map((t) => t.level.peak[0])),
    );
  expect(peaks(music.id)).toBeGreaterThan(0.01);
  expect(peaks(dialogueTrack)).toBe(0);
});

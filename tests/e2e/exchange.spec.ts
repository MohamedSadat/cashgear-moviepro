import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FRAME, clear, run, setUp, still } from './golden-tools';

// Timelines to and from other editors, in the app: the Export timeline dialog says
// what stays behind and saves the file; Import timeline opens a file as a new
// project whose media asks to be relinked. crates/cgv-exchange/tests holds the
// format checks, with OpenTimelineIO reading what we write.
const fixtures = join(process.cwd(), 'tests/fixtures/exchange');

type Snapshot = {
  project: {
    name: string;
    settings: { width: number };
    sequences?: { name: string }[];
    markers: { name: string }[];
    tracks: { clips: { kind?: string; start: number; duration: number }[] }[];
    media: { name: string }[];
  };
};

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => Reflect.get(window, '__cgv').client.api.projectSnapshot());
}

/** Picks files through a file input: tests can't drive the native picker. */
async function useFileInputs(page: Page) {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, 'showOpenFilePicker');
  });
}

test('a timeline exports, saying what stays behind, and comes back as a new project', async ({
  page,
}) => {
  await useFileInputs(page);
  const ids = await setUp(page, '', ['sunset.png', 'city.png']);
  const [bottom, upper] = await clear(page, 2);
  await run(page, { type: 'append', track: bottom, clip: still(ids, 'sunset.png', 60) });
  await run(page, { type: 'append', track: bottom, clip: still(ids, 'city.png', 30) });
  await run(page, {
    type: 'overwrite',
    track: upper,
    at: 30 * FRAME,
    clip: { kind: 'title', duration: 30 * FRAME, title: { elements: [] } },
  });
  await run(page, { type: 'addMarker', at: 15 * FRAME, name: 'Here', color: 'green' });

  await page.getByTestId('export-timeline').click();
  const dialog = page.getByTestId('export-timeline-dialog');
  await expect(dialog.getByTestId('exchange-left-out')).toContainText('The title at');
  await dialog.getByTestId('export-timeline-format').selectOption('otio');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByTestId('export-timeline-save').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.otio$/);
  const file = join(test.info().outputDir, download.suggestedFilename());
  await download.saveAs(file);
  const written = JSON.parse(readFileSync(file, 'utf8'));
  expect(written.OTIO_SCHEMA).toBe('Timeline.1');
  await expect(dialog).toHaveCount(0);

  // Back in: a new project with the same cut, whose stills ask to be relinked.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('import-timeline').click(),
  ]);
  await chooser.setFiles(file);
  await expect(page.getByTestId('relink-dialog')).toBeVisible({ timeout: 30000 });
  const imported = await snapshot(page);
  const clips = imported.project.tracks.flatMap((track) => track.clips);
  expect(clips.map((clip) => [clip.start / FRAME, clip.duration / FRAME])).toEqual([
    [0, 60],
    [60, 30],
  ]);
  expect(imported.project.markers.map((marker) => marker.name)).toEqual(['Here']);
  expect(imported.project.media.map((media) => media.name).sort()).toEqual([
    'city.png',
    'sunset.png',
  ]);
});

test('a timeline Premiere wrote opens with its clips and nested sequence', async ({ page }) => {
  await useFileInputs(page);
  await page.goto('/?diagnostic=1');
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
  // The project opens after the client starts, and disables the button while it does.
  await expect(page.getByTestId('export-timeline')).toBeEnabled();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('import-timeline').click(),
  ]);
  await chooser.setFiles(join(fixtures, 'premiere_example.xml'));
  await expect(page.getByTestId('relink-dialog')).toContainText('sc01_sh010_anim.mov', {
    timeout: 30000,
  });
  const { project } = await snapshot(page);
  expect(project.name).toBe('sc01_sh010_layerA');
  expect(project.settings.width).toBe(1280);
  expect(project.sequences?.length).toBe(1);
  expect(project.markers).toHaveLength(3);
  const kinds = project.tracks.flatMap((track) => track.clips.map((clip) => clip.kind ?? 'media'));
  expect(kinds.filter((kind) => kind === 'sequence').length).toBeGreaterThan(0);
  expect(kinds.filter((kind) => kind === 'media').length).toBeGreaterThan(8);
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 2: projects save and reload exactly, every edit undoes, autosave recovers
// a project after the tab is killed, and missing or changed files are handled.
const mediaDir = join(process.cwd(), 'tests/media');
const FRAME = 23_520_000; // one frame at 30 fps, in flicks

interface Snapshot {
  project: {
    id: string;
    name: string;
    media: {
      id: string;
      name: string;
      size: number;
      modified: number | null;
      location: { kind: string };
    }[];
    tracks: {
      id: number;
      clips: { id: number; start: number; duration: number; link: number | null }[];
    }[];
    markers: unknown[];
    settings: { width: number; height: number };
  };
  generation: number;
  dirty: boolean;
  needsAutosave: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
}

type Hooks = {
  client: {
    api: {
      projectSnapshot(): Promise<Snapshot>;
      projectSave(): Promise<{ text: string; generation: number }>;
      projectExecute(command: unknown): Promise<{ outcome: { created: number[] } }>;
      projectBeginGroup(label: string): Promise<void>;
      mediaSnapshot(): Promise<{ id: string; name: string; status: { state: string } }[]>;
    };
  };
  project: {
    execute(command: unknown): Promise<{ created: number[] } | null>;
    importRequests(requests: unknown[]): Promise<void>;
    autosaveNow(): Promise<void>;
  };
};

async function open(page: Page, query = '') {
  await page.goto('/?diagnostic=1' + query);
  await waitForProject(page);
}

/** The engine is up and the project (with its media) has opened. The check must be synchronous. */
async function waitForProject(page: Page) {
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      !['Opening…', undefined].includes(
        document.querySelector('[data-testid="project-name"]')?.textContent ?? undefined,
      ) &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot());
}

function savedText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const hooks = Reflect.get(window, '__cgv') as Hooks;
    return (await hooks.client.api.projectSave()).text;
  });
}

/** Runs a command through the UI's project state, which shows the result. */
async function run(page: Page, command: unknown): Promise<number[]> {
  const outcome = await page.evaluate(
    (command) => (Reflect.get(window, '__cgv') as Hooks).project.execute(command),
    command,
  );
  expect(outcome, JSON.stringify(command)).not.toBeNull();
  return outcome!.created;
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

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
}

/** Writes `file` from the test media into OPFS under `name`. */
async function writeOpfs(page: Page, file: string, name: string) {
  const base64 = readFileSync(join(mediaDir, file)).toString('base64');
  await page.evaluate(
    async ({ base64, name }) => {
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
    },
    { base64, name },
  );
}

/**
 * Kills the browser's renderer processes (TerminateProcess on Windows), as when a
 * tab crashes or is killed. Only this test's pages are open; storage lives on in
 * the browser process.
 */
async function killTab(page: Page) {
  const browser = page.context().browser()!;
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
    processInfo: { id: number; type: string }[];
  };
  const crashed = page.waitForEvent('crash');
  for (const renderer of processInfo.filter((p) => p.type === 'renderer'))
    process.kill(renderer.id);
  await crashed;
  await cdp.detach();
}

test.describe.configure({ timeout: 120000 });

test('a new start creates an empty saved project with the default settings', async ({ page }) => {
  await open(page);
  const state = await snapshot(page);
  expect(state.project.name).toBe('Untitled project');
  expect(state.project.settings).toMatchObject({ width: 1920, height: 1080 });
  expect(state.project.tracks).toHaveLength(2);
  expect(state.dirty).toBe(false);
  await expect(page.getByTestId('track')).toHaveCount(2);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
});

test('save then reload gives an identical project', async ({ page }) => {
  await open(page);
  await importFiles(page, ['vp9-720p25-opus.webm', 'tone-48k-stereo.wav', 'still-1280x720.webp']);
  for (const name of ['vp9-720p25-opus.webm', 'still-1280x720.webp', 'tone-48k-stereo.wav'])
    await page.getByRole('button', { name: `Add ${name} to the timeline` }).click();
  await expect(page.getByTestId('clip')).toHaveCount(3);
  const state = await snapshot(page);
  const [video, still] = state.project.tracks[0].clips;
  // A spread of edits through the engine: split, detach, speed, properties, marker, settings.
  const [right] = await run(page, { type: 'split', at: 3 * 30 * FRAME, clips: [video.id] });
  await run(page, { type: 'detachAudio', clip: right });
  await run(page, { type: 'setSpeed', clip: video.id, speed: { num: 2, den: 1 } });
  await run(page, { type: 'move', clips: [still.id], delta: 10 * FRAME, tracks: 1 });
  await run(page, {
    type: 'setClipProperties',
    clip: video.id,
    properties: {
      opacity: 0.3,
      volumeDb: -3.25,
      transform: {
        x: 0.1 + 0.2,
        y: -12.5,
        scaleX: 1 / 3,
        scaleY: 0.5,
        rotation: 7.25,
        anchorX: 0.5,
        anchorY: 0.5,
      },
    },
  });
  await run(page, { type: 'addMarker', at: 45 * FRAME, name: 'Cue ✓', color: 'purple' });
  await run(page, { type: 'renameTrack', track: state.project.tracks[1].id, name: 'Titles' });
  await run(page, { type: 'rename', name: 'Holiday edit' });
  await run(page, {
    type: 'setSettings',
    settings: {
      width: 1080,
      height: 1920,
      frameRate: { num: 30, den: 1 },
      sampleRate: 48000,
      channels: 2,
    },
  });
  await expect(page.getByTestId('project-name')).toHaveText('Holiday edit');
  await save(page);
  const before = await snapshot(page);
  const text = await savedText(page);
  expect(before.dirty).toBe(false);

  await page.reload();
  await waitForProject(page);
  const after = await snapshot(page);
  expect(after.project).toEqual(before.project);
  expect(await savedText(page)).toBe(text);
  expect(after.dirty).toBe(false);
  expect(after.canUndo).toBe(false);
  await expect(page.getByTestId('clip')).toHaveCount(
    before.project.tracks.flatMap((t) => t.clips).length,
  );
  await expect(page.locator('[data-testid="media-item"][data-status="ready"]')).toHaveCount(3);
});

test('every edit undoes and redoes from the toolbar and the keyboard', async ({ page }) => {
  await open(page);
  await importFiles(page, ['vp9-720p25-opus.webm']);
  const empty = (await snapshot(page)).project;
  const add = page.getByRole('button', { name: 'Add vp9-720p25-opus.webm to the timeline' });
  await add.click();
  await add.click();
  await expect(page.getByTestId('clip')).toHaveCount(2);
  const two = (await snapshot(page)).project;
  await expect(page.getByTestId('undo')).toHaveAttribute('title', /Undo Add to timeline/);
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('clip')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('clip')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('media-item')).toHaveCount(0);
  expect((await snapshot(page)).project.media).toEqual([]);
  await page.getByTestId('redo').click();
  expect((await snapshot(page)).project).toEqual(empty);
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+Shift+z');
  expect((await snapshot(page)).project).toEqual(two);
  await expect(page.getByTestId('redo')).toBeDisabled();

  // Track toggles are edits too.
  await page.getByRole('button', { name: 'Lock Track 1' }).click();
  await expect(page.getByRole('button', { name: 'Unlock Track 1' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await add.click();
  await expect(page.getByTestId('project-notice').last()).toContainText('Track 1 is locked');
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('button', { name: 'Lock Track 1' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('autosave recovers the project after the tab is killed mid-edit', async ({
  page,
  context,
}) => {
  await open(page, '&autosave=400');
  await importFiles(page, ['vp9-720p25-opus.webm', 'tone-48k-stereo.wav']);
  await page.getByRole('button', { name: 'Add vp9-720p25-opus.webm to the timeline' }).click();
  await save(page);
  const saved = await snapshot(page);

  // Keep editing: a drag in progress (an open undo group) plus finished edits.
  await page.getByRole('button', { name: 'Add tone-48k-stereo.wav to the timeline' }).click();
  const clip = saved.project.tracks[0].clips[0];
  await run(page, { type: 'split', at: 2 * 25 * FRAME, clips: [clip.id] });
  await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).client.api.projectBeginGroup('Drag'),
  );
  await run(page, { type: 'move', clips: [clip.id], delta: 0, tracks: 1 });
  await expect(page.getByTestId('save-state')).toHaveText('Unsaved changes (autosaved)');
  const autosaved = await snapshot(page);
  expect(autosaved.needsAutosave).toBe(false);
  expect(autosaved.project).not.toEqual(saved.project);

  // Kill the tab's process: no unload handlers, and the engine worker dies with it.
  await killTab(page);

  const next = await context.newPage();
  await next.goto('/?diagnostic=1');
  const dialog = next.getByTestId('recovery-dialog');
  await expect(dialog).toBeVisible({ timeout: 30000 });
  await expect(dialog).toContainText('Untitled project');
  await dialog.getByRole('button', { name: 'Recover' }).click();
  await waitForProject(next);
  const recovered = await snapshot(next);
  expect(recovered.project).toEqual(autosaved.project);
  expect(recovered.dirty).toBe(true);
  await expect(next.getByTestId('save-state')).toHaveAttribute('data-state', 'dirty');
  await expect(next.locator('[data-testid="media-item"][data-status="ready"]')).toHaveCount(2);

  // Saving the recovered project makes it the saved one; the autosave goes.
  await save(next);
  await next.reload();
  await waitForProject(next);
  await expect(next.getByTestId('recovery-dialog')).toHaveCount(0);
  expect((await snapshot(next)).project).toEqual(autosaved.project);
});

test('discarding a recovery opens the last saved version', async ({ page, context }) => {
  await open(page, '&autosave=400');
  await importFiles(page, ['tone-48k-stereo.wav']);
  await save(page);
  const saved = await snapshot(page);
  await page.getByRole('button', { name: 'Add tone-48k-stereo.wav to the timeline' }).click();
  await expect(page.getByTestId('save-state')).toHaveText('Unsaved changes (autosaved)');
  await killTab(page);
  const next = await context.newPage();
  await next.goto('/?diagnostic=1');
  await next.getByTestId('recovery-dialog').getByRole('button', { name: 'Discard' }).click();
  await waitForProject(next);
  expect((await snapshot(next)).project).toEqual(saved.project);
  await next.reload();
  await waitForProject(next);
  await expect(next.getByTestId('recovery-dialog')).toHaveCount(0);
});

test('missing media is relinked, and changed files are noticed', async ({ page }) => {
  await open(page);
  await writeOpfs(page, 'vp9-720p25-opus.webm', 'picked.webm');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('picked.webm');
    await (Reflect.get(window, '__cgv') as Hooks).project.importRequests([
      { id: crypto.randomUUID(), source: { kind: 'handle', handle } },
    ]);
  });
  await page.getByRole('button', { name: 'Add picked.webm to the timeline' }).click();
  await save(page);
  const before = await snapshot(page);
  const id = before.project.media[0].id;

  // The file moves away.
  await writeOpfs(page, 'vp9-720p25-opus.webm', 'moved.webm');
  await page.evaluate(async () =>
    (await navigator.storage.getDirectory()).removeEntry('picked.webm'),
  );
  await page.reload();
  await waitForProject(page);
  const dialog = page.getByTestId('relink-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('missing-media')).toHaveAttribute('data-media-id', id);
  await expect(page.locator('[data-testid="media-item"]')).toHaveAttribute(
    'data-status',
    'missing',
  );
  await expect(page.locator('.cgv-clip-offline')).toHaveCount(1);
  expect((await snapshot(page)).project).toEqual(before.project);

  // Locate it: the picker answers with the moved file.
  await page.evaluate(() => {
    Reflect.set(window, 'showOpenFilePicker', async () => {
      const root = await navigator.storage.getDirectory();
      return [await root.getFileHandle('moved.webm')];
    });
  });
  await dialog.getByRole('button', { name: 'Locate picked.webm' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`[data-testid="media-item"][data-media-id="${id}"]`)).toHaveAttribute(
    'data-status',
    'ready',
  );
  await expect(page.locator('.cgv-clip-offline')).toHaveCount(0);
  const relinked = await snapshot(page);
  expect(relinked.dirty).toBe(true);
  expect(relinked.canUndo).toBe(false);
  expect(relinked.project.media[0]).toMatchObject({ id, name: 'moved.webm' });
  expect(relinked.project.tracks).toEqual(before.project.tracks);
  await save(page);

  // The file is written again (a new modified time): the project notices and records it.
  await page.waitForTimeout(20);
  await writeOpfs(page, 'vp9-720p25-opus.webm', 'moved.webm');
  await page.reload();
  await waitForProject(page);
  await expect(page.getByTestId('media-notice')).toContainText(
    'moved.webm changed since the project last used it',
  );
  const changed = await snapshot(page);
  expect(changed.project.media[0].modified).toBeGreaterThan(relinked.project.media[0].modified!);
  expect(changed.dirty).toBe(true);
  await expect(page.getByTestId('relink-dialog')).toHaveCount(0);
});

test('projects are listed, switched with unsaved changes kept, and deleted', async ({ page }) => {
  await open(page);
  await importFiles(page, ['tone-48k-stereo.wav']);
  await run(page, { type: 'rename', name: 'First' });
  await save(page);
  const first = await snapshot(page);

  // A new project while the first has unsaved changes keeps them as an autosave.
  await page.getByRole('button', { name: 'Add tone-48k-stereo.wav to the timeline' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByTestId('project-name')).toHaveText('Untitled project');
  await expect(page.getByTestId('project-notice')).toContainText(
    'Unsaved changes to First were kept',
  );
  await expect(page.getByTestId('media-item')).toHaveCount(0);

  await page.getByRole('button', { name: 'Open…' }).click();
  const list = page.getByTestId('projects-dialog');
  await expect(list.getByTestId('project-entry')).toHaveCount(2);
  await list
    .locator(`[data-project-id="${first.project.id}"]`)
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  // Its unsaved changes come back as a recovery.
  await page.getByTestId('recovery-dialog').getByRole('button', { name: 'Recover' }).click();
  await waitForProject(page);
  const reopened = await snapshot(page);
  expect(reopened.project.id).toBe(first.project.id);
  expect(reopened.project.tracks[0].clips).toHaveLength(1);
  await save(page);

  await page.getByRole('button', { name: 'Open…' }).click();
  const other = list.locator('[data-testid="project-entry"]').filter({ hasNotText: 'First' });
  await other.getByRole('button', { name: /^Delete/ }).click();
  await expect(list.getByTestId('project-entry')).toHaveCount(1);
});

test('an exported project file imports as a copy with the same edit', async ({ page }) => {
  await open(page);
  await importFiles(page, ['tone-48k-stereo.wav']);
  await page.getByRole('button', { name: 'Add tone-48k-stereo.wav to the timeline' }).click();
  await run(page, { type: 'rename', name: 'Exported' });
  await save(page);
  const original = await snapshot(page);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export file' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Exported.cgvproj');
  const text = readFileSync((await file.path())!, 'utf8');
  expect(text).toBe(await savedText(page));

  // Import it: the picker answers with the exported file.
  await page.evaluate(async (text) => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('import.cgvproj', { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    Reflect.set(window, 'showOpenFilePicker', async () => [handle]);
  }, text);
  await page.getByRole('button', { name: 'Open…' }).click();
  await page.getByTestId('projects-dialog').getByRole('button', { name: 'Import file…' }).click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await waitForProject(page);
  const copy = await snapshot(page);
  // Same project under a new id, since the original is still here; same browser, so no relinking.
  expect(copy.project.id).not.toBe(original.project.id);
  expect({ ...copy.project, id: original.project.id }).toEqual(original.project);
  await expect(page.locator('[data-testid="media-item"][data-status="ready"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open…' }).click();
  await expect(page.getByTestId('project-entry')).toHaveCount(2);
});

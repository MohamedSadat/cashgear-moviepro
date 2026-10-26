import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Phase 9: every project template is started from the Templates tab and filled
// with the user's clips, each in under 10 seconds: starting it (its stickers and
// sounds come in), importing eight clips, then filling every slot until the
// monitor shows the first. Each step is timed and recorded.
const root = process.cwd();
const mediaDir = join(root, 'tests/media');
const resultsDir = join(root, 'bench/results');
const software = process.env.GPU_TEST_SOFTWARE === '1';
const templateDir = join(root, 'assets/templates');
const maxSeconds = 10;

interface TemplateFile {
  name: string;
  kind: 'project' | 'intro' | 'outro';
  slots: number;
}
const templates = readdirSync(templateDir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => ({
    id: file.slice(0, -'.json'.length),
    ...(JSON.parse(readFileSync(join(templateDir, file), 'utf8')) as TemplateFile),
  }));

/** Eight clips, as a user brings them: two videos and stills, some twice under other names. */
const clips: { name: string; file: string; mimeType: string }[] = [
  { name: 'beach.mp4', file: 'h264-1080p30-aac.mp4', mimeType: 'video/mp4' },
  { name: 'sunset.png', file: 'still-1920x1080.png', mimeType: 'image/png' },
  { name: 'street.webm', file: 'vp9-720p25-opus.webm', mimeType: 'video/webm' },
  { name: 'friends.jpg', file: 'still-1280x720.jpg', mimeType: 'image/jpeg' },
  { name: 'market.webp', file: 'still-1280x720.webp', mimeType: 'image/webp' },
  { name: 'harbour.mp4', file: 'h264-1080p30-aac.mp4', mimeType: 'video/mp4' },
  { name: 'garden.png', file: 'still-1920x1080.png', mimeType: 'image/png' },
  { name: 'dinner.jpg', file: 'still-1280x720.jpg', mimeType: 'image/jpeg' },
];

type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
};

async function snapshot(page: Page) {
  return (await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
  )) as {
    project: {
      name: string;
      mainTrack: number;
      tracks: { id: number; clips: { start: number; slot?: number; media: string }[] }[];
    };
  };
}

async function idle(page: Page) {
  await expect(page.getByTestId('project-bar')).toHaveAttribute('data-busy', 'false');
}

test('every project template fills from the user’s clips in under 10 seconds', async ({
  page,
}, testInfo) => {
  test.setTimeout((software ? 60 : 20) * templates.length * 1000);
  await page.goto('/?diagnostic=1');
  await page.waitForFunction(() => !!Reflect.get(window, '__cgv')?.client);
  await idle(page);
  const files = clips.map((clip) => ({
    name: clip.name,
    mimeType: clip.mimeType,
    buffer: readFileSync(join(mediaDir, clip.file)),
  }));
  const report: Record<string, { use: number; import: number; fill: number }> = {};
  for (const template of templates) {
    // Intros and outros go into the open project: a new one each time.
    if (template.kind !== 'project') {
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await idle(page);
      await expect(page.getByTestId('project-name')).toHaveText('Untitled project');
    }
    await page.getByTestId('library-tab-templates').click();
    const started = Date.now();
    await page
      .locator(`[data-testid="template-item"][data-key="${template.id}"]`)
      .getByTestId('template-use')
      .click();
    if (template.kind === 'project')
      await expect(page.getByTestId('project-name')).toHaveText(template.name);
    await expect(page.getByTestId('template-slot')).toHaveCount(template.slots);
    await idle(page);
    const used = Date.now();

    await page.getByTestId('library-tab-media').click();
    await page.getByTestId('media-file-input').setInputFiles(files);
    for (const clip of clips)
      await expect(
        page.locator(`[data-testid="media-item"][data-name="${clip.name}"]`),
      ).toHaveAttribute('data-status', 'ready', { timeout: 60000 });
    await page.getByTestId('library-tab-templates').click();
    const imported = Date.now();

    await page.getByTestId('template-fill-all').click();
    await expect(page.locator('[data-testid="template-slot"][data-filled="false"]')).toHaveCount(0);
    // Filled when the monitor shows the first slot's picture.
    const { project } = await snapshot(page);
    const first = project.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => clip.slot !== undefined && clip.media)
      .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))[0];
    await page.evaluate(
      (time) => (Reflect.get(window, '__cgv') as Hooks).client.api.seekAndWait(time),
      first.start,
    );
    const filled = Date.now();
    report[template.id] = {
      use: (used - started) / 1000,
      import: (imported - used) / 1000,
      fill: (filled - imported) / 1000,
    };
  }
  mkdirSync(resultsDir, { recursive: true });
  const body = JSON.stringify({ maxSeconds, software, report }, null, 2);
  writeFileSync(join(resultsDir, `templates-${testInfo.project.name}.json`), body + '\n');
  await testInfo.attach('template-timings', { body, contentType: 'application/json' });
  expect(Object.keys(report)).toHaveLength(20);
  if (software) return;
  for (const [id, time] of Object.entries(report))
    expect(time.use + time.import + time.fill, id).toBeLessThan(maxSeconds);
});

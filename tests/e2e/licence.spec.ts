import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startLicensing, type TestLicensing } from './licensing';

// Phase 11: Pro licence keys activate against the licence server, hold across
// reloads and through the offline grace period, and give way to the free edition
// when deactivated, revoked or not checked for 14 days. Every browser context is a
// machine of its own.

let licensing: TestLicensing;

test.beforeAll(async () => {
  licensing = await startLicensing();
});

test.afterAll(async () => {
  await licensing?.stop();
});

const DAY = 86_400_000;
const FRAME = 23_520_000; // one frame at 30 fps
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(process.cwd(), '.tools/ffmpeg/bin');
const ffmpeg = join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

type Hooks = {
  client: { api: { projectSnapshot(): Promise<{ project: { mainTrack: number } }> } };
  project: { execute(command: unknown): Promise<{ created: number[] } | null> };
  exporter: {
    start(settings: unknown, options: { download: boolean }): Promise<boolean>;
    settled(): Promise<{ state: string; message?: string }>;
    dismiss(): void;
  };
};

/** Exports 1080p30 H.264 and returns frame 30 as RGB bytes, or the failure. */
async function exportFrame(page: Page, file: string, width = 1920, height = 1080) {
  const download = page.waitForEvent('download', { timeout: 5 * 60_000 });
  const settings = {
    format: 'mp4',
    width,
    height,
    frameRate: { num: 30, den: 1 },
    video: { codec: 'avc', bitrate: 8e6 },
    audio: null,
  };
  await page.evaluate(
    (settings) =>
      (Reflect.get(window, '__cgv') as Hooks).exporter.start(settings, { download: true }),
    settings,
  );
  const status = await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).exporter.settled(),
  );
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).exporter.dismiss());
  if (status.state !== 'done') return status.message ?? status.state;
  await (await download).saveAs(file);
  const pick = 'trim=start_frame=30:end_frame=31,format=rgb24';
  const decoded = spawnSync(
    ffmpeg,
    ['-v', 'error', '-i', file, '-vf', pick, '-frames:v', '1', '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 28 },
  );
  expect(decoded.status, String(decoded.stderr)).toBe(0);
  return decoded.stdout;
}

/** Pixels brighter than the grey background in a box of the frame (fractions of it). */
function bright(rgb: Buffer, box: [number, number, number, number]) {
  const [x0, y0, x1, y1] = [box[0] * 1920, box[1] * 1080, box[2] * 1920, box[3] * 1080];
  let count = 0;
  for (let y = Math.floor(y0); y < y1; y++)
    for (let x = Math.floor(x0); x < x1; x++) if (rgb[(y * 1920 + x) * 3] > 160) count++;
  return count;
}

async function open(page: Page, query = licensing.query) {
  await page.goto('/?diagnostic=1' + query);
  await expect(page.getByTestId('open-licence')).toBeVisible();
}

async function activate(page: Page, key: string) {
  await page.getByTestId('open-licence').click();
  await page.getByTestId('licence-key').fill(key);
  await page.getByTestId('licence-activate').click();
}

const edition = (page: Page) => page.getByTestId('open-licence');

test('a key activates Pro, which holds across reloads until deactivated', async ({
  page,
  browser,
}) => {
  const { key } = await licensing.issue({ machines: 1 });
  await open(page);
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');
  await page.getByTestId('open-licence').click();
  await expect(page.getByTestId('licence-status')).toContainText('Free edition');
  // Typed carelessly: lower case and spaces for dashes.
  await page.getByTestId('licence-key').fill(key.toLowerCase().replace(/-/g, ' '));
  await page.getByTestId('licence-activate').click();
  await expect(page.getByTestId('licence-status')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('licence-status')).toContainText('Pro is active on this browser');
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');

  await page.reload();
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');

  // The licence allows one machine: another browser is refused until this one lets go.
  const other = await browser.newContext();
  const second = await other.newPage();
  await open(second);
  await activate(second, key);
  await expect(second.getByTestId('licence-error')).toContainText('as many computers');
  await expect(edition(second)).toHaveAttribute('data-edition', 'free');

  await page.getByTestId('open-licence').click();
  await page.getByTestId('licence-deactivate').click();
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');
  await second.getByTestId('licence-activate').click();
  await expect(edition(second)).toHaveAttribute('data-edition', 'pro');
  await other.close();
});

test('wrong keys are refused with the reason', async ({ page }) => {
  await open(page);
  await activate(page, 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
  await expect(page.getByTestId('licence-error')).toHaveText('That licence key is not valid.');
  await page.getByTestId('licence-key').fill('not a key');
  await page.getByTestId('licence-activate').click();
  await expect(page.getByTestId('licence-error')).toHaveText('The request is not valid.');
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');
});

test('a revoked licence becomes the free edition at its next check', async ({ page }) => {
  const { id, key } = await licensing.issue();
  await open(page);
  await activate(page, key);
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');
  await licensing.revoke(id);
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByTestId('licence-error')).toHaveText('That licence has been withdrawn.');
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');
});

test('offline, Pro holds for 14 days after the last check, and a clock set back does not help', async ({
  page,
}) => {
  const { key } = await licensing.issue();
  await open(page);
  await activate(page, key);
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');
  const offline = licensing.query.replace(
    encodeURIComponent(licensing.base),
    'http%3A%2F%2F127.0.0.1%3A9',
  );
  const now = Date.now();

  await page.clock.setFixedTime(now + 8 * DAY);
  await open(page, offline);
  await page.getByTestId('open-licence').click();
  await expect(page.getByTestId('licence-status')).toHaveAttribute('data-state', 'offline');
  await expect(page.getByTestId('licence-status')).toContainText('Connect to the internet by');
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');

  await page.clock.setFixedTime(now + 15 * DAY);
  await open(page, offline);
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');
  await page.getByTestId('open-licence').click();
  await expect(page.getByTestId('licence-status')).toHaveAttribute('data-state', 'lapsed');

  await page.clock.setFixedTime(now);
  await open(page, offline);
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');

  // Back online, a check brings Pro back.
  await open(page);
  await page.getByTestId('open-licence').click();
  await page.getByRole('button', { name: 'Check now' }).first().click();
  await expect(page.getByTestId('licence-status')).toHaveAttribute('data-edition', 'pro');
});

test('free exports carry the watermark and stop at 1080p; Pro exports do neither', async ({
  page,
}, testInfo) => {
  test.skip(!existsSync(ffmpeg), 'needs the pinned FFmpeg (pnpm setup:ffmpeg)');
  test.setTimeout(5 * 60_000);
  await open(page);
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      !['Opening…', undefined].includes(
        document.querySelector('[data-testid="project-name"]')?.textContent ?? undefined,
      ) &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
  await page.evaluate(async (FRAME) => {
    const hooks = Reflect.get(window, '__cgv') as Hooks;
    const { project } = await hooks.client.api.projectSnapshot();
    // Two seconds of mid grey: the white watermark stands out on it.
    const grey = { r: 0.3, g: 0.3, b: 0.3, a: 1 };
    await hooks.project.execute({
      type: 'overwrite',
      track: project.mainTrack,
      at: 0,
      clip: {
        kind: 'title',
        duration: 60 * FRAME,
        title: {
          elements: [
            {
              id: 1,
              x: 0,
              y: 0,
              fill: grey,
              type: 'shape',
              kind: 'rectangle',
              width: 1920,
              height: 1080,
            },
          ],
        },
      },
    });
  }, FRAME);

  // The dialog offers nothing over 1080p, and the export worker refuses it too.
  await page.getByTestId('open-export').click();
  await expect(page.getByTestId('export-watermark')).toBeVisible();
  await expect(
    page.locator('[data-testid="export-preset"] option[value="youtube-4k"]'),
  ).toHaveJSProperty('disabled', true);
  await page.keyboard.press('Escape');
  expect(await exportFrame(page, testInfo.outputPath('free-4k.mp4'), 3840, 2160)).toContain(
    'up to 1080p',
  );

  const corner: [number, number, number, number] = [0.7, 0.88, 0.99, 0.99];
  const elsewhere: [number, number, number, number] = [0, 0, 0.6, 0.8];
  const free = await exportFrame(page, testInfo.outputPath('free.mp4'));
  expect(typeof free).not.toBe('string');
  expect(bright(free as Buffer, corner)).toBeGreaterThan(1000);
  expect(bright(free as Buffer, elsewhere)).toBe(0);

  const { key } = await licensing.issue();
  await activate(page, key);
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');
  await page.keyboard.press('Escape');
  const pro = await exportFrame(page, testInfo.outputPath('pro.mp4'));
  expect(bright(pro as Buffer, corner)).toBe(0);
});

test('builds that are not releases are Pro without a licence server', async ({ page }) => {
  await open(page, '');
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');
  await page.getByTestId('open-licence').click();
  await expect(page.getByTestId('licence-status')).toHaveAttribute('data-state', 'development');
});

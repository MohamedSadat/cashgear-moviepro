import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';

// Phase 11: the web app installs as a PWA, starts offline once it has loaded online
// and passes the capability check there, and shows its third-party notices. A
// browser only installs apps in a profile of its own (Playwright's are incognito),
// so the install test makes one, and installs through Chrome's own PWA commands.

const base = 'http://127.0.0.1:4173';

async function ready(page: Page) {
  await expect(page.getByTestId('engine-status')).toHaveText('Engine ready');
  await expect(page.getByTestId('capability-strip')).toHaveAttribute('data-status', 'ok');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
}

test('the web app installs, and the installed app starts offline with every capability', async ({}, testInfo) => {
  const profile = await mkdtemp(join(tmpdir(), 'cgv-pwa-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: testInfo.project.use.channel,
    args: testInfo.project.use.launchOptions?.args,
    viewport: { width: 1280, height: 800 },
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(base + '/?diagnostic=1');
    await ready(page);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, {
      timeout: 60_000,
    });
    const cdp = await context.newCDPSession(page);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    expect(installabilityErrors).toEqual([]);
    const manifest = await cdp.send('Page.getAppManifest');
    expect(manifest.errors).toEqual([]);
    expect(JSON.parse(manifest.data!)).toMatchObject({
      name: 'CashGear Video',
      display: 'standalone',
    });

    // The app shell is cached once the worker has installed.
    const cached = await page.evaluate(async () => {
      const shell = (await caches.keys()).find((name) => name.startsWith('cgv-shell-'));
      return shell
        ? (await (await caches.open(shell)).keys()).map((r) => new URL(r.url).pathname)
        : [];
    });
    expect(cached).toContain('/');
    expect(cached.some((path) => /\/assets\/cgv_wasm_bg-.*\.wasm$/.test(path))).toBe(true);

    // Install it as the browser's install button does, and start it, offline.
    const browser = await context.browser()!.newBrowserCDPSession();
    const manifestId = base + '/';
    await browser.send('PWA.install', { manifestId, installUrlOrBundleUrl: base + '/' });
    // The system knows the installed app (this fails for one that is not installed).
    await browser.send('PWA.getOsAppState', { manifestId });
    // As if the user ticked "Open in a window" in the install prompt.
    await browser.send('PWA.changeAppUserSettings', { manifestId, displayMode: 'standalone' });
    await context.setOffline(true);
    let app: Page;
    if (testInfo.project.use.channel === 'msedge') {
      // Edge starts installed apps through a host of its own, out of the test's
      // reach: the app's page, offline in the same profile, stands in for it.
      app = await context.newPage();
      await app.goto(base + '/?diagnostic=1');
    } else {
      const opened = context.waitForEvent('page');
      await browser.send('PWA.launch', { manifestId, url: base + '/?diagnostic=1' });
      app = await opened;
      // It runs in an app window of its own.
      await app.waitForLoadState();
      expect(await app.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
    }
    await ready(app);
    await app.waitForFunction(
      () =>
        document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy ===
        'false',
    );
    await context.setOffline(false);
    await browser.send('PWA.uninstall', { manifestId });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
});

test('About lists the third-party software and its licences', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-about').click();
  await expect(page.getByTestId('about-version')).toContainText('CashGear Video');
  await page.getByTestId('about-show-notices').click();
  const notices = page.getByTestId('about-notices');
  await expect(notices).toContainText('Rust crates (');
  await expect(notices).toContainText('mediabunny');
  await expect(notices).toContainText('Inter: OFL-1.1');
  await expect(notices).toContainText('Whisper large-v3-turbo: MIT');
  await expect(notices).toContainText('Apache License');
});

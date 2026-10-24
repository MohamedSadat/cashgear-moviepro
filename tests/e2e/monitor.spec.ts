import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { barMismatches, sweepBand } from './pattern.mjs';

async function capture(page: Page) {
  return PNG.sync.read(await page.getByTestId('program-monitor').screenshot());
}

async function frames(page: Page) {
  return Number(await page.getByTestId('program-monitor').getAttribute('data-frames'));
}

async function engineReady(page: Page, backend: 'WebGPU' | 'WebGL2') {
  await expect(page.getByTestId('engine-status')).toHaveText('Engine ready');
  await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
  await expect.poll(() => frames(page)).toBeGreaterThan(2);
}

// The Phase 0 test pattern (`?pattern=1`) checks the GPU path itself; the
// monitor otherwise shows the timeline, which tests/e2e/playback.spec.ts covers.
for (const backend of ['WebGPU', 'WebGL2'] as const) {
  const query = backend === 'WebGL2' ? '?pattern=1&gpu=webgl2' : '?pattern=1';

  test(
    backend + ' draws the animated test pattern in the engine worker',
    async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const response = await page.goto('/' + query);
      expect(response?.headers()['cross-origin-opener-policy']).toBe('same-origin');
      expect(response?.headers()['cross-origin-embedder-policy']).toBe('require-corp');
      await engineReady(page, backend);
      if (testInfo.project.name === 'software-webgl2')
        await expect(page.getByTestId('gpu-backend')).toHaveAttribute('title', /SwiftShader/);
      if (testInfo.project.name === 'software-webgpu' && backend === 'WebGPU') {
        const vendor = await page.evaluate(async () => {
          const gpu = Reflect.get(navigator, 'gpu') as {
            requestAdapter: () => Promise<{ info: { vendor: string } }>;
          };
          return (await gpu.requestAdapter()).info.vendor;
        });
        expect(vendor).toBe('google');
      }
      await testInfo.attach('adapter', {
        body: JSON.stringify({
          backend,
          adapter: await page.getByTestId('gpu-backend').getAttribute('title'),
          browser: page.context().browser()?.version(),
        }),
        contentType: 'application/json',
      });

      const first = await capture(page);
      expect(barMismatches(first)).toEqual([]);
      const band = sweepBand(first);
      expect(band.center).toBeDefined();
      expect(Math.abs(band.width - band.expectedWidth)).toBeLessThanOrEqual(3);
      // The band crosses the frame every 2 s; after ~0.3 s it must have moved.
      const before = await frames(page);
      await page.waitForTimeout(300);
      const second = await capture(page);
      expect(await frames(page)).toBeGreaterThan(before);
      const moved = Math.abs((sweepBand(second).center ?? 0) - (band.center ?? 0));
      expect(Math.min(moved, 1 - moved)).toBeGreaterThan(0.02);

      expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
      await expect(page.getByTestId('shared-memory')).toHaveText('Shared memory OK');
      await expect(page.getByTestId('webcodecs')).toHaveText('WebCodecs OK');
      const strip = page.getByTestId('capability-strip');
      if (backend === 'WebGPU') {
        await expect(strip).toHaveAttribute('data-status', 'ok');
        await expect(page.getByTestId('capability-notice')).toHaveCount(0);
      } else {
        await expect(strip).toHaveAttribute('data-status', 'degraded');
        await expect(page.getByTestId('capability-notice')).toContainText('using WebGL2');
      }
      await expect(page.getByTestId('capability-blocked')).toHaveCount(0);
      expect(errors).toEqual([]);
    },
  );

  test(backend + ' recovers from device loss and a Rust panic on retry', async ({ page }) => {
    await page.goto('/?diagnostic=1&' + query.slice(1));
    await engineReady(page, backend);
    await page.getByRole('button', { name: 'Simulate device loss' }).click();
    await expect(page.getByRole('alert')).toContainText('GPU device lost');
    await page.getByRole('button', { name: 'Retry engine' }).click();
    await engineReady(page, backend);
    await expect(page.getByTestId('program-monitor')).toHaveCount(1);
    await page.getByRole('button', { name: 'Simulate Rust panic' }).click();
    await expect(page.getByRole('alert')).toContainText('Rust panic');
    await page.getByRole('button', { name: 'Retry engine' }).click();
    await engineReady(page, backend);
    expect(barMismatches(await capture(page))).toEqual([]);
  });
}

for (const fault of ['adapter', 'device']) {
  test('reports the WebGL2 fallback when the WebGPU ' + fault + ' fails', async ({ page }) => {
    await page.goto('/?diagnostic=1&pattern=1&fault=' + fault);
    await engineReady(page, 'WebGL2');
    await expect(page.getByTestId('capability-strip')).toHaveAttribute('data-status', 'degraded');
    await expect(page.getByTestId('capability-notice')).toContainText(
      'WebGPU could not start, so the engine is using WebGL2',
    );
    expect(barMismatches(await capture(page))).toEqual([]);
  });
}

test('blocks with a clear message when WebCodecs is missing', async ({ page }) => {
  await page.addInitScript(() => {
    for (const name of ['VideoEncoder', 'AudioEncoder']) Reflect.deleteProperty(globalThis, name);
  });
  await page.goto('/');
  const blocked = page.getByRole('alertdialog');
  await expect(blocked).toContainText('CashGear Video can’t run here');
  await expect(blocked).toContainText('WebCodecs is missing (VideoEncoder, AudioEncoder)');
  await expect(page.getByTestId('capability-strip')).toHaveAttribute('data-status', 'blocked');
});

test('pauses a zero-sized monitor and resumes rendering', async ({ page }) => {
  await page.goto('/?pattern=1');
  await expect.poll(() => frames(page)).toBeGreaterThan(2);
  const monitor = page.getByTestId('program-monitor');
  await monitor.evaluate((canvas) => {
    canvas.parentElement!.style.width = '0px';
  });
  await expect(monitor).toHaveAttribute('data-render-width', '0');
  const paused = await frames(page);
  await page.waitForTimeout(300);
  expect(await frames(page)).toBe(paused);
  await monitor.evaluate((canvas) => {
    canvas.parentElement!.style.width = '';
  });
  await expect.poll(() => frames(page)).toBeGreaterThan(paused);
});

test('renders at physical pixels when the window or device pixel ratio changes', async ({
  page,
}) => {
  await page.goto('/?pattern=1');
  await expect.poll(() => frames(page)).toBeGreaterThan(2);
  const monitor = page.getByTestId('program-monitor');
  const matchesBacking = () =>
    monitor.evaluate((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return (
        Number(canvas.dataset.renderWidth) === Math.round(rect.width * devicePixelRatio) &&
        Number(canvas.dataset.renderHeight) === Math.round(rect.height * devicePixelRatio)
      );
    });
  await page.setViewportSize({ width: 960, height: 640 });
  await expect.poll(matchesBacking).toBe(true);
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 700,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await expect.poll(matchesBacking).toBe(true);
  await session.detach();
});

test('serves the engine WASM with its MIME type', async ({ page }) => {
  const wasm = page.waitForResponse((response) => response.url().endsWith('.wasm'));
  await page.goto('/');
  const response = await wasm;
  expect(response.headers()['content-type']).toContain('application/wasm');
  expect(response.headers()['cross-origin-resource-policy']).toBe('same-origin');
});

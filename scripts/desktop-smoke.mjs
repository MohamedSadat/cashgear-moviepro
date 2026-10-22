// Launches the release desktop build, attaches Playwright to its WebView2 over
// CDP and checks the same things the browser specs check: the pattern on both
// GPU backends, cross-origin isolation, shared memory and the native command.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { PNG } from 'pngjs';
import { barMismatches, sweepBand } from '../tests/e2e/pattern.mjs';
import { root } from './lib.mjs';

if (process.platform !== 'win32') throw new Error('Desktop smoke currently targets Windows.');
const runtimeKeys = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
];
const runtimeVersion = runtimeKeys
  .map(
    (key) =>
      spawnSync('reg', ['query', key, '/v', 'pv'], {
        encoding: 'utf8',
        windowsHide: true,
      }).stdout?.match(/REG_SZ\s+([\d.]+)/)?.[1],
  )
  .find((version) => version && version !== '0.0.0.0');
if (!runtimeVersion)
  throw new Error('WebView2 Runtime is missing. Run scripts/setup-webview2.ps1 first.');
console.log('WebView2 Runtime: ' + runtimeVersion);

const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const profilePrefix = join(tmpdir(), 'cgv-webview2-smoke-');
const profile = await mkdtemp(profilePrefix);
const software = process.env.GPU_TEST_SOFTWARE === '1';
const softwareArgs = software
  ? ' --enable-unsafe-webgpu --enable-unsafe-swiftshader --use-angle=d3d11-warp --use-webgpu-adapter=swiftshader'
  : '';
const browserArguments =
  '--remote-debugging-port=' + port + ' --remote-debugging-address=127.0.0.1' + softwareArgs;
// Elevated WebView2 hosts ignore environment browser arguments. Use the documented
// HKLM override only on disposable GitHub-hosted runners, scoped to our executable.
// https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags
const policyKey = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
const policyName = 'cgv-desktop.exe';
const hostedRunner =
  process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
let previousPolicy;
function reg(args) {
  return spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
}
if (hostedRunner) {
  const existing = reg(['query', policyKey, '/v', policyName, '/reg:64']);
  if (existing.status === 0) {
    previousPolicy = existing.stdout.match(/REG_SZ\s+(.+)/)?.[1];
    if (previousPolicy === undefined) throw new Error('Unexpected existing WebView2 test policy');
  }
  const added = reg([
    'add',
    policyKey,
    '/v',
    policyName,
    '/t',
    'REG_SZ',
    '/d',
    browserArguments,
    '/f',
    '/reg:64',
  ]);
  if (added.status !== 0)
    throw new Error('Could not configure WebView2 test policy: ' + added.stderr);
}

const child = spawn(join(root, 'target/release/cgv-desktop.exe'), [], {
  cwd: root,
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
  },
  stdio: 'inherit',
});
let launchError;
child.on('error', (error) => {
  launchError = error;
});
let browser;
try {
  const endpoint = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 45000;
  while (true) {
    if (launchError) throw launchError;
    if (child.exitCode !== null)
      throw new Error('Desktop exited before debugging was ready: ' + child.exitCode);
    try {
      const response = await fetch(endpoint + '/json/version', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) break;
    } catch {
      /* Wait for WebView2 to create its debugging endpoint. */
    }
    if (Date.now() > deadline) throw new Error('WebView2 debugging endpoint timed out');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await expect(page.getByTestId('engine-status')).toHaveText('Engine ready', { timeout: 30000 });
  const origin = new URL(page.url()).origin;
  const results = [];
  for (const backend of ['WebGPU', 'WebGL2']) {
    await page.goto(origin + (backend === 'WebGL2' ? '/?gpu=webgl2' : '/'));
    await expect(page.getByTestId('engine-status')).toHaveText('Engine ready', { timeout: 30000 });
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
    const monitor = page.getByTestId('program-monitor');
    await expect
      .poll(async () => Number(await monitor.getAttribute('data-frames')), { timeout: 30000 })
      .toBeGreaterThan(2);
    if (!(await page.evaluate(() => crossOriginIsolated)))
      throw new Error('Desktop is not cross-origin isolated');
    await expect(page.getByTestId('shared-memory')).toHaveText('Shared memory OK');
    await expect(page.getByTestId('native-info')).toHaveText(/^Desktop 0\.1\.0 · windows x86_64$/);
    const pixels = PNG.sync.read(await monitor.screenshot());
    const mismatches = barMismatches(pixels);
    if (mismatches.length) throw new Error(backend + ' pattern mismatch: ' + mismatches.join('; '));
    const first = sweepBand(pixels).center;
    await page.waitForTimeout(300);
    const second = sweepBand(PNG.sync.read(await monitor.screenshot())).center;
    if (first === undefined || second === undefined || first === second)
      throw new Error(backend + ' sweep band is missing or not moving');
    const webgpuVendor =
      backend === 'WebGPU'
        ? await page.evaluate(async () => (await navigator.gpu.requestAdapter())?.info.vendor)
        : undefined;
    if (software && backend === 'WebGPU' && webgpuVendor !== 'google')
      throw new Error('Expected the SwiftShader WebGPU adapter');
    await mkdir(join(root, 'bench/results'), { recursive: true });
    await page.screenshot({ path: join(root, 'bench/results/desktop-' + backend + '.png') });
    results.push({
      backend,
      webgpuVendor,
      adapter: await page.getByTestId('gpu-backend').getAttribute('title'),
      native: await page.getByTestId('native-info').textContent(),
      status: await page.getByTestId('capability-strip').getAttribute('data-status'),
      browser: browser.version(),
      origin,
      software,
    });
  }
  await page.goto(origin + '/');
  await expect(page.getByTestId('engine-status')).toHaveText('Engine ready', { timeout: 30000 });
  await page.screenshot({ path: join(root, 'bench/results/desktop.png') });
  await writeFile(
    join(root, 'bench/results/desktop-smoke.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close().catch((error) => {
    console.error('Could not close the desktop browser: ' + error.message);
    process.exitCode = 1;
  });
  child.kill();
  if (hostedRunner) {
    const restored = reg(
      previousPolicy === undefined
        ? ['delete', policyKey, '/v', policyName, '/f', '/reg:64']
        : [
            'add',
            policyKey,
            '/v',
            policyName,
            '/t',
            'REG_SZ',
            '/d',
            previousPolicy,
            '/f',
            '/reg:64',
          ],
    );
    if (restored.status !== 0) {
      console.error('Could not restore WebView2 test policy: ' + restored.stderr);
      process.exitCode = 1;
    }
  }
  if (profile.startsWith(profilePrefix)) {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
      (error) => console.warn('Temporary WebView2 profile cleanup: ' + error.message),
    );
  }
}

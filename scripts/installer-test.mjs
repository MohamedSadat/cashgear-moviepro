// Installs, updates and uninstalls the Windows installer as a user would (Phase 11's
// exit criterion; pnpm desktop:installer-test, after pnpm build). It builds the
// installer twice, a version apart, signed with a throwaway certificate and a
// throwaway updater key, serves the second as an update on 127.0.0.1, then:
//   1. installs the first silently into a folder of its own and checks that every
//      program and library in it is signed with the certificate;
//   2. starts it, checks it finds its FFmpeg, and has it find, download, check and
//      install the update;
//   3. checks that the app the installer starts again is the new version;
//   4. uninstalls it silently and checks that nothing is left behind.
// Needs .tools/ffmpeg (pnpm setup:ffmpeg), the WebView2 Runtime and the Windows SDK.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { pnpmCommand, root, run, windowsPowerShell } from './lib.mjs';
import { makeTestCertificate } from './test-certificate.mjs';

if (process.platform !== 'win32') throw new Error('The installer test runs on Windows.');
const product = 'CashGear Video';
const feedPort = 47811;
const started = Date.now();
const log = (line) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)} s] ${line}`);
const work = join(tmpdir(), `cgv-installer-${randomBytes(4).toString('hex')}`);
const feed = join(work, 'feed');
const installDir = join(work, 'app');
mkdirSync(feed, { recursive: true });
const results = { versions: [], installer: {}, steps: {} };

function uninstallEntry() {
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}`;
  const query = spawnSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true });
  if (query.status !== 0) return null;
  return { version: query.stdout.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1] ?? null };
}

async function until(what, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function freePort() {
  const listener = createNetServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

const appExe = () =>
  join(
    installDir,
    readdirSync(installDir).find((name) => /\.exe$/i.test(name) && !/^uninstall/i.test(name)),
  );

function stopApp() {
  windowsPowerShell(
    `Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${installDir}') } | Stop-Process -Force`,
  );
}

/** Attaches to the app's WebView2 and returns the page with its test hooks. */
async function attach(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  await until(
    'the app to accept a debugger',
    () =>
      fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) }).then(
        (r) => r.ok,
        () => false,
      ),
    60_000,
  );
  const browser = await chromium.connectOverCDP(endpoint);
  // On a slow machine the webview answers before it has opened its page.
  const context = await until('the webview', () => browser.contexts()[0], 30_000);
  const page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 60_000 }));
  await until('the app to load', () => page.url().startsWith('http'), 30_000);
  await page.goto(new URL(page.url()).origin + '/?diagnostic=1');
  await page.waitForFunction(() => !!window.__cgv?.updates, undefined, { timeout: 60_000 });
  return { browser, page };
}

const policyKey = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments';
const policyName = 'cgv-desktop.exe';
const hostedRunner =
  process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const reg = (args) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
let policySet = false;
let server;
let profile;
let dataDir;
try {
  // Two installers a version apart, signed with a throwaway certificate and updater key.
  const certificate = makeTestCertificate(join(work, 'certificate'));
  const keyPath = join(work, 'updater.key');
  const keyPassword = randomBytes(12).toString('hex');
  await run(
    ...pnpmCommand([
      '--filter',
      '@cgv/desktop',
      'tauri',
      'signer',
      'generate',
      '--ci',
      '-w',
      keyPath,
      '-p',
      keyPassword,
    ]),
    { stdio: 'ignore' },
  );
  const base = JSON.parse(
    readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'),
  ).version;
  const [major, minor, patch] = base.split('.').map(Number);
  const versions = [base, `${major}.${minor}.${patch + 1}`];
  results.versions = versions;
  const env = {
    ...process.env,
    CGV_SIGN_PFX: certificate.pfx,
    CGV_SIGN_PASSWORD: certificate.password,
    CGV_SIGN_TIMESTAMP: '0',
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, 'utf8'),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: keyPassword,
    CGV_UPDATER_PUBKEY: readFileSync(keyPath + '.pub', 'utf8').trim(),
    CGV_UPDATER_URL: `http://127.0.0.1:${feedPort}/latest.json`,
  };
  const bundle = join(root, 'target/release/bundle/nsis');
  const setups = [];
  for (const version of versions) {
    log(`Building the ${version} installer`);
    const building = Date.now();
    await run(process.execPath, [join(root, 'scripts/desktop-installer.mjs')], {
      env: { ...env, CGV_VERSION: version },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const name = `${product}_${version}_x64-setup.exe`;
    copyFileSync(join(bundle, name), join(feed, name));
    copyFileSync(join(bundle, name + '.sig'), join(feed, name + '.sig'));
    setups.push(join(feed, name));
    results.installer[version] = {
      bytes: statSync(join(feed, name)).size,
      buildSeconds: Math.round((Date.now() - building) / 1000),
    };
  }

  // The update feed.
  const update = setups[1].split(/[\\/]/).pop();
  const manifest = {
    version: versions[1],
    notes: 'The installer test update.',
    pub_date: new Date().toISOString(),
    platforms: Object.fromEntries(
      ['windows-x86_64', 'windows-x86_64-nsis'].map((platform) => [
        platform,
        {
          signature: readFileSync(setups[1] + '.sig', 'utf8'),
          url: `http://127.0.0.1:${feedPort}/${encodeURIComponent(update)}`,
        },
      ]),
    ),
  };
  writeFileSync(join(feed, 'latest.json'), JSON.stringify(manifest));
  server = createServer((request, response) => {
    const file = join(
      feed,
      decodeURIComponent(new URL(request.url, 'http://feed').pathname.slice(1)),
    );
    if (!file.startsWith(feed) || !existsSync(file)) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Length': statSync(file).size });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(feedPort, '127.0.0.1', resolve));

  // 1. Install silently, and check the signatures.
  if (uninstallEntry())
    throw new Error(`${product} is already installed for this user: uninstall it first.`);
  log(`Installing ${versions[0]} into ${installDir}`);
  let step = Date.now();
  const installed = spawnSync(`"${setups[0]}" /S /D=${installDir}`, {
    shell: true,
    windowsHide: true,
  });
  if (installed.status !== 0) throw new Error(`The installer failed (${installed.status}).`);
  results.steps.installSeconds = (Date.now() - step) / 1000;
  if (uninstallEntry()?.version !== versions[0])
    throw new Error('The install left no uninstall entry.');
  const files = JSON.parse(
    windowsPowerShell(
      `@(Get-ChildItem -Path '${installDir}' -Recurse -Include *.exe,*.dll | ForEach-Object { ` +
        `$s = Get-AuthenticodeSignature $_.FullName; ` +
        `[pscustomobject]@{ file = $_.FullName.Substring(${installDir.length + 1}); signer = $s.SignerCertificate.Thumbprint } }) | ConvertTo-Json`,
    ),
  );
  const unsigned = files.filter((file) => file.signer !== certificate.thumbprint);
  results.signedFiles = files.length;
  if (unsigned.length)
    throw new Error('Unsigned files: ' + unsigned.map((file) => file.file).join(', '));
  for (const needed of [
    'ffmpeg/ffmpeg.exe',
    'ffmpeg/ffprobe.exe',
    'ffmpeg/LICENSE.txt',
    'ffmpeg/README.txt',
  ]) {
    if (!existsSync(join(installDir, needed))) throw new Error(`The install lacks ${needed}.`);
  }
  log(`Installed: ${files.length} programs and libraries, all signed`);

  // 2. Start it, and update it from the feed.
  const port = await freePort();
  profile = join(work, 'webview2');
  dataDir = join(work, 'data');
  const browserArguments = `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`;
  // Elevated WebView2 hosts ignore browser arguments from the environment. On
  // GitHub's disposable runners, which run elevated, the documented policy passes
  // them to our executable only, as the desktop smoke does.
  if (hostedRunner) {
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
      throw new Error('Could not set the WebView2 test policy: ' + added.stderr);
    policySet = true;
  }
  const start = () =>
    spawn(appExe(), [], {
      windowsHide: true,
      env: {
        ...process.env,
        CGV_DATA_DIR: dataDir,
        WEBVIEW2_USER_DATA_FOLDER: profile,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
      },
      stdio: 'ignore',
    });
  const app = start();
  const exited = new Promise((resolve) => app.once('exit', resolve));
  let { browser, page } = await attach(port);
  const before = await page.evaluate(() => window.__cgv.platform.nativeInfo());
  if (before.version !== versions[0]) throw new Error(`The installed app is ${before.version}.`);
  const clip = join(root, 'tests/media/h264-1080p30-aac.mp4');
  if (existsSync(clip)) {
    // The installed app probes media with the FFmpeg beside it.
    const [media] = await page.evaluate(
      (path) => window.__TAURI_INTERNALS__.invoke('media_register', { files: [{ path }] }),
      clip,
    );
    if (!media?.probe) throw new Error('The installed app could not run its ffprobe.');
    results.ffprobe = true;
  }
  const offered = await page.evaluate(() => window.__cgv.updates.check());
  if (offered?.version !== versions[1])
    throw new Error(`The feed offered ${JSON.stringify(offered)}.`);
  log(`Updating to ${versions[1]}`);
  step = Date.now();
  await page.evaluate(() => void window.__cgv.updates.install());
  await until('the app to close for the installer', () => exited.then(() => true), 120_000);
  await browser.close().catch(() => {});
  await until('the update to install', () => uninstallEntry()?.version === versions[1], 180_000);
  results.steps.updateSeconds = (Date.now() - step) / 1000;

  // 3. The installer starts the new version, with the same settings. It starts it
  // as the desktop's user, which a CI runner's service session may not have: then
  // the test starts it, and records that the installer did not.
  try {
    ({ browser, page } = await attach(port));
    results.steps.restartedByInstaller = true;
  } catch (error) {
    log(`The installer did not start the app again (${error.message}): starting it`);
    results.steps.restartedByInstaller = false;
    start();
    ({ browser, page } = await attach(port));
  }
  const after = await page.evaluate(() => window.__cgv.platform.nativeInfo());
  if (after.version !== versions[1])
    throw new Error(`After the update the app is ${after.version}.`);
  results.steps.restartedVersion = after.version;
  log(`Updated: the app runs as ${after.version}`);
  await browser.close().catch(() => {});
  stopApp();

  // 4. Uninstall silently: nothing may be left.
  step = Date.now();
  spawnSync(`"${join(installDir, 'uninstall.exe')}" /S`, { shell: true, windowsHide: true });
  await until(
    'the uninstaller to finish',
    () => !uninstallEntry() && !existsSync(join(installDir, 'uninstall.exe')),
    120_000,
  );
  const shortcut = join(
    process.env.APPDATA,
    'Microsoft/Windows/Start Menu/Programs',
    `${product}.lnk`,
  );
  const left = existsSync(installDir) ? readdirSync(installDir) : [];
  if (left.length) throw new Error('The uninstaller left: ' + left.join(', '));
  if (existsSync(shortcut)) throw new Error('The uninstaller left the Start menu shortcut.');
  results.steps.uninstallSeconds = (Date.now() - step) / 1000;
  log('Uninstalled: nothing left behind');
  mkdirSync(join(root, 'bench/results'), { recursive: true });
  writeFileSync(join(root, 'bench/results/installer-test.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  server?.close();
  if (policySet) reg(['delete', policyKey, '/v', policyName, '/f', '/reg:64']);
  if (existsSync(installDir)) {
    stopApp();
    if (uninstallEntry() && existsSync(join(installDir, 'uninstall.exe'))) {
      spawnSync(`"${join(installDir, 'uninstall.exe')}" /S`, { shell: true, windowsHide: true });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}

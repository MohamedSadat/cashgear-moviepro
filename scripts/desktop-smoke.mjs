// Launches the release desktop build, attaches Playwright to its WebView2 over
// CDP and checks the same things the browser specs check: the pattern on both
// GPU backends, cross-origin isolation, shared memory and the native command.
// Then media (native streaming, ffprobe, a ProRes proxy), projects (a saved
// .cgvproj that reopens, and an autosave that recovers after the app is killed),
// playback, exports (MP4 written natively, GIF and MP3 converted by FFmpeg),
// sound, installed fonts, and a template filled from the project's media.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
// Autosaves and the saved project stay out of the real app data folder.
const dataPrefix = join(tmpdir(), 'cgv-data-smoke-');
const dataDir = await mkdtemp(dataPrefix);
const projectPath = join(dataDir, 'Smoke test.cgvproj');
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

/** What the app's CSP refused, from the console of every launch. The smoke fails on any. */
const policyViolations = [];

/** Starts the desktop app and attaches to its WebView2. Launches share the profile and data folder. */
async function launch() {
  const child = spawn(join(root, 'target/release/cgv-desktop.exe'), [], {
    cwd: root,
    windowsHide: true,
    env: {
      ...process.env,
      CGV_FFMPEG_DIR: process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin'),
      CGV_DATA_DIR: dataDir,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
    },
    stdio: 'inherit',
  });
  let launchError;
  child.on('error', (error) => {
    launchError = error;
  });
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
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  // Page errors show in the smoke's output, so a failure says what went wrong inside.
  page.on('pageerror', (error) => console.error('Page error: ' + error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url, lineNumber } = message.location();
    console.error('Console error: ' + message.text() + (url ? ` (${url}:${lineNumber})` : ''));
    if (message.text().includes('Content Security Policy')) policyViolations.push(message.text());
  });
  return { child, browser, page };
}

/** Kills the app the hard way (TerminateProcess): no unload handlers, no clean exit. */
async function kill(app) {
  const exited = new Promise((resolve) => app.child.once('exit', resolve));
  app.child.kill();
  await exited;
  await app.browser.close().catch(() => {});
  // WebView2's browser processes follow the host down; wait until they let go of the profile.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      await fetch('http://127.0.0.1:' + port + '/json/version', {
        signal: AbortSignal.timeout(500),
      });
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The engine is up and the project (with its media) has opened. Says what it saw if not. */
const waitForProject = (page) =>
  page
    .waitForFunction(
      () =>
        !!window.__cgv?.client &&
        !['Opening…', undefined].includes(
          document.querySelector('[data-testid="project-name"]')?.textContent ?? undefined,
        ) &&
        document.querySelector('[data-testid="project-bar"]')?.dataset.busy === 'false',
      undefined,
      { timeout: 60000 },
    )
    .catch(async (error) => {
      const seen = await page
        .evaluate(() => ({
          name: document.querySelector('[data-testid="project-name"]')?.textContent,
          busy: document.querySelector('[data-testid="project-bar"]')?.dataset.busy,
          notices: [...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent),
          dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => d.dataset.testid),
          url: location.href,
        }))
        .catch(() => 'page unavailable');
      await mkdir(join(root, 'bench/results'), { recursive: true });
      await page
        .screenshot({ path: join(root, 'bench/results/desktop-failure.png') })
        .catch(() => {});
      throw new Error('The project did not open: ' + JSON.stringify(seen), { cause: error });
    });

let app;
try {
  app = await launch();
  let page = app.page;
  await expect(page.getByTestId('engine-status')).toHaveText('Engine ready', { timeout: 30000 });
  const origin = new URL(page.url()).origin;
  const results = [];
  for (const backend of ['WebGPU', 'WebGL2']) {
    await page.goto(origin + (backend === 'WebGL2' ? '/?pattern=1&gpu=webgl2' : '/?pattern=1'));
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
      browser: app.browser.version(),
      origin,
      software,
    });
  }
  // Media: native registration, cgv-media streaming, ffprobe and a ProRes proxy.
  await page.goto(origin + '/?diagnostic=1');
  await expect(page.getByTestId('engine-status')).toHaveText('Engine ready', { timeout: 30000 });
  await waitForProject(page);
  const mediaNames = ['h264-1080p30-aac.mp4', 'prores-720p2997-pcm.mov'];
  const paths = mediaNames.map((file) => join(root, 'tests/media', file));
  const media = await page.evaluate(async (paths) => {
    const hooks = window.__cgv;
    const api = hooks.client.api;
    await hooks.project.importRequests(await hooks.platform.registerPaths(paths));
    const deadline = Date.now() + 180000;
    let items = await api.mediaSnapshot();
    while (
      Date.now() < deadline &&
      !items.every((item) =>
        ['ready', 'proxyReady', 'proxyFailed', 'unsupported'].includes(item.status.state),
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      items = await api.mediaSnapshot();
    }
    const reads = {};
    for (const item of items) {
      reads[item.name] = [];
      for (const frame of [0, 1, 45, 89])
        reads[item.name].push([frame, (await api.readFrame(item.id, frame)).barcode]);
    }
    return {
      items: items.map((item) => ({
        name: item.name,
        status: item.status,
        codec: item.video?.codecLabel,
      })),
      reads,
      notices: hooks.library.notices,
    };
  }, paths);
  console.log(JSON.stringify(media, null, 2));
  const status = Object.fromEntries(media.items.map((item) => [item.name, item.status.state]));
  if (status['h264-1080p30-aac.mp4'] !== 'ready')
    throw new Error('H.264 should play directly on desktop: ' + JSON.stringify(media.items));
  if (status['prores-720p2997-pcm.mov'] !== 'proxyReady')
    throw new Error('ProRes should play through its proxy: ' + JSON.stringify(media.items));
  for (const [name, reads] of Object.entries(media.reads))
    for (const [frame, barcode] of reads)
      if (frame !== barcode) throw new Error(`${name}: frame ${frame} decoded as ${barcode}`);
  results.push({ media });

  // Filmstrips: the timeline fetches each thumbnail's object URL and decodes it,
  // which the CSP must allow.
  const filmstrip = await page.evaluate(async () => {
    const id = (await window.__cgv.client.api.mediaSnapshot()).find(
      (item) => item.name === 'h264-1080p30-aac.mp4',
    ).id;
    const deadline = Date.now() + 60000;
    let urls = [];
    while (!urls.length && Date.now() < deadline) {
      urls = window.__cgv.library.visuals[id]?.thumbnails ?? [];
      if (!urls.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const sizes = new Set();
    for (const url of urls) {
      try {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        sizes.add(bitmap.width + 'x' + bitmap.height);
        bitmap.close();
      } catch (error) {
        throw new Error(`Filmstrip image ${url} could not be read: ${error.message}`, {
          cause: error,
        });
      }
    }
    return { thumbnails: urls.length, sizes: [...sizes] };
  });
  if (!filmstrip.thumbnails) throw new Error('The H.264 clip has no filmstrip');
  results.push({ filmstrip });

  // Projects: save to a real .cgvproj file and reopen it from the recent list.
  const saved = await page.evaluate(async (path) => {
    const hooks = window.__cgv;
    if (!(await hooks.project.saveTo(path))) throw new Error('Saving the project failed');
    return (await hooks.client.api.projectSnapshot()).project;
  }, projectPath);
  const file = JSON.parse(await readFile(projectPath, 'utf8'));
  if (file.format !== 'cashgear-video-project' || file.version !== 6)
    throw new Error('Unexpected project file: ' + JSON.stringify(file).slice(0, 200));
  // The file leaves out an empty LUT list; the snapshot lists LUTs without their data.
  expect({ ...file.project, luts: file.project.luts ?? [] }).toEqual(saved);
  if (saved.media.length !== 2 || !saved.media.every((m) => m.location.kind === 'path'))
    throw new Error('Desktop projects should record both files by path');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await page.goto(origin + '/?diagnostic=1&autosave=500');
  await waitForProject(page);
  const reopened = await page.evaluate(() => window.__cgv.client.api.projectSnapshot());
  expect(reopened.project).toEqual(saved);
  expect(reopened.dirty).toBe(false);
  await expect(page.locator('[data-testid="media-item"][data-status="ready"]')).toHaveCount(1, {
    timeout: 60000,
  });
  // The proxy made in the first pass is reused, not made again.
  await expect(page.locator('[data-testid="media-item"][data-status="proxyReady"]')).toHaveCount(
    1,
    { timeout: 60000 },
  );

  // Edit, let the autosave run, then kill the app in the middle of a drag.
  for (const name of mediaNames)
    await page.getByRole('button', { name: `Add ${name} to the timeline` }).click();
  await expect(page.getByTestId('clip')).toHaveCount(2);
  await page.evaluate(async () => {
    const hooks = window.__cgv;
    const state = await hooks.client.api.projectSnapshot();
    const first = state.project.tracks[0].clips[0];
    await hooks.project.execute({ type: 'split', at: 705600000, clips: [first.id] });
    await hooks.client.api.projectBeginGroup('Drag');
    await hooks.project.execute({ type: 'move', clips: [first.id], delta: 0, tracks: 1 });
  });
  await expect(page.getByTestId('save-state')).toHaveText('Unsaved changes (autosaved)', {
    timeout: 30000,
  });
  const autosaved = await page.evaluate(() => window.__cgv.client.api.projectSnapshot());
  await kill(app);

  // Relaunch: the recovery prompt brings back the autosaved project.
  app = await launch();
  page = app.page;
  await expect(page.getByTestId('engine-status')).toHaveText('Engine ready', { timeout: 30000 });
  await page.goto(origin + '/?diagnostic=1');
  const recovery = page.getByTestId('recovery-dialog');
  await expect(recovery).toBeVisible({ timeout: 60000 });
  await expect(recovery).toContainText(saved.name);
  await recovery.getByRole('button', { name: 'Recover' }).click();
  await waitForProject(page);
  const recovered = await page.evaluate(() => window.__cgv.client.api.projectSnapshot());
  expect(recovered.project).toEqual(autosaved.project);
  expect(recovered.dirty).toBe(true);
  await expect(page.getByTestId('clip')).toHaveCount(3);
  results.push({
    project: {
      file: projectPath,
      savedMedia: saved.media.map((m) => m.name),
      recoveredClips: recovered.project.tracks.flatMap((t) => t.clips).length,
      recoveredEqualsAutosave: true,
    },
  });

  // Playback: the recovered timeline (H.264 and the ProRes proxy) plays in WebView2.
  const transport = page.getByTestId('transport');
  await page.getByTestId('play-toggle').click();
  await expect(transport).toHaveAttribute('data-playing', 'true');
  await expect(transport).toHaveAttribute('data-starting', 'false', { timeout: 15000 });
  await page.waitForTimeout(3000);
  const playback = await page.evaluate(async () => {
    const api = window.__cgv.client.api;
    return { state: await api.playbackState(), stats: await api.playbackStats() };
  });
  await page.getByTestId('play-toggle').click();
  await expect(transport).toHaveAttribute('data-playing', 'false');
  // About 3 s played. Software rendering draws few frames (Auto drops to 1/4), so
  // there it only has to keep time; on hardware nearly every frame must show.
  const shownEnough = playback.stats.presented >= (software ? 5 : 80);
  if (!shownEnough || playback.state.frame < 60)
    throw new Error('Playback did not run: ' + JSON.stringify(playback));
  results.push({
    playback: {
      presented: playback.stats.presented,
      dropped: playback.stats.dropped,
      clock: playback.stats.clock,
      fallback: playback.stats.fallback,
      offsetMaxMs: playback.stats.offset.maxAbsMs,
      level: playback.stats.level,
      reachedFrame: playback.state.frame,
    },
  });

  // Export: the recovered timeline (the ProRes clip through its proxy) muxed in
  // WebView2 and written by the native side, then GIF and MP3 made by FFmpeg.
  const ffprobe = join(
    process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin'),
    'ffprobe.exe',
  );
  const exportDir = join(dataDir, 'exports');
  await mkdir(exportDir, { recursive: true });
  const exports = [
    {
      format: 'mp4',
      width: 1280,
      height: 720,
      frameRate: { num: 30, den: 1 },
      video: { codec: 'avc', bitrate: 4e6 },
      audio: { codec: 'aac', bitrate: 192000 },
    },
    {
      format: 'gif',
      width: 320,
      height: 180,
      frameRate: { num: 10, den: 1 },
      video: { codec: 'avc', bitrate: 2e6 },
      audio: null,
    },
    {
      format: 'mp3',
      width: 1280,
      height: 720,
      frameRate: { num: 30, den: 1 },
      video: null,
      audio: { codec: 'pcm-s16', bitrate: 192000 },
    },
  ];
  const exported = {};
  for (const settings of exports) {
    const path = join(exportDir, 'Smoke export.' + settings.format);
    const status = await page.evaluate(
      async ({ settings, path }) => {
        const exporter = window.__cgv.exporter;
        if (!(await exporter.start(settings, { path })))
          throw new Error('The export did not start');
        const status = await exporter.settled();
        exporter.dismiss();
        return status;
      },
      { settings, path },
    );
    if (status.state !== 'done')
      throw new Error(`${settings.format} export failed: ` + JSON.stringify(status));
    const probed = JSON.parse(
      spawnSync(
        ffprobe,
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,width,height,nb_frames:format=duration',
          '-of',
          'json',
          path,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).stdout,
    );
    const codecs = probed.streams.map((stream) => stream.codec_name);
    const expected = { mp4: ['h264', 'aac'], gif: ['gif'], mp3: ['mp3'] }[settings.format];
    if (JSON.stringify(codecs) !== JSON.stringify(expected))
      throw new Error(
        `${settings.format} export has ${codecs.join(', ')}: ` + JSON.stringify(probed),
      );
    if (Math.abs(Number(probed.format.duration) - status.result.durationSeconds) > 0.15)
      throw new Error(`${settings.format} export lasts ${probed.format.duration} s`);
    exported[settings.format] = {
      location: status.location,
      bytes: status.result.bytes,
      elapsedMs: Math.round(status.result.elapsedMs),
      durationSeconds: status.result.durationSeconds,
      streams: probed.streams,
    };
  }
  results.push({ exported });

  // Sound: a voiceover take is kept beside the project by the native side, and a
  // sound from the app's pack plays (and meters) in WebView2.
  const voiceover = await page.evaluate(async (projectPath) => {
    const hooks = window.__cgv;
    // Half a second of 440 Hz, as a 16-bit mono WAV.
    const frames = 24_000;
    const view = new DataView(new ArrayBuffer(44 + frames * 2));
    const text = (at, value) =>
      [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, 36 + frames * 2, true);
    text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 48_000, true);
    view.setUint32(28, 96_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, frames * 2, true);
    for (let i = 0; i < frames; i++)
      view.setInt16(
        44 + i * 2,
        Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48_000)),
        true,
      );
    const request = await hooks.platform.saveRecording(
      'Voiceover 1.wav',
      new Uint8Array(view.buffer),
      projectPath,
    );
    const [media] = await hooks.library.importRequests([request]);
    return { path: media.location.path, duration: media.duration / 705_600_000 };
  }, projectPath);
  const expectedTake = join(dirname(projectPath), 'Voiceovers', 'Voiceover 1.wav');
  if (voiceover.path !== expectedTake || !existsSync(expectedTake))
    throw new Error('The voiceover was not kept beside the project: ' + JSON.stringify(voiceover));
  if (Math.abs(voiceover.duration - 0.5) > 0.01)
    throw new Error('The voiceover file lasts ' + voiceover.duration + ' s');
  await page.getByTestId('library-tab-sounds').click();
  await page.locator('[data-testid="sound-item"][data-key="whoosh"]').dblclick();
  const pack = await page.evaluate(async () => {
    const hooks = window.__cgv;
    const deadline = performance.now() + 30_000;
    let clip = null;
    while (!clip && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      clip = (await hooks.client.api.projectSnapshot()).project.tracks
        .flatMap((track) => track.clips)
        .find((c) => c.media === 'sound-whoosh');
    }
    if (!clip) {
      const { project } = await hooks.client.api.projectSnapshot();
      throw new Error(
        'The whoosh did not reach the timeline: ' +
          JSON.stringify({
            items: document.querySelectorAll('[data-testid="sound-item"]').length,
            media: project.media.map((m) => [m.id, m.location.kind]),
            library: hooks.library.notices,
            alerts: [...document.querySelectorAll('[role="alert"]')].map((n) => n.textContent),
          }),
      );
    }
    await hooks.client.api.seek(clip.start + 1);
    hooks.meters.take();
    await hooks.client.play();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await hooks.client.togglePlay();
    const readings = hooks.meters.take();
    // Its own track's meter: the master also carries the clips placed earlier.
    const track = (await hooks.client.api.projectSnapshot()).project.tracks.find((t) =>
      t.clips.some((c) => c.id === clip.id),
    ).id;
    const peak = Math.max(
      0,
      ...readings.flatMap((r) =>
        r.tracks.filter((t) => t.id === track).map((t) => t.level.peak[0]),
      ),
    );
    return { peak, peakDb: 20 * Math.log10(peak), readings: readings.length };
  });
  if (pack.peak < 0.01) throw new Error('The pack sound did not play: ' + JSON.stringify(pack));
  results.push({ sound: { voiceover, pack } });

  // Titles: an installed font (Arial, on every Windows) reaches the engine through
  // the media protocol and draws differently from the fallback a missing family gets.
  const installedFonts = await page.evaluate(async () => {
    const hooks = window.__cgv;
    const started = performance.now();
    const installed = await hooks.platform.installedFonts();
    const listMs = performance.now() - started;
    if (!installed.some((entry) => entry.family === 'Arial'))
      throw new Error('Arial is not among the installed fonts');
    const tracks = (await hooks.client.api.projectSnapshot()).project.tracks;
    const title = (family) => ({
      elements: [
        {
          id: 1,
          x: 0,
          y: 0,
          fill: { r: 1, g: 1, b: 1 },
          type: 'text',
          text: 'Installed fonts',
          font: { family },
          size: 120,
        },
      ],
    });
    const outcome = await hooks.project.execute({
      type: 'append',
      track: tracks[tracks.length - 1].id,
      clip: { kind: 'title', duration: 705_600_000, title: title('Arial') },
    });
    const clip = outcome.created[0];
    const start = (await hooks.client.api.projectSnapshot()).project.tracks
      .flatMap((track) => track.clips)
      .find((c) => c.id === clip).start;
    const draw = async (family) => {
      await hooks.project.execute({ type: 'setTitle', clip, title: title(family) });
      return (await hooks.client.api.renderPixels(start + 352_800_000)).data;
    };
    const missing = await draw('No Such Family');
    let differing = 0;
    // The page passes installed families to the engine's worker as it starts.
    for (let attempt = 0; attempt < 20 && !differing; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
      const arial = await draw('Arial');
      differing = 0;
      for (let i = 0; i < arial.length; i += 4)
        if (Math.abs(arial[i] - missing[i]) > 16) differing++;
    }
    await hooks.project.execute({ type: 'delete', clips: [clip] });
    return { families: installed.length, listMs: Math.round(listMs), differing };
  });
  if (installedFonts.differing < 500)
    throw new Error('Arial drew like the fallback: ' + JSON.stringify(installedFonts));
  results.push({ installedFonts });

  // Templates: an intro goes in at the playhead with its pack sounds (through the
  // desktop's asset server), and its slot fills from the project's video.
  await page.getByTestId('library-tab-templates').click();
  await page
    .locator('[data-testid="template-item"][data-key="bold-intro"]')
    .getByTestId('template-use')
    .click();
  // The Templates panel lists the slot once the intro has landed.
  await page
    .locator('[data-testid="template-slot"][data-filled="false"]')
    .first()
    .waitFor({ timeout: 30_000 });
  const template = await page.evaluate(async () => {
    const hooks = window.__cgv;
    const project = async () => (await hooks.client.api.projectSnapshot()).project;
    const slot = (await project()).tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.slot !== undefined && !clip.media);
    if (!slot) throw new Error('The intro did not reach the timeline');
    const { media } = await project();
    const video = media.find((item) => item.name.endsWith('.mp4'));
    await hooks.editor.fillSlots([video.id]);
    const filled = (await project()).tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === slot.id);
    if (filled?.media !== video.id) throw new Error('The intro’s slot did not fill');
    const pixels = (await hooks.client.api.renderPixels(filled.start + 352_800_000)).data;
    let lit = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 60) lit++;
    return {
      slot: filled.slot,
      sounds: media.filter((item) => item.id.startsWith('sound-')).map((item) => item.id),
      lit: Number((lit / (pixels.length / 4)).toFixed(3)),
    };
  });
  if (!['sound-riser', 'sound-impact'].every((id) => template.sounds.includes(id)))
    throw new Error('The intro’s sounds did not come in: ' + JSON.stringify(template));
  if (template.lit < 0.2)
    throw new Error('The filled slot drew nothing: ' + JSON.stringify(template));
  results.push({ template });

  await page.screenshot({ path: join(root, 'bench/results/desktop.png') });
  await writeFile(
    join(root, 'bench/results/desktop-smoke.json'),
    JSON.stringify(results, null, 2) + '\n',
  );
  console.log(JSON.stringify(results, null, 2));
  if (policyViolations.length)
    throw new Error('The CSP refused: ' + [...new Set(policyViolations)].join(' | '));
} finally {
  await app?.browser.close().catch((error) => {
    console.error('Could not close the desktop browser: ' + error.message);
    process.exitCode = 1;
  });
  app?.child.kill();
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
  for (const [folder, prefix] of [
    [profile, profilePrefix],
    [dataDir, dataPrefix],
  ]) {
    if (!folder.startsWith(prefix)) continue;
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(
      (error) => console.warn('Temporary folder cleanup: ' + error.message),
    );
  }
}

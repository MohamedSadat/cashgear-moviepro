import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { render } from './golden-tools';
import {
  backgroundPng,
  encode,
  frames,
  height,
  renderScenario,
  scenarios,
  scoreKey,
  shown,
  width,
  type KeyScore,
  type Truth,
} from './greenscreen';

// The chroma key on a synthetic green-screen set with ground truth (greenscreen.ts):
// an even screen, an unevenly lit one, motion blur, green spill and sensor noise,
// each encoded as H.264 4:2:0. The key colour is picked with the eyedropper and
// every other setting is the default, as a user would start. The matte and the
// composite over a purple background are scored against the truth.
const root = process.cwd();
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin');
const ffmpeg = join(ffmpegDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const FRAME = 23_520_000;

test.skip(
  !existsSync(ffmpeg) && process.env.CGV_REQUIRE_FFMPEG !== '1',
  'FFmpeg is missing: run pnpm setup:ffmpeg',
);

/**
 * What a clean key may miss by. Measured on WebGPU and WebGL2: a mean matte error
 * of at most 0.0104 (0.14 at edges, where 4:2:0 chroma and the one-pixel hair
 * strands are lost), no screen left, no holes, edges within 11.3 levels and green
 * on the subject under 0.11 levels on average. Without spill suppression the
 * spill scenario keeps 4 levels of green.
 */
const limits: KeyScore = {
  matteMean: 0.015,
  matteEdge: 0.2,
  screenLeaks: 0.001,
  holes: 0.002,
  screenError: 1,
  subjectError: 4,
  edgeError: 14,
  spillMean: 0.25,
  spillShare: 0.001,
};
/**
 * Bounced light that leaves a colour no greener than its red and blue (skin,
 * lightened) cannot be told from the subject's own: only its green goes.
 */
const allowances: Record<string, Partial<KeyScore>> = { spill: { subjectError: 16 } };

type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
  project: { execute(command: unknown): Promise<{ created: number[] } | null> };
};

async function run(page: Page, command: unknown): Promise<number[]> {
  const outcome = await page.evaluate(
    (command) => (Reflect.get(window, '__cgv') as Hooks).project.execute(command),
    command,
  );
  expect(outcome, JSON.stringify(command)).not.toBeNull();
  return outcome!.created;
}

async function snapshot(page: Page) {
  return (await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).client.api.projectSnapshot(),
  )) as {
    project: {
      tracks: { id: number; clips: { id: number }[] }[];
      media: { id: string; name: string }[];
    };
  };
}

let made: { files: string[]; truths: Map<string, Truth> } | null = null;

/** The test set's clips and background, made once per run. */
function testSet(dir: string) {
  if (made) return made;
  mkdirSync(dir, { recursive: true });
  const files = [join(dir, 'background.png')];
  writeFileSync(files[0], backgroundPng());
  const truths = new Map<string, Truth>();
  for (const scenario of scenarios) {
    const { video, truth } = renderScenario(scenario);
    const file = join(dir, `greenscreen-${scenario.name}.mp4`);
    encode(ffmpeg, video, scenario.bitrate, file);
    files.push(file);
    truths.set(scenario.name, truth);
  }
  made = { files, truths };
  return made;
}

const png = (pixels: { width: number; height: number; data: Uint8Array }) => {
  const out = new PNG({ width: pixels.width, height: pixels.height });
  Buffer.from(pixels.data).copy(out.data);
  return PNG.sync.write(out);
};

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} chroma key removes a green screen cleanly, without spill`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(300000);
    const { files, truths } = testSet(join(testInfo.project.outputDir, 'greenscreen'));
    await page.goto('/?diagnostic=1' + (backend === 'WebGL2' ? '&gpu=webgl2' : ''));
    await page.waitForFunction(
      () =>
        !!Reflect.get(window, '__cgv')?.client &&
        document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy ===
          'false',
    );
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
    await page.getByTestId('media-file-input').setInputFiles(files);
    for (const file of files) {
      const name = file.slice(file.lastIndexOf(file.includes('\\') ? '\\' : '/') + 1);
      await expect(page.locator(`[data-testid="media-item"][data-name="${name}"]`)).toHaveAttribute(
        'data-status',
        'ready',
        { timeout: 60000 },
      );
    }
    const ids = new Map((await snapshot(page)).project.media.map((m) => [m.name, m.id]));
    await run(page, {
      type: 'setSettings',
      settings: {
        width,
        height,
        frameRate: { num: 30, den: 1 },
        sampleRate: 48000,
        channels: 2,
      },
    });
    const outDir = testInfo.outputPath('renders');
    mkdirSync(outDir, { recursive: true });

    const scores: Record<string, KeyScore> = {};
    const build = async (name: string, params: Record<string, unknown> = {}) => {
      const tracks = (await snapshot(page)).project.tracks;
      const clips = tracks.flatMap((track) => track.clips.map((clip) => clip.id));
      if (clips.length) await run(page, { type: 'delete', clips });
      const [main, top] = tracks.map((track) => track.id);
      await run(page, {
        type: 'append',
        track: main,
        clip: { media: ids.get('background.png'), duration: frames * FRAME },
      });
      const [clip] = await run(page, {
        type: 'overwrite',
        track: top,
        at: 0,
        clip: { media: ids.get(`greenscreen-${name}.mp4`), duration: frames * FRAME, audio: false },
      });
      // The eyedropper, on the screen beside the subject.
      const color = await page.evaluate(
        ([time, clip]) =>
          (Reflect.get(window, '__cgv') as Hooks).client.api.pickColor(time, 0.12, 0.5, clip),
        [shown * FRAME, clip],
      );
      expect(color).not.toBeNull();
      const [effect] = await run(page, {
        type: 'addEffect',
        clip,
        effect: { kind: 'chroma-key', params: { color, ...params } },
      });
      const result = await render(page, shown * FRAME);
      await run(page, { type: 'setEffectParams', clip, effect, params: { view: 'matte' } });
      const matte = await render(page, shown * FRAME);
      return { result, matte, color };
    };

    for (const scenario of scenarios) {
      const { result, matte, color } = await build(scenario.name);
      writeFileSync(join(outDir, `${scenario.name}-result.png`), png(result));
      writeFileSync(join(outDir, `${scenario.name}-matte.png`), png(matte));
      scores[scenario.name] = scoreKey(truths.get(scenario.name)!, result, matte);
      testInfo.annotations.push({ type: scenario.name, description: JSON.stringify(color) });
    }
    // Without spill suppression the spill scenario keeps its green: the test can see it.
    const unsuppressed = await build('spill', { spill: 0 });
    const control = scoreKey(truths.get('spill')!, unsuppressed.result, unsuppressed.matte);

    const report = { backend, project: testInfo.project.name, limits, allowances, scores, control };
    await testInfo.attach('keying', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    writeFileSync(testInfo.outputPath('keying.json'), JSON.stringify(report, null, 2));
    for (const [name, score] of Object.entries(scores))
      for (const [metric, limit] of Object.entries({ ...limits, ...allowances[name] }))
        expect(score[metric as keyof KeyScore], `${name} ${metric}`).toBeLessThanOrEqual(limit);
    expect(control.spillMean).toBeGreaterThan(limits.spillMean * 4);
  });
}

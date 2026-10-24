import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { PNG } from 'pngjs';

// Phase 5: exports. Fixture projects are exported, decoded with the pinned LGPL
// FFmpeg and compared with the preview's renderFrame(t); flash frames and clicks
// measure A/V sync; the dialog, cancel, background editing and playback in the
// browser are checked; a one-minute 1080p30 project is timed. CI's software GPU
// and encoders check function only, never speed.
const root = process.cwd();
const mediaDir = join(root, 'tests/media');
const resultsDir = join(root, 'bench/results');
const FRAME = 23_520_000; // one frame at 30 fps
const software = process.env.GPU_TEST_SOFTWARE === '1';
const ffmpegDir = process.env.CGV_FFMPEG_DIR ?? join(root, '.tools/ffmpeg/bin');
const exe = (name: string) => join(ffmpegDir, process.platform === 'win32' ? name + '.exe' : name);
const ffmpeg = exe('ffmpeg');
const ffprobe = exe('ffprobe');
const hasFfmpeg = existsSync(ffmpeg) && existsSync(ffprobe);
/** Seconds in the speed test's project (60 on the reference machine). */
const speedSeconds = Number(process.env.CGV_EXPORT_SECONDS ?? (software ? 4 : 60));
/**
 * PSNR every compared frame must beat, in dB (the exit criterion), measured on
 * the Y'CbCr 4:2:0 planes as codecs report it (see `yuvPsnr`).
 */
const minPsnr = 40;
/** Largest A/V offset allowed: under one frame at 30 fps. */
const maxOffsetMs = 1000 / 30;

interface Layer {
  /** Media, or none for an adjustment layer. */
  media?: string;
  kind?: 'adjustment';
  length: number;
  /** The track it goes on (0 is the bottom); its own index by default. */
  track?: number;
  transform?: Partial<Record<string, number>>;
  crop?: Partial<Record<string, number>>;
  opacity?: number;
  effects?: { kind: string; params?: Record<string, unknown> }[];
  /** Keys by property as [frame, value, easing]; `$n` names effect n of the layer. */
  keyframes?: Record<string, [number, number, string?][]>;
}
interface Fixture {
  name: string;
  size: [number, number];
  frames: number[];
  export: { format: string; video: string; bitrate: number; audio: string };
  layers: Layer[];
  /** Between layers `from` and `to` (indices) on a track, `frames` long. */
  transitions?: { track: number; from?: number; to?: number; kind: string; frames: number }[];
}
const { fixtures, media: fixtureMedia } = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/export.json'), 'utf8'),
) as { fixtures: Fixture[]; media: string[] };

interface Settings {
  format: string;
  width: number;
  height: number;
  frameRate: { num: number; den: number };
  video: { codec: string; bitrate: number } | null;
  audio: { codec: string; bitrate: number } | null;
}
interface ExportResult {
  bytes: number;
  frames: number;
  durationSeconds: number;
  elapsedMs: number;
  videoCodec: string | null;
  audioCodec: string | null;
  hardwareEncoder: boolean | null;
  backend: string;
}
type Status =
  | { state: 'done'; name: string; location: string; result: ExportResult }
  | { state: 'failed' | 'cancelled' | 'idle' | 'running'; message?: string };
type Hooks = {
  client: { api: Record<string, (...args: unknown[]) => Promise<unknown>> };
  project: { execute(command: unknown): Promise<{ created: number[] } | null> };
  exporter: {
    start(settings: Settings, options?: { download?: boolean }): Promise<boolean>;
    settled(): Promise<Status>;
    dismiss(): void;
  };
};

test.skip(
  !hasFfmpeg && process.env.CGV_REQUIRE_FFMPEG !== '1',
  'FFmpeg is missing: run pnpm setup:ffmpeg',
);

function run(tool: string, args: string[], binary = false) {
  const result = spawnSync(tool, args, {
    maxBuffer: 1 << 30,
    encoding: binary ? 'buffer' : 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`${tool} ${args.join(' ')} failed: ${String(result.stderr).slice(0, 2000)}`);
  return result.stdout as unknown as string & Buffer;
}

function probe(file: string) {
  return JSON.parse(
    run(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,profile,width,height,r_frame_rate,nb_frames,start_time,' +
        'duration,color_space,color_range,color_primaries,color_transfer,sample_rate,channels:' +
        'format=format_name,duration,size',
      '-of',
      'json',
      file,
    ]),
  ) as {
    streams: Record<string, string | number | undefined>[];
    format: { format_name: string; duration: string; size: string };
  };
}

const rgbScale =
  'scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24';
const yuvScale =
  'scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,format=yuv420p';

/** Frame `index` of `file` as RGB bytes, converted with the BT.709 limited-range matrix. */
function decodeFrame(file: string, index: number): Buffer {
  const pick = `trim=start_frame=${index}:end_frame=${index + 1},`;
  return run(
    ffmpeg,
    ['-v', 'error', '-i', file, '-vf', pick + rgbScale, '-frames:v', '1', '-f', 'rawvideo', '-'],
    true,
  );
}

/** PSNR over R, G and B of an RGBA preview against RGB bytes, and the worst difference. */
function rgbPsnr(preview: Buffer, decoded: Buffer) {
  expect(decoded.length / 3).toBe(preview.length / 4);
  let squared = 0;
  let worst = 0;
  for (let i = 0, j = 0; j < decoded.length; i += 4, j += 3)
    for (let c = 0; c < 3; c++) {
      const difference = preview[i + c] - decoded[j + c];
      squared += difference * difference;
      worst = Math.max(worst, Math.abs(difference));
    }
  const mse = squared / decoded.length;
  return { psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse), worst };
}

function writePng(rgba: Buffer, width: number, height: number, file: string) {
  const image = new PNG({ width, height });
  rgba.copy(image.data);
  writeFileSync(file, PNG.sync.write(image));
}

/**
 * Frame `index` of `file` against the preview frame in `png`, as codecs measure
 * quality: FFmpeg converts the preview to the export's own format (BT.709
 * limited-range Y'CbCr 4:2:0) and its psnr filter compares the planes.
 */
function yuvPsnr(file: string, index: number, png: string) {
  const graph =
    `[0:v]trim=start_frame=${index}:end_frame=${index + 1},setpts=PTS-STARTPTS[export];` +
    `[1:v]${yuvScale}[preview];[export][preview]psnr`;
  const result = spawnSync(
    ffmpeg,
    ['-hide_banner', '-i', file, '-i', png, '-lavfi', graph, '-f', 'null', '-'],
    {
      encoding: 'utf8',
    },
  );
  const found = /PSNR y:(\S+) u:(\S+) v:(\S+) average:(\S+)/.exec(result.stderr);
  if (!found) throw new Error('No PSNR from FFmpeg: ' + result.stderr.slice(-1500));
  const value = (text: string) => (text === 'inf' ? 99 : Number(text));
  return { y: value(found[1]), u: value(found[2]), v: value(found[3]), average: value(found[4]) };
}

/**
 * The RGB PSNR a perfect 4:2:0 copy of the preview would have. Sharp edges
 * between saturated colours cannot survive 4:2:0 chroma in any file, so this is
 * as high as an export's RGB PSNR can go.
 */
function ceiling(preview: Buffer, png: string) {
  const copy = run(
    ffmpeg,
    ['-v', 'error', '-i', png, '-vf', `${yuvScale},${rgbScale}`, '-f', 'rawvideo', '-'],
    true,
  );
  return rgbPsnr(preview, copy).psnr;
}

async function execute(page: Page, command: unknown): Promise<number[]> {
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
      media: { id: string; name: string }[];
      tracks: { id: number; clips: { id: number }[] }[];
    };
  };
}

async function open(page: Page, query = '') {
  await page.goto('/?diagnostic=1' + query);
  await page.waitForFunction(
    () =>
      !!Reflect.get(window, '__cgv')?.client &&
      document.querySelector<HTMLElement>('[data-testid="project-bar"]')?.dataset.busy === 'false',
  );
}

/** Imports files (paths) and returns media ids by file name. */
async function importFiles(page: Page, paths: string[]) {
  await page.getByTestId('media-file-input').setInputFiles(paths);
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop()!;
    await expect(page.locator(`[data-testid="media-item"][data-name="${name}"]`)).toHaveAttribute(
      'data-status',
      'ready',
      { timeout: 60000 },
    );
  }
  const { project } = await snapshot(page);
  return new Map(project.media.map((media) => [media.name, media.id]));
}

/**
 * Replaces the project's clips with `layers` (one track each unless they say),
 * at `size` and 30 fps, with their effects, keyframes and `transitions`.
 */
async function build(
  page: Page,
  size: [number, number],
  layers: Layer[],
  ids: Map<string, string>,
  transitions: Fixture['transitions'] = [],
) {
  const { project } = await snapshot(page);
  const clips = project.tracks.flatMap((track) => track.clips.map((clip) => clip.id));
  if (clips.length) await execute(page, { type: 'delete', clips });
  await execute(page, {
    type: 'setSettings',
    settings: {
      width: size[0],
      height: size[1],
      frameRate: { num: 30, den: 1 },
      sampleRate: 48000,
      channels: 2,
    },
  });
  let tracks = (await snapshot(page)).project.tracks;
  const needed = Math.max(...layers.map((layer, index) => (layer.track ?? index) + 1));
  while (tracks.length < needed) {
    await execute(page, { type: 'addTrack', index: tracks.length });
    tracks = (await snapshot(page)).project.tracks;
  }
  const placed: number[] = [];
  for (const [index, layer] of layers.entries()) {
    const [clip] = await execute(page, {
      type: 'append',
      track: tracks[layer.track ?? index].id,
      clip:
        layer.kind === 'adjustment'
          ? { kind: 'adjustment', duration: layer.length * FRAME }
          : { media: ids.get(layer.media!), duration: layer.length * FRAME },
    });
    placed.push(clip);
    const properties: Record<string, unknown> = {};
    if (layer.transform)
      properties.transform = {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        ...layer.transform,
      };
    if (layer.crop) properties.crop = { left: 0, top: 0, right: 0, bottom: 0, ...layer.crop };
    if (layer.opacity !== undefined) properties.opacity = layer.opacity;
    if (Object.keys(properties).length)
      await execute(page, { type: 'setClipProperties', clip, properties });
    const effects: number[] = [];
    for (const effect of layer.effects ?? [])
      effects.push((await execute(page, { type: 'addEffect', clip, effect }))[0]);
    for (const [name, keys] of Object.entries(layer.keyframes ?? {})) {
      const property = name.replace(/\$(\d+)/, (_, n: string) => String(effects[Number(n)]));
      for (const [frame, value, ease] of keys)
        await execute(page, {
          type: 'setKeyframe',
          clip,
          property,
          time: frame * FRAME,
          value,
          interpolation: ease ? { kind: ease } : undefined,
        });
    }
  }
  for (const transition of transitions)
    await execute(page, {
      type: 'addTransition',
      track: tracks[transition.track].id,
      from: transition.from !== undefined ? placed[transition.from] : null,
      to: transition.to !== undefined ? placed[transition.to] : null,
      transition: { kind: transition.kind, duration: transition.frames * FRAME },
    });
}

/** Exports with `settings` to a download and saves it as `name`. */
async function exportTo(page: Page, settings: Settings, file: string) {
  const download = page.waitForEvent('download', { timeout: 15 * 60_000 });
  const started = await page.evaluate(
    (settings) =>
      (Reflect.get(window, '__cgv') as Hooks).exporter.start(settings, { download: true }),
    settings,
  );
  expect(started).toBe(true);
  const status = await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).exporter.settled(),
  );
  expect(status, JSON.stringify(status)).toMatchObject({ state: 'done' });
  await (await download).saveAs(file);
  await page.evaluate(() => (Reflect.get(window, '__cgv') as Hooks).exporter.dismiss());
  return (status as Extract<Status, { state: 'done' }>).result;
}

/** The preview's frame at `index` (30 fps), as RGBA bytes. */
async function preview(page: Page, index: number) {
  const raw = await page.evaluate(async (time) => {
    const api = (Reflect.get(window, '__cgv') as Hooks).client.api;
    const pixels = (await api.renderPixels(time)) as {
      width: number;
      height: number;
      data: Uint8Array;
    };
    let text = '';
    for (let i = 0; i < pixels.data.length; i += 0x8000)
      text += String.fromCharCode(...pixels.data.subarray(i, i + 0x8000));
    return { width: pixels.width, height: pixels.height, data: btoa(text) };
  }, index * FRAME);
  return { width: raw.width, height: raw.height, data: Buffer.from(raw.data, 'base64') };
}

function record(name: string, testInfo: TestInfo, value: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const text = JSON.stringify(value, null, 2);
  writeFileSync(join(resultsDir, `${name}-${testInfo.project.name}.json`), text + '\n');
  return testInfo.attach(name, { body: text, contentType: 'application/json' });
}

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} exports match the preview above 40 dB`, async ({ page }, testInfo) => {
    test.setTimeout(software ? 20 * 60_000 : 6 * 60_000);
    await open(page, backend === 'WebGL2' ? '&gpu=webgl2' : '');
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
    const ids = await importFiles(
      page,
      fixtureMedia.map((name) => join(mediaDir, name)),
    );
    const report: Record<
      string,
      {
        result: ExportResult;
        frames: {
          index: number;
          yuv: ReturnType<typeof yuvPsnr>;
          rgb: ReturnType<typeof rgbPsnr>;
          rgbCeiling: number;
        }[];
      }
    > = {};
    for (const fixture of fixtures) {
      await build(page, fixture.size, fixture.layers, ids, fixture.transitions);
      const file = testInfo.outputPath(`${fixture.name}.${fixture.export.format}`);
      const settings: Settings = {
        format: fixture.export.format,
        width: fixture.size[0],
        height: fixture.size[1],
        frameRate: { num: 30, den: 1 },
        video: { codec: fixture.export.video, bitrate: fixture.export.bitrate },
        audio: { codec: fixture.export.audio, bitrate: 192_000 },
      };
      const result = await exportTo(page, settings, file);
      const info = probe(file);
      const video = info.streams.find((stream) => stream.codec_type === 'video')!;
      expect(video).toMatchObject({
        width: fixture.size[0],
        height: fixture.size[1],
        color_space: 'bt709',
        color_range: 'tv',
      });
      // Each track's clips run one after another.
      const ends = new Map<number, number>();
      fixture.layers.forEach((layer, index) => {
        const track = layer.track ?? index;
        ends.set(track, (ends.get(track) ?? 0) + layer.length);
      });
      expect(Number(video.nb_frames ?? result.frames)).toBe(Math.max(...ends.values()));
      const frames = [];
      for (const index of fixture.frames) {
        const reference = await preview(page, index);
        expect([reference.width, reference.height]).toEqual(fixture.size);
        const png = testInfo.outputPath(`${fixture.name}-${index}-preview.png`);
        writePng(reference.data, fixture.size[0], fixture.size[1], png);
        const decoded = decodeFrame(file, index);
        frames.push({
          index,
          yuv: yuvPsnr(file, index, png),
          rgb: rgbPsnr(reference.data, decoded),
          rgbCeiling: ceiling(reference.data, png),
        });
      }
      report[fixture.name] = { result, frames };
    }
    // The comparison has teeth: the next frame of the moving clip is not this one.
    const control = report['youtube-1080p'] && fixtures.find((f) => f.name === 'youtube-1080p')!;
    const neighbour = testInfo.outputPath('control-31-preview.png');
    if (control) {
      await build(page, control.size, control.layers, ids);
      const next = await preview(page, 31);
      writePng(next.data, control.size[0], control.size[1], neighbour);
    }
    const controlPsnr = control
      ? yuvPsnr(testInfo.outputPath('youtube-1080p.mp4'), 30, neighbour)
      : null;
    await record(`export-psnr-${backend.toLowerCase()}`, testInfo, {
      backend,
      minPsnr,
      report,
      control: controlPsnr,
    });
    for (const [name, { frames }] of Object.entries(report))
      for (const frame of frames) {
        const where = `${name} frame ${frame.index}`;
        expect(frame.yuv.average, where).toBeGreaterThan(minPsnr);
        expect(frame.yuv.y, where).toBeGreaterThan(minPsnr);
        // Colour and geometry: RGB is as close as a 4:2:0 file can be.
        expect(frame.rgb.psnr, where).toBeGreaterThan(frame.rgbCeiling - 6);
      }
    expect(controlPsnr?.average).toBeLessThan(minPsnr);
  });
}

test('exports keep picture and sound in sync in every format', async ({ page }, testInfo) => {
  test.setTimeout(software ? 15 * 60_000 : 5 * 60_000);
  // A black clip with white frames at 1, 2.5 and 4 s, and clicks at the same times.
  const flash = testInfo.outputPath('flash-30.mp4');
  const click = testInfo.outputPath('click-48k.wav');
  run(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=640x360:r=30:d=6',
    '-vf',
    "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,30)+eq(n,75)+eq(n,120)'," +
      'format=yuv420p',
    '-c:v',
    'libopenh264',
    '-g',
    '30',
    flash,
  ]);
  const clicks = '0.8*sin(2*PI*1000*t)*(between(t,1,1.01)+between(t,2.5,2.51)+between(t,4,4.01))';
  run(ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc='${clicks}|${clicks}':s=48000:d=6`,
    '-c:a',
    'pcm_s16le',
    click,
  ]);
  await open(page);
  const ids = await importFiles(page, [flash, click]);
  await build(
    page,
    [640, 360],
    [
      { media: 'flash-30.mp4', length: 180 },
      { media: 'click-48k.wav', length: 180 },
    ],
    ids,
  );
  const runs = [
    ['mp4', 'avc', 'aac'],
    ['webm', 'vp9', 'opus'],
    ['mov', 'avc', 'aac'],
    ['mkv', 'avc', 'opus'],
  ];
  const report = [];
  for (const [format, video, audio] of runs) {
    const file = testInfo.outputPath(`sync.${format}`);
    await exportTo(
      page,
      {
        format,
        width: 640,
        height: 360,
        frameRate: { num: 30, den: 1 },
        video: { codec: video, bitrate: 2e6 },
        audio: { codec: audio, bitrate: 192_000 },
      },
      file,
    );
    // Picture: the time of each bright frame.
    const times = run(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=best_effort_timestamp_time',
      '-of',
      'csv=p=0',
      file,
    ])
      .trim()
      .split(/\r?\n/)
      .map(Number);
    const gray = run(
      ffmpeg,
      ['-v', 'error', '-i', file, '-vf', 'scale=16:9,format=gray', '-f', 'rawvideo', '-'],
      true,
    );
    const flashes: number[] = [];
    for (let frame = 0; frame * 144 < gray.length; frame++) {
      let sum = 0;
      for (let i = 0; i < 144; i++) sum += gray[frame * 144 + i];
      if (sum / 144 > 128) flashes.push(times[frame]);
    }
    // Sound: where each click starts, after the stream's own start.
    const start = Number(
      run(ffprobe, [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=start_time',
        '-of',
        'csv=p=0',
        file,
      ]).trim(),
    );
    const pcm = run(
      ffmpeg,
      ['-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'],
      true,
    );
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
    const onsets: number[] = [];
    for (let i = 0, quiet = 0; i < samples.length; i++)
      if (i >= quiet && Math.abs(samples[i]) > 3000) {
        onsets.push(start + i / 48000);
        quiet = i + 24000;
      }
    const offsets = flashes.map((time, index) => (onsets[index] - time) * 1000);
    report.push({ format, video, audio, flashes, onsets, offsetsMs: offsets });
    expect(flashes, format).toHaveLength(3);
    expect(flashes[0], format).toBeCloseTo(1, 3);
    expect(onsets, format).toHaveLength(3);
    for (const offset of offsets) expect(Math.abs(offset), format).toBeLessThan(maxOffsetMs);
  }
  await record('export-sync', testInfo, report);
});

test('the export dialog saves through the save picker while editing goes on', async ({
  page,
}, testInfo) => {
  test.setTimeout(software ? 10 * 60_000 : 3 * 60_000);
  // The picker is a native dialog: hand out a file in OPFS instead, which the
  // export writes to like any picked file.
  await page.addInitScript(() => {
    Reflect.set(
      window,
      'showSaveFilePicker',
      async ({ suggestedName }: { suggestedName: string }) => {
        const root = await navigator.storage.getDirectory();
        return root.getFileHandle('picked-' + suggestedName, { create: true });
      },
    );
  });
  await open(page);
  const ids = await importFiles(page, [join(mediaDir, 'h264-1080p30-aac.mp4')]);
  await build(
    page,
    [1920, 1080],
    [{ media: 'h264-1080p30-aac.mp4', length: software ? 30 : 120 }],
    ids,
  );
  await page.keyboard.press('Control+e');
  const dialog = page.getByTestId('export-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('export-preset')).toHaveValue('youtube-1080p');
  await page.getByTestId('export-preset').selectOption('instagram');
  await expect(dialog).toContainText('black bars above and below');
  await expect(page.getByTestId('export-summary')).toContainText('frames');
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-progress')).toBeVisible();
  // Hide the dialog and edit: the export keeps the project it started with.
  await dialog.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.getByTestId('export-chip')).toBeVisible();
  const { project } = await snapshot(page);
  await execute(page, { type: 'split', at: 15 * FRAME, clips: [project.tracks[0].clips[0].id] });
  await execute(page, {
    type: 'delete',
    clips: [(await snapshot(page)).project.tracks[0].clips[0].id],
  });
  await expect(page.getByTestId('export-chip')).toHaveAttribute('data-state', 'done', {
    timeout: software ? 9 * 60_000 : 120_000,
  });
  await page.getByTestId('export-chip').click();
  await expect(page.getByTestId('export-done')).toContainText('Untitled project.mp4');
  // The file is in OPFS: read it back, check it, and play it in a <video>.
  const file = testInfo.outputPath('dialog.mp4');
  const base64 = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const blob = await (await root.getFileHandle('picked-Untitled project.mp4')).getFile();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  });
  writeFileSync(file, Buffer.from(base64, 'base64'));
  const info = probe(file);
  const video = info.streams.find((stream) => stream.codec_type === 'video')!;
  expect(video).toMatchObject({ width: 1080, height: 1080, codec_name: 'h264', profile: 'High' });
  expect(Number(video.nb_frames)).toBe(software ? 30 : 120);
  const playback = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const blob = await (await root.getFileHandle('picked-Untitled project.mp4')).getFile();
    const element = document.createElement('video');
    element.muted = true;
    element.src = URL.createObjectURL(blob);
    document.body.append(element);
    await new Promise((resolve, reject) => {
      element.onloadedmetadata = resolve;
      element.onerror = () => reject(new Error(element.error?.message ?? 'cannot play'));
    });
    await element.play();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const shown = element.getVideoPlaybackQuality().totalVideoFrames;
    element.pause();
    element.currentTime = element.duration - 0.1;
    await new Promise((resolve) => (element.onseeked = resolve));
    const result = {
      width: element.videoWidth,
      height: element.videoHeight,
      duration: element.duration,
      shown,
      error: element.error?.message ?? null,
    };
    element.remove();
    return result;
  });
  expect(playback).toMatchObject({ width: 1080, height: 1080, error: null });
  expect(playback.duration).toBeCloseTo(software ? 1 : 4, 1);
  expect(playback.shown).toBeGreaterThan(0);
  await record('export-dialog', testInfo, { info, playback });
});

test('cancelling an export removes its file', async ({ page }) => {
  test.setTimeout(software ? 10 * 60_000 : 3 * 60_000);
  await open(page);
  const ids = await importFiles(page, [join(mediaDir, 'h264-1080p30-aac.mp4')]);
  await build(page, [1920, 1080], [{ media: 'h264-1080p30-aac.mp4', length: 300 }], ids);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.evaluate(() =>
    (Reflect.get(window, '__cgv') as Hooks).exporter.start(
      {
        format: 'mp4',
        width: 1920,
        height: 1080,
        frameRate: { num: 30, den: 1 },
        video: { codec: 'avc', bitrate: 8e6 },
        audio: { codec: 'aac', bitrate: 192_000 },
      },
      { download: true },
    ),
  );
  await page.keyboard.press('Control+e');
  await expect
    .poll(
      async () => Number(await page.getByTestId('export-progress').getAttribute('aria-valuenow')),
      {
        timeout: software ? 5 * 60_000 : 60_000,
      },
    )
    .toBeGreaterThan(5);
  await page.getByTestId('export-cancel').click();
  await expect(page.getByTestId('export-cancelled')).toBeVisible();
  const left = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle('exports', { create: true });
    const names: string[] = [];
    for await (const name of (folder as unknown as { keys(): AsyncIterable<string> }).keys())
      names.push(name);
    return names;
  });
  expect(left).toEqual([]);
  expect(downloads).toBe(0);
});

test('sound-only and other formats export with the right streams', async ({ page }, testInfo) => {
  test.setTimeout(software ? 10 * 60_000 : 3 * 60_000);
  await open(page);
  const ids = await importFiles(page, [
    join(mediaDir, 'h264-1080p30-aac.mp4'),
    join(mediaDir, 'tone-48k-stereo.wav'),
  ]);
  await build(
    page,
    [1280, 720],
    [
      { media: 'h264-1080p30-aac.mp4', length: 45 },
      { media: 'tone-48k-stereo.wav', length: 60 },
    ],
    ids,
  );
  const base = { width: 1280, height: 720, frameRate: { num: 30, den: 1 } };
  const wav = testInfo.outputPath('sound.wav');
  await exportTo(
    page,
    { ...base, format: 'wav', video: null, audio: { codec: 'pcm-s16', bitrate: 0 } },
    wav,
  );
  const sound = probe(wav);
  expect(sound.streams).toHaveLength(1);
  expect(sound.streams[0]).toMatchObject({
    codec_name: 'pcm_s16le',
    sample_rate: '48000',
    channels: 2,
  });
  expect(Number(sound.format.duration)).toBeCloseTo(2, 2);
  const silent = testInfo.outputPath('silent.mkv');
  await exportTo(
    page,
    { ...base, format: 'mkv', video: { codec: 'vp9', bitrate: 3e6 }, audio: null },
    silent,
  );
  const mkv = probe(silent);
  expect(mkv.streams.map((stream) => stream.codec_name)).toEqual(['vp9']);
  expect(Number(mkv.format.duration)).toBeCloseTo(2, 1);
  // 23.976 fps from a 30 fps project: the frames follow the export's rate.
  const ntsc = testInfo.outputPath('film.mov');
  const film = await exportTo(
    page,
    {
      ...base,
      format: 'mov',
      frameRate: { num: 24000, den: 1001 },
      video: { codec: 'avc', bitrate: 4e6 },
      audio: { codec: 'aac', bitrate: 192_000 },
    },
    ntsc,
  );
  const mov = probe(ntsc);
  expect(mov.format.format_name).toContain('mov');
  expect(mov.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({
    r_frame_rate: '24000/1001',
  });
  expect(film.frames).toBe(48);
});

test('a one-minute 1080p30 project exports faster than real time', async ({ page }, testInfo) => {
  test.setTimeout(software ? 20 * 60_000 : 5 * 60_000);
  await open(page);
  const ids = await importFiles(page, [
    join(mediaDir, 'h264-1080p30-aac.mp4'),
    join(mediaDir, 'tone-48k-stereo.wav'),
  ]);
  // Cuts every 10 s on the main track (the clip's own sound) and music under it.
  const frames = speedSeconds * 30;
  await build(
    page,
    [1920, 1080],
    [{ media: 'h264-1080p30-aac.mp4', length: Math.min(300, frames) }],
    ids,
  );
  const main = (await snapshot(page)).project.tracks[0].id;
  for (let at = 300; at < frames; at += 300)
    await execute(page, {
      type: 'append',
      track: main,
      clip: {
        media: ids.get('h264-1080p30-aac.mp4'),
        duration: Math.min(300, frames - at) * FRAME,
      },
    });
  const music = (await snapshot(page)).project.tracks[1].id;
  await execute(page, {
    type: 'append',
    track: music,
    clip: { media: ids.get('tone-48k-stereo.wav'), duration: Math.min(frames, 60) * FRAME },
  });
  const file = testInfo.outputPath('minute.mp4');
  const result = await exportTo(
    page,
    {
      format: 'mp4',
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      video: { codec: 'avc', bitrate: 8e6 },
      audio: { codec: 'aac', bitrate: 192_000 },
    },
    file,
  );
  const info = probe(file);
  expect(Number(info.streams.find((stream) => stream.codec_type === 'video')!.nb_frames)).toBe(
    frames,
  );
  const realTime = (speedSeconds * 1000) / result.elapsedMs;
  await record('export-speed', testInfo, {
    software,
    seconds: speedSeconds,
    elapsedMs: result.elapsedMs,
    realTime,
    framesPerSecond: (frames * 1000) / result.elapsedMs,
    result,
  });
  if (!software) expect(result.elapsedMs).toBeLessThan(speedSeconds * 1000);
});

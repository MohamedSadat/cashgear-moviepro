// Generates the synthetic test clips into tests/media and rewrites
// tests/media/manifest.json with their SHA-256, size, release URL and the
// metadata the app must report. Run it only when the test set changes; then
// upload the files as the `test-media-vN` release (see --publish).
//
// Every video frame carries its frame number as a 16-bit barcode in the top
// eighth of the picture (bit 0 on the left, white = 1), so tests can read back
// exactly which frame a seek returned. Reference crops of selected frames are
// FFmpeg's own decode as raw I420 bytes: H.264, HEVC and VP9 decoding is
// bit-exact, so the engine's frames must match them byte for byte.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegBuildInfo, ffmpegTool, root } from './lib.mjs';

export const release = 'test-media-v1';
const repo = 'MohamedSadat/cashgear-moviepro';
const mediaDir = join(root, 'tests/media');

const tag709 = [
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
];
function videoInput({ width, height, rate }) {
  // testsrc2 content with the frame-number barcode overlaid along the top.
  const bar = Math.round(height / 8);
  return [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=${rate}[base];` +
      `color=c=black:size=${width}x${bar}:rate=${rate},format=gray,` +
      `geq=lum='if(mod(floor(N/pow(2\\,floor(X*16/W)))\\,2)\\,235\\,16)'[bar];` +
      `[base][bar]overlay=0:0,scale=out_color_matrix=bt709:out_range=tv,` +
      // Tag the frames themselves: encoders take colour metadata from frames, not options.
      'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
  ];
}
const tone = (seconds, rate = 48000, layout = 'stereo') => [
  '-f',
  'lavfi',
  '-i',
  `aevalsrc='0.6*sin(2*PI*440*t)*abs(sin(PI*t/2))|0.6*sin(2*PI*660*t)*abs(cos(PI*t/2))':s=${rate}:d=${seconds}`,
  ...(layout === 'mono' ? ['-ac', '1'] : []),
];

/** The test set. `expect` is what the media library must report for each file. */
export const clips = [
  {
    file: 'h264-1080p30-aac.mp4',
    video: { width: 1920, height: 1080, rate: '30', frames: 300 },
    args: (v) => [
      ...videoInput(v),
      ...tone(10),
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-frames:v',
      v.frames,
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libopenh264',
      '-profile:v',
      'high',
      '-b:v',
      '4M',
      '-g',
      '30',
      ...tag709,
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-shortest',
      '-movflags',
      '+faststart',
    ],
    references: [0, 1, 2, 29, 30, 31, 150, 298, 299],
    expect: {
      container: 'mp4',
      kind: 'video',
      codecLabel: 'H.264 High',
      width: 1920,
      height: 1080,
      rotation: 0,
      frameRateLabel: '30',
      frameCount: 300,
      audioCodecLabel: 'AAC-LC',
      sampleRate: 48000,
      channels: 2,
    },
  },
  {
    file: 'hevc-1080p23976-rot90.mov',
    video: { width: 1920, height: 1080, rate: '24000/1001', frames: 192 },
    inputOptions: ['-noautorotate', '-display_rotation:v:0', '-90'],
    args: (v) => [
      ...videoInput(v),
      '-frames:v',
      v.frames,
      '-pix_fmt',
      'yuv420p',
      // A random-access GOP of 8 with B-frames, so decode order differs from display order.
      '-c:v',
      'libkvazaar',
      '-kvazaar-params',
      'gop=8,period=48,bitrate=3000000',
      ...tag709,
      '-tag:v',
      'hvc1',
    ],
    references: [0, 1, 5, 7, 8, 47, 48, 100, 191],
    expect: {
      container: 'mov',
      kind: 'video',
      codecLabel: 'HEVC Main',
      width: 1080,
      height: 1920,
      rotation: 90,
      frameRateLabel: '23.976',
      frameCount: 192,
    },
  },
  {
    file: 'vp9-720p25-opus.webm',
    video: { width: 1280, height: 720, rate: '25', frames: 200 },
    args: (v) => [
      ...videoInput(v),
      ...tone(8),
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-frames:v',
      v.frames,
      '-pix_fmt',
      'yuv420p',
      // Alt-ref frames are decoded but never shown, another decode/display mismatch.
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '1M',
      '-g',
      '50',
      '-auto-alt-ref',
      '1',
      '-lag-in-frames',
      '16',
      ...tag709,
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-shortest',
    ],
    references: [0, 1, 24, 25, 26, 99, 199],
    expect: {
      container: 'webm',
      kind: 'video',
      codecLabel: 'VP9 Profile 0',
      width: 1280,
      height: 720,
      rotation: 0,
      frameRateLabel: '25',
      frameCount: 200,
      audioCodecLabel: 'Opus',
      sampleRate: 48000,
      channels: 2,
    },
  },
  {
    file: 'prores-720p2997-pcm.mov',
    video: { width: 1280, height: 720, rate: '30000/1001', frames: 90 },
    args: (v) => [
      ...videoInput(v),
      ...tone(3.003),
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-frames:v',
      v.frames,
      '-pix_fmt',
      'yuv422p10le',
      '-c:v',
      'prores_ks',
      '-profile:v',
      '0',
      ...tag709,
      '-c:a',
      'pcm_s16le',
      '-shortest',
    ],
    expect: {
      container: 'mov',
      kind: 'video',
      codecLabel: 'ProRes 422 Proxy',
      width: 1280,
      height: 720,
      rotation: 0,
      frameRateLabel: '29.97',
      frameCount: 90,
      audioCodecLabel: 'PCM 16-bit',
      sampleRate: 48000,
      channels: 2,
      webDecodable: false,
    },
  },
  {
    file: 'tone-44k-stereo.mp3',
    args: () => [...tone(10, 44100), '-c:a', 'libmp3lame', '-b:a', '192k'],
    expect: {
      container: 'mp3',
      kind: 'audio',
      audioCodecLabel: 'MP3',
      sampleRate: 44100,
      channels: 2,
    },
  },
  {
    file: 'tone-48k-stereo.wav',
    args: () => [...tone(5), '-c:a', 'pcm_s16le'],
    expect: {
      container: 'wav',
      kind: 'audio',
      audioCodecLabel: 'PCM 16-bit',
      sampleRate: 48000,
      channels: 2,
    },
  },
  {
    file: 'tone-48k-mono.aac',
    args: () => [...tone(5, 48000, 'mono'), '-c:a', 'aac', '-b:a', '96k', '-f', 'adts'],
    expect: {
      container: 'adts',
      kind: 'audio',
      audioCodecLabel: 'AAC-LC',
      sampleRate: 48000,
      channels: 1,
    },
  },
  {
    file: 'tone-48k-stereo.opus',
    args: () => [...tone(5), '-c:a', 'libopus', '-b:a', '96k'],
    expect: {
      container: 'ogg',
      kind: 'audio',
      audioCodecLabel: 'Opus',
      sampleRate: 48000,
      channels: 2,
    },
  },
  {
    file: 'still-1920x1080.png',
    args: () => [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1920x1080:rate=1',
      '-frames:v',
      '1',
      '-c:v',
      'png',
    ],
    expect: { container: 'png', kind: 'image', codecLabel: 'PNG', width: 1920, height: 1080 },
  },
  {
    file: 'still-1280x720.jpg',
    args: () => [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=1',
      '-frames:v',
      '1',
      '-c:v',
      'mjpeg',
      '-q:v',
      '3',
      '-pix_fmt',
      'yuvj420p',
    ],
    expect: { container: 'jpeg', kind: 'image', codecLabel: 'JPEG', width: 1280, height: 720 },
  },
  {
    file: 'still-1280x720.webp',
    args: () => [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=1',
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
    ],
    expect: { container: 'webp', kind: 'image', codecLabel: 'WebP', width: 1280, height: 720 },
  },
];

function ffmpeg(args) {
  const result = spawnSync(
    ffmpegTool('ffmpeg'),
    ['-hide_banner', '-loglevel', 'error', '-y', ...args.map(String)],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) throw new Error('ffmpeg failed: ' + result.stderr);
}
function ffprobe(path) {
  const result = spawnSync(
    ffmpegTool('ffprobe'),
    [
      '-v',
      'error',
      '-count_frames',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      path,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error('ffprobe failed: ' + result.stderr);
  return JSON.parse(result.stdout);
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Checks the generated file against its declared expectations with ffprobe. */
function verify(clip, path) {
  const probe = ffprobe(path);
  const video = probe.streams.find(
    (s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1,
  );
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  const problems = [];
  const check = (label, actual, expected) => {
    if (expected !== undefined && String(actual) !== String(expected))
      problems.push(`${label}: ${actual} (expected ${expected})`);
  };
  if (clip.video) {
    check('coded width', video?.width, clip.video.width);
    check('coded height', video?.height, clip.video.height);
    check('frames', video?.nb_read_frames, clip.video.frames);
    check(
      'rate',
      video?.r_frame_rate,
      clip.video.rate.includes('/') ? clip.video.rate : clip.video.rate + '/1',
    );
    const rotation = video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0;
    check('rotation', (360 - rotation) % 360, clip.expect.rotation);
  } else if (clip.expect.kind === 'image') {
    check('width', video?.width, clip.expect.width);
    check('height', video?.height, clip.expect.height);
  }
  if (clip.expect.sampleRate) {
    check('sample rate', audio?.sample_rate, clip.expect.sampleRate);
    check('channels', audio?.channels, clip.expect.channels);
  }
  if (problems.length) throw new Error(clip.file + ': ' + problems.join('; '));
  return { probe, video, audio };
}

async function referenceCrops(clip, path) {
  // The lower-right quadrant has bar edges, the moving diagonal and the checkerboard.
  // Even coordinates, so the 4:2:0 chroma planes crop cleanly.
  const even = (value) => Math.round(value / 2) * 2;
  const { width, height } = clip.video;
  const crop = { width: even(width / 5), height: even(height / 5) };
  const x = even(width / 2);
  const y = even(height / 2);
  const select = clip.references.map((n) => `eq(n\\,${n})`).join('+');
  const staging = join(mediaDir, 'staging-' + clip.file);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  ffmpeg([
    '-noautorotate',
    '-i',
    path,
    '-vf',
    `select='${select}',crop=${crop.width}:${crop.height}:${x}:${y}`,
    '-fps_mode',
    'passthrough',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'rawvideo',
    '-f',
    'image2',
    join(staging, '%04d.yuv'),
  ]);
  const outputs = (await readdir(staging)).sort();
  if (outputs.length !== clip.references.length)
    throw new Error(
      clip.file +
        ': expected ' +
        clip.references.length +
        ' reference frames, got ' +
        outputs.length,
    );
  const references = [];
  for (const [index, frame] of [...clip.references].sort((a, b) => a - b).entries()) {
    const file = clip.file.replace(/\.[^.]+$/, '') + `.ref-${String(frame).padStart(4, '0')}.yuv`;
    await rename(join(staging, outputs[index]), join(mediaDir, file));
    references.push({ frame, file, crop: { x, y, ...crop } });
  }
  await rm(staging, { recursive: true, force: true });
  return references;
}

async function main() {
  const info = ffmpegBuildInfo();
  if (info.gpl || info.nonfree)
    throw new Error('Refusing to generate test media with a GPL or nonfree FFmpeg.');
  console.log('Using ' + info.version);
  await mkdir(mediaDir, { recursive: true });
  const entries = [];
  for (const clip of clips) {
    const path = join(mediaDir, clip.file);
    ffmpeg([...(clip.inputOptions ?? []), ...clip.args(clip.video), path]);
    verify(clip, path);
    const references = clip.references ? await referenceCrops(clip, path) : [];
    const files = [clip.file, ...references.map((r) => r.file)];
    for (const file of files) {
      const bytes = await readFile(join(mediaDir, file));
      entries.push({
        file,
        url: `https://github.com/${repo}/releases/download/${release}/${file}`,
        sha256: sha256(bytes),
        size: bytes.length,
      });
    }
    clip.referenceFrames = references.map(({ frame, file, crop: c }) => ({ frame, file, crop: c }));
    console.log(
      '  ' + clip.file + ' (' + Math.round((await readFile(path)).length / 1024) + ' KiB)',
    );
  }
  const manifest = {
    comment:
      'Generated by scripts/make-test-media.mjs; fetched by pnpm fetch-test-media. Do not edit by hand.',
    release,
    files: entries,
    clips: clips.map((clip) => ({
      file: clip.file,
      expect: clip.expect,
      ...(clip.video ? { frames: clip.video.frames, rate: clip.video.rate } : {}),
      ...(clip.referenceFrames?.length ? { references: clip.referenceFrames } : {}),
    })),
  };
  await writeFile(join(mediaDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  console.log(
    entries.length + ' files, ' + (total / 1024 / 1024).toFixed(1) + ' MiB. Manifest written.',
  );
  if (process.argv.includes('--publish')) {
    const gh = spawnSync(
      'gh',
      [
        'release',
        'create',
        release,
        '--repo',
        repo,
        '--title',
        'Test media v1',
        '--notes',
        'Synthetic test clips generated by scripts/make-test-media.mjs. Fetch them with `pnpm fetch-test-media`.',
        ...entries.map((e) => join(mediaDir, e.file)),
      ],
      { stdio: 'inherit' },
    );
    if (gh.status !== 0) throw new Error('gh release create failed');
  }
}

await main();

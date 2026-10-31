import { spawnSync } from 'node:child_process';

// A synthetic 10-bit test set: a horizontal luma ramp through every limited-range
// 10-bit level (64 to 940) on neutral chroma, encoded by the pinned LGPL FFmpeg in
// the professional and 10-bit codecs. Through 8 bits the ramp keeps at most 220
// levels (16 to 235), so counting the levels that survive shows where a path
// loses precision. Nothing here is a recording, so nothing needs licensing or a
// release.

/** The lowest and highest limited-range 10-bit luma. */
export const rampLow = 64;
export const rampHigh = 940;
/** Every level the ramp holds. */
export const rampLevels = rampHigh - rampLow + 1;
export const rampFrames = 15;

/** The ramp's level at column `x` of a picture `width` wide. */
export function rampLevel(x: number, width: number) {
  return rampLow + Math.min(rampLevels - 1, Math.floor((x * rampLevels) / width));
}

export interface DeepClip {
  name: string;
  /** Chroma subsampling of the raw frames the encoder reads. */
  chroma: '420' | '422';
  args: string[];
  /** Whether the codec keeps every level exactly. */
  lossless: boolean;
}

export const deepClips: DeepClip[] = [
  {
    name: 'ramp-prores-hq.mov',
    chroma: '422',
    args: ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'],
    lossless: false,
  },
  {
    name: 'ramp-dnxhr-hqx.mov',
    chroma: '422',
    args: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx', '-pix_fmt', 'yuv422p10le'],
    lossless: false,
  },
  {
    name: 'ramp-vp9-10bit.webm',
    chroma: '420',
    args: [
      '-c:v',
      'libvpx-vp9',
      '-profile:v',
      '2',
      '-pix_fmt',
      'yuv420p10le',
      '-lossless',
      '1',
      '-row-mt',
      '1',
      '-cpu-used',
      '8',
      '-deadline',
      'realtime',
    ],
    lossless: true,
  },
  {
    name: 'ramp-av1-10bit.mp4',
    chroma: '420',
    args: [
      '-c:v',
      'libaom-av1',
      '-pix_fmt',
      'yuv420p10le',
      '-aom-params',
      'lossless=1',
      '-cpu-used',
      '8',
      '-row-mt',
      '1',
      '-usage',
      'realtime',
    ],
    lossless: true,
  },
];

/** One ramp frame as planar 10-bit Y'CbCr, little-endian, in `chroma` subsampling. */
export function rampFrame(width: number, height: number, chroma: '420' | '422'): Buffer {
  const chromaWidth = width / 2;
  const chromaHeight = chroma === '420' ? height / 2 : height;
  const luma = width * height;
  const frame = Buffer.alloc(2 * (luma + 2 * chromaWidth * chromaHeight));
  const row = Buffer.alloc(2 * width);
  for (let x = 0; x < width; x++) row.writeUInt16LE(rampLevel(x, width), 2 * x);
  for (let y = 0; y < height; y++) row.copy(frame, 2 * y * width);
  for (let i = luma; i < frame.length / 2; i++) frame.writeUInt16LE(512, 2 * i);
  return frame;
}

/** Encodes `rampFrames` ramp frames at 30 fps, tagged BT.709 limited range. */
export function encodeRamp(
  ffmpeg: string,
  clip: DeepClip,
  width: number,
  height: number,
  file: string,
) {
  const frame = rampFrame(width, height, clip.chroma);
  const result = spawnSync(
    ffmpeg,
    [
      '-y',
      '-v',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      clip.chroma === '420' ? 'yuv420p10le' : 'yuv422p10le',
      '-s',
      `${width}x${height}`,
      '-r',
      '30',
      '-i',
      '-',
      '-vf',
      'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      ...clip.args,
      '-g',
      String(rampFrames),
      file,
    ],
    { input: Buffer.concat(Array.from({ length: rampFrames }, () => frame)), maxBuffer: 1 << 28 },
  );
  if (result.status !== 0) throw new Error(`Encoding ${file} failed: ${String(result.stderr)}`);
}

/** How many distinct values `samples` holds. */
export function distinctLevels(samples: ArrayLike<number>) {
  return new Set(Array.from(samples)).size;
}

// Export settings: formats, presets, codec strings and bitrates. Pure, so the
// dialog, the export worker and the tests share one set of rules.
import type { FrameRate } from '../media/types';
import { FLICKS_PER_SECOND } from '../project/types';

export type ExportFormat = 'mp4' | 'webm' | 'mov' | 'mkv' | 'wav' | 'gif' | 'mp3';
/** Mediabunny's codec names. */
export type ExportVideoCodec = 'avc' | 'hevc' | 'vp9' | 'av1';
export type ExportAudioCodec = 'aac' | 'opus' | 'pcm-s16';
export type ExportQuality = 'high' | 'medium' | 'low';

export interface ExportSettings {
  format: ExportFormat;
  /** Frame size in pixels; both sides even. */
  width: number;
  height: number;
  frameRate: FrameRate;
  /** Null for audio-only formats. */
  video: { codec: ExportVideoCodec; bitrate: number } | null;
  /** Null when the file has no sound track. */
  audio: { codec: ExportAudioCodec; bitrate: number } | null;
}

export interface FormatInfo {
  id: ExportFormat;
  label: string;
  extension: string;
  mimeType: string;
  /** Video codecs the container takes, best first; empty for audio-only formats. */
  video: ExportVideoCodec[];
  /** Audio codecs the container takes, best first; empty for silent formats. */
  audio: ExportAudioCodec[];
  /** Made by FFmpeg from an intermediate file, so only the desktop app has it. */
  convertedFrom?: 'mp4' | 'wav';
}

export const formats: FormatInfo[] = [
  {
    id: 'mp4',
    label: 'MP4',
    extension: 'mp4',
    mimeType: 'video/mp4',
    video: ['avc', 'hevc', 'av1'],
    audio: ['aac', 'opus'],
  },
  {
    id: 'webm',
    label: 'WebM',
    extension: 'webm',
    mimeType: 'video/webm',
    video: ['vp9', 'av1'],
    audio: ['opus'],
  },
  {
    id: 'mov',
    label: 'MOV',
    extension: 'mov',
    mimeType: 'video/quicktime',
    video: ['avc', 'hevc'],
    audio: ['aac'],
  },
  {
    id: 'mkv',
    label: 'MKV',
    extension: 'mkv',
    mimeType: 'video/x-matroska',
    video: ['avc', 'hevc', 'vp9', 'av1'],
    audio: ['aac', 'opus'],
  },
  {
    id: 'gif',
    label: 'GIF',
    extension: 'gif',
    mimeType: 'image/gif',
    video: ['avc'],
    audio: [],
    convertedFrom: 'mp4',
  },
  {
    id: 'wav',
    label: 'WAV (audio)',
    extension: 'wav',
    mimeType: 'audio/wav',
    video: [],
    audio: ['pcm-s16'],
  },
  {
    id: 'mp3',
    label: 'MP3 (audio)',
    extension: 'mp3',
    mimeType: 'audio/mpeg',
    video: [],
    audio: ['pcm-s16'],
    convertedFrom: 'wav',
  },
];

export function formatInfo(format: ExportFormat): FormatInfo {
  return formats.find((info) => info.id === format)!;
}

/** The formats a platform offers: FFmpeg conversions need the desktop app. */
export function formatsFor(platform: 'web' | 'desktop'): FormatInfo[] {
  return formats.filter((info) => platform === 'desktop' || !info.convertedFrom);
}

export const videoCodecLabels: Record<ExportVideoCodec, string> = {
  avc: 'H.264',
  hevc: 'HEVC (H.265)',
  vp9: 'VP9',
  av1: 'AV1',
};
export const audioCodecLabels: Record<ExportAudioCodec, string> = {
  aac: 'AAC',
  opus: 'Opus',
  'pcm-s16': 'PCM 16-bit',
};

export interface ExportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  /** H.264 bitrate in bits per second at the project's frame rate. */
  bitrate(fps: number): number;
}

/** YouTube's recommended SDR upload bitrates: the higher one for 48 fps and up. */
const byRate = (normal: number, fast: number) => (fps: number) => (fps > 31 ? fast : normal);

export const presets: ExportPreset[] = [
  {
    id: 'youtube-1080p',
    label: 'YouTube 1080p',
    width: 1920,
    height: 1080,
    bitrate: byRate(8e6, 12e6),
  },
  {
    id: 'youtube-4k',
    label: 'YouTube 4K',
    width: 3840,
    height: 2160,
    bitrate: byRate(40e6, 60e6),
  },
  {
    id: 'tiktok',
    label: 'TikTok 9:16',
    width: 1080,
    height: 1920,
    bitrate: byRate(8e6, 12e6),
  },
  {
    id: 'instagram',
    label: 'Instagram 1:1',
    width: 1080,
    height: 1080,
    bitrate: byRate(6e6, 9e6),
  },
];

/** Bits per pixel per frame for H.264 at each quality. */
const bitsPerPixel: Record<ExportQuality, number> = { high: 0.13, medium: 0.08, low: 0.05 };
/** How much less each codec needs than H.264 for the same picture. */
const codecEfficiency: Record<ExportVideoCodec, number> = {
  avc: 1,
  hevc: 0.65,
  vp9: 0.7,
  av1: 0.55,
};

/** A video bitrate (bits per second) for `quality`, rounded to 100 kbit/s. */
export function qualityBitrate(
  quality: ExportQuality,
  codec: ExportVideoCodec,
  width: number,
  height: number,
  fps: number,
): number {
  const bits = bitsPerPixel[quality] * width * height * fps * codecEfficiency[codec];
  return Math.max(2e5, Math.round(bits / 1e5) * 1e5);
}

/** A preset's bitrate for `codec`: the H.264 figure scaled by the codec's efficiency. */
export function presetBitrate(preset: ExportPreset, codec: ExportVideoCodec, fps: number) {
  return Math.round((preset.bitrate(fps) * codecEfficiency[codec]) / 1e5) * 1e5;
}

/**
 * Sound bitrates: 96 kbit/s a channel for AAC and Opus. Windows' AAC encoder
 * takes at most 192 kbit/s, so stereo AAC gets exactly that.
 */
export function audioBitrate(codec: ExportAudioCodec, channels: number): number {
  if (codec === 'pcm-s16') return 0;
  return 96_000 * Math.max(1, Math.min(2, channels));
}

export const fps = (rate: FrameRate) => rate.num / rate.den;

/** Sides rounded to even numbers, at least 16 and at most 8,192 pixels. */
export function evenSize(width: number, height: number): { width: number; height: number } {
  const side = (value: number) =>
    Math.min(8192, Math.max(16, 2 * Math.round((Number.isFinite(value) ? value : 0) / 2)));
  return { width: side(width), height: side(height) };
}

/** Whole frames at `rate` that cover `durationFlicks` (exact, in integers). */
export function frameCount(durationFlicks: number, rate: FrameRate): number {
  if (durationFlicks <= 0) return 0;
  const numerator = BigInt(Math.round(durationFlicks)) * BigInt(rate.num);
  const denominator = BigInt(rate.den) * BigInt(FLICKS_PER_SECOND);
  return Number((numerator + denominator - 1n) / denominator);
}

/** Where export frame `index` starts, in flicks. */
export function frameTime(index: number, rate: FrameRate): number {
  return Number((BigInt(index) * BigInt(rate.den) * BigInt(FLICKS_PER_SECOND)) / BigInt(rate.num));
}

/** Where export frame `index` starts, in microseconds (encoder timestamps). */
export function frameMicroseconds(index: number, rate: FrameRate): number {
  return Math.round((index * rate.den * 1e6) / rate.num);
}

/** How the project's picture sits in an export frame of another shape, if it does. */
export function fitNotice(
  project: { width: number; height: number },
  frame: { width: number; height: number },
): string | null {
  const projectShape = project.width / project.height;
  const frameShape = frame.width / frame.height;
  if (Math.abs(projectShape - frameShape) / frameShape < 0.01) return null;
  const where = projectShape > frameShape ? 'above and below' : 'at the sides';
  return (
    `The project is ${shapeLabel(project)} and this frame is ${shapeLabel(frame)}: ` +
    `the picture fits with black bars ${where}. Change the project's format to fill it.`
  );
}

function shapeLabel({ width, height }: { width: number; height: number }) {
  const known: [number, string][] = [
    [16 / 9, '16:9'],
    [9 / 16, '9:16'],
    [1, '1:1'],
    [4 / 3, '4:3'],
    [4 / 5, '4:5'],
    [21 / 9, '21:9'],
  ];
  const shape = width / height;
  const match = known.find(([value]) => Math.abs(value - shape) / value < 0.01);
  return match ? match[1] : `${width}×${height}`;
}

/** A file name for the export: the project name made safe, with the format's extension. */
export function exportFileName(projectName: string, format: ExportFormat): string {
  const base = projectName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled project';
  return `${base}.${formatInfo(format).extension}`;
}

// ---- Codec strings: the lowest level that holds the frame size, rate and bitrate ----

interface Level {
  id: number;
  /** Largest frame, in the codec's unit (macroblocks for H.264, luma samples otherwise). */
  frame: number;
  /** Largest rate of those units per second. */
  rate: number;
  /** Largest bitrate (bits per second), where the level limits it. */
  bitrate?: number;
}

// H.264 levels in macroblocks; High profile bitrates are 1.25× the base ones.
const avcLevels: Level[] = [
  { id: 30, frame: 1620, rate: 40500, bitrate: 12.5e6 },
  { id: 31, frame: 3600, rate: 108000, bitrate: 17.5e6 },
  { id: 32, frame: 5120, rate: 216000, bitrate: 25e6 },
  { id: 40, frame: 8192, rate: 245760, bitrate: 25e6 },
  { id: 41, frame: 8192, rate: 245760, bitrate: 62.5e6 },
  { id: 42, frame: 8704, rate: 522240, bitrate: 62.5e6 },
  { id: 50, frame: 22080, rate: 589824, bitrate: 168.75e6 },
  { id: 51, frame: 36864, rate: 983040, bitrate: 300e6 },
  { id: 52, frame: 36864, rate: 2073600, bitrate: 300e6 },
  { id: 60, frame: 139264, rate: 4177920, bitrate: 300e6 },
  { id: 61, frame: 139264, rate: 8355840, bitrate: 480e6 },
  { id: 62, frame: 139264, rate: 16711680, bitrate: 800e6 },
];
// HEVC Main tier, VP9 and AV1 levels in luma samples (ids are 10× the level).
const hevcLevels: Level[] = [
  { id: 31, frame: 983040, rate: 33177600, bitrate: 10e6 },
  { id: 40, frame: 2228224, rate: 66846720, bitrate: 12e6 },
  { id: 41, frame: 2228224, rate: 133693440, bitrate: 20e6 },
  { id: 50, frame: 8912896, rate: 267386880, bitrate: 25e6 },
  { id: 51, frame: 8912896, rate: 534773760, bitrate: 40e6 },
  { id: 52, frame: 8912896, rate: 1069547520, bitrate: 60e6 },
  { id: 60, frame: 35651584, rate: 1069547520, bitrate: 60e6 },
  { id: 61, frame: 35651584, rate: 2139095040, bitrate: 120e6 },
  { id: 62, frame: 35651584, rate: 4278190080, bitrate: 240e6 },
];
const vp9Levels: Level[] = [
  { id: 31, frame: 983040, rate: 36864000 },
  { id: 40, frame: 2228224, rate: 83558400 },
  { id: 41, frame: 2228224, rate: 160432128 },
  { id: 50, frame: 8912896, rate: 311951360 },
  { id: 51, frame: 8912896, rate: 588251136 },
  { id: 52, frame: 8912896, rate: 1176502272 },
  { id: 60, frame: 35651584, rate: 1176502272 },
  { id: 61, frame: 35651584, rate: 2353004544 },
  { id: 62, frame: 35651584, rate: 4706009088 },
];
// AV1 ids are seq_level_idx.
const av1Levels: Level[] = [
  { id: 4, frame: 665856, rate: 19975680 },
  { id: 5, frame: 1065024, rate: 31950720 },
  { id: 8, frame: 2359296, rate: 70778880 },
  { id: 9, frame: 2359296, rate: 141557760 },
  { id: 12, frame: 8912896, rate: 267386880 },
  { id: 13, frame: 8912896, rate: 534773760 },
  { id: 14, frame: 8912896, rate: 1069547520 },
  { id: 16, frame: 35651584, rate: 1069547520 },
  { id: 17, frame: 35651584, rate: 2139095040 },
  { id: 18, frame: 35651584, rate: 4278190080 },
];

function level(levels: Level[], frame: number, rate: number, bitrate: number): number {
  const fits = levels.find(
    (candidate) =>
      candidate.frame >= frame &&
      candidate.rate >= rate &&
      (candidate.bitrate === undefined || candidate.bitrate >= bitrate),
  );
  return (fits ?? levels[levels.length - 1]).id;
}

const hex = (value: number) => value.toString(16).padStart(2, '0');

/** The WebCodecs codec string for an export: profile High/Main/0, 8-bit, lowest level that fits. */
export function videoCodecString(
  codec: ExportVideoCodec,
  width: number,
  height: number,
  frameRate: number,
  bitrate: number,
): string {
  const samples = width * height;
  switch (codec) {
    case 'avc': {
      const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
      return `avc1.6400${hex(level(avcLevels, macroblocks, macroblocks * frameRate, bitrate))}`;
    }
    case 'hevc':
      return `hvc1.1.6.L${level(hevcLevels, samples, samples * frameRate, bitrate) * 3}.B0`;
    case 'vp9':
      return `vp09.00.${level(vp9Levels, samples, samples * frameRate, bitrate)}.08`;
    case 'av1': {
      const id = level(av1Levels, samples, samples * frameRate, bitrate);
      return `av01.0.${String(id).padStart(2, '0')}M.08`;
    }
  }
}

export function audioCodecString(codec: ExportAudioCodec): string {
  return codec === 'aac' ? 'mp4a.40.2' : codec;
}

import {
  audioBitrate,
  evenSize,
  exportPresets,
  formatInfo,
  presetBitrate,
  qualityBitrate,
  type EncoderSupport,
  type ExportAudioCodec,
  type ExportFormat,
  type ExportSettings,
  type ExportVideoCodec,
  type FrameRate,
  type ProjectSettings,
} from '@cgv/engine-client';

/** What the export dialog's fields hold. */
export interface ExportForm {
  /** A preset id, `project` (the project's own size) or `custom`. */
  preset: string;
  format: ExportFormat;
  width: number;
  height: number;
  /** `project`, or a rate as `num/den`. */
  rate: string;
  videoCodec: ExportVideoCodec;
  /** `recommended` is the preset's bitrate. */
  quality: 'recommended' | 'high' | 'medium' | 'low' | 'custom';
  /** The custom video bitrate. */
  bitrateMbps: number;
  audio: boolean;
  audioCodec: ExportAudioCodec;
  /** MP3 only. */
  mp3Kbps: number;
}

/** GIFs are small and slow: 640 pixels wide at most, 15 frames a second. */
const gifWidth = 640;
const gifRate = '15/1';

export function frameRateOf(form: ExportForm, project: ProjectSettings): FrameRate {
  if (form.rate === 'project') return project.frameRate;
  const [num, den] = form.rate.split('/').map(Number);
  return { num, den };
}

/** The preset that matches the project's size, if one does. */
function matchingPreset(project: ProjectSettings) {
  return exportPresets.find(
    (preset) => preset.width === project.width && preset.height === project.height,
  );
}

export function initialForm(project: ProjectSettings): ExportForm {
  const preset = matchingPreset(project);
  return {
    preset: preset?.id ?? 'project',
    format: 'mp4',
    width: project.width,
    height: project.height,
    rate: 'project',
    videoCodec: 'avc',
    quality: preset ? 'recommended' : 'high',
    bitrateMbps: 8,
    audio: true,
    audioCodec: 'aac',
    mp3Kbps: 256,
  };
}

/** Chooses a preset: its frame size, and its recommended bitrate. */
export function applyPreset(form: ExportForm, id: string, project: ProjectSettings): ExportForm {
  const preset = exportPresets.find((candidate) => candidate.id === id);
  if (preset)
    return {
      ...form,
      preset: id,
      width: preset.width,
      height: preset.height,
      quality: form.quality === 'custom' ? 'custom' : 'recommended',
    };
  if (id === 'project')
    return {
      ...form,
      preset: id,
      width: project.width,
      height: project.height,
      quality: form.quality === 'recommended' ? 'high' : form.quality,
    };
  return {
    ...form,
    preset: 'custom',
    quality: form.quality === 'recommended' ? 'high' : form.quality,
  };
}

/** The codecs a format offers that this browser can encode (all of them while unknown). */
export function usableCodecs(format: ExportFormat, support: EncoderSupport | null) {
  const info = formatInfo(format);
  return {
    video: info.video.filter((codec) => !support || support.video[codec]),
    audio: info.audio.filter((codec) => !support || support.audio[codec]),
  };
}

/** Keeps the form's codecs where the format and browser allow them, else the first that work. */
export function fitCodecs(form: ExportForm, support: EncoderSupport | null): ExportForm {
  const { video, audio } = usableCodecs(form.format, support);
  const videoCodec = video.includes(form.videoCodec)
    ? form.videoCodec
    : (video[0] ?? form.videoCodec);
  const audioCodec = audio.includes(form.audioCodec)
    ? form.audioCodec
    : (audio[0] ?? form.audioCodec);
  return videoCodec === form.videoCodec && audioCodec === form.audioCodec
    ? form
    : { ...form, videoCodec, audioCodec };
}

/** Switches format, keeping the codecs where the container takes them. */
export function applyFormat(
  form: ExportForm,
  format: ExportFormat,
  project: ProjectSettings,
  support: EncoderSupport | null,
): ExportForm {
  let next = fitCodecs({ ...form, format }, support);
  if (format === 'gif') {
    const width = Math.min(gifWidth, project.width);
    const size = evenSize(width, (width * project.height) / project.width);
    next = { ...next, preset: 'custom', ...size, rate: gifRate };
  } else if (form.format === 'gif') {
    next = applyPreset(
      { ...next, rate: 'project' },
      matchingPreset(project)?.id ?? 'project',
      project,
    );
  }
  return next;
}

/** The video bitrate the form asks for, in bits per second. */
export function videoBitrateOf(form: ExportForm, project: ProjectSettings): number {
  const rate = frameRateOf(form, project);
  const fps = rate.num / rate.den;
  const { width, height } = evenSize(form.width, form.height);
  // A GIF's intermediate file must not add artefacts of its own.
  if (form.format === 'gif')
    return Math.max(4e6, 3 * qualityBitrate('high', 'avc', width, height, fps));
  const preset = exportPresets.find((candidate) => candidate.id === form.preset);
  if (form.quality === 'recommended' && preset) return presetBitrate(preset, form.videoCodec, fps);
  if (form.quality === 'custom') return Math.round(Math.max(0.1, form.bitrateMbps) * 1e6);
  const quality = form.quality === 'recommended' ? 'high' : form.quality;
  return qualityBitrate(quality, form.videoCodec, width, height, fps);
}

/** The export the form describes. */
export function exportSettings(form: ExportForm, project: ProjectSettings): ExportSettings {
  const info = formatInfo(form.format);
  const { width, height } = evenSize(form.width, form.height);
  const hasAudio = info.audio.length > 0 && (form.audio || info.video.length === 0);
  return {
    format: form.format,
    width,
    height,
    frameRate: frameRateOf(form, project),
    video: info.video.length
      ? { codec: form.videoCodec, bitrate: videoBitrateOf(form, project) }
      : null,
    audio: hasAudio
      ? {
          codec: form.audioCodec,
          bitrate:
            form.format === 'mp3'
              ? form.mp3Kbps * 1000
              : audioBitrate(form.audioCodec, project.channels),
        }
      : null,
  };
}

/** About how big the file gets, in bytes. */
export function estimateBytes(
  settings: ExportSettings,
  project: ProjectSettings,
  seconds: number,
): number {
  const pcm = project.sampleRate * project.channels * 16;
  const audio =
    settings.audio === null
      ? 0
      : settings.audio.codec === 'pcm-s16' && settings.format !== 'mp3'
        ? pcm
        : settings.audio.bitrate;
  // A GIF's size has little to do with its intermediate bitrate.
  const video = settings.format === 'gif' ? 0 : (settings.video?.bitrate ?? 0);
  return ((video + audio) * seconds) / 8;
}

/** "45.2 MB" */
export function formatBytes(bytes: number): string {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

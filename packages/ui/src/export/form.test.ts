import { describe, expect, it } from 'vitest';
import type { EncoderSupport, ProjectSettings } from '@cgv/engine-client';
import {
  applyFormat,
  applyPreset,
  estimateBytes,
  exportSettings,
  formatBytes,
  initialForm,
  usableCodecs,
} from './form';

const hd: ProjectSettings = {
  width: 1920,
  height: 1080,
  frameRate: { num: 30, den: 1 },
  sampleRate: 48000,
  channels: 2,
};
const vertical: ProjectSettings = { ...hd, width: 1080, height: 1920 };
const chrome: EncoderSupport = {
  video: { avc: 'hardware', hevc: 'hardware', vp9: 'software', av1: 'software' },
  audio: { aac: true, opus: true, 'pcm-s16': true },
};
const noAac: EncoderSupport = {
  video: { vp9: 'software' },
  audio: { opus: true, 'pcm-s16': true },
};

describe('export form', () => {
  it('starts from the preset that matches the project', () => {
    const form = initialForm(hd);
    expect(form.preset).toBe('youtube-1080p');
    expect(exportSettings(form, hd)).toEqual({
      format: 'mp4',
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      video: { codec: 'avc', bitrate: 8e6 },
      audio: { codec: 'aac', bitrate: 192_000 },
    });
    expect(initialForm(vertical).preset).toBe('tiktok');
    const odd = initialForm({ ...hd, width: 1280, height: 720 });
    expect([odd.preset, odd.quality]).toEqual(['project', 'high']);
    expect(exportSettings(odd, { ...hd, width: 1280, height: 720 }).video?.bitrate).toBe(3.6e6);
  });

  it('applies presets with their recommended bitrates', () => {
    const uhd = applyPreset(initialForm(hd), 'youtube-4k', hd);
    expect(exportSettings(uhd, hd)).toMatchObject({ width: 3840, height: 2160 });
    expect(exportSettings(uhd, hd).video?.bitrate).toBe(40e6);
    const custom = {
      ...applyPreset(uhd, 'custom', hd),
      quality: 'custom' as const,
      bitrateMbps: 12.5,
    };
    expect(exportSettings(custom, hd).video?.bitrate).toBe(12.5e6);
    const back = applyPreset(custom, 'project', hd);
    expect([back.width, back.height, back.quality]).toEqual([1920, 1080, 'custom']);
  });

  it('keeps codecs the container takes and the browser encodes', () => {
    const webm = applyFormat(initialForm(hd), 'webm', hd, chrome);
    expect([webm.videoCodec, webm.audioCodec]).toEqual(['vp9', 'opus']);
    const mkv = applyFormat(webm, 'mkv', hd, chrome);
    expect([mkv.videoCodec, mkv.audioCodec]).toEqual(['vp9', 'opus']);
    // Without AAC, MP4 takes Opus.
    expect(applyFormat(initialForm(hd), 'mp4', hd, noAac).audioCodec).toBe('opus');
    expect(usableCodecs('mov', noAac)).toEqual({ video: [], audio: [] });
    expect(usableCodecs('mp4', null).video).toEqual(['avc', 'hevc', 'av1']);
  });

  it('makes GIFs small and silent and sound-only files without video', () => {
    const gif = exportSettings(applyFormat(initialForm(hd), 'gif', hd, chrome), hd);
    expect(gif).toMatchObject({ width: 640, height: 360, frameRate: { num: 15, den: 1 } });
    expect(gif.audio).toBeNull();
    expect(gif.video?.codec).toBe('avc');
    const wav = exportSettings(applyFormat(initialForm(hd), 'wav', hd, chrome), hd);
    expect(wav.video).toBeNull();
    expect(wav.audio).toEqual({ codec: 'pcm-s16', bitrate: 0 });
    const mp3Form = { ...applyFormat(initialForm(hd), 'mp3', hd, chrome), mp3Kbps: 320 };
    expect(exportSettings(mp3Form, hd).audio).toEqual({ codec: 'pcm-s16', bitrate: 320_000 });
    // Back from GIF, the size follows the project again.
    const back = applyFormat(applyFormat(initialForm(hd), 'gif', hd, chrome), 'mp4', hd, chrome);
    expect([back.preset, back.width, back.rate]).toEqual(['youtube-1080p', 1920, 'project']);
  });

  it('estimates the file size', () => {
    const settings = exportSettings(initialForm(hd), hd);
    expect(estimateBytes(settings, hd, 60)).toBe(((8e6 + 192e3) * 60) / 8);
    const wav = exportSettings(applyFormat(initialForm(hd), 'wav', hd, chrome), hd);
    expect(estimateBytes(wav, hd, 10)).toBe(48000 * 2 * 2 * 10);
    expect(formatBytes(61_440_000)).toBe('61.4 MB');
    expect(formatBytes(400)).toBe('1 KB');
    expect(formatBytes(2.5e9)).toBe('2.50 GB');
  });
});

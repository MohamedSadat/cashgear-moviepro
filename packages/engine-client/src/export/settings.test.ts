import { describe, expect, it } from 'vitest';
import { FLICKS_PER_SECOND } from '../project/types';
import {
  audioBitrate,
  evenSize,
  exportFileName,
  fitNotice,
  formatInfo,
  formatsFor,
  frameCount,
  frameMicroseconds,
  frameTime,
  presetBitrate,
  presets,
  qualityBitrate,
  videoCodecString,
  loudnessCeiling,
  loudnessGain,
  loudnessTargets,
} from './settings';

const ntsc = { num: 30000, den: 1001 };

describe('export settings', () => {
  it('offers FFmpeg conversions on the desktop only', () => {
    const web = formatsFor('web').map((format) => format.id);
    expect(web).toEqual(['mp4', 'webm', 'mov', 'mkv', 'wav']);
    expect(formatsFor('desktop').map((format) => format.id)).toContain('gif');
    expect(formatsFor('desktop').map((format) => format.id)).toContain('mp3');
    expect(formatInfo('mp4').video[0]).toBe('avc');
    expect(formatInfo('mp4').audio[0]).toBe('aac');
    expect(formatInfo('webm').audio).toEqual(['opus']);
  });

  it('picks the lowest codec level that holds the frame', () => {
    // 1080p30 at 8 Mbit/s is High 4.0, as YouTube uploads usually are.
    expect(videoCodecString('avc', 1920, 1080, 30, 8e6)).toBe('avc1.640028');
    expect(videoCodecString('avc', 1920, 1080, 60, 12e6)).toBe('avc1.64002a');
    expect(videoCodecString('avc', 3840, 2160, 30, 40e6)).toBe('avc1.640033');
    expect(videoCodecString('avc', 1280, 720, 30, 5e6)).toBe('avc1.64001f');
    // A bitrate above level 4.0's limit needs 4.1.
    expect(videoCodecString('avc', 1920, 1080, 30, 40e6)).toBe('avc1.640029');
    expect(videoCodecString('hevc', 1920, 1080, 30, 5e6)).toBe('hvc1.1.6.L120.B0');
    expect(videoCodecString('hevc', 3840, 2160, 30, 26e6)).toBe('hvc1.1.6.L153.B0');
    expect(videoCodecString('vp9', 1920, 1080, 30, 6e6)).toBe('vp09.00.40.08');
    expect(videoCodecString('vp9', 3840, 2160, 60, 40e6)).toBe('vp09.00.51.08');
    expect(videoCodecString('av1', 1920, 1080, 30, 4e6)).toBe('av01.0.08M.08');
    expect(videoCodecString('av1', 3840, 2160, 30, 20e6)).toBe('av01.0.12M.08');
  });

  it('follows YouTube bitrates and scales them per codec', () => {
    const youtube = presets.find((preset) => preset.id === 'youtube-1080p')!;
    expect(presetBitrate(youtube, 'avc', 30)).toBe(8e6);
    expect(presetBitrate(youtube, 'avc', 60)).toBe(12e6);
    expect(presetBitrate(youtube, 'av1', 30)).toBe(4.4e6);
    const uhd = presets.find((preset) => preset.id === 'youtube-4k')!;
    expect(presetBitrate(uhd, 'avc', 29.97)).toBe(40e6);
    expect(qualityBitrate('high', 'avc', 1920, 1080, 30)).toBe(8.1e6);
    expect(qualityBitrate('low', 'avc', 1280, 720, 30)).toBe(1.4e6);
    expect(qualityBitrate('low', 'av1', 160, 90, 10)).toBe(2e5);
    expect(audioBitrate('aac', 2)).toBe(192_000);
    expect(audioBitrate('opus', 1)).toBe(96_000);
    expect(audioBitrate('pcm-s16', 2)).toBe(0);
  });

  it('counts and times frames exactly at any rate', () => {
    const second = FLICKS_PER_SECOND;
    expect(frameCount(0, { num: 30, den: 1 })).toBe(0);
    expect(frameCount(60 * second, { num: 30, den: 1 })).toBe(1800);
    expect(frameCount(60 * second + 1, { num: 30, den: 1 })).toBe(1801);
    // 10 s at 29.97 fps is 299.7 frames: 300 cover it.
    expect(frameCount(10 * second, ntsc)).toBe(300);
    expect(frameTime(1, ntsc)).toBe(23_543_520);
    expect(frameTime(30_000, ntsc)).toBe(1001 * second);
    expect(frameMicroseconds(1, ntsc)).toBe(33367);
    expect(frameMicroseconds(3, { num: 25, den: 1 })).toBe(120_000);
    // Eight hours at 60 fps stays exact.
    expect(frameCount(8 * 3600 * second, { num: 60, den: 1 })).toBe(1_728_000);
  });

  it('keeps frame sides even and in range', () => {
    expect(evenSize(1919, 1081)).toEqual({ width: 1920, height: 1082 });
    expect(evenSize(5, 99999)).toEqual({ width: 16, height: 8192 });
    expect(evenSize(Number.NaN, 720)).toEqual({ width: 16, height: 720 });
  });

  it('says when the picture gets black bars', () => {
    expect(fitNotice({ width: 1920, height: 1080 }, { width: 3840, height: 2160 })).toBeNull();
    expect(fitNotice({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toBe(
      'The project is 16:9 and this frame is 9:16: the picture fits with black bars above and ' +
        "below. Change the project's format to fill it.",
    );
    expect(fitNotice({ width: 1080, height: 1920 }, { width: 1080, height: 1080 })).toContain(
      'at the sides',
    );
  });

  it('names files after the project', () => {
    expect(exportFileName('Trip: day 1/2', 'mp4')).toBe('Trip_ day 1_2.mp4');
    expect(exportFileName('  ', 'wav')).toBe('Untitled project.wav');
  });
});

describe('loudness', () => {
  it('raises or lowers the mix to the target, within 24 dB, and leaves silence alone', () => {
    expect(loudnessGain(-20, -14)).toBe(6);
    expect(loudnessGain(-9.5, -14)).toBe(-4.5);
    expect(loudnessGain(-60, -14)).toBe(24);
    expect(loudnessGain(-200, -14)).toBe(0);
    expect(loudnessGain(Number.NEGATIVE_INFINITY, -23)).toBe(0);
    expect(loudnessTargets.map((target) => target.value)).toEqual([-14, -16, -23, -24]);
    expect(loudnessCeiling).toBe(-1);
  });
});

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// A multicam test set: four cameras filming one event, each started at a known
// moment. Their sound is one synthetic recording of irregular bursts, each with
// its own level and noise, as different microphones hear it; their pictures are
// the same pattern in four hues. Drawn and encoded by the pinned FFmpeg during
// the tests, so nothing here is a recording and nothing needs a release.

export const angleCount = 4;
/** When each camera started, in seconds into the event: not on frame boundaries. */
export const startSeconds = [0, 0.7375, 1.4031, 2.1009];
/** The start timecode's frames of each camera, at 30 fps: the same moments to a frame. */
export const startFrames = startSeconds.map((seconds) => 108_000 + Math.round(seconds * 30));
export const angleSeconds = 12;

/** Bursts of tones and noise at uneven times, as speech and claps have. */
const event = [
  '0.4*sin(2*PI*(300+200*sin(3*t))*t)*gt(sin(7.3*t)+sin(2.1*t),0.6)',
  '0.35*sin(2*PI*(900+300*sin(5*t))*t)*gt(sin(4.7*t)*sin(1.3*t),0.5)',
  '0.5*(random(0)-0.5)*gt(sin(11*t)*sin(1.7*t),0.7)',
].join('+');

function run(ffmpeg: string, args: string[]) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1 << 24,
  });
  if (result.status !== 0) throw new Error(`FFmpeg failed: ${result.stderr}`);
}

const timecode = (frames: number) => {
  const part = (value: number) => String(value).padStart(2, '0');
  const seconds = Math.floor(frames / 30);
  return [
    part(Math.floor(seconds / 3600)),
    part(Math.floor(seconds / 60) % 60),
    part(seconds % 60),
    part(frames % 30),
  ].join(':');
};

/**
 * The four angles as 1080p30 H.264 and AAC in QuickTime files carrying a start
 * timecode, made in `dir` unless they are there already. Returns their paths.
 */
export function makeAngles(ffmpeg: string, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const master = join(dir, 'event.wav');
  if (!existsSync(master))
    run(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      `aevalsrc=exprs='${event}':s=48000:d=${angleSeconds + 4}`,
      '-c:a',
      'pcm_s16le',
      master,
    ]);
  return startSeconds.map((start, index) => {
    const file = join(dir, `angle-${index + 1}.mov`);
    if (existsSync(file)) return file;
    const gain = [0.8, 0.5, 1, 0.35][index];
    run(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=1920x1080:rate=30,hue=h=${index * 90}:s=0.8`,
      '-i',
      master,
      '-f',
      'lavfi',
      '-i',
      `anoisesrc=c=pink:a=0.02:r=48000:s=${index + 1}`,
      '-filter_complex',
      `[1:a]atrim=start=${start},asetpts=PTS-STARTPTS,volume=${gain}[sound];` +
        '[sound][2:a]amix=inputs=2:duration=first:normalize=0[mix]',
      '-map',
      '0:v',
      '-map',
      '[mix]',
      '-t',
      String(angleSeconds),
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libopenh264',
      '-b:v',
      '16M',
      '-g',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-timecode',
      timecode(startFrames[index]),
      file,
    ]);
    return file;
  });
}

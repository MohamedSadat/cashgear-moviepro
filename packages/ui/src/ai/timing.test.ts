import { describe, expect, it } from 'vitest';
import { FLICKS_PER_SECOND, type Clip, type Project } from '@cgv/engine-client';
import { sourceAt } from '../speed/timing';
import { beatTimes, soundClipOf, tempoOf, timelineAt, timelineRanges } from './timing';

const S = FLICKS_PER_SECOND;

const clip = (patch: Partial<Clip> = {}): Clip => ({
  id: 1,
  media: 'm',
  start: 10 * S,
  duration: 4 * S,
  sourceIn: 2 * S,
  speed: { num: 1, den: 1 },
  video: true,
  audio: true,
  link: null,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
  opacity: 1,
  volumeDb: 0,
  ...patch,
});

describe('AI results on the timeline', () => {
  it('maps media times through speed, reverse and ramps', () => {
    expect(timelineAt(clip(), 3 * S)).toBe(11 * S);
    expect(timelineAt(clip(), 1 * S)).toBeNull();
    expect(timelineAt(clip({ speed: { num: 2, den: 1 } }), 6 * S)).toBe(12 * S);
    const reversed = clip({ reverse: true });
    expect(timelineAt(reversed, 5 * S)).toBeCloseTo(11 * S, -1);
    const ramped = clip({
      ramp: [
        { time: 0, speed: 0.5 },
        { time: 4 * S, speed: 2 },
      ],
    });
    for (const offset of [0.5, 1.7, 3.2]) {
      const source = sourceAt(ramped, offset * S);
      expect(Math.abs(timelineAt(ramped, source)! - (10 + offset) * S)).toBeLessThan(2);
    }
    expect(timelineAt(clip({ freeze: true }), 2 * S)).toBeNull();
  });

  it('turns source ranges into timeline ranges inside the clip', () => {
    expect(
      timelineRanges(clip(), [
        [0, 2.5],
        [3, 3.5],
        [5.5, 9],
      ]),
    ).toEqual([
      [10 * S, 10.5 * S],
      [11 * S, 11.5 * S],
      [13.5 * S, 14 * S],
    ]);
    // Reversed, later media plays earlier.
    expect(timelineRanges(clip({ reverse: true }), [[5, 6]])).toEqual([[10 * S, 11 * S]]);
    expect(timelineRanges(clip(), [[7, 8]])).toEqual([]);
  });

  it('finds the clip playing the sound and its beats', () => {
    const video = clip({ id: 1, audio: false, link: 7 });
    const sound = clip({ id: 2, video: false, link: 7 });
    const project = { tracks: [{ clips: [video] }, { clips: [sound] }] } as unknown as Project;
    expect(soundClipOf(project, 1)?.id).toBe(2);
    expect(soundClipOf(project, 2)?.id).toBe(2);
    const beats = [1, 2.5, 3, 3.5, 4, 7].map((t) => t * S);
    expect(beatTimes(clip({ beats }))).toEqual([10.5 * S, 11 * S, 11.5 * S, 12 * S]);
    expect(tempoOf([10.5 * S, 11 * S, 11.5 * S, 12 * S])).toBe(120);
    expect(tempoOf([S])).toBeNull();
  });
});

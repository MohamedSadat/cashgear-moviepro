import { describe, expect, it } from 'vitest';
import type { Keyframe } from '@cgv/engine-client';
import { keyTimes, progress, valueAt } from './animation';

const key = (time: number, value: number, kind: Keyframe['interpolation']['kind'] = 'linear') =>
  ({ time, value, interpolation: { kind } }) as Keyframe;

describe('keyframes', () => {
  it('evaluate as the engine does: held outside, eased between', () => {
    const keys = [key(10, 0), key(30, 10, 'hold'), key(50, 20, 'easeIn'), key(70, 40)];
    expect(valueAt(keys, 0)).toBe(0);
    expect(valueAt(keys, 20)).toBe(5);
    expect(valueAt(keys, 49)).toBe(10);
    expect(valueAt(keys, 50)).toBe(20);
    expect(valueAt(keys, 60)).toBeLessThan(30);
    expect(valueAt(keys, 999)).toBe(40);
    expect(valueAt([], 0)).toBeUndefined();
  });

  it('ease like CSS, matching the Rust model', () => {
    expect(progress({ kind: 'easeIn' }, 0.5)).toBeCloseTo(0.315356, 5);
    expect(progress({ kind: 'easeOut' }, 0.5)).toBeCloseTo(0.684644, 5);
    expect(progress({ kind: 'easeInOut' }, 0.5)).toBeCloseTo(0.5, 9);
    const overshoot = { kind: 'bezier', x1: 0.3, y1: 1.8, x2: 0.7, y2: 1 } as const;
    expect(progress(overshoot, 0.5)).toBeGreaterThan(1);
  });

  it('blend colours in linear light', () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 1, g: 1, b: 1, a: 0 };
    const mid = valueAt(
      [
        { time: 0, value: black, interpolation: { kind: 'linear' } },
        { time: 100, value: white, interpolation: { kind: 'linear' } },
      ],
      50,
    ) as { r: number; a: number };
    expect(mid.r).toBeCloseTo(0.735357, 5);
    expect(mid.a).toBeCloseTo(0.5, 9);
  });

  it('list the times with keys inside the clip', () => {
    const clip = {
      duration: 100,
      keyframes: { opacity: [key(-5, 0), key(10, 1)], 'transform.x': [key(10, 0), key(40, 1)] },
    } as never;
    expect(keyTimes(clip)).toEqual([10, 40]);
  });
});

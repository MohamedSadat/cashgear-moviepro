import { describe, expect, it } from 'vitest';
import { PeakPyramid } from './visuals';

describe('waveform pyramid', () => {
  // 8 peaks at 4 per second: quiet, then one loud pair in the middle.
  const peaks = new Int8Array([-1, 1, -2, 2, -100, 120, -3, 3, -1, 1, -1, 1, -5, 5, -1, 1]);
  const pyramid = new PeakPyramid(peaks, 4);

  it('halves the resolution at each level, keeping the extremes', () => {
    expect(pyramid.levels.map((level) => level.length)).toEqual([16, 8, 4]);
    expect([...pyramid.levels[1]]).toEqual([-2, 2, -100, 120, -1, 1, -5, 5]);
    expect([...pyramid.levels[2]]).toEqual([-100, 120, -5, 5]);
  });

  it('reads ranges at the resolution asked for', () => {
    expect(pyramid.range(0, 0.25, 1)).toEqual([-1, 1]);
    expect(pyramid.range(0.5, 0.75, 1)).toEqual([-100, 120]);
    expect(pyramid.range(1, 2, 1)).toEqual([-5, 5]);
    // Four pairs per pixel reads the top level: one pair covers a second.
    expect(pyramid.range(0, 0.25, 4)).toEqual([-100, 120]);
    expect(pyramid.range(5, 6, 1)).toEqual([0, 0]);
  });
});

import { describe, expect, it } from 'vitest';
import { colourDifference, traceLevel, vectorTargets } from './graticule';

describe('scope graticule', () => {
  it('puts the 75% bars where BT.709 does, as the engine counts them', () => {
    const red = vectorTargets.find((target) => target.name === 'R')!;
    expect(red.cb).toBeCloseTo(-0.0859, 4);
    expect(red.cr).toBeCloseTo(0.375, 4);
    expect((Math.atan2(red.cr, red.cb) * 180) / Math.PI).toBeCloseTo(102.9, 1);
    // Complementary bars sit opposite each other.
    const cyan = vectorTargets.find((target) => target.name === 'Cy')!;
    expect(cyan.cb).toBeCloseTo(-red.cb, 6);
    expect(cyan.cr).toBeCloseTo(-red.cr, 6);
    expect(colourDifference(0.5, 0.5, 0.5)).toEqual({ cb: 0, cr: 0 });
  });

  it('shows sparse cells and saturates the busiest', () => {
    expect(traceLevel(0, 100)).toBe(0);
    expect(traceLevel(1, 100)).toBeGreaterThan(0.2);
    expect(traceLevel(400, 100)).toBe(1);
  });
});

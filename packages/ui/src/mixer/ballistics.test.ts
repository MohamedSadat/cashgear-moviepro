import { describe, expect, it } from 'vitest';
import { fallDbPerSecond, holdMs, MeterBallistics, meterFloor, meterPosition } from './ballistics';

const level = (peak: number, rms = peak / 2) => ({
  peak: [peak, peak] as [number, number],
  rms: [rms, rms] as [number, number],
});

describe('meter ballistics', () => {
  it('rise at once, hold the peak, then fall at the IEC rate', () => {
    const meter = new MeterBallistics();
    let [left] = meter.update(level(0.5), 1000);
    expect(left.peak).toBeCloseTo(-6.02, 2);
    expect(left.hold).toBeCloseTo(-6.02, 2);
    // Quiet a second later: the bar falls, the marker holds.
    [left] = meter.update(level(0.01), 2000);
    expect(left.peak).toBeCloseTo(-6.02 - fallDbPerSecond, 2);
    expect(left.hold).toBeCloseTo(-6.02, 2);
    // After the hold, the marker falls too.
    [left] = meter.update(level(0.01), 1000 + holdMs + 500);
    expect(left.hold).toBeLessThan(-6.02);
    expect(left.clipped).toBe(false);
  });

  it('fall to rest once readings stop, and remember a clip', () => {
    const meter = new MeterBallistics();
    meter.update(level(1.2), 0);
    expect(meter.update(null, 10)[0].clipped).toBe(true);
    for (let t = 20; t < 10_000; t += 100) meter.update(null, t);
    expect(meter.resting).toBe(true);
    meter.resetClip();
    expect(meter.update(null, 10_100)[0].clipped).toBe(false);
  });

  it('place levels on the scale', () => {
    expect(meterPosition(meterFloor)).toBe(0);
    expect(meterPosition(3)).toBe(1);
    expect(meterPosition(-200)).toBe(0);
    expect(meterPosition(-28.5)).toBeCloseTo(0.5, 6);
  });
});

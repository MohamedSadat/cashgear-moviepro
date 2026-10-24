import { describe, expect, it } from 'vitest';
import { ProgressClock, remainingLabel } from './progress';

describe('export progress', () => {
  it('estimates from the recent rate', () => {
    const clock = new ProgressClock(5000);
    clock.record(0, 0);
    expect(clock.rate()).toBeNull();
    clock.record(10, 400);
    expect(clock.remainingMs(100)).toBeNull();
    clock.record(30, 1000);
    expect(clock.rate()).toBe(30);
    expect(clock.remainingMs(90)).toBe(2000);
    // Slower later: after the window passes, only the recent rate counts.
    for (let at = 2000; at <= 12000; at += 1000) clock.record(30 + (at - 1000) / 100, at);
    expect(clock.rate()).toBeCloseTo(10, 5);
    expect(clock.remainingMs(150)).toBeCloseTo(1000, 5);
  });

  it('says how long is left in words', () => {
    expect(remainingLabel(null)).toBe('Estimating time left…');
    expect(remainingLabel(400)).toBe('1 second left');
    expect(remainingLabel(12_300)).toBe('13 seconds left');
    expect(remainingLabel(95_000)).toBe('About 2 minutes left');
    expect(remainingLabel(60_000)).toBe('About 1 minute left');
    expect(remainingLabel(2 * 3600_000 + 5 * 60_000)).toBe('About 2 h 5 min left');
  });
});

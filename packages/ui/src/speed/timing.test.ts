import { describe, expect, it } from 'vitest';
import type { Clip } from '@cgv/engine-client';
import { presetOf, rampPresets, rampSpan, rampSpeed, shapeMean, shapeOf, sourceAt } from './timing';

const clip = (patch: Partial<Clip> = {}): Clip => ({
  id: 1,
  media: 'm',
  start: 0,
  duration: 400,
  sourceIn: 100,
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

describe('clip timing', () => {
  it('integrates a ramp as the model does', () => {
    const ramp = [
      { time: 100, speed: 1 },
      { time: 300, speed: 3 },
      { time: 400, speed: 3 },
    ];
    expect(rampSpeed(ramp, 200)).toBe(2);
    expect(rampSpan(ramp, 100)).toBe(100);
    expect(rampSpan(ramp, 300)).toBe(500);
    expect(rampSpan(ramp, 500)).toBe(1100);
  });

  it('maps forward, reversed and frozen clips to their media', () => {
    expect(sourceAt(clip(), 50)).toBe(150);
    expect(sourceAt(clip({ speed: { num: 2, den: 1 } }), 50)).toBe(200);
    // Reversed: from the out point (100 + 400) back.
    expect(sourceAt(clip({ reverse: true }), 0)).toBe(500);
    expect(sourceAt(clip({ reverse: true }), 400)).toBe(100);
    expect(sourceAt(clip({ freeze: true }), 300)).toBe(100);
  });

  it('reads a clip ramp back as fractions and knows its presets', () => {
    const ramped = clip({
      ramp: [
        { time: 0, speed: 1 },
        { time: 400, speed: 3 },
      ],
    });
    expect(shapeOf(ramped)).toEqual([
      { at: 0, speed: 1 },
      { at: 1, speed: 3 },
    ]);
    expect(shapeMean(shapeOf(ramped))).toBeCloseTo(2);
    for (const preset of rampPresets) {
      expect(presetOf(preset.shape)?.id).toBe(preset.id);
      // Every preset stays in the model's range at normal speed.
      for (const point of preset.shape) expect(point.speed).toBeGreaterThanOrEqual(0.1);
    }
  });
});

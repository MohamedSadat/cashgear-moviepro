import { describe, expect, it } from 'vitest';
import type { Clip, Track, Transition } from '@cgv/engine-client';
import { cutNear, cutsOf, durationForEdge, transitionWindow } from './transitions';

const clip = (id: number, start: number, duration: number, extra: Partial<Clip> = {}) =>
  ({ id, start, duration, video: true, audio: false, ...extra }) as Clip;
const track = (clips: Clip[]) => ({ id: 1, clips }) as unknown as Track;

describe('transition targets', () => {
  it('are cuts between touching pictures and free edges', () => {
    const t = track([clip(1, 0, 30), clip(2, 30, 30), clip(3, 80, 10)]);
    expect(cutsOf(t)).toEqual([
      { from: null, to: 1, cut: 0 },
      { from: 1, to: 2, cut: 30 },
      { from: 2, to: null, cut: 60 },
      { from: null, to: 3, cut: 80 },
      { from: 3, to: null, cut: 90 },
    ]);
    expect(cutNear(t, 34)).toEqual({ from: 1, to: 2, cut: 30 });
    expect(cutNear(t, 70, 5)).toBeNull();
  });

  it('leave out adjustment layers and sound', () => {
    const t = track([
      clip(1, 0, 30),
      clip(2, 30, 30, { kind: 'adjustment' }),
      clip(3, 60, 30, { video: false }),
    ]);
    expect(cutsOf(t)).toEqual([{ from: null, to: 1, cut: 0 }]);
  });
});

describe('transition windows', () => {
  const t = track([clip(1, 0, 60), clip(2, 60, 60)]);
  const transition = (alignment: Transition['alignment'], duration: number) =>
    ({ from: 1, to: 2, duration, alignment }) as Transition;

  it('are centred with whole frames before the cut', () => {
    expect(transitionWindow(t, transition('center', 30), 2)).toEqual([46, 76]);
    expect(transitionWindow(t, transition('start', 30), 2)).toEqual([60, 90]);
    expect(transitionWindow(t, transition('end', 30), 2)).toEqual([30, 60]);
  });

  it('grow from a dragged edge', () => {
    expect(durationForEdge(transition('center', 30), 60, 'end', 80, 2)).toBe(40);
    expect(durationForEdge(transition('center', 30), 60, 'start', 30, 2)).toBe(60);
    expect(durationForEdge(transition('end', 30), 60, 'start', 50, 2)).toBe(10);
    expect(durationForEdge(transition('start', 30), 60, 'end', 59, 2)).toBe(2);
  });
});

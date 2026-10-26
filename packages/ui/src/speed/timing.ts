import type { Clip, RampPoint, RampShape } from '@cgv/engine-client';

// The clip time map of crates/cgv-model/src/timing.rs, for drawing: how far into
// its media a clip is at each point of its timeline. Times are flicks.

/** The ramp's speed `t` from the clip's start; straight lines between points. */
export function rampSpeed(points: RampPoint[], t: number): number {
  if (!points.length) return 1;
  if (t <= points[0].time) return points[0].speed;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (t <= b.time) return a.speed + ((b.speed - a.speed) * (t - a.time)) / (b.time - a.time);
  }
  return points[points.length - 1].speed;
}

/** Media time the ramp covers over the first `t` of the clip, at speed 1. */
export function rampSpan(points: RampPoint[], t: number): number {
  if (!points.length) return t;
  const first = points[0];
  if (t <= first.time) return first.speed * t;
  let total = first.speed * first.time;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const x = Math.min(t, b.time) - a.time;
    const slope = (b.speed - a.speed) / (b.time - a.time);
    total += a.speed * x + (slope * x * x) / 2;
    if (t <= b.time) return total;
  }
  const last = points[points.length - 1];
  return total + last.speed * (t - last.time);
}

/** How long a freeze frame holds, in seconds. */
export const freezeSeconds = 2;

const speedOf = (clip: Clip) => clip.speed.num / clip.speed.den;

/** How fast the clip plays its media `offset` from its start (0 for a freeze frame). */
export function speedAt(clip: Clip, offset: number): number {
  if (clip.freeze) return 0;
  return speedOf(clip) * rampSpeed(clip.ramp ?? [], offset);
}

/** Media time the first `offset` of the clip covers. */
export function spanAt(clip: Clip, offset: number): number {
  if (clip.freeze) return 0;
  return speedOf(clip) * rampSpan(clip.ramp ?? [], offset);
}

/** The media time shown `offset` from the clip's start, whichever way it plays. */
export function sourceAt(clip: Clip, offset: number): number {
  if (clip.freeze) return clip.sourceIn;
  if (clip.reverse) return clip.sourceIn + spanAt(clip, clip.duration) - spanAt(clip, offset);
  return clip.sourceIn + spanAt(clip, offset);
}

/** The clip's ramp as fractions of its length, as the curve editor and presets give it. */
export function shapeOf(clip: Clip): RampShape[] {
  return (clip.ramp ?? []).map((point) => ({
    at: clip.duration > 0 ? point.time / clip.duration : 0,
    speed: point.speed,
  }));
}

/** The mean speed of a curve given by fractions. */
export function shapeMean(shape: RampShape[]): number {
  if (!shape.length) return 1;
  const points = shape.map((point) => ({ time: point.at, speed: point.speed }));
  return rampSpan(points, 1);
}

/** A named speed curve, by fraction of the clip's length. */
export interface RampPreset {
  id: string;
  label: string;
  shape: RampShape[];
}

const curve = (...points: [number, number][]): RampShape[] =>
  points.map(([at, speed]) => ({ at, speed }));

/** Speed curves for one click: each eases between plateaus, as editors' presets do. */
export const rampPresets: RampPreset[] = [
  {
    id: 'montage',
    label: 'Montage',
    shape: curve([0, 0.8], [0.2, 3], [0.42, 0.5], [0.58, 0.5], [0.8, 3], [1, 0.8]),
  },
  {
    id: 'hero',
    label: 'Hero',
    shape: curve([0, 1.5], [0.35, 1.5], [0.45, 0.25], [0.6, 0.25], [0.7, 1.5], [1, 1.5]),
  },
  {
    id: 'bullet',
    label: 'Bullet',
    shape: curve([0, 2], [0.35, 2], [0.45, 0.15], [0.65, 0.15], [0.75, 2], [1, 2]),
  },
  {
    id: 'jumper',
    label: 'Jumper',
    shape: curve([0, 3], [0.3, 3], [0.4, 0.3], [0.6, 0.3], [0.7, 3], [1, 3]),
  },
  { id: 'flash-in', label: 'Flash in', shape: curve([0, 5], [0.4, 5], [0.6, 1], [1, 1]) },
  { id: 'flash-out', label: 'Flash out', shape: curve([0, 1], [0.4, 1], [0.6, 5], [1, 5]) },
];

/** The preset `shape` matches, if any. */
export function presetOf(shape: RampShape[]): RampPreset | undefined {
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  return rampPresets.find(
    (preset) =>
      preset.shape.length === shape.length &&
      preset.shape.every(
        (point, i) => close(point.at, shape[i].at) && close(point.speed, shape[i].speed),
      ),
  );
}

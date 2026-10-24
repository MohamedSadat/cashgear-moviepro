// Keyframes as the engine evaluates them (crates/cgv-model/src/animation.rs), for
// the inspector's values at the playhead and its curve lanes.
import type { Clip, Color, Interpolation, KeyValue, Keyframe } from '@cgv/engine-client';

/** CSS curve points of each ease. */
const curves: Record<string, [number, number, number, number]> = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
};

/** The Bézier control points an interpolation follows, or null for linear and hold. */
export function curveOf(interpolation: Interpolation): [number, number, number, number] | null {
  if (interpolation.kind === 'bezier') {
    const { x1, y1, x2, y2 } = interpolation;
    return [x1, y1, x2, y2];
  }
  return curves[interpolation.kind] ?? null;
}

function bezierAt(x1: number, y1: number, x2: number, y2: number, x: number): number {
  const along = (a: number, b: number, s: number) => {
    const u = 1 - s;
    return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s;
  };
  const slope = (a: number, b: number, s: number) => {
    const u = 1 - s;
    return 3 * u * u * a + 6 * u * s * (b - a) + 3 * s * s * (1 - b);
  };
  let s = x;
  for (let i = 0; i < 8; i++) {
    const error = along(x1, x2, s) - x;
    if (Math.abs(error) < 1e-9) return along(y1, y2, s);
    const d = slope(x1, x2, s);
    if (Math.abs(d) < 1e-6) break;
    s = Math.min(1, Math.max(0, s - error / d));
  }
  let low = 0;
  let high = 1;
  s = x;
  for (let i = 0; i < 60; i++) {
    const value = along(x1, x2, s);
    if (Math.abs(value - x) < 1e-9) break;
    if (value < x) low = s;
    else high = s;
    s = (low + high) / 2;
  }
  return along(y1, y2, s);
}

/** How far along a stretch the value is at fraction `t` of its time. */
export function progress(interpolation: Interpolation, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  if (interpolation.kind === 'linear') return x;
  if (interpolation.kind === 'hold') return 0;
  const [x1, y1, x2, y2] = curveOf(interpolation)!;
  return bezierAt(x1, y1, x2, y2, x);
}

const toLinear = (c: number) => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (c: number) => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
};

export const isColor = (value: KeyValue): value is Color => typeof value === 'object';

function mix(a: KeyValue, b: KeyValue, t: number): KeyValue {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (isColor(a) && isColor(b)) {
    const channel = (x: number, y: number) => toSrgb(toLinear(x) + (toLinear(y) - toLinear(x)) * t);
    return {
      r: channel(a.r, b.r),
      g: channel(a.g, b.g),
      b: channel(a.b, b.b),
      a: Math.min(1, Math.max(0, a.a + (b.a - a.a) * t)),
    };
  }
  return a;
}

/** The value of `keys` (sorted by time) at `time`, from the clip's start. */
export function valueAt(keys: Keyframe[] | undefined, time: number): KeyValue | undefined {
  if (!keys?.length) return undefined;
  if (time <= keys[0].time) return keys[0].value;
  const next = keys.findIndex((key) => key.time > time);
  if (next < 0) return keys[keys.length - 1].value;
  const before = keys[next - 1];
  const after = keys[next];
  const t = (time - before.time) / (after.time - before.time);
  return mix(before.value, after.value, progress(before.interpolation, t));
}

/** A number property of `clip` at `offset` from its start: animated, or its static value. */
export function numberAt(clip: Clip, property: string, offset: number, fallback: number): number {
  const value = valueAt(clip.keyframes?.[property], offset);
  return typeof value === 'number' ? value : fallback;
}

export const effectProperty = (effect: number, param: string) => `effects.${effect}.${param}`;

export function isAnimated(clip: Clip, property: string): boolean {
  return !!clip.keyframes?.[property]?.length;
}

/** Times (from the clip's start) that have a keyframe of any property, inside the clip. */
export function keyTimes(clip: Clip): number[] {
  const times = new Set<number>();
  for (const keys of Object.values(clip.keyframes ?? {}))
    for (const key of keys) if (key.time >= 0 && key.time < clip.duration) times.add(key.time);
  return [...times].sort((a, b) => a - b);
}

export const interpolations: { kind: Interpolation['kind']; label: string }[] = [
  { kind: 'linear', label: 'Linear' },
  { kind: 'hold', label: 'Hold' },
  { kind: 'easeIn', label: 'Ease in' },
  { kind: 'easeOut', label: 'Ease out' },
  { kind: 'easeInOut', label: 'Ease in and out' },
  { kind: 'bezier', label: 'Custom curve' },
];

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Interpolation, Keyframe } from '@cgv/engine-client';
import type { Gesture } from '../editing/gesture';
import type { EditorState } from '../editing/useEditor';
import { curveOf, interpolations, valueAt } from '../effects/animation';
import { frameDuration } from '../timeline/geometry';
import { clamp, together, type KeyContext } from './fields';

interface Props {
  editor: EditorState;
  context: KeyContext;
  /** Properties edited together; the first one's keys are shown. */
  properties: string[];
  label: string;
  /** The values the property may take. */
  min: number;
  max: number;
  disabled?: boolean;
}

const height = 72;
const pad = 9;
const grab = 6;

type Drag =
  | { kind: 'key'; index: number; origin: Keyframe[]; gesture: Gesture | null }
  | { kind: 'handle'; index: number; which: 1 | 2; origin: Keyframe[]; gesture: Gesture | null };

/**
 * A property's value over its clip: keyframes as diamonds on the curve the
 * interpolations draw. Drag a diamond to move it in time and value; select a
 * stretch to drag its Bézier handles; double-click to add a keyframe.
 */
export function CurveLane({ editor, context, properties, label, min, max, disabled }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(240);
  const [selected, setSelected] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const { clip, offset } = context;
  const keys = clip.keyframes?.[properties[0]] ?? [];
  const project = editor.project.snapshot?.project;
  const frame = project ? frameDuration(project.settings.frameRate) : 1;
  const selectedIndex = keys.findIndex((key) => key.time === selected);

  // The vertical range: the values on the curve, with some room.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i <= 64; i++) {
    const value = valueAt(keys, (clip.duration * i) / 64);
    if (typeof value === 'number') {
      lo = Math.min(lo, value);
      hi = Math.max(hi, value);
    }
  }
  for (const key of keys)
    if (typeof key.value === 'number') {
      lo = Math.min(lo, key.value);
      hi = Math.max(hi, key.value);
    }
  if (!Number.isFinite(lo)) [lo, hi] = [min, max];
  if (hi - lo < 1e-9) {
    const room = Math.max(1e-3, Math.abs(hi) * 0.1, (max - min) * 0.05);
    lo -= room;
    hi += room;
  }
  const margin = (hi - lo) * 0.12;
  lo -= margin;
  hi += margin;

  const x = (time: number) => pad + (time / Math.max(1, clip.duration)) * (width - 2 * pad);
  const y = (value: number) => pad + ((hi - value) / (hi - lo)) * (height - 2 * pad);
  const timeAt = (px: number) => ((px - pad) / (width - 2 * pad)) * clip.duration;
  const valueAtY = (py: number) => hi - ((py - pad) / (height - 2 * pad)) * (hi - lo);

  /** The handle points of the stretch from key `index`, when it curves. */
  const handles = (index: number) => {
    const a = keys[index];
    const b = keys[index + 1];
    const curve = a && b && curveOf(a.interpolation);
    if (!curve || typeof a.value !== 'number' || typeof b.value !== 'number') return null;
    const [x1, y1, x2, y2] = curve;
    const dt = b.time - a.time;
    const dv = b.value - a.value || (hi - lo) / 2;
    return [
      { x: x(a.time + x1 * dt), y: y(a.value + y1 * dv) },
      { x: x(a.time + x2 * dt), y: y(a.value + y2 * dv) },
    ];
  };

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(80, Math.round(entry.contentRect.width))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext('2d');
    if (!element || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    element.width = Math.round(width * dpr);
    element.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const style = getComputedStyle(element);
    const color = (name: string, fallback: string) =>
      style.getPropertyValue(name).trim() || fallback;
    ctx.fillStyle = color('--cgv-curve-bg', '#15181d');
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = color('--cgv-curve-grid', '#262b34');
    ctx.lineWidth = 1;
    for (const level of [lo + margin, hi - margin]) {
      ctx.beginPath();
      ctx.moveTo(pad, Math.round(y(level)) + 0.5);
      ctx.lineTo(width - pad, Math.round(y(level)) + 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = color('--cgv-accent', '#3d8bfd');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let px = pad; px <= width - pad; px += 2) {
      const value = valueAt(keys, timeAt(px));
      if (typeof value !== 'number') continue;
      if (px === pad) ctx.moveTo(px, y(value));
      else ctx.lineTo(px, y(value));
    }
    ctx.stroke();
    const playhead = Math.round(x(offset)) + 0.5;
    ctx.strokeStyle = color('--cgv-playhead', '#ef5a5a');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playhead, 0);
    ctx.lineTo(playhead, height);
    ctx.stroke();
    const points = selectedIndex >= 0 ? handles(selectedIndex) : null;
    if (points) {
      const a = keys[selectedIndex];
      const b = keys[selectedIndex + 1];
      ctx.strokeStyle = color('--cgv-clip-selected', '#f2b84b');
      ctx.fillStyle = ctx.strokeStyle;
      for (const [index, point] of points.entries()) {
        const anchor = index === 0 ? a : b;
        ctx.beginPath();
        ctx.moveTo(x(anchor.time), y(anchor.value as number));
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const key of keys) {
      if (typeof key.value !== 'number') continue;
      const kx = x(key.time);
      const ky = y(key.value);
      const size = key.time === selected ? 6 : 4.5;
      ctx.fillStyle =
        key.time === selected
          ? color('--cgv-clip-selected', '#f2b84b')
          : color('--cgv-text', '#eef1f6');
      ctx.beginPath();
      ctx.moveTo(kx, ky - size);
      ctx.lineTo(kx + size, ky);
      ctx.lineTo(kx, ky + size);
      ctx.lineTo(kx - size, ky);
      ctx.closePath();
      ctx.fill();
    }
  });

  const local = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { px: event.clientX - rect.left, py: event.clientY - rect.top };
  };
  const send = (next: Keyframe[], gesture: Gesture | null) =>
    gesture?.step(
      together(
        properties.map((property) => ({
          type: 'setKeyframes' as const,
          clip: clip.id,
          property,
          keys: next,
        })),
      ),
    );

  const down = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (disabled || event.button !== 0) return;
    const { px, py } = local(event);
    const points = selectedIndex >= 0 ? handles(selectedIndex) : null;
    const handle = points?.findIndex((p) => Math.hypot(p.x - px, p.y - py) <= grab) ?? -1;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (handle >= 0) {
      drag.current = {
        kind: 'handle',
        index: selectedIndex,
        which: (handle + 1) as 1 | 2,
        origin: keys,
        gesture: null,
      };
      return;
    }
    const index = keys.findIndex(
      (key) =>
        typeof key.value === 'number' &&
        Math.abs(x(key.time) - px) <= grab &&
        Math.abs(y(key.value) - py) <= grab,
    );
    if (index >= 0) {
      setSelected(keys[index].time);
      drag.current = { kind: 'key', index, origin: keys, gesture: null };
      return;
    }
    // A press on a stretch selects the key it starts from, to show its handles.
    const time = timeAt(px);
    const before = [...keys].reverse().find((key) => key.time <= time);
    setSelected(before?.time ?? null);
  };

  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    if (!current) return;
    const { px, py } = local(event);
    current.gesture ??= editor.project.gesture(`Change ${label.toLowerCase()} curve`);
    const next = current.origin.map((key) => ({ ...key }));
    if (current.kind === 'key') {
      const previous = next[current.index - 1];
      const following = next[current.index + 1];
      const time = clamp(
        Math.round(timeAt(px) / frame) * frame,
        previous ? previous.time + frame : -Infinity,
        following ? following.time - frame : Infinity,
      );
      next[current.index].time = time;
      next[current.index].value = clamp(valueAtY(py), min, max);
      setSelected(time);
    } else {
      const a = next[current.index];
      const b = next[current.index + 1];
      const [x1, y1, x2, y2] = curveOf(a.interpolation) ?? [0.33, 0.33, 0.67, 0.67];
      const dt = b.time - a.time;
      const dv = (b.value as number) - (a.value as number);
      const hx = clamp((timeAt(px) - a.time) / dt, 0, 1);
      const hy = dv ? clamp((valueAtY(py) - (a.value as number)) / dv, -2, 3) : null;
      const curve: Interpolation =
        current.which === 1
          ? { kind: 'bezier', x1: hx, y1: hy ?? y1, x2, y2 }
          : { kind: 'bezier', x1, y1, x2: hx, y2: hy ?? y2 };
      a.interpolation = curve;
    }
    send(next, current.gesture);
  };

  const up = async () => {
    const current = drag.current;
    drag.current = null;
    if (current?.gesture) await editor.project.finish(current.gesture);
  };

  const addKey = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const time = clamp(
      Math.round(timeAt(event.clientX - rect.left) / frame) * frame,
      0,
      clip.duration - frame,
    );
    const value = valueAt(keys, time);
    if (typeof value !== 'number') return;
    setSelected(time);
    void editor.project.execute(
      together(
        properties.map((property) => ({
          type: 'setKeyframe' as const,
          clip: clip.id,
          property,
          time,
          value,
        })),
      ),
    );
  };

  const key = selectedIndex >= 0 ? keys[selectedIndex] : null;
  const setInterpolation = (kind: Interpolation['kind']) => {
    if (!key) return;
    const interpolation: Interpolation =
      kind === 'bezier'
        ? { kind: 'bezier', ...pointsOf(curveOf(key.interpolation) ?? [0.25, 0.1, 0.25, 1]) }
        : ({ kind } as Interpolation);
    void editor.project.execute(
      together(
        properties.map((property) => ({
          type: 'setInterpolation' as const,
          clip: clip.id,
          property,
          times: [key.time],
          interpolation,
        })),
      ),
    );
  };

  return (
    <div className="cgv-curve" data-testid="curve-lane">
      <canvas
        ref={canvas}
        className="cgv-curve-canvas"
        style={{ height }}
        role="img"
        aria-label={`${label} over the clip, ${keys.length} keyframes`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => void up()}
        onPointerCancel={() => void up()}
        onDoubleClick={addKey}
      />
      {key && (
        <div className="cgv-curve-tools">
          <select
            aria-label="Interpolation after this keyframe"
            value={key.interpolation.kind}
            disabled={disabled}
            onChange={(event) =>
              setInterpolation(event.currentTarget.value as Interpolation['kind'])
            }
          >
            {interpolations.map((option) => (
              <option key={option.kind} value={option.kind}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="cgv-link-button"
            disabled={disabled}
            onClick={() => {
              setSelected(null);
              void editor.project.execute(
                together(
                  properties.map((property) => ({
                    type: 'removeKeyframes' as const,
                    clip: clip.id,
                    property,
                    times: [key.time],
                  })),
                ),
              );
            }}
          >
            Delete keyframe
          </button>
        </div>
      )}
    </div>
  );
}

function pointsOf([x1, y1, x2, y2]: [number, number, number, number]) {
  return { x1, y1, x2, y2 };
}

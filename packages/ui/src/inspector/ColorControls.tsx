import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Command, Effect } from '@cgv/engine-client';
import type { Gesture } from '../editing/gesture';
import type { EditorState } from '../editing/useEditor';
import { effectProperty, isAnimated, numberAt } from '../effects/animation';
import { together, type KeyContext } from './fields';

// Grading controls for the Color Wheels and Curves effects: the wheels and
// curves colourists work with, over the effects' own numbers, so they keyframe
// and undo as every setting does. A drag is one undo step.

interface GradeProps {
  editor: EditorState;
  context: KeyContext;
  effect: Effect;
  disabled?: boolean;
}

/** The value of setting `id` at the playhead: its keyframes, or its setting. */
function valueAt(context: KeyContext, effect: Effect, id: string, fallback: number): number {
  const property = effectProperty(effect.id, id);
  const base = typeof effect.params[id] === 'number' ? (effect.params[id] as number) : fallback;
  return isAnimated(context.clip, property)
    ? numberAt(context.clip, property, context.offset, base)
    : base;
}

/** Sets `values`: keyframes at the playhead where a setting is keyframed, else the settings. */
function gradeCommand(
  context: KeyContext,
  effect: Effect,
  values: Record<string, number>,
): Command {
  const plain: Effect['params'] = {};
  const keys: Command[] = [];
  for (const [id, value] of Object.entries(values)) {
    const property = effectProperty(effect.id, id);
    if (isAnimated(context.clip, property))
      keys.push({
        type: 'setKeyframe',
        clip: context.clip.id,
        property,
        time: context.offset,
        value,
      });
    else plain[id] = value;
  }
  const commands: Command[] = Object.keys(plain).length
    ? [
        { type: 'setEffectParams', clip: context.clip.id, effect: effect.id, params: plain },
        ...keys,
      ]
    : keys;
  return together(commands);
}

/** Pointer drags over an element as one gesture: `at` turns a position into settings. */
function useDrag(
  props: GradeProps,
  label: string,
  at: (x: number, y: number, rect: DOMRect) => Record<string, number>,
) {
  const gesture = useRef<Gesture | null>(null);
  const apply = (event: ReactPointerEvent<Element>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const current = (gesture.current ??= props.editor.project.gesture(label));
    current?.step(
      gradeCommand(
        props.context,
        props.effect,
        at(event.clientX - rect.left, event.clientY - rect.top, rect),
      ),
    );
  };
  return {
    onPointerDown(event: ReactPointerEvent<Element>) {
      if (props.disabled || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      apply(event);
    },
    onPointerMove(event: ReactPointerEvent<Element>) {
      if (gesture.current) apply(event);
    },
    async onPointerUp() {
      const current = gesture.current;
      gesture.current = null;
      if (current) await props.editor.project.finish(current);
    },
  };
}

const wheels = [
  { id: 'lift', label: 'Lift' },
  { id: 'gamma', label: 'Gamma' },
  { id: 'gain', label: 'Gain' },
  { id: 'offset', label: 'Offset' },
];
const wheelSize = 96;

function Wheel(props: GradeProps & { id: string; label: string }) {
  const { context, effect, id, label } = props;
  const hue = valueAt(context, effect, `${id}_hue`, 0);
  const amount = valueAt(context, effect, `${id}_amount`, 0);
  const master = valueAt(context, effect, `${id}_master`, 0);
  const radius = wheelSize / 2;
  const angle = (hue * Math.PI) / 180;
  const drag = useDrag(props, `Change ${label.toLowerCase()}`, (x, y) => {
    const dx = x - radius;
    const dy = radius - y;
    const distance = Math.min(1, Math.hypot(dx, dy) / (radius - 4));
    const degrees = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    return { [`${id}_hue`]: Math.round(degrees), [`${id}_amount`]: Number(distance.toFixed(2)) };
  });
  const masterDrag = useDrag(props, `Change ${label.toLowerCase()} brightness`, (x, _y, rect) => ({
    [`${id}_master`]: Number(Math.max(-1, Math.min(1, (x / rect.width) * 2 - 1)).toFixed(2)),
  }));
  return (
    <div className="cgv-wheel" data-testid={`wheel-${id}`}>
      <span className="cgv-field-label">{label}</span>
      <svg
        width={wheelSize}
        height={wheelSize}
        role="slider"
        aria-label={`${label} colour`}
        aria-valuetext={`${Math.round(amount * 100)}% towards ${Math.round(hue)}°`}
        {...drag}
      >
        <defs>
          <radialGradient id={`wheel-fade-${id}`}>
            <stop offset="0%" stopColor="#808080" />
            <stop offset="100%" stopColor="#808080" stopOpacity={0} />
          </radialGradient>
        </defs>
        <circle cx={radius} cy={radius} r={radius - 2} className="cgv-wheel-hues" />
        <circle cx={radius} cy={radius} r={radius - 2} fill={`url(#wheel-fade-${id})`} />
        <circle
          cx={radius + Math.cos(angle) * amount * (radius - 4)}
          cy={radius - Math.sin(angle) * amount * (radius - 4)}
          r={5}
          className="cgv-wheel-puck"
        />
      </svg>
      <div
        className="cgv-wheel-master"
        role="slider"
        aria-label={`${label} brightness`}
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={Math.round(master * 100)}
        {...masterDrag}
      >
        <div className="cgv-wheel-master-fill" style={{ left: `${((master + 1) / 2) * 100}%` }} />
      </div>
      <span className="cgv-muted">{Math.round(master * 100)}%</span>
    </div>
  );
}

const curveSets = {
  luma: {
    label: 'Luma',
    points: 5,
    prefix: 'luma_',
    min: 0,
    max: 1,
    neutral: (i: number) => i / 4,
  },
  red: { label: 'Red', points: 5, prefix: 'red_', min: 0, max: 1, neutral: (i: number) => i / 4 },
  green: {
    label: 'Green',
    points: 5,
    prefix: 'green_',
    min: 0,
    max: 1,
    neutral: (i: number) => i / 4,
  },
  blue: {
    label: 'Blue',
    points: 5,
    prefix: 'blue_',
    min: 0,
    max: 1,
    neutral: (i: number) => i / 4,
  },
  hueHue: {
    label: 'Hue vs hue',
    points: 6,
    prefix: 'hue_hue_',
    min: -180,
    max: 180,
    neutral: () => 0,
  },
  hueSat: { label: 'Hue vs sat', points: 6, prefix: 'hue_sat_', min: 0, max: 2, neutral: () => 1 },
  lumaSat: {
    label: 'Luma vs sat',
    points: 5,
    prefix: 'luma_sat_',
    min: 0,
    max: 2,
    neutral: () => 1,
  },
} as const;
type CurveSet = keyof typeof curveSets;
const curveWidth = 220;
const curveHeight = 140;

function Curves(props: GradeProps) {
  const { context, effect } = props;
  const [shown, setShown] = useState<CurveSet>('luma');
  const set = curveSets[shown];
  const values = Array.from({ length: set.points }, (_, i) =>
    valueAt(context, effect, `${set.prefix}${i}`, set.neutral(i)),
  );
  const spacing = set.points === 6 ? curveWidth / 6 : curveWidth / 4;
  const xOf = (i: number) => (set.points === 6 ? (i + 0.5) * spacing : i * spacing);
  const yOf = (value: number) => curveHeight * (1 - (value - set.min) / (set.max - set.min));
  const nearest = useRef(0);
  const drag = useDrag(props, `Change the ${set.label.toLowerCase()} curve`, (_x, y) => {
    const value = set.min + (1 - Math.max(0, Math.min(1, y / curveHeight))) * (set.max - set.min);
    return { [`${set.prefix}${nearest.current}`]: Number(value.toFixed(3)) };
  });
  return (
    <div className="cgv-curves" data-testid="curves">
      <select
        aria-label="Curve"
        data-testid="curve-set"
        value={shown}
        onChange={(event) => setShown(event.target.value as CurveSet)}
      >
        {Object.entries(curveSets).map(([id, curve]) => (
          <option key={id} value={id}>
            {curve.label}
          </option>
        ))}
      </select>
      <svg
        width={curveWidth}
        height={curveHeight}
        className="cgv-curve"
        data-curve={shown}
        {...drag}
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          let best = 0;
          values.forEach((_, i) => {
            if (Math.abs(xOf(i) - x) < Math.abs(xOf(best) - x)) best = i;
          });
          nearest.current = best;
          drag.onPointerDown(event);
        }}
      >
        <line
          x1={0}
          y1={yOf(set.neutral(0))}
          x2={curveWidth}
          y2={yOf(set.neutral(set.points - 1))}
          className="cgv-curve-neutral"
        />
        <polyline
          points={values.map((value, i) => `${xOf(i)},${yOf(value)}`).join(' ')}
          className="cgv-curve-line"
        />
        {values.map((value, i) => (
          <circle key={i} cx={xOf(i)} cy={yOf(value)} r={4} className="cgv-curve-point" />
        ))}
      </svg>
    </div>
  );
}

/** The Colour section of a Color Wheels or Curves effect; null for other effects. */
export function GradeControls(props: GradeProps) {
  if (props.effect.pack !== 'builtin') return null;
  if (props.effect.kind === 'color-wheels')
    return (
      <div className="cgv-wheels">
        {wheels.map((wheel) => (
          <Wheel key={wheel.id} {...props} id={wheel.id} label={wheel.label} />
        ))}
      </div>
    );
  if (props.effect.kind === 'curves') return <Curves {...props} />;
  return null;
}

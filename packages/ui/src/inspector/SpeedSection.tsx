import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { CgButton } from '@cashgear/ui';
import {
  FLICKS_PER_SECOND,
  type Clip,
  type Command,
  type RampShape,
  type Speed,
} from '@cgv/engine-client';
import type { Gesture } from '../editing/gesture';
import type { EditorState } from '../editing/useEditor';
import {
  freezeSeconds,
  presetOf,
  rampPresets,
  rampSpeed,
  shapeMean,
  shapeOf,
} from '../speed/timing';
import { Section } from './AnimatedField';
import { ScrubField, clamp } from './fields';

const speeds: Speed[] = [
  { num: 1, den: 4 },
  { num: 1, den: 2 },
  { num: 1, den: 1 },
  { num: 3, den: 2 },
  { num: 2, den: 1 },
  { num: 4, den: 1 },
];

/** A speed as a reduced fraction, to two decimal places. */
export function speedOf(value: number): Speed {
  let num = Math.round(clamp(value, 0.1, 100) * 100);
  let den = 100;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = gcd(num, den);
  num /= divisor;
  den /= divisor;
  return { num, den };
}

const speedLabel = (speed: Speed) => `${Number((speed.num / speed.den).toFixed(2))}×`;

const flat: RampShape[] = [
  { at: 0, speed: 1 },
  { at: 1, speed: 1 },
];

// The curve editor: speed on a log scale from 0.1× to 10×.
const editorHeight = 96;
const pad = 8;
const lowest = 0.1;
const highest = 10;
const grid = [0.1, 0.25, 0.5, 1, 2, 4, 10];

/**
 * A clip's speed ramp as a curve over its length: drag a point up or down to
 * change its speed, along to move it; double-click to add a point, Alt-click to
 * remove one. Each drag is one undo step, and the clip's length follows.
 */
function RampEditor({
  editor,
  clip,
  shape,
  disabled,
}: {
  editor: EditorState;
  clip: Clip;
  shape: RampShape[];
  disabled: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(240);
  const drag = useRef<{ index: number; origin: RampShape[]; gesture: Gesture } | null>(null);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(120, Math.round(entry.contentRect.width))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const span = Math.log(highest / lowest);
  const x = (at: number) => pad + at * (width - 2 * pad);
  const y = (speed: number) =>
    pad + (1 - Math.log(clamp(speed, lowest, highest) / lowest) / span) * (editorHeight - 2 * pad);
  const atOf = (px: number) => clamp((px - pad) / (width - 2 * pad), 0, 1);
  const speedAtY = (py: number) => {
    const fraction = 1 - (py - pad) / (editorHeight - 2 * pad);
    return Number(clamp(lowest * Math.exp(fraction * span), lowest, highest).toPrecision(3));
  };
  const local = (event: { clientX: number; clientY: number }) => {
    const box = svg.current!.getBoundingClientRect();
    return { px: event.clientX - box.left, py: event.clientY - box.top };
  };
  const command = (points: RampShape[]): Command => ({ type: 'setRamp', clip: clip.id, points });
  const curve = shape.length ? shape : flat;
  // The curve as the clip plays it: straight lines between points.
  const path = curve
    .map((point, i) => `${i ? 'L' : 'M'}${x(point.at).toFixed(1)},${y(point.speed).toFixed(1)}`)
    .join(' ');
  const ends = `M${x(0)},${y(curve[0].speed)} L${x(curve[0].at)},${y(curve[0].speed)} M${x(curve[curve.length - 1].at)},${y(curve[curve.length - 1].speed)} L${x(1)},${y(curve[curve.length - 1].speed)}`;

  const down = (index: number, event: ReactPointerEvent<SVGCircleElement>) => {
    if (disabled || event.button !== 0) return;
    event.stopPropagation();
    if (event.altKey) {
      if (curve.length > 2)
        void editor.project.execute(command(curve.filter((_, i) => i !== index)));
      return;
    }
    const gesture = editor.project.gesture('Change speed ramp');
    if (!gesture) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { index, origin: curve, gesture };
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    if (!current) return;
    const { px, py } = local(event);
    const points = current.origin.map((point) => ({ ...point }));
    const i = current.index;
    // The first and last points stay at the ends; others stay between their neighbours.
    if (i > 0 && i < points.length - 1)
      points[i].at = clamp(atOf(px), points[i - 1].at + 0.01, points[i + 1].at - 0.01);
    points[i].speed = speedAtY(py);
    current.gesture.step(command(points));
  };
  const up = async () => {
    const current = drag.current;
    drag.current = null;
    if (current) await editor.project.finish(current.gesture);
  };
  const add = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (disabled) return;
    const { px, py } = local(event);
    const at = atOf(px);
    if (curve.some((point) => Math.abs(point.at - at) < 0.01)) return;
    const points = [...curve, { at, speed: speedAtY(py) }].sort((a, b) => a.at - b.at);
    void editor.project.execute(command(points));
  };
  return (
    <svg
      ref={svg}
      className="cgv-ramp"
      data-testid="ramp-editor"
      role="img"
      aria-label="Speed ramp: double-click to add a point, Alt-click a point to remove it"
      height={editorHeight}
      onPointerMove={move}
      onPointerUp={() => void up()}
      onPointerCancel={() => void up()}
      onDoubleClick={add}
    >
      {grid.map((speed) => (
        <g key={speed} className={speed === 1 ? 'cgv-ramp-unit' : 'cgv-ramp-grid'}>
          <line x1={pad} x2={width - pad} y1={y(speed)} y2={y(speed)} />
          <text x={pad + 2} y={y(speed) - 2}>
            {speed}×
          </text>
        </g>
      ))}
      <path className="cgv-ramp-ends" d={ends} />
      <path className="cgv-ramp-line" d={path} />
      {curve.map((point, index) => (
        <circle
          key={index}
          className="cgv-ramp-point"
          data-testid="ramp-point"
          cx={x(point.at)}
          cy={y(point.speed)}
          r={5}
          onPointerDown={(event) => down(index, event)}
        >
          <title>{`${Number(point.speed.toFixed(2))}× at ${Math.round(point.at * 100)}%`}</title>
        </circle>
      ))}
    </svg>
  );
}

/**
 * A clip's speed: one speed throughout, or a ramp from presets or drawn; whether
 * it plays backwards, keeps its pitch and blends frames in slow motion; and a
 * freeze frame at the playhead.
 */
export function SpeedSection({
  editor,
  clip,
  playhead,
  frame,
  disabled,
}: {
  editor: EditorState;
  clip: Clip;
  playhead: number;
  frame: number;
  disabled: boolean;
}) {
  const shape = shapeOf(clip);
  const [ramping, setRamping] = useState(shape.length > 0);
  useEffect(() => setRamping((clip.ramp?.length ?? 0) > 0), [clip.id, clip.ramp?.length]);
  const run = (command: Command) => void editor.project.execute(command);
  const speed = clip.speed;
  const base = speed.num / speed.den;
  const preset = presetOf(shape);
  const seconds = clip.duration / FLICKS_PER_SECOND;
  const offset = clamp(playhead - clip.start, 0, clip.duration);
  const now = base * rampSpeed(clip.ramp ?? [], offset);
  const under = playhead >= clip.start && playhead < clip.start + clip.duration;
  if (clip.freeze)
    return (
      <Section title="Speed">
        <p className="cgv-muted">
          A freeze frame holds one frame: drag its edges to hold it longer.
        </p>
      </Section>
    );
  return (
    <Section title="Speed">
      <div className="cgv-segmented" role="group" aria-label="Speed kind">
        {(['uniform', 'ramp'] as const).map((kind) => {
          const active = (kind === 'ramp') === ramping;
          return (
            <CgButton
              key={kind}
              appearance={active ? 'soft' : 'ghost'}
              intent={active ? 'primary' : 'neutral'}
              size="small"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => {
                setRamping(kind === 'ramp');
                // Back to one speed: the ramp goes, and the clip keeps its media.
                if (kind === 'uniform' && shape.length)
                  run({ type: 'setRamp', clip: clip.id, points: [] });
              }}
            >
              {kind === 'uniform' ? 'Uniform' : 'Ramp'}
            </CgButton>
          );
        })}
      </div>
      {!ramping && (
        <>
          <div className="cgv-speed-presets" role="group" aria-label="Speed presets">
            {speeds.map((preset) => {
              const active = preset.num === speed.num && preset.den === speed.den;
              return (
                <CgButton
                  key={speedLabel(preset)}
                  appearance={active ? 'soft' : 'ghost'}
                  intent={active ? 'primary' : 'neutral'}
                  size="small"
                  aria-pressed={active}
                  disabled={disabled}
                  onClick={() => run({ type: 'setSpeed', clip: clip.id, speed: preset })}
                >
                  {speedLabel(preset)}
                </CgButton>
              );
            })}
          </div>
          <ScrubField
            label="Speed"
            value={Number(base.toFixed(2))}
            min={0.1}
            max={100}
            step={0.01}
            precision={2}
            unit="×"
            testId="field-speed"
            editor={editor}
            disabled={disabled}
            command={(value) => ({ type: 'setSpeed', clip: clip.id, speed: speedOf(value) })}
          />
        </>
      )}
      {ramping && (
        <>
          <div className="cgv-speed-presets" role="group" aria-label="Speed ramp presets">
            {rampPresets.map((item) => {
              const active = preset?.id === item.id;
              return (
                <CgButton
                  key={item.id}
                  appearance={active ? 'soft' : 'ghost'}
                  intent={active ? 'primary' : 'neutral'}
                  size="small"
                  aria-pressed={active}
                  disabled={disabled}
                  onClick={() => run({ type: 'setRamp', clip: clip.id, points: item.shape })}
                >
                  {item.label}
                </CgButton>
              );
            })}
          </div>
          <RampEditor editor={editor} clip={clip} shape={shape} disabled={disabled} />
          <p className="cgv-muted" data-testid="ramp-summary">
            {shape.length
              ? `${preset ? preset.label : 'Custom'}: ${Number((base * shapeMean(shape)).toFixed(2))}× on average, ${Number(now.toFixed(2))}× at the playhead.`
              : 'Pick a preset or drag the line to draw a ramp.'}
          </p>
        </>
      )}
      <p className="cgv-muted">{`Plays for ${seconds.toFixed(2)} s.`}</p>
      <label className="cgv-check-row">
        <input
          type="checkbox"
          data-testid="field-reverse"
          checked={!!clip.reverse}
          disabled={disabled}
          onChange={(event) =>
            run({ type: 'setReverse', clip: clip.id, reverse: event.currentTarget.checked })
          }
        />
        Reverse
      </label>
      {clip.audio && (
        <label className="cgv-check-row">
          <input
            type="checkbox"
            data-testid="field-keep-pitch"
            checked={clip.keepPitch ?? true}
            disabled={disabled}
            onChange={(event) =>
              run({
                type: 'setClipProperties',
                clip: clip.id,
                properties: { keepPitch: event.currentTarget.checked },
              })
            }
          />
          Keep the pitch of its sound
        </label>
      )}
      {clip.video && (
        <label className="cgv-check-row">
          <input
            type="checkbox"
            data-testid="field-frame-blending"
            checked={!!clip.frameBlending}
            disabled={disabled}
            onChange={(event) =>
              run({
                type: 'setClipProperties',
                clip: clip.id,
                properties: { frameBlending: event.currentTarget.checked },
              })
            }
          />
          Blend frames in slow motion
        </label>
      )}
      {clip.audio && base * Math.max(1, ...shape.map((p) => p.speed)) > 4 && (
        <p className="cgv-muted">Sound is silent where the clip plays faster than 4×.</p>
      )}
      {clip.video && (
        <CgButton
          appearance="ghost"
          size="small"
          data-testid="freeze-frame"
          disabled={disabled || !under}
          title={under ? undefined : 'Move the playhead over the clip'}
          onClick={() =>
            run({
              type: 'freezeFrame',
              clip: clip.id,
              at: playhead,
              duration: Math.round((freezeSeconds * FLICKS_PER_SECOND) / frame) * frame,
            })
          }
        >
          Freeze frame at the playhead
        </CgButton>
      )}
    </Section>
  );
}

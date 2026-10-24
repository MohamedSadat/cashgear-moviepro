import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { CgButton, CgNumericEdit } from '@cashgear/ui';
import type { Clip, ClipProperties, Command, Speed } from '@cgv/engine-client';
import type { Gesture } from '../editing/gesture';
import type { EditorState } from '../editing/useEditor';

interface FieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Change per pixel of scrubbing, and per arrow step. */
  step: number;
  precision: number;
  unit: string;
  testId: string;
  /** The command that sets the field to `value`. */
  command(value: number): Command;
  editor: EditorState;
  disabled?: boolean;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * A number with a label that scrubs: dragging the label changes the value live,
 * as one undo step. Typing a value and pressing Enter (or leaving) sets it.
 */
function ScrubField(props: FieldProps) {
  const { label, value, min, max, step, precision, unit, testId, command, editor, disabled } =
    props;
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const drag = useRef<{ x: number; start: number; gesture: Gesture | null } | null>(null);
  const round = (next: number) => Number(clamp(next, min, max).toFixed(precision));
  const shown = scrubbing ?? value;

  const down = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: value, gesture: null };
  };
  const move = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.x;
    if (!current.gesture && Math.abs(dx) < 2) return;
    current.gesture ??= editor.project.gesture(`Change ${label.toLowerCase()}`);
    const factor = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
    const next = round(current.start + dx * step * factor);
    setScrubbing(next);
    current.gesture?.step(command(next));
  };
  const up = async () => {
    const current = drag.current;
    drag.current = null;
    if (current?.gesture) await editor.project.finish(current.gesture);
    setScrubbing(null);
  };

  return (
    <label className="cgv-field" data-testid={testId}>
      <span
        className="cgv-field-label"
        title={`Drag to change ${label.toLowerCase()}; Shift for bigger steps, Alt for finer ones`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => void up()}
        onPointerCancel={() => void up()}
      >
        {label}
      </span>
      <CgNumericEdit
        size="small"
        aria-label={label}
        value={shown}
        min={min}
        max={max}
        step={step * 10}
        precision={precision}
        useGrouping={false}
        commitMode="blur"
        disabled={disabled}
        suffix={unit}
        onValueChange={(next, details) => {
          if (next === null || details.reason === 'reset' || next === value) return;
          void editor.project.execute(command(round(next)));
        }}
      />
    </label>
  );
}

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="cgv-inspector-section" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Picture, sound and speed of the selected clip. Every change is an undoable command. */
export function Inspector({ editor }: { editor: EditorState }) {
  const clip: Clip | null = editor.focused;
  const snapshot = editor.project.snapshot;
  if (!clip || !snapshot)
    return (
      <aside className="cgv-inspector" data-testid="inspector" aria-label="Inspector">
        <h2>Inspector</h2>
        <p className="cgv-muted">Select a clip to change its picture, sound and speed.</p>
      </aside>
    );
  const media = snapshot.project.media.find((item) => item.id === clip.media);
  const still = media?.kind === 'image';
  const locked = snapshot.project.tracks.some(
    (track) => track.locked && track.clips.some((c) => c.id === clip.id),
  );
  const set = (properties: ClipProperties): Command => ({
    type: 'setClipProperties',
    clip: clip.id,
    properties,
  });
  const transform = clip.transform;
  const crop = clip.crop;
  const field = (props: Omit<FieldProps, 'editor' | 'disabled'>) => (
    <ScrubField key={props.testId} {...props} editor={editor} disabled={locked} />
  );
  const speed = clip.speed;
  return (
    <aside
      className="cgv-inspector"
      data-testid="inspector"
      data-clip-id={clip.id}
      aria-label="Inspector"
    >
      <h2 title={media?.name}>{media?.name ?? 'Clip'}</h2>
      {locked && <p className="cgv-muted">This clip is on a locked track.</p>}
      {clip.video && (
        <Section title="Transform">
          {field({
            label: 'Position X',
            value: transform.x,
            min: -100000,
            max: 100000,
            step: 1,
            precision: 1,
            unit: 'px',
            testId: 'field-x',
            command: (x) => set({ transform: { x } }),
          })}
          {field({
            label: 'Position Y',
            value: transform.y,
            min: -100000,
            max: 100000,
            step: 1,
            precision: 1,
            unit: 'px',
            testId: 'field-y',
            command: (y) => set({ transform: { y } }),
          })}
          {field({
            label: 'Scale',
            value: Number((transform.scaleX * 100).toFixed(1)),
            min: 1,
            max: 10000,
            step: 0.5,
            precision: 1,
            unit: '%',
            testId: 'field-scale',
            command: (scale) => set({ transform: { scaleX: scale / 100, scaleY: scale / 100 } }),
          })}
          {field({
            label: 'Rotation',
            value: transform.rotation,
            min: -3600,
            max: 3600,
            step: 0.5,
            precision: 1,
            unit: '°',
            testId: 'field-rotation',
            command: (rotation) => set({ transform: { rotation } }),
          })}
          {field({
            label: 'Opacity',
            value: Number((clip.opacity * 100).toFixed(1)),
            min: 0,
            max: 100,
            step: 0.5,
            precision: 1,
            unit: '%',
            testId: 'field-opacity',
            command: (opacity) => set({ opacity: opacity / 100 }),
          })}
          <CgButton
            appearance="ghost"
            size="small"
            disabled={locked}
            onClick={() =>
              void editor.project.execute(
                set({
                  transform: {
                    x: 0,
                    y: 0,
                    scaleX: 1,
                    scaleY: 1,
                    rotation: 0,
                    anchorX: 0.5,
                    anchorY: 0.5,
                  },
                  opacity: 1,
                }),
              )
            }
          >
            Reset transform
          </CgButton>
        </Section>
      )}
      {clip.video && (
        <Section title="Crop">
          {(['left', 'top', 'right', 'bottom'] as const).map((side) =>
            field({
              label: side[0].toUpperCase() + side.slice(1),
              value: Number((crop[side] * 100).toFixed(1)),
              min: 0,
              max: 95,
              step: 0.25,
              precision: 1,
              unit: '%',
              testId: `field-crop-${side}`,
              command: (value) => set({ crop: { [side]: value / 100 } }),
            }),
          )}
        </Section>
      )}
      {clip.audio && (
        <Section title="Audio">
          {field({
            label: 'Volume',
            value: clip.volumeDb,
            min: -96,
            max: 24,
            step: 0.1,
            precision: 1,
            unit: 'dB',
            testId: 'field-volume',
            command: (volumeDb) => set({ volumeDb }),
          })}
        </Section>
      )}
      {!still && (
        <Section title="Speed">
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
                  disabled={locked}
                  onClick={() =>
                    void editor.project.execute({ type: 'setSpeed', clip: clip.id, speed: preset })
                  }
                >
                  {speedLabel(preset)}
                </CgButton>
              );
            })}
          </div>
          {field({
            label: 'Speed',
            value: Number((speed.num / speed.den).toFixed(2)),
            min: 0.1,
            max: 100,
            step: 0.01,
            precision: 2,
            unit: '×',
            testId: 'field-speed',
            command: (value) => ({ type: 'setSpeed', clip: clip.id, speed: speedOf(value) }),
          })}
          {speed.num !== speed.den && clip.audio && (
            <p className="cgv-muted">Sound plays only at normal speed for now.</p>
          )}
        </Section>
      )}
    </aside>
  );
}

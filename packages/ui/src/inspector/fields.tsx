import {
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { CgNumericEdit } from '@cashgear/ui';
import type { Clip, Color, Command, KeyValue } from '@cgv/engine-client';
import type { Gesture } from '../editing/gesture';
import type { EditorState } from '../editing/useEditor';
import { isAnimated, valueAt } from '../effects/animation';
import { colorToHex, hexToColor } from '../effects/catalog';
import type { PlaybackControls } from '../monitor/usePlayback';

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * The playhead while paused. Playing keeps the last paused time, so fields that
 * read it never re-render with every frame.
 */
export function usePausedTime(playback: PlaybackControls): number {
  const last = useRef(0);
  return useSyncExternalStore(playback.subscribe, () => {
    const state = playback.state;
    if (state && !state.playing) last.current = state.time;
    return last.current;
  });
}

/** Where keyframes go for a clip: the playhead's frame inside it, from its start. */
export interface KeyContext {
  clip: Clip;
  /** The playhead's offset into the clip, on a frame, inside the clip. */
  offset: number;
}

export function keyContext(clip: Clip, playhead: number, frame: number): KeyContext {
  const last = Math.max(0, clip.duration - frame);
  const offset = Math.round((playhead - clip.start) / frame) * frame;
  return { clip, offset: clamp(offset, 0, last) };
}

/** One command, or several as a batch (one undo step, one gesture step). */
export function together(commands: Command[]): Command {
  return commands.length === 1 ? commands[0] : { type: 'batch', commands };
}

/** Sets `value` as the keyframe of each of `properties` at the playhead. */
export function keyCommand(context: KeyContext, properties: string[], value: KeyValue): Command {
  return together(
    properties.map((property) => ({
      type: 'setKeyframe',
      clip: context.clip.id,
      property,
      time: context.offset,
      value,
    })),
  );
}

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
  /** Keyframe controls shown before the label. */
  keys?: ReactNode;
}

/**
 * A number with a label that scrubs: dragging the label changes the value live,
 * as one undo step. Typing a value and pressing Enter (or leaving) sets it.
 */
export function ScrubField(props: FieldProps) {
  const { label, value, min, max, step, precision, unit, testId, command, editor, disabled } =
    props;
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const drag = useRef<{ x: number; start: number; gesture: Gesture | null } | null>(null);
  const round = (next: number) => Number(clamp(next, min, max).toFixed(precision));
  const shown = scrubbing ?? Number(value.toFixed(precision));

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
      {props.keys}
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
          if (next === null || details.reason === 'reset' || next === shown) return;
          void editor.project.execute(command(round(next)));
        }}
      />
    </label>
  );
}

interface KeyControlsProps {
  editor: EditorState;
  context: KeyContext;
  /** Properties keyed together (a uniform scale's x and y); the first leads. */
  properties: string[];
  label: string;
  /** The value to key at the playhead when keying starts or adds a key. */
  value: KeyValue;
  disabled?: boolean;
  curve?: { open: boolean; toggle(): void };
}

/**
 * The stopwatch (animate or stop animating), shown before a field's label, and
 * after its value: stepping to the previous or next keyframe, the keyframe
 * toggle at the playhead and the curve.
 */
export function KeyControls(props: KeyControlsProps) {
  const { editor, context, properties, label, value, disabled, curve } = props;
  const { clip, offset } = context;
  const lead = properties[0];
  const animated = isAnimated(clip, lead);
  const keys = clip.keyframes?.[lead] ?? [];
  const here = keys.some((key) => key.time === offset);
  const before = [...keys].reverse().find((key) => key.time < offset);
  const after = keys.find((key) => key.time > offset);
  const run = (commands: Command[]) => void editor.project.execute(together(commands));
  const seek = (time: number) => {
    const project = editor.project.snapshot?.project;
    if (!project) return;
    const rate = project.settings.frameRate;
    const length = (705_600_000 * rate.den) / rate.num;
    editor.playback.seekFrame(Math.round((clip.start + time) / length));
  };
  return (
    <>
      <button
        type="button"
        className="cgv-key-button cgv-stopwatch"
        aria-pressed={animated}
        aria-label={`${animated ? 'Stop animating' : 'Animate'} ${label}`}
        title={
          animated
            ? `Stop animating ${label.toLowerCase()} (keeps the value at the playhead)`
            : `Animate ${label.toLowerCase()}: adds a keyframe at the playhead`
        }
        disabled={disabled}
        onClick={() =>
          run(
            properties.map((property) =>
              animated
                ? { type: 'clearKeyframes', clip: clip.id, property, at: offset }
                : { type: 'setKeyframe', clip: clip.id, property, time: offset, value },
            ),
          )
        }
      >
        ◷
      </button>
      {animated && (
        <span className="cgv-key-nav">
          <button
            type="button"
            className="cgv-key-button"
            aria-label={`Previous keyframe of ${label}`}
            title="Previous keyframe"
            disabled={!before}
            onClick={() => before && seek(before.time)}
          >
            ‹
          </button>
          <button
            type="button"
            className="cgv-key-button cgv-key-diamond"
            aria-pressed={here}
            aria-label={`${here ? 'Remove' : 'Add'} keyframe of ${label} at the playhead`}
            title={here ? 'Remove the keyframe at the playhead' : 'Add a keyframe at the playhead'}
            disabled={disabled}
            onClick={() =>
              run(
                properties.map((property) =>
                  here
                    ? { type: 'removeKeyframes', clip: clip.id, property, times: [offset] }
                    : { type: 'setKeyframe', clip: clip.id, property, time: offset, value },
                ),
              )
            }
          >
            ◆
          </button>
          <button
            type="button"
            className="cgv-key-button"
            aria-label={`Next keyframe of ${label}`}
            title="Next keyframe"
            disabled={!after}
            onClick={() => after && seek(after.time)}
          >
            ›
          </button>
          {curve && (
            <button
              type="button"
              className="cgv-key-button"
              aria-expanded={curve.open}
              aria-label={`${curve.open ? 'Hide' : 'Show'} the curve of ${label}`}
              title="Curve"
              onClick={curve.toggle}
            >
              ∿
            </button>
          )}
        </span>
      )}
    </>
  );
}

/** A colour setting: a colour picker, keyed at the playhead when animated. */
export function ColorField({
  label,
  value,
  testId,
  command,
  editor,
  disabled,
  keys,
}: {
  label: string;
  value: Color;
  testId: string;
  command(value: Color): Command;
  editor: EditorState;
  disabled?: boolean;
  keys?: ReactNode;
}) {
  return (
    <label className="cgv-field" data-testid={testId}>
      {keys}
      <span className="cgv-field-label">{label}</span>
      <input
        type="color"
        className="cgv-color"
        aria-label={label}
        value={colorToHex(value)}
        disabled={disabled}
        onChange={(event) =>
          void editor.project.execute(command(hexToColor(event.currentTarget.value, value.a)))
        }
      />
    </label>
  );
}

/** A property's value at the playhead: animated, or `fallback`. */
export function valueNow(context: KeyContext, property: string, fallback: KeyValue): KeyValue {
  return valueAt(context.clip.keyframes?.[property], context.offset) ?? fallback;
}

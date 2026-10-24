import { useState, type ReactNode } from 'react';
import { CgButton } from '@cashgear/ui';
import type { Clip, ClipProperties, Command, Speed } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { isAnimated, numberAt } from '../effects/animation';
import { frameDuration } from '../timeline/geometry';
import { CurveLane } from './CurveLane';
import { EffectStack } from './EffectStack';
import {
  KeyControls,
  ScrubField,
  clamp,
  keyCommand,
  keyContext,
  usePausedTime,
  type KeyContext,
} from './fields';
import { TransitionInspector } from './TransitionInspector';

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

interface PropertyField {
  label: string;
  /** Keyframe properties set together; the first one's value shows. */
  properties: string[];
  /** The static value, in the model's units. */
  base: number;
  /** Shown value per model unit (100 for a fraction shown as %). */
  display: number;
  min: number;
  max: number;
  step: number;
  precision: number;
  unit: string;
  testId: string;
  /** The static change, when not animated, in the model's units. */
  set(value: number): Command;
}

/** A clip property with its keyframe controls and, when asked, its curve. */
function AnimatedField({
  editor,
  context,
  field,
  disabled,
}: {
  editor: EditorState;
  context: KeyContext;
  field: PropertyField;
  disabled: boolean;
}) {
  const [curve, setCurve] = useState(false);
  const lead = field.properties[0];
  const animated = isAnimated(context.clip, lead);
  const value = animated ? numberAt(context.clip, lead, context.offset, field.base) : field.base;
  return (
    <>
      <ScrubField
        label={field.label}
        value={value * field.display}
        min={field.min * field.display}
        max={field.max * field.display}
        step={field.step}
        precision={field.precision}
        unit={field.unit}
        testId={field.testId}
        editor={editor}
        disabled={disabled}
        command={(shown) =>
          animated
            ? keyCommand(context, field.properties, shown / field.display)
            : field.set(shown / field.display)
        }
        keys={
          <KeyControls
            editor={editor}
            context={context}
            properties={field.properties}
            label={field.label}
            value={value}
            disabled={disabled}
            curve={{ open: curve, toggle: () => setCurve(!curve) }}
          />
        }
      />
      {animated && curve && (
        <CurveLane
          editor={editor}
          context={context}
          properties={field.properties}
          label={field.label}
          min={field.min}
          max={field.max}
          disabled={disabled}
        />
      )}
    </>
  );
}

/**
 * The selected clip's picture, sound, speed and effects, or the selected
 * transition. Every change is an undoable command; animated properties take
 * keyframes at the playhead.
 */
export function Inspector({ editor }: { editor: EditorState }) {
  const playhead = usePausedTime(editor.playback);
  const clip: Clip | null = editor.focused;
  const snapshot = editor.project.snapshot;
  if (editor.transition && snapshot)
    return (
      <aside className="cgv-inspector" data-testid="inspector" aria-label="Inspector">
        <h2>Transition</h2>
        <TransitionInspector editor={editor} />
      </aside>
    );
  if (!clip || !snapshot)
    return (
      <aside className="cgv-inspector" data-testid="inspector" aria-label="Inspector">
        <h2>Inspector</h2>
        <p className="cgv-muted">Select a clip to change its picture, sound, speed and effects.</p>
      </aside>
    );
  const adjustment = clip.kind === 'adjustment';
  const media = snapshot.project.media.find((item) => item.id === clip.media);
  const still = media?.kind === 'image' || adjustment;
  const locked = snapshot.project.tracks.some(
    (track) => track.locked && track.clips.some((c) => c.id === clip.id),
  );
  const frame = frameDuration(snapshot.project.settings.frameRate);
  const context = keyContext(clip, playhead, frame);
  const set = (properties: ClipProperties): Command => ({
    type: 'setClipProperties',
    clip: clip.id,
    properties,
  });
  const field = (props: PropertyField) => (
    <AnimatedField
      key={props.testId}
      editor={editor}
      context={context}
      field={props}
      disabled={locked}
    />
  );
  const transform = clip.transform;
  const crop = clip.crop;
  const opacity = field({
    label: 'Opacity',
    properties: ['opacity'],
    base: clip.opacity,
    display: 100,
    min: 0,
    max: 1,
    step: 0.5,
    precision: 1,
    unit: '%',
    testId: 'field-opacity',
    set: (opacity) => set({ opacity }),
  });
  const speed = clip.speed;
  return (
    <aside
      className="cgv-inspector"
      data-testid="inspector"
      data-clip-id={clip.id}
      aria-label="Inspector"
    >
      <h2 title={media?.name}>{adjustment ? 'Adjustment layer' : (media?.name ?? 'Clip')}</h2>
      {locked && <p className="cgv-muted">This clip is on a locked track.</p>}
      {adjustment && (
        <Section title="Adjustment">
          <p className="cgv-muted">Its effects apply to every track below it.</p>
          {opacity}
        </Section>
      )}
      {clip.video && !adjustment && (
        <Section title="Transform">
          {field({
            label: 'Position X',
            properties: ['transform.x'],
            base: transform.x,
            display: 1,
            min: -100000,
            max: 100000,
            step: 1,
            precision: 1,
            unit: 'px',
            testId: 'field-x',
            set: (x) => set({ transform: { x } }),
          })}
          {field({
            label: 'Position Y',
            properties: ['transform.y'],
            base: transform.y,
            display: 1,
            min: -100000,
            max: 100000,
            step: 1,
            precision: 1,
            unit: 'px',
            testId: 'field-y',
            set: (y) => set({ transform: { y } }),
          })}
          {field({
            label: 'Scale',
            properties: ['transform.scaleX', 'transform.scaleY'],
            base: transform.scaleX,
            display: 100,
            min: 0.01,
            max: 100,
            step: 0.5,
            precision: 1,
            unit: '%',
            testId: 'field-scale',
            set: (scale) => set({ transform: { scaleX: scale, scaleY: scale } }),
          })}
          {field({
            label: 'Rotation',
            properties: ['transform.rotation'],
            base: transform.rotation,
            display: 1,
            min: -3600,
            max: 3600,
            step: 0.5,
            precision: 1,
            unit: '°',
            testId: 'field-rotation',
            set: (rotation) => set({ transform: { rotation } }),
          })}
          {opacity}
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
      {clip.video && !adjustment && (
        <Section title="Crop">
          {(['left', 'top', 'right', 'bottom'] as const).map((side) =>
            field({
              label: side[0].toUpperCase() + side.slice(1),
              properties: [`crop.${side}`],
              base: crop[side],
              display: 100,
              min: 0,
              max: 0.95,
              step: 0.25,
              precision: 1,
              unit: '%',
              testId: `field-crop-${side}`,
              set: (value) => set({ crop: { [side]: value } }),
            }),
          )}
        </Section>
      )}
      {clip.audio && (
        <Section title="Audio">
          {field({
            label: 'Volume',
            properties: ['volumeDb'],
            base: clip.volumeDb,
            display: 1,
            min: -96,
            max: 24,
            step: 0.1,
            precision: 1,
            unit: 'dB',
            testId: 'field-volume',
            set: (volumeDb) => set({ volumeDb }),
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
          <ScrubField
            label="Speed"
            value={Number((speed.num / speed.den).toFixed(2))}
            min={0.1}
            max={100}
            step={0.01}
            precision={2}
            unit="×"
            testId="field-speed"
            editor={editor}
            disabled={locked}
            command={(value) => ({ type: 'setSpeed', clip: clip.id, speed: speedOf(value) })}
          />
          {speed.num !== speed.den && clip.audio && (
            <p className="cgv-muted">Sound plays only at normal speed for now.</p>
          )}
        </Section>
      )}
      {clip.video && <EffectStack editor={editor} context={context} disabled={locked} />}
    </aside>
  );
}

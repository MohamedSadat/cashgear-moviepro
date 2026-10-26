import { useState, type ReactNode } from 'react';
import type { Command } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { isAnimated, numberAt } from '../effects/animation';
import { CurveLane } from './CurveLane';
import { KeyControls, ScrubField, keyCommand, type KeyContext } from './fields';

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="cgv-inspector-section" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export interface PropertyField {
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
export function AnimatedField({
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

import { CgButton } from '@cashgear/ui';
import type { Clip, Command, Mask, MaskMode } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { maskName, maskProperty, maskTools, newMask } from '../masks/shapes';
import { AnimatedField, Section } from './AnimatedField';
import type { KeyContext } from './fields';

const modes: { mode: MaskMode; label: string }[] = [
  { mode: 'add', label: 'Add' },
  { mode: 'subtract', label: 'Subtract' },
  { mode: 'intersect', label: 'Intersect' },
];

interface Setting {
  setting: keyof Mask;
  label: string;
  display: number;
  min: number;
  max: number;
  step: number;
  precision: number;
  unit: string;
}

const settings: Setting[] = [
  {
    setting: 'x',
    label: 'Centre X',
    display: 100,
    min: -1,
    max: 2,
    step: 0.1,
    precision: 1,
    unit: '%',
  },
  {
    setting: 'y',
    label: 'Centre Y',
    display: 100,
    min: -1,
    max: 2,
    step: 0.1,
    precision: 1,
    unit: '%',
  },
  {
    setting: 'width',
    label: 'Width',
    display: 100,
    min: 0.001,
    max: 4,
    step: 0.1,
    precision: 1,
    unit: '%',
  },
  {
    setting: 'height',
    label: 'Height',
    display: 100,
    min: 0.001,
    max: 4,
    step: 0.1,
    precision: 1,
    unit: '%',
  },
  {
    setting: 'rotation',
    label: 'Rotation',
    display: 1,
    min: -3600,
    max: 3600,
    step: 0.5,
    precision: 1,
    unit: '°',
  },
  {
    setting: 'feather',
    label: 'Feather',
    display: 100,
    min: 0,
    max: 0.5,
    step: 0.05,
    precision: 1,
    unit: '%',
  },
  {
    setting: 'expansion',
    label: 'Expansion',
    display: 100,
    min: -0.5,
    max: 0.5,
    step: 0.05,
    precision: 1,
    unit: '%',
  },
  {
    setting: 'opacity',
    label: 'Opacity',
    display: 100,
    min: 0,
    max: 1,
    step: 0.5,
    precision: 0,
    unit: '%',
  },
];

const roundness: Setting = {
  setting: 'roundness',
  label: 'Roundness',
  display: 100,
  min: 0,
  max: 1,
  step: 0.5,
  precision: 0,
  unit: '%',
};

/**
 * A clip's masks: shapes that cut its picture after its effects, in order, each
 * adding to, cutting from or intersecting what the ones before show. Every
 * number can be animated; points and handles are shaped on the monitor.
 */
export function MaskSection({
  editor,
  context,
  disabled,
}: {
  editor: EditorState;
  context: KeyContext;
  disabled: boolean;
}) {
  const clip: Clip = context.clip;
  const masks = clip.masks ?? [];
  const run = (command: Command) => void editor.project.execute(command);
  const set = (mask: Mask, patch: Partial<Mask>): Command => ({
    type: 'setMask',
    clip: clip.id,
    mask: { ...mask, ...patch },
  });
  return (
    <Section title="Masks">
      <div className="cgv-speed-presets" role="group" aria-label="Add a mask">
        {maskTools.map(({ tool, label }) => (
          <CgButton
            key={tool}
            appearance="ghost"
            size="small"
            data-testid={`add-mask-${tool}`}
            disabled={disabled || masks.length >= 8}
            onClick={() => run({ type: 'addMask', clip: clip.id, mask: newMask(tool) })}
          >
            {`+ ${label}`}
          </CgButton>
        ))}
      </div>
      {masks.map((mask, index) => (
        <div className="cgv-effect-panel" key={mask.id} data-testid="mask" data-mask-id={mask.id}>
          <div className="cgv-inspector-row">
            <strong className="cgv-mask-name">{maskName(mask, index)}</strong>
            <select
              aria-label="Mask mode"
              value={mask.mode ?? 'add'}
              disabled={disabled}
              onChange={(event) => run(set(mask, { mode: event.currentTarget.value as MaskMode }))}
            >
              {modes.map(({ mode, label }) => (
                <option key={mode} value={mode}>
                  {label}
                </option>
              ))}
            </select>
            <label className="cgv-check-row">
              <input
                type="checkbox"
                checked={!!mask.invert}
                disabled={disabled}
                onChange={(event) => run(set(mask, { invert: event.currentTarget.checked }))}
              />
              Invert
            </label>
            <CgButton
              appearance="ghost"
              size="small"
              aria-label={`Move ${maskName(mask, index)} up`}
              disabled={disabled || index === 0}
              onClick={() =>
                run({ type: 'moveMask', clip: clip.id, mask: mask.id, index: index - 1 })
              }
            >
              ↑
            </CgButton>
            <CgButton
              appearance="ghost"
              size="small"
              aria-label={`Move ${maskName(mask, index)} down`}
              disabled={disabled || index === masks.length - 1}
              onClick={() =>
                run({ type: 'moveMask', clip: clip.id, mask: mask.id, index: index + 1 })
              }
            >
              ↓
            </CgButton>
            <CgButton
              appearance="ghost"
              size="small"
              aria-label={`Delete ${maskName(mask, index)}`}
              disabled={disabled}
              onClick={() => run({ type: 'removeMask', clip: clip.id, mask: mask.id })}
            >
              ×
            </CgButton>
          </div>
          {[
            ...settings.slice(0, 5),
            ...(mask.shape === 'rectangle' ? [roundness] : []),
            ...settings.slice(5),
          ].map((field) => (
            <AnimatedField
              key={field.setting}
              editor={editor}
              context={context}
              disabled={disabled}
              field={{
                label: field.label,
                properties: [maskProperty(mask.id, field.setting)],
                base: (mask[field.setting] as number | undefined) ?? 0,
                display: field.display,
                min: field.min,
                max: field.max,
                step: field.step,
                precision: field.precision,
                unit: field.unit,
                testId: `mask-${field.setting}`,
                set: (value) => set(mask, { [field.setting]: value }),
              }}
            />
          ))}
        </div>
      ))}
      {masks.length > 0 && (
        <p className="cgv-muted">Drag a mask's box, points and handles on the monitor.</p>
      )}
    </Section>
  );
}

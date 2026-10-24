import { CgButton } from '@cashgear/ui';
import { FLICKS_PER_SECOND, type Alignment, type Color, type Command } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { colorToHex, hexToColor, nameOf, valueOf } from '../effects/catalog';
import { frameDuration } from '../timeline/geometry';
import { decimals } from './EffectStack';
import { ScrubField } from './fields';

const alignments: { id: Alignment; label: string }[] = [
  { id: 'start', label: 'Starts at the cut' },
  { id: 'center', label: 'Centred on the cut' },
  { id: 'end', label: 'Ends at the cut' },
];

/** The selected transition: its kind, length, alignment and settings. */
export function TransitionInspector({ editor }: { editor: EditorState }) {
  const selected = editor.transition;
  const project = editor.project.snapshot?.project;
  if (!selected || !project) return null;
  const { transition, track } = selected;
  const entry = editor.catalog?.find(transition.pack, transition.kind);
  const name = entry ? nameOf(entry, transition.params) : transition.kind;
  const frame = frameDuration(project.settings.frameRate);
  const locked = track.locked;
  const oneSided = transition.from === null || transition.to === null;
  const set = (patch: Omit<Extract<Command, { type: 'setTransition' }>, 'type' | 'transition'>) =>
    void editor.project.execute({ type: 'setTransition', transition: transition.id, ...patch });
  const items = editor.catalog?.transitions ?? [];
  const current = items.find(
    (item) =>
      item.entry === entry &&
      (!item.variant || nameOf(item.entry, transition.params) === item.variant.name),
  );
  const step = frame / FLICKS_PER_SECOND;
  return (
    <section
      className="cgv-inspector-section"
      aria-label="Transition"
      data-testid="transition-inspector"
      data-transition-id={transition.id}
    >
      <h3>{name}</h3>
      <label className="cgv-field">
        <span className="cgv-field-label">Type</span>
        <select
          aria-label="Transition type"
          value={current?.key ?? ''}
          disabled={locked}
          onChange={(event) => {
            const item = items.find((entry) => entry.key === event.currentTarget.value);
            if (!item) return;
            void editor.project.execute({
              type: 'addTransition',
              track: track.id,
              from: transition.from,
              to: transition.to,
              transition: {
                kind: item.entry.id,
                pack: item.entry.pack,
                version: item.entry.version,
                duration: transition.duration,
                alignment: transition.alignment,
                params: item.params,
              },
            });
          }}
        >
          {!current && <option value="">{name}</option>}
          {items.map((item) => (
            <option key={item.key} value={item.key}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <ScrubField
        label="Duration"
        value={transition.duration / FLICKS_PER_SECOND}
        min={step}
        max={600}
        step={step}
        precision={2}
        unit="s"
        testId="field-transition-duration"
        editor={editor}
        disabled={locked}
        command={(seconds) => ({
          type: 'setTransition',
          transition: transition.id,
          duration: Math.max(1, Math.round((seconds * FLICKS_PER_SECOND) / frame)) * frame,
        })}
      />
      <label className="cgv-field">
        <span className="cgv-field-label">Alignment</span>
        <select
          aria-label="Alignment"
          value={transition.alignment}
          disabled={locked || oneSided}
          title={oneSided ? 'A transition at a free edge stays inside its clip' : undefined}
          onChange={(event) => set({ alignment: event.currentTarget.value as Alignment })}
        >
          {alignments.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {entry?.params.map((param) => {
        const value = valueOf(transition.params, param);
        const field = (control: React.ReactNode) => (
          <label key={param.id} className="cgv-field" data-testid={`param-${param.id}`}>
            <span className="cgv-field-label">{param.name}</span>
            {control}
          </label>
        );
        switch (param.type) {
          case 'number': {
            const display = param.display ?? 1;
            const stepShown = (param.step ?? (param.max - param.min) / 100) * display;
            return (
              <ScrubField
                key={param.id}
                label={param.name}
                value={(value as number) * display}
                min={param.min * display}
                max={param.max * display}
                step={stepShown}
                precision={decimals(stepShown)}
                unit={param.unit ?? ''}
                testId={`param-${param.id}`}
                editor={editor}
                disabled={locked}
                command={(shown) => ({
                  type: 'setTransition',
                  transition: transition.id,
                  params: { [param.id]: shown / display },
                })}
              />
            );
          }
          case 'bool':
            return field(
              <input
                type="checkbox"
                aria-label={param.name}
                checked={value === true}
                disabled={locked}
                onChange={(event) => set({ params: { [param.id]: event.currentTarget.checked } })}
              />,
            );
          case 'choice':
            return field(
              <select
                aria-label={param.name}
                value={value as string}
                disabled={locked}
                onChange={(event) => set({ params: { [param.id]: event.currentTarget.value } })}
              >
                {param.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>,
            );
          case 'color':
            return field(
              <input
                type="color"
                className="cgv-color"
                aria-label={param.name}
                value={colorToHex(value as Color)}
                disabled={locked}
                onChange={(event) =>
                  set({
                    params: {
                      [param.id]: hexToColor(event.currentTarget.value, (value as Color).a),
                    },
                  })
                }
              />,
            );
          default:
            return null;
        }
      })}
      <CgButton
        appearance="ghost"
        size="small"
        disabled={locked}
        onClick={() =>
          void editor.project.execute({ type: 'removeTransition', transition: transition.id })
        }
      >
        Delete transition
      </CgButton>
    </section>
  );
}

import { useRef, useState, type ReactNode } from 'react';
import type { Color, Command, Effect, ParamDef } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { effectProperty, isAnimated, numberAt, valueAt } from '../effects/animation';
import { defaultsOf, nameOf, valueOf } from '../effects/catalog';
import { CurveLane } from './CurveLane';
import { ColorField, KeyControls, ScrubField, keyCommand, type KeyContext } from './fields';

/** Decimal places that show a step: 0.01 needs 2. */
export function decimals(step: number): number {
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
}

interface ParamProps {
  editor: EditorState;
  context: KeyContext;
  effect: Effect;
  param: ParamDef;
  disabled?: boolean;
}

function setParams(context: KeyContext, effect: Effect, params: Effect['params']): Command {
  return { type: 'setEffectParams', clip: context.clip.id, effect: effect.id, params };
}

function NumberParam({ editor, context, effect, param, disabled }: ParamProps) {
  const [curve, setCurve] = useState(false);
  if (param.type !== 'number') return null;
  const property = effectProperty(effect.id, param.id);
  const display = param.display ?? 1;
  const base = valueOf(effect.params, param) as number;
  const animated = isAnimated(context.clip, property);
  const value = animated ? numberAt(context.clip, property, context.offset, base) : base;
  const step = (param.step ?? (param.max - param.min) / 100) * display;
  const command = (shown: number): Command =>
    animated
      ? keyCommand(context, [property], shown / display)
      : setParams(context, effect, { [param.id]: shown / display });
  return (
    <>
      <ScrubField
        label={param.name}
        value={value * display}
        min={param.min * display}
        max={param.max * display}
        step={step}
        precision={decimals(step)}
        unit={param.unit ?? ''}
        testId={`param-${param.id}`}
        command={command}
        editor={editor}
        disabled={disabled}
        keys={
          param.animate ? (
            <KeyControls
              editor={editor}
              context={context}
              properties={[property]}
              label={param.name}
              value={value}
              disabled={disabled}
              curve={{ open: curve, toggle: () => setCurve(!curve) }}
            />
          ) : undefined
        }
      />
      {animated && curve && (
        <CurveLane
          editor={editor}
          context={context}
          properties={[property]}
          label={param.name}
          min={param.min}
          max={param.max}
          disabled={disabled}
        />
      )}
    </>
  );
}

function LutParam({ editor, context, effect, param, disabled }: ParamProps) {
  const file = useRef<HTMLInputElement>(null);
  const project = editor.project;
  const luts = project.snapshot?.project.luts ?? [];
  const looks = editor.catalog?.looks ?? [];
  const value = (effect.params[param.id] as string | undefined) ?? '';
  const use = (id: number | null) =>
    id !== null && void project.execute(setParams(context, effect, { [param.id]: `lut-${id}` }));
  const choose = async (choice: string) => {
    if (choice === '__import') return file.current?.click();
    if (choice.startsWith('look:')) {
      const look = looks.find((entry) => entry.id === choice.slice(5));
      // A look already in the project is used again rather than copied twice.
      const known = look && luts.find((lut) => lut.name === look.name);
      return use(known ? known.id : await project.importLook(choice.slice(5)));
    }
    void project.execute(setParams(context, effect, { [param.id]: choice }));
  };
  return (
    <label className="cgv-field" data-testid={`param-${param.id}`}>
      <span className="cgv-field-label">{param.name}</span>
      <select
        aria-label={param.name}
        value={value}
        disabled={disabled}
        onChange={(event) => void choose(event.currentTarget.value)}
      >
        <option value="">None</option>
        {luts.length > 0 && (
          <optgroup label="In this project">
            {luts.map((lut) => (
              <option key={lut.id} value={`lut-${lut.id}`}>
                {lut.name}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Built-in looks">
          {looks
            .filter((look) => !luts.some((lut) => lut.name === look.name))
            .map((look) => (
              <option key={look.id} value={`look:${look.id}`}>
                {look.name}
              </option>
            ))}
        </optgroup>
        <option value="__import">Import a .cube file…</option>
      </select>
      <input
        ref={file}
        type="file"
        accept=".cube"
        hidden
        data-testid="lut-file-input"
        onChange={async (event) => {
          const picked = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (picked) use(await project.importLut(picked.name, await picked.text()));
        }}
      />
    </label>
  );
}

function ColorParam({ editor, context, effect, param, disabled }: ParamProps) {
  const property = effectProperty(effect.id, param.id);
  const base = valueOf(effect.params, param) as Color;
  const animated = isAnimated(context.clip, property);
  const now = animated
    ? (valueAt(context.clip.keyframes?.[property], context.offset) as Color)
    : base;
  return (
    <ColorField
      label={param.name}
      value={now ?? base}
      testId={`param-${param.id}`}
      editor={editor}
      disabled={disabled}
      command={(color) =>
        animated
          ? keyCommand(context, [property], color)
          : setParams(context, effect, { [param.id]: color })
      }
      keys={
        param.animate ? (
          <KeyControls
            editor={editor}
            context={context}
            properties={[property]}
            label={param.name}
            value={now ?? base}
            disabled={disabled}
          />
        ) : undefined
      }
    />
  );
}

/** A setting of an effect, keyframed at the playhead when animated. */
export function ParamControl(props: ParamProps) {
  const { editor, context, effect, param, disabled } = props;
  const run = (params: Effect['params']) =>
    void editor.project.execute(setParams(context, effect, params));
  switch (param.type) {
    case 'number':
      return <NumberParam {...props} />;
    case 'color':
      return <ColorParam {...props} />;
    case 'lut':
      return <LutParam {...props} />;
    case 'bool':
      return (
        <label className="cgv-field" data-testid={`param-${param.id}`}>
          <span className="cgv-field-label">{param.name}</span>
          <input
            type="checkbox"
            aria-label={param.name}
            checked={valueOf(effect.params, param) === true}
            disabled={disabled}
            onChange={(event) => run({ [param.id]: event.currentTarget.checked })}
          />
        </label>
      );
    case 'choice':
      return (
        <label className="cgv-field" data-testid={`param-${param.id}`}>
          <span className="cgv-field-label">{param.name}</span>
          <select
            aria-label={param.name}
            value={valueOf(effect.params, param) as string}
            disabled={disabled}
            onChange={(event) => run({ [param.id]: event.currentTarget.value })}
          >
            {param.options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      );
  }
}

function IconButton(props: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cgv-key-button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function EffectPanel({
  editor,
  context,
  effect,
  index,
  count,
  disabled,
}: {
  editor: EditorState;
  context: KeyContext;
  effect: Effect;
  index: number;
  count: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const entry = editor.catalog?.find(effect.pack, effect.kind);
  const name = entry ? nameOf(entry, effect.params) : effect.kind;
  const clip = context.clip.id;
  const run = (command: Command) => void editor.project.execute(command);
  return (
    <div
      className="cgv-effect-panel"
      data-testid="effect-panel"
      data-effect-id={effect.id}
      data-kind={effect.kind}
    >
      <div className="cgv-effect-header">
        <input
          type="checkbox"
          aria-label={`${name} on`}
          title={effect.enabled ? 'Turn the effect off' : 'Turn the effect on'}
          checked={effect.enabled}
          disabled={disabled}
          onChange={(event) =>
            run({
              type: 'setEffectEnabled',
              clip,
              effect: effect.id,
              enabled: event.currentTarget.checked,
            })
          }
        />
        <button
          type="button"
          className="cgv-effect-title"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {name}
        </button>
        <IconButton
          label={`Move ${name} up`}
          disabled={disabled || index === 0}
          onClick={() => run({ type: 'moveEffect', clip, effect: effect.id, index: index - 1 })}
        >
          ▲
        </IconButton>
        <IconButton
          label={`Move ${name} down`}
          disabled={disabled || index === count - 1}
          onClick={() => run({ type: 'moveEffect', clip, effect: effect.id, index: index + 1 })}
        >
          ▼
        </IconButton>
        <IconButton
          label={`Reset ${name}`}
          disabled={disabled || !entry}
          onClick={() =>
            entry &&
            run({ type: 'resetEffect', clip, effect: effect.id, params: defaultsOf(entry) })
          }
        >
          ↺
        </IconButton>
        <IconButton
          label={`Remove ${name}`}
          disabled={disabled}
          onClick={() => run({ type: 'removeEffect', clip, effect: effect.id })}
        >
          ✕
        </IconButton>
      </div>
      {open && !entry && (
        <p className="cgv-muted">
          {effect.pack}/{effect.kind} is not in this version of CashGear Video, so it is not drawn.
        </p>
      )}
      {open &&
        entry?.params.map((param) => (
          <ParamControl
            key={param.id}
            editor={editor}
            context={context}
            effect={effect}
            param={param}
            disabled={disabled}
          />
        ))}
    </div>
  );
}

/** The clip's effects in the order they run: switch, reorder, reset and remove them. */
export function EffectStack({
  editor,
  context,
  disabled,
}: {
  editor: EditorState;
  context: KeyContext;
  disabled?: boolean;
}) {
  const effects = context.clip.effects ?? [];
  const items = editor.catalog?.effects ?? [];
  return (
    <section className="cgv-inspector-section" aria-label="Effects" data-testid="effect-stack">
      <h3>Effects</h3>
      <select
        aria-label="Add an effect"
        value=""
        disabled={disabled || !items.length}
        onChange={(event) => {
          const item = items.find((entry) => entry.key === event.currentTarget.value);
          if (item) void editor.applyEffect(item, [context.clip.id]);
        }}
      >
        <option value="">Add effect…</option>
        {items.map((item) => (
          <option key={item.key} value={item.key}>
            {item.name}
          </option>
        ))}
      </select>
      {!effects.length && (
        <p className="cgv-muted">
          Drag an effect from the Effects tab onto the clip, or add one here.
        </p>
      )}
      {effects.map((effect, index) => (
        <EffectPanel
          key={effect.id}
          editor={editor}
          context={context}
          effect={effect}
          index={index}
          count={effects.length}
          disabled={disabled}
        />
      ))}
    </section>
  );
}

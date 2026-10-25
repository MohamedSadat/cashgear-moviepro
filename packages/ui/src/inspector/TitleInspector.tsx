import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CgButton } from '@cashgear/ui';
import {
  elementProperty,
  fontCatalog,
  type Clip,
  type Color,
  type Command,
  type ElementSetting,
  type ShapeKind,
  type TextAlign,
  type TextDirection,
  type Title,
  type TitleElement,
} from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { isAnimated, numberAt, valueAt } from '../effects/animation';
import { animateCommands, presets, type Preset } from '../titles/animations';
import {
  ColorField,
  KeyControls,
  ScrubField,
  keyCommand,
  together,
  type KeyContext,
} from './fields';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="cgv-inspector-section" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

const weights = [
  [100, 'Thin'],
  [200, 'Extra light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [800, 'Extra bold'],
  [900, 'Black'],
] as const;

const shapeNames: Record<ShapeKind, string> = {
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  polygon: 'Polygon',
  star: 'Star',
};

const black: Color = { r: 0, g: 0, b: 0, a: 1 };

/** An element's name in the list: its text's start, or its shape. */
function elementName(element: TitleElement): string {
  if (element.type === 'shape') return shapeNames[element.kind];
  const text = element.text.trim().replace(/\s+/g, ' ');
  return text ? (text.length > 24 ? text.slice(0, 23) + '…' : text) : 'Empty text';
}

interface Props {
  editor: EditorState;
  clip: Clip;
  context: KeyContext;
  canvas: { width: number; height: number };
  frame: number;
  disabled: boolean;
}

/**
 * A title clip's elements: pick one to edit its text, font, colours, outline,
 * shadow, background, position and animation. Every change is one command.
 */
export function TitleInspector({ editor, clip, context, canvas, frame, disabled }: Props) {
  const title: Title = clip.title ?? { elements: [] };
  const [chosen, setChosen] = useState<number | null>(title.elements[0]?.id ?? null);
  const element = title.elements.find((e) => e.id === chosen) ?? title.elements[0] ?? null;
  const execute = (command: Command) => void editor.project.execute(command);
  const setTitle = (next: Title): Command => ({ type: 'setTitle', clip: clip.id, title: next });
  /** The command that changes the chosen element. */
  const update = (change: (element: TitleElement) => TitleElement): Command =>
    setTitle({
      elements: title.elements.map((e) => (e.id === element?.id ? change(e) : e)),
    });

  const addText = () => {
    const made: TitleElement = {
      id: 0,
      x: 0,
      y: 0,
      fill: { r: 1, g: 1, b: 1, a: 1 },
      type: 'text',
      text: 'New text',
      font: { family: 'Inter', weight: 700 },
      size: 96,
    };
    execute(setTitle({ elements: [...title.elements, made] }));
  };
  const addShape = (kind: ShapeKind) => {
    const made: TitleElement = {
      id: 0,
      x: 0,
      y: 0,
      fill: { r: 1, g: 1, b: 1, a: 1 },
      type: 'shape',
      kind,
      width: kind === 'line' ? 600 : 300,
      height: kind === 'line' ? 12 : kind === 'arrow' ? 120 : 300,
    };
    execute(setTitle({ elements: [...title.elements, made] }));
  };
  const move = (by: number) => {
    if (!element) return;
    const list = [...title.elements];
    const from = list.findIndex((e) => e.id === element.id);
    const to = from + by;
    if (to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to], list[from]];
    execute(setTitle({ elements: list }));
  };
  // New elements get their ids from the engine: pick the one that appeared.
  const known = useMemo(() => title.elements.map((e) => e.id).join(','), [title.elements]);
  const [seen, setSeen] = useState(known);
  useEffect(() => {
    if (known === seen) return;
    const before = new Set(seen.split(',').map(Number));
    const added = title.elements.find((e) => !before.has(e.id));
    if (added) setChosen(added.id);
    setSeen(known);
  }, [known, seen, title.elements]);

  return (
    <>
      <Section title="Elements">
        <ul className="cgv-element-list" aria-label="Title elements" data-testid="title-elements">
          {[...title.elements].reverse().map((e) => (
            <li key={e.id}>
              <button
                type="button"
                className="cgv-element"
                aria-pressed={e.id === element?.id}
                data-testid="title-element"
                data-element-id={e.id}
                onClick={() => setChosen(e.id)}
              >
                {e.type === 'text' ? 'T ' : '◆ '}
                {elementName(e)}
              </button>
            </li>
          ))}
        </ul>
        <div className="cgv-inspector-row">
          <CgButton size="small" appearance="ghost" disabled={disabled} onClick={addText}>
            Add text
          </CgButton>
          <select
            aria-label="Add shape"
            value=""
            disabled={disabled}
            onChange={(event) => {
              const kind = event.currentTarget.value as ShapeKind;
              if (kind) addShape(kind);
            }}
          >
            <option value="">Add shape…</option>
            {Object.entries(shapeNames).map(([kind, name]) => (
              <option key={kind} value={kind}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {element && (
          <div className="cgv-inspector-row">
            <CgButton size="small" appearance="ghost" disabled={disabled} onClick={() => move(1)}>
              Bring forward
            </CgButton>
            <CgButton size="small" appearance="ghost" disabled={disabled} onClick={() => move(-1)}>
              Send back
            </CgButton>
            <CgButton
              size="small"
              appearance="ghost"
              intent="danger"
              disabled={disabled || title.elements.length < 2}
              onClick={() =>
                execute(setTitle({ elements: title.elements.filter((e) => e.id !== element.id) }))
              }
            >
              Remove
            </CgButton>
          </div>
        )}
      </Section>
      {element?.type === 'text' && (
        <TextSection key={element.id} {...{ editor, element, update, execute, disabled }} />
      )}
      {element?.type === 'shape' && (
        <Section title="Shape">
          <label className="cgv-field">
            <span className="cgv-field-label">Kind</span>
            <select
              aria-label="Shape"
              value={element.kind}
              disabled={disabled}
              onChange={(event) =>
                execute(update((e) => ({ ...e, kind: event.currentTarget.value as ShapeKind })))
              }
            >
              {Object.entries(shapeNames).map(([kind, name]) => (
                <option key={kind} value={kind}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {(
            [
              ['Width', 'width', 0, 10000],
              ['Height', 'height', 0, 10000],
              ...(element.kind === 'rectangle' ? [['Corners', 'radius', 0, 5000]] : []),
            ] as [string, 'width' | 'height' | 'radius', number, number][]
          ).map(([label, key, min, max]) => (
            <ScrubField
              key={key}
              label={label}
              value={element[key] ?? 0}
              min={min}
              max={max}
              step={1}
              precision={0}
              unit="px"
              testId={`title-shape-${key}`}
              editor={editor}
              disabled={disabled}
              command={(value) => update((e) => ({ ...e, [key]: value }))}
            />
          ))}
          {(element.kind === 'polygon' || element.kind === 'star') && (
            <ScrubField
              label={element.kind === 'star' ? 'Points' : 'Sides'}
              value={element.sides ?? 5}
              min={3}
              max={64}
              step={0.1}
              precision={0}
              unit=""
              testId="title-shape-sides"
              editor={editor}
              disabled={disabled}
              command={(value) => update((e) => ({ ...e, sides: Math.round(value) }))}
            />
          )}
        </Section>
      )}
      {element && <StyleSection {...{ editor, context, element, update, execute, disabled }} />}
      {element && (
        <Section title="Position">
          {(
            [
              ['Position X', 'x', element.x, 1, -100000, 100000, 1, 'px'],
              ['Position Y', 'y', element.y, 1, -100000, 100000, 1, 'px'],
              ['Scale', 'scale', element.scale ?? 1, 100, 0.01, 100, 0.5, '%'],
              ['Rotation', 'rotation', element.rotation ?? 0, 1, -3600, 3600, 0.5, '°'],
              ['Opacity', 'opacity', element.opacity ?? 1, 100, 0, 1, 0.5, '%'],
              ...(element.type === 'text'
                ? ([['Reveal', 'reveal', element.reveal ?? 1, 100, 0, 1, 0.5, '%']] as const)
                : []),
            ] as const
          ).map(([label, setting, base, display, min, max, step, unit]) => (
            <ElementNumber
              key={setting}
              {...{ editor, context, element, setting, label, base, display, min, max, step, unit }}
              disabled={disabled}
              set={(value) => update((e) => ({ ...e, [setting]: value }))}
            />
          ))}
        </Section>
      )}
      {element && <AnimationSection {...{ editor, clip, element, canvas, frame, disabled }} />}
    </>
  );
}

/** An element setting that keyframes can animate, with its stopwatch. */
function ElementNumber(props: {
  editor: EditorState;
  context: KeyContext;
  element: TitleElement;
  setting: ElementSetting;
  label: string;
  base: number;
  display: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  disabled: boolean;
  set(value: number): Command;
}) {
  const { editor, context, element, setting, label, base, display, min, max, step, unit } = props;
  const property = elementProperty(element.id, setting);
  const animated = isAnimated(context.clip, property);
  const value = animated ? numberAt(context.clip, property, context.offset, base) : base;
  return (
    <ScrubField
      label={label}
      value={value * display}
      min={min * display}
      max={max * display}
      step={step}
      precision={1}
      unit={unit}
      testId={`title-${setting}`}
      editor={editor}
      disabled={props.disabled}
      command={(shown) =>
        animated ? keyCommand(context, [property], shown / display) : props.set(shown / display)
      }
      keys={
        <KeyControls
          editor={editor}
          context={context}
          properties={[property]}
          label={label}
          value={value}
          disabled={props.disabled}
        />
      }
    />
  );
}

interface SectionProps {
  editor: EditorState;
  element: TitleElement;
  update(change: (element: TitleElement) => TitleElement): Command;
  execute(command: Command): void;
  disabled: boolean;
}

type TextElement = Extract<TitleElement, { type: 'text' }>;

function TextSection({
  editor,
  element,
  update,
  execute,
  disabled,
}: SectionProps & { element: TextElement }) {
  const [draft, setDraft] = useState(element.text);
  useEffect(() => setDraft(element.text), [element.text]);
  const families = useMemo(() => fontCatalog().list(), []);
  const commit = () => {
    if (draft !== element.text) execute(update((e) => ({ ...e, text: draft })));
  };
  const scripts: [string, string][] = [
    ['latin', 'Latin'],
    ['arabic', 'Arabic'],
    ['emoji', 'Emoji'],
    ['other', 'Other'],
  ];
  const known = families.some((f) => f.family === element.font.family);
  const text = (change: Partial<typeof element>) =>
    execute(update((e) => ({ ...e, ...change }) as TitleElement));
  return (
    <Section title="Text">
      <textarea
        className="cgv-title-text"
        aria-label="Text"
        data-testid="title-text"
        dir="auto"
        rows={3}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) commit();
          if (event.key === 'Escape') setDraft(element.text);
        }}
      />
      <label className="cgv-field">
        <span className="cgv-field-label">Font</span>
        <select
          aria-label="Font"
          data-testid="title-font"
          value={element.font.family}
          disabled={disabled}
          onChange={(event) =>
            text({ font: { ...element.font, family: event.currentTarget.value } })
          }
        >
          {!known && <option value={element.font.family}>{element.font.family} (missing)</option>}
          {scripts.map(([script, name]) => {
            const list = families.filter((f) => f.script === script);
            return list.length ? (
              <optgroup key={script} label={name}>
                {list.map((f) => (
                  <option key={f.family} value={f.family}>
                    {f.family}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
      </label>
      <label className="cgv-field">
        <span className="cgv-field-label">Weight</span>
        <select
          aria-label="Weight"
          value={element.font.weight ?? 400}
          disabled={disabled}
          onChange={(event) =>
            text({ font: { ...element.font, weight: Number(event.currentTarget.value) } })
          }
        >
          {weights.map(([weight, name]) => (
            <option key={weight} value={weight}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label className="cgv-field">
        <span className="cgv-field-label">Italic</span>
        <input
          type="checkbox"
          aria-label="Italic"
          checked={element.font.italic === true}
          disabled={disabled}
          onChange={(event) =>
            text({ font: { ...element.font, italic: event.currentTarget.checked } })
          }
        />
      </label>
      <ScrubField
        label="Size"
        value={element.size}
        min={1}
        max={10000}
        step={1}
        precision={0}
        unit="px"
        testId="title-size"
        editor={editor}
        disabled={disabled}
        command={(size) => update((e) => ({ ...e, size }))}
      />
      <div className="cgv-field">
        <span className="cgv-field-label">Align</span>
        <div className="cgv-segmented" role="group" aria-label="Alignment">
          {(['left', 'center', 'right'] as TextAlign[]).map((align) => (
            <CgButton
              key={align}
              size="small"
              appearance={(element.align ?? 'center') === align ? 'soft' : 'ghost'}
              aria-pressed={(element.align ?? 'center') === align}
              disabled={disabled}
              onClick={() => text({ align })}
            >
              {align[0].toUpperCase() + align.slice(1)}
            </CgButton>
          ))}
        </div>
      </div>
      <label className="cgv-field">
        <span className="cgv-field-label">Direction</span>
        <select
          aria-label="Direction"
          value={element.direction ?? 'auto'}
          disabled={disabled}
          onChange={(event) => text({ direction: event.currentTarget.value as TextDirection })}
        >
          <option value="auto">From the text</option>
          <option value="ltr">Left to right</option>
          <option value="rtl">Right to left</option>
        </select>
      </label>
      <ScrubField
        label="Line spacing"
        value={element.lineSpacing ?? 1}
        min={0.1}
        max={10}
        step={0.01}
        precision={2}
        unit="×"
        testId="title-line-spacing"
        editor={editor}
        disabled={disabled}
        command={(lineSpacing) => update((e) => ({ ...e, lineSpacing }))}
      />
      <ScrubField
        label="Letter spacing"
        value={element.letterSpacing ?? 0}
        min={-500}
        max={500}
        step={0.5}
        precision={1}
        unit="px"
        testId="title-letter-spacing"
        editor={editor}
        disabled={disabled}
        command={(letterSpacing) => update((e) => ({ ...e, letterSpacing }))}
      />
      <label className="cgv-field">
        <span className="cgv-field-label">Wrap</span>
        <input
          type="checkbox"
          aria-label="Wrap lines"
          checked={element.wrap !== undefined}
          disabled={disabled}
          onChange={(event) =>
            text({
              wrap: event.currentTarget.checked ? Math.max(200, element.size * 8) : undefined,
            })
          }
        />
      </label>
      {element.wrap !== undefined && (
        <ScrubField
          label="Wrap width"
          value={element.wrap}
          min={1}
          max={10000}
          step={1}
          precision={0}
          unit="px"
          testId="title-wrap"
          editor={editor}
          disabled={disabled}
          command={(wrap) => update((e) => ({ ...e, wrap }))}
        />
      )}
    </Section>
  );
}

function StyleSection({
  editor,
  context,
  element,
  update,
  execute,
  disabled,
}: SectionProps & { context: KeyContext }) {
  const fillProperty = elementProperty(element.id, 'fill');
  const fillAnimated = isAnimated(context.clip, fillProperty);
  const fill = fillAnimated
    ? ((valueAt(context.clip.keyframes?.[fillProperty], context.offset) as Color | undefined) ??
      element.fill)
    : element.fill;
  const stroke = element.stroke;
  const shadow = element.shadow;
  const background = element.type === 'text' ? element.background : undefined;
  const scrub = (
    label: string,
    testId: string,
    value: number,
    min: number,
    max: number,
    command: (value: number) => Command,
  ) => (
    <ScrubField
      label={label}
      value={value}
      min={min}
      max={max}
      step={0.5}
      precision={1}
      unit="px"
      testId={testId}
      editor={editor}
      disabled={disabled}
      command={command}
    />
  );
  return (
    <Section title="Style">
      <ColorField
        label="Colour"
        value={fill}
        testId="title-fill"
        editor={editor}
        disabled={disabled}
        command={(color) =>
          fillAnimated
            ? keyCommand(context, [fillProperty], color)
            : update((e) => ({ ...e, fill: color }))
        }
        keys={
          <KeyControls
            editor={editor}
            context={context}
            properties={[fillProperty]}
            label="Colour"
            value={fill}
            disabled={disabled}
          />
        }
      />
      <ScrubField
        label="Fill opacity"
        value={fill.a * 100}
        min={0}
        max={100}
        step={0.5}
        precision={0}
        unit="%"
        testId="title-fill-alpha"
        editor={editor}
        disabled={disabled || fillAnimated}
        command={(alpha) => update((e) => ({ ...e, fill: { ...e.fill, a: alpha / 100 } }))}
      />
      <label className="cgv-field">
        <span className="cgv-field-label">Outline</span>
        <input
          type="checkbox"
          aria-label="Outline"
          checked={!!stroke}
          disabled={disabled}
          onChange={(event) =>
            execute(
              update((e) => ({
                ...e,
                stroke: event.currentTarget.checked ? { color: black, width: 6 } : undefined,
              })),
            )
          }
        />
      </label>
      {stroke && (
        <>
          <ColorField
            label="Outline colour"
            value={stroke.color}
            testId="title-stroke-color"
            editor={editor}
            disabled={disabled}
            command={(color) => update((e) => ({ ...e, stroke: { ...stroke, color } }))}
          />
          {scrub('Outline width', 'title-stroke-width', stroke.width, 0, 1000, (width) =>
            update((e) => ({ ...e, stroke: { ...stroke, width } })),
          )}
        </>
      )}
      <label className="cgv-field">
        <span className="cgv-field-label">Shadow</span>
        <input
          type="checkbox"
          aria-label="Shadow"
          checked={!!shadow}
          disabled={disabled}
          onChange={(event) =>
            execute(
              update((e) => ({
                ...e,
                shadow: event.currentTarget.checked
                  ? { color: { ...black, a: 0.6 }, x: 0, y: 6, blur: 12 }
                  : undefined,
              })),
            )
          }
        />
      </label>
      {shadow && (
        <>
          <ColorField
            label="Shadow colour"
            value={shadow.color}
            testId="title-shadow-color"
            editor={editor}
            disabled={disabled}
            command={(color) => update((e) => ({ ...e, shadow: { ...shadow, color } }))}
          />
          {scrub('Shadow X', 'title-shadow-x', shadow.x, -10000, 10000, (x) =>
            update((e) => ({ ...e, shadow: { ...shadow, x } })),
          )}
          {scrub('Shadow Y', 'title-shadow-y', shadow.y, -10000, 10000, (y) =>
            update((e) => ({ ...e, shadow: { ...shadow, y } })),
          )}
          {scrub('Blur', 'title-shadow-blur', shadow.blur, 0, 1000, (blur) =>
            update((e) => ({ ...e, shadow: { ...shadow, blur } })),
          )}
        </>
      )}
      {element.type === 'text' && (
        <label className="cgv-field">
          <span className="cgv-field-label">Background</span>
          <input
            type="checkbox"
            aria-label="Background box"
            checked={!!background}
            disabled={disabled}
            onChange={(event) =>
              execute(
                update((e) => ({
                  ...e,
                  background: event.currentTarget.checked
                    ? { color: { ...black, a: 0.6 }, padding: 16, radius: 8 }
                    : undefined,
                })),
              )
            }
          />
        </label>
      )}
      {background && element.type === 'text' && (
        <>
          <ColorField
            label="Box colour"
            value={background.color}
            testId="title-background-color"
            editor={editor}
            disabled={disabled}
            command={(color) => update((e) => ({ ...e, background: { ...background, color } }))}
          />
          <ScrubField
            label="Box opacity"
            value={background.color.a * 100}
            min={0}
            max={100}
            step={0.5}
            precision={0}
            unit="%"
            testId="title-background-alpha"
            editor={editor}
            disabled={disabled}
            command={(alpha) =>
              update((e) => ({
                ...e,
                background: { ...background, color: { ...background.color, a: alpha / 100 } },
              }))
            }
          />
          {scrub('Padding', 'title-background-padding', background.padding, 0, 10000, (padding) =>
            update((e) => ({ ...e, background: { ...background, padding } })),
          )}
          {scrub('Corners', 'title-background-radius', background.radius ?? 0, 0, 10000, (radius) =>
            update((e) => ({ ...e, background: { ...background, radius } })),
          )}
          <label className="cgv-field">
            <span className="cgv-field-label">Per line</span>
            <input
              type="checkbox"
              aria-label="A box per line"
              checked={background.perLine === true}
              disabled={disabled}
              onChange={(event) =>
                execute(
                  update((e) => ({
                    ...e,
                    background: { ...background, perLine: event.currentTarget.checked },
                  })),
                )
              }
            />
          </label>
        </>
      )}
    </Section>
  );
}

function AnimationSection({
  editor,
  clip,
  element,
  canvas,
  frame,
  disabled,
}: {
  editor: EditorState;
  clip: Clip;
  element: TitleElement;
  canvas: { width: number; height: number };
  frame: number;
  disabled: boolean;
}) {
  const [seconds, setSeconds] = useState(0.6);
  const offered = presets.filter((p) => !p.text || element.type === 'text');
  const apply = (which: 'in' | 'out', preset: Preset | null) => {
    const commands = animateCommands(clip, {
      element,
      which,
      preset,
      seconds,
      duration: clip.duration,
      frame,
      canvas,
    });
    if (commands.length) void editor.project.execute(together(commands));
  };
  const menu = (which: 'in' | 'out', label: string) => (
    <label className="cgv-field">
      <span className="cgv-field-label">{label}</span>
      <select
        aria-label={label}
        data-testid={`title-animation-${which}`}
        value=""
        disabled={disabled}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value) apply(which, value === 'none' ? null : (value as Preset));
        }}
      >
        <option value="">Choose…</option>
        <option value="none">None</option>
        {offered
          .filter((p) => which === 'in' || !p.entranceOnly)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <Section title="Animation">
      <label className="cgv-field">
        <span className="cgv-field-label">Length</span>
        <input
          type="number"
          aria-label="Animation length in seconds"
          data-testid="title-animation-seconds"
          min={0.1}
          max={10}
          step={0.1}
          value={seconds}
          disabled={disabled}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (value > 0) setSeconds(Math.min(10, value));
          }}
        />
      </label>
      {menu('in', 'Entrance')}
      {menu('out', 'Exit')}
      <p className="cgv-muted">
        Presets write keyframes on this element&apos;s position, scale, opacity or reveal; change
        them like any other.
      </p>
    </Section>
  );
}

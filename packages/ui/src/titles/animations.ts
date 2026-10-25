// Title animations as keyframe presets: an entrance runs an element from a start
// state to its own values; an exit runs it from its values to an end state.
// They write ordinary keyframes on the element's settings, which stay editable.
import {
  elementProperty,
  type Clip,
  type Command,
  type ElementSetting,
  type Interpolation,
  type Keyframe,
  type RevealUnit,
  type Title,
  type TitleElement,
} from '@cgv/engine-client';

export type Preset =
  | 'fade'
  | 'slideUp'
  | 'slideDown'
  | 'slideLeft'
  | 'slideRight'
  | 'scale'
  | 'pop'
  | 'typewriter'
  | 'words';

/** Entrances and exits offered, in menu order; some suit text only. */
export const presets: { id: Preset; label: string; text?: boolean; entranceOnly?: boolean }[] = [
  { id: 'fade', label: 'Fade' },
  { id: 'slideUp', label: 'Slide up' },
  { id: 'slideDown', label: 'Slide down' },
  { id: 'slideLeft', label: 'Slide left' },
  { id: 'slideRight', label: 'Slide right' },
  { id: 'scale', label: 'Scale' },
  { id: 'pop', label: 'Pop', entranceOnly: true },
  { id: 'typewriter', label: 'Typewriter', text: true },
  { id: 'words', label: 'Word by word', text: true },
];

/** The settings presets animate; applying one clears the others in its stretch. */
const animated: ElementSetting[] = ['x', 'y', 'scale', 'opacity', 'reveal'];

const linear: Interpolation = { kind: 'linear' };
const easeOut: Interpolation = { kind: 'easeOut' };
const easeIn: Interpolation = { kind: 'easeIn' };
/** CSS's ease-out-back: overshoots a little before it settles. */
const overshoot: Interpolation = { kind: 'bezier', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };

/** One setting's move between the element's own value and the preset's far state. */
interface Ramp {
  setting: ElementSetting;
  /** The far state: where an entrance starts and an exit ends. */
  far: number;
  /** The element's own value. */
  own: number;
  /** The entrance's curve; exits mirror it. */
  ease: Interpolation;
}

function ramps(
  preset: Preset,
  element: TitleElement,
  canvas: { width: number; height: number },
): Ramp[] {
  const opacity = element.opacity ?? 1;
  const scale = element.scale ?? 1;
  const fade: Ramp = { setting: 'opacity', far: 0, own: opacity, ease: easeOut };
  const slideY = canvas.height * 0.08;
  const slideX = canvas.width * 0.08;
  switch (preset) {
    case 'fade':
      return [fade];
    case 'slideUp':
      return [{ setting: 'y', far: element.y + slideY, own: element.y, ease: easeOut }, fade];
    case 'slideDown':
      return [{ setting: 'y', far: element.y - slideY, own: element.y, ease: easeOut }, fade];
    case 'slideLeft':
      return [{ setting: 'x', far: element.x + slideX, own: element.x, ease: easeOut }, fade];
    case 'slideRight':
      return [{ setting: 'x', far: element.x - slideX, own: element.x, ease: easeOut }, fade];
    case 'scale':
      return [{ setting: 'scale', far: scale * 0.6, own: scale, ease: easeOut }, fade];
    case 'pop':
      return [{ setting: 'scale', far: scale * 0.01, own: scale, ease: overshoot }];
    case 'typewriter':
    case 'words':
      return [{ setting: 'reveal', far: 0, own: 1, ease: linear }];
  }
}

export interface AnimationRequest {
  element: TitleElement;
  which: 'in' | 'out';
  /** None removes the element's animation in that stretch. */
  preset: Preset | null;
  seconds: number;
  /** Seconds after the clip's start an entrance waits (staggered templates). */
  delay?: number;
  /** The clip's length and one frame, in flicks. */
  duration: number;
  frame: number;
  canvas: { width: number; height: number };
  /** The clip's keyframes now. */
  keyframes?: Record<string, Keyframe[]>;
}

export interface AnimationKeys {
  /** The new keys of each setting it touches; empty stops animating one. */
  keyframes: Record<string, Keyframe[]>;
  /** The reveal unit the preset counts in, when it reveals. */
  revealBy?: RevealUnit;
}

const snap = (time: number, frame: number) => Math.round(time / frame) * frame;

/**
 * The keyframes an entrance or exit gives an element: its stretch at the clip's
 * start (after any delay) or end is cleared of earlier preset keys and filled
 * with the preset's ramps; keys outside the stretch stay.
 */
export function animationKeys(request: AnimationRequest): AnimationKeys {
  const { element, which, preset, duration, frame, canvas } = request;
  const last = Math.max(0, duration - frame);
  const length = Math.min(snap(request.seconds * 705_600_000, frame), last);
  const delay =
    which === 'in' ? Math.min(snap((request.delay ?? 0) * 705_600_000, frame), last) : 0;
  const start = which === 'in' ? delay : Math.max(0, last - length);
  const end = which === 'in' ? Math.min(last, delay + length) : last;
  const inside = (time: number) => time >= start && time <= end;
  const isText = element.type === 'text';
  const chosen =
    preset && ramps(preset, element, canvas).filter((r) => isText || r.setting !== 'reveal');
  const keyframes: Record<string, Keyframe[]> = {};
  for (const setting of animated) {
    const name = elementProperty(element.id, setting);
    const existing = request.keyframes?.[name] ?? [];
    const ramp = chosen?.find((r) => r.setting === setting);
    const kept = existing.filter((key) => !inside(key.time));
    if (!ramp && kept.length === existing.length) continue;
    const added: Keyframe[] = ramp
      ? which === 'in'
        ? [
            { time: start, value: ramp.far, interpolation: ramp.ease },
            { time: end, value: ramp.own, interpolation: linear },
          ]
        : [
            { time: start, value: ramp.own, interpolation: mirror(ramp.ease) },
            { time: end, value: ramp.far, interpolation: linear },
          ]
      : [];
    keyframes[name] = [...kept, ...added].sort((a, b) => a.time - b.time);
  }
  const revealBy: RevealUnit | undefined =
    preset === 'typewriter' ? 'letter' : preset === 'words' ? 'word' : undefined;
  return { keyframes, revealBy };
}

/** An exit runs the entrance's curve backwards. */
function mirror(ease: Interpolation): Interpolation {
  if (ease.kind === 'easeOut') return easeIn;
  if (ease.kind === 'easeIn') return easeOut;
  if (ease.kind === 'bezier')
    return { kind: 'bezier', x1: 1 - ease.x2, y1: 1 - ease.y2, x2: 1 - ease.x1, y2: 1 - ease.y1 };
  return ease;
}

/** The title with `element`'s reveal unit changed, when it differs. */
function withReveal(title: Title, element: TitleElement, revealBy?: RevealUnit): Title | null {
  if (!revealBy || element.type !== 'text' || (element.revealBy ?? 'letter') === revealBy)
    return null;
  return {
    elements: title.elements.map((e) => (e.id === element.id ? { ...e, revealBy } : e)),
  };
}

/** The commands that give a title clip's element an entrance or exit: one step. */
export function animateCommands(
  clip: Clip,
  request: Omit<AnimationRequest, 'keyframes'>,
): Command[] {
  const { keyframes, revealBy } = animationKeys({ ...request, keyframes: clip.keyframes });
  const commands: Command[] = [];
  const title = clip.title && withReveal(clip.title, request.element, revealBy);
  if (title) commands.push({ type: 'setTitle', clip: clip.id, title });
  for (const [property, keys] of Object.entries(keyframes))
    commands.push({ type: 'setKeyframes', clip: clip.id, property, keys });
  return commands;
}

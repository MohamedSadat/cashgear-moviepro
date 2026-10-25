// Title templates: JSON presets in assets/titles, one file each, designed on a
// 1920×1080 canvas and fitted to the project. Animations are named presets, so a
// template stays readable; they become keyframes when the title is added.
import {
  FLICKS_PER_SECOND,
  type ClipSpec,
  type Keyframe,
  type ProjectSettings,
  type ShapeKind,
  type Title,
  type TitleElement,
} from '@cgv/engine-client';
import { animationKeys, type Preset } from './animations';

export interface TemplateAnimation {
  /** The element's id in the template. */
  element: number;
  in?: Preset;
  out?: Preset;
  seconds?: number;
  /** Seconds after the start the entrance waits. */
  delay?: number;
}

interface TemplateFile {
  name: string;
  category: string;
  /** How long a new title lasts. */
  seconds?: number;
  elements: TitleElement[];
  animations?: TemplateAnimation[];
}

export interface TitleTemplate {
  id: string;
  name: string;
  category: string;
  seconds: number;
  title: Title;
  animations: TemplateAnimation[];
}

/** The canvas templates are designed on. */
export const designSize = { width: 1920, height: 1080 };
/** A new title's length when its template does not say. */
export const titleSeconds = 5;

const files = import.meta.glob<TemplateFile>('../../../../assets/titles/*.json', {
  eager: true,
  import: 'default',
});

/** Categories in the order the browser shows them. */
const categories = [
  'Basic',
  'Headlines',
  'Lower thirds',
  'Social',
  'Quotes and captions',
  'Arabic',
];

export const templates: TitleTemplate[] = Object.entries(files)
  .map(([path, file]) => ({
    id: path.slice(path.lastIndexOf('/') + 1, -'.json'.length),
    name: file.name,
    category: file.category,
    seconds: file.seconds ?? titleSeconds,
    title: { elements: file.elements },
    animations: file.animations ?? [],
  }))
  .sort(
    (a, b) =>
      (categories.indexOf(a.category) + 1 || 99) - (categories.indexOf(b.category) + 1 || 99) ||
      // The plain title leads.
      Number(a.id !== 'default') - Number(b.id !== 'default') ||
      a.name.localeCompare(b.name),
  );

const white = { r: 1, g: 1, b: 1, a: 1 };

function shape(kind: ShapeKind, name: string, width: number, height: number): TitleTemplate {
  return {
    id: `shape-${kind}`,
    name,
    category: 'Shapes',
    seconds: titleSeconds,
    title: {
      elements: [
        {
          id: 1,
          x: 0,
          y: 0,
          fill: white,
          type: 'shape',
          kind,
          width,
          height,
          radius: kind === 'rectangle' ? 24 : 0,
          sides: kind === 'star' ? 5 : 6,
          inner: 0.45,
        },
      ],
    },
    animations: [],
  };
}

/** Basic shapes, each a title of one element. */
export const shapes: TitleTemplate[] = [
  shape('rectangle', 'Rectangle', 600, 340),
  shape('ellipse', 'Ellipse', 400, 400),
  shape('line', 'Line', 800, 16),
  shape('arrow', 'Arrow', 500, 180),
  shape('polygon', 'Hexagon', 400, 400),
  shape('star', 'Star', 400, 400),
];

/** `title`, designed on `designSize`, scaled to fit a canvas of `width` × `height`. */
export function fitTitle(title: Title, width: number, height: number): Title {
  const k = Math.min(width / designSize.width, height / designSize.height);
  if (Math.abs(k - 1) < 1e-9) return title;
  return {
    elements: title.elements.map((e) => {
      const scaled: TitleElement = {
        ...e,
        x: e.x * k,
        y: e.y * k,
        stroke: e.stroke && { ...e.stroke, width: e.stroke.width * k },
        shadow: e.shadow && {
          ...e.shadow,
          x: e.shadow.x * k,
          y: e.shadow.y * k,
          blur: e.shadow.blur * k,
        },
      };
      if (scaled.type === 'text' && e.type === 'text')
        return {
          ...scaled,
          size: e.size * k,
          wrap: e.wrap && e.wrap * k,
          letterSpacing: e.letterSpacing && e.letterSpacing * k,
          background: e.background && {
            ...e.background,
            padding: e.background.padding * k,
            radius: (e.background.radius ?? 0) * k,
          },
        };
      if (scaled.type === 'shape' && e.type === 'shape')
        return {
          ...scaled,
          width: e.width * k,
          height: e.height * k,
          radius: (e.radius ?? 0) * k,
        };
      return scaled;
    }),
  };
}

/** A new title clip from `template`, fitted to the project, its animations keyed. */
export function templateSpec(template: TitleTemplate, settings: ProjectSettings): ClipSpec {
  const rate = settings.frameRate;
  const frame = (FLICKS_PER_SECOND * rate.den) / rate.num;
  const duration = Math.round((template.seconds * FLICKS_PER_SECOND) / frame) * frame;
  const canvas = { width: settings.width, height: settings.height };
  let title = fitTitle(template.title, canvas.width, canvas.height);
  let keyframes: Record<string, Keyframe[]> = {};
  for (const animation of template.animations) {
    for (const which of ['in', 'out'] as const) {
      const preset = animation[which];
      const element = title.elements.find((e) => e.id === animation.element);
      if (!preset || !element) continue;
      const made = animationKeys({
        element,
        which,
        preset,
        seconds: animation.seconds ?? 0.6,
        delay: which === 'in' ? animation.delay : 0,
        duration,
        frame,
        canvas,
        keyframes,
      });
      keyframes = { ...keyframes, ...made.keyframes };
      if (made.revealBy && element.type === 'text') {
        const revealBy = made.revealBy;
        title = {
          elements: title.elements.map((e) => (e.id === element.id ? { ...e, revealBy } : e)),
        };
      }
    }
  }
  for (const [name, keys] of Object.entries(keyframes)) if (!keys.length) delete keyframes[name];
  return { kind: 'title', duration, title, keyframes };
}

/** A clip's name on the timeline: its first text, on one line. */
export function titleName(title: Title | undefined): string {
  for (const element of title?.elements ?? [])
    if (element.type === 'text' && element.text.trim())
      return element.text.trim().replace(/\s+/g, ' ');
  return title?.elements.some((e) => e.type === 'shape') ? 'Shape' : 'Title';
}

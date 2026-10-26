// Project templates: JSON in assets/templates, made by scripts/make-project-templates.mjs
// and bundled into the app. Each carries its pack and version, so a server can
// offer more later. Times in the files are seconds.
import type {
  ClipProperties,
  Color,
  EffectSpec,
  Params,
  ProjectSettings,
  TrackRole,
} from '@cgv/engine-client';

export type TemplateKind = 'project' | 'intro' | 'outro';
export type Motion = 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight';

interface Timed {
  at: number;
  seconds: number;
}

/** A clip of a template. */
export type TemplateClip =
  | (Timed & {
      type: 'slot';
      slot: number;
      motion?: Motion;
      effects?: EffectSpec[];
      properties?: ClipProperties;
    })
  | (Timed & { type: 'title'; template: string; texts?: string[]; properties?: ClipProperties })
  | (Timed & { type: 'background'; color: Color })
  | (Timed & { type: 'sticker'; sticker: string; properties?: ClipProperties })
  | (Timed & { type: 'sound'; sound: string; fadeOut?: number; volumeDb?: number })
  | (Timed & { type: 'adjustment'; effects: EffectSpec[] });

/** A transition between touching clips of a track (`from`, `to` index them; null is a free edge). */
export interface TemplateTransition {
  from: number | null;
  to: number | null;
  kind: string;
  seconds: number;
  params?: Params;
}

export interface TemplateTrack {
  name?: string;
  role?: TrackRole;
  clips: TemplateClip[];
  transitions?: TemplateTransition[];
}

interface TemplateFile {
  pack: string;
  version: number;
  name: string;
  category: string;
  kind: TemplateKind;
  /** The frame a project template is made for; intros and outros fit any. */
  aspect?: 'landscape' | 'portrait' | 'square';
  description: string;
  /** Its length and its slots, as the script counted them. */
  seconds: number;
  slots: number;
  /** Bottom first; the first goes on the main track. */
  tracks: TemplateTrack[];
}

export interface ProjectTemplate extends TemplateFile {
  id: string;
}

const files = import.meta.glob<TemplateFile>('../../../../assets/templates/*.json', {
  eager: true,
  import: 'default',
});

/** Categories in the order the browser shows them. */
const categories = ['Slideshows', 'Vlog', 'Promo', 'Social', 'Arabic', 'Intros', 'Outros'];

export const projectTemplates: ProjectTemplate[] = Object.entries(files)
  .map(([path, file]) => ({
    ...file,
    id: path.slice(path.lastIndexOf('/') + 1, -'.json'.length),
  }))
  .sort(
    (a, b) =>
      (categories.indexOf(a.category) + 1 || 99) - (categories.indexOf(b.category) + 1 || 99) ||
      a.name.localeCompare(b.name),
  );

/** The settings a project template starts a project with: its frame, at 30 fps. */
export function templateSettings(
  template: ProjectTemplate,
  base: ProjectSettings,
): ProjectSettings {
  const size = {
    landscape: { width: 1920, height: 1080 },
    portrait: { width: 1080, height: 1920 },
    square: { width: 1080, height: 1080 },
  }[template.aspect ?? 'landscape'];
  return { ...base, ...size };
}

/** "6 slots · 18 s · 16:9" */
export function templateSummary(template: ProjectTemplate): string {
  const shape = { landscape: '16:9', portrait: '9:16', square: '1:1' }[
    template.aspect ?? 'landscape'
  ];
  const slots = `${template.slots} ${template.slots === 1 ? 'slot' : 'slots'}`;
  const where = template.kind === 'project' ? shape : template.kind === 'intro' ? 'intro' : 'outro';
  return `${slots} · ${Number(template.seconds.toFixed(1))} s · ${where}`;
}

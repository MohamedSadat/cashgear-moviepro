import {
  FLICKS_PER_SECOND,
  type Clip,
  type ClipSpec,
  type Command,
  type ImportRequest,
  type Keyframe,
  type Project,
  type ProjectSettings,
  type Title,
} from '@cgv/engine-client';
import { stickerMediaId, stickerRequest, stickerScale, stickers } from '../stickers/catalog';
import { soundMediaId, soundRequest, sounds } from '../sounds/catalog';
import { nearestCut } from '../timeline/geometry';
import { templateSpec, templates as titleTemplates } from '../titles/templates';
import type { Motion, ProjectTemplate, TemplateClip } from './templates';

/** How far a slow zoom or pan moves: 15% larger. */
const drift = 1.15;

const white = { r: 1, g: 1, b: 1, a: 1 };

/** Flicks of `seconds`, on whole frames. */
const frames = (seconds: number, frame: number) =>
  Math.round((seconds * FLICKS_PER_SECOND) / frame) * frame;

/**
 * A slot's placeholder: a dark frame with its number and length, drawn as a
 * title so the template plays before it is filled.
 */
export function slotPlaceholder(slot: number, seconds: number, settings: ProjectSettings): Title {
  const { width, height } = settings;
  const shorter = Math.min(width, height);
  return {
    elements: [
      {
        id: 1,
        x: 0,
        y: 0,
        fill: { r: 0.13, g: 0.15, b: 0.19, a: 1 },
        type: 'shape',
        kind: 'rectangle',
        width,
        height,
      },
      {
        id: 2,
        x: 0,
        y: -shorter * 0.04,
        fill: white,
        type: 'text',
        text: `Clip ${slot}`,
        font: { family: 'Inter', weight: 700 },
        size: shorter * 0.11,
      },
      {
        id: 3,
        x: 0,
        y: shorter * 0.08,
        fill: { r: 0.62, g: 0.66, b: 0.73, a: 1 },
        type: 'text',
        text: `${Number(seconds.toFixed(1))} s · drop media here`,
        font: { family: 'Inter', weight: 500 },
        size: shorter * 0.04,
      },
    ],
  };
}

/** A slot's slow zoom or pan, as transform keyframes over `duration`. */
export function motionKeyframes(
  motion: Motion,
  duration: number,
  frame: number,
  settings: ProjectSettings,
): { keyframes: Record<string, Keyframe[]>; scale?: number } {
  const last = Math.max(0, duration - frame);
  const keys = (from: number, to: number): Keyframe[] => [
    { time: 0, value: from, interpolation: { kind: 'easeInOut' } },
    { time: last, value: to, interpolation: { kind: 'easeInOut' } },
  ];
  if (motion === 'zoomIn' || motion === 'zoomOut') {
    const [from, to] = motion === 'zoomIn' ? [1, drift] : [drift, 1];
    return {
      keyframes: { 'transform.scaleX': keys(from, to), 'transform.scaleY': keys(from, to) },
    };
  }
  // A pan keeps the picture 15% larger and slides across what that leaves.
  const reach = Math.round(((drift - 1) / 2) * settings.width * 0.9);
  const [from, to] = motion === 'panLeft' ? [reach, -reach] : [-reach, reach];
  return { keyframes: { 'transform.x': keys(from, to) }, scale: drift };
}

/** A title template with its texts replaced in order, `seconds` long. */
function titleSpec(
  id: string,
  texts: string[] | undefined,
  seconds: number,
  settings: ProjectSettings,
): ClipSpec {
  const template = titleTemplates.find((item) => item.id === id);
  if (!template) throw new Error(`The template uses a title it does not have: ${id}`);
  let index = 0;
  const title: Title = {
    elements: template.title.elements.map((element) =>
      element.type === 'text' && texts && index < texts.length
        ? { ...element, text: texts[index++] }
        : element,
    ),
  };
  return templateSpec({ ...template, title, seconds }, settings);
}

/**
 * What a template clip becomes in the project. Slots are numbered after the
 * project's own (`after`), so an intro's slots follow those already there.
 */
export function clipSpec(
  clip: TemplateClip,
  settings: ProjectSettings,
  frame: number,
  after = 0,
): ClipSpec {
  const duration = frames(clip.seconds, frame);
  switch (clip.type) {
    case 'slot': {
      const slot = clip.slot + after;
      const motion = clip.motion
        ? motionKeyframes(clip.motion, duration, frame, settings)
        : { keyframes: {} };
      const transform = {
        ...(motion.scale ? { scaleX: motion.scale, scaleY: motion.scale } : {}),
        ...clip.properties?.transform,
      };
      return {
        kind: 'title',
        duration,
        title: slotPlaceholder(slot, clip.seconds, settings),
        slot,
        properties: { ...clip.properties, transform },
        effects: clip.effects,
        keyframes: motion.keyframes,
      };
    }
    case 'title': {
      const spec = titleSpec(clip.template, clip.texts, clip.seconds, settings);
      return clip.properties ? { ...spec, properties: clip.properties } : spec;
    }
    case 'background':
      return {
        kind: 'title',
        duration,
        title: {
          elements: [
            {
              id: 1,
              x: 0,
              y: 0,
              fill: clip.color,
              type: 'shape',
              kind: 'rectangle',
              width: settings.width,
              height: settings.height,
            },
          ],
        },
      };
    case 'sticker': {
      const sticker = stickers.find((item) => item.id === clip.sticker);
      if (!sticker)
        throw new Error(`The template uses a sticker it does not have: ${clip.sticker}`);
      return {
        media: stickerMediaId(sticker),
        duration,
        properties: {
          ...clip.properties,
          transform: { scaleX: stickerScale, scaleY: stickerScale, ...clip.properties?.transform },
        },
      };
    }
    case 'sound': {
      const sound = sounds.find((item) => item.id === clip.sound);
      if (!sound) throw new Error(`The template uses a sound it does not have: ${clip.sound}`);
      const length = Math.min(
        duration,
        Math.floor((sound.seconds * FLICKS_PER_SECOND) / frame) * frame,
      );
      return {
        media: soundMediaId(sound),
        duration: length,
        video: false,
        audio: true,
        properties: {
          ...(clip.fadeOut ? { fadeOut: Math.min(length, frames(clip.fadeOut, frame)) } : {}),
          ...(clip.volumeDb !== undefined ? { volumeDb: clip.volumeDb } : {}),
        },
      };
    }
    case 'adjustment':
      return { kind: 'adjustment', duration, effects: clip.effects };
  }
}

/** The pack media (stickers and sounds) a template uses that the project lacks. */
export function packRequests(template: ProjectTemplate, project: Project): ImportRequest[] {
  const have = new Set(project.media.map((media) => media.id));
  const requests = new Map<string, ImportRequest>();
  for (const clip of template.tracks.flatMap((track) => track.clips)) {
    if (clip.type === 'sticker') {
      const sticker = stickers.find((item) => item.id === clip.sticker);
      if (sticker && !have.has(stickerMediaId(sticker)))
        requests.set(stickerMediaId(sticker), stickerRequest(sticker));
    } else if (clip.type === 'sound') {
      const sound = sounds.find((item) => item.id === clip.sound);
      if (sound && !have.has(soundMediaId(sound)))
        requests.set(soundMediaId(sound), soundRequest(sound));
    }
  }
  return [...requests.values()];
}

/**
 * Places `template` in `project` at `at`, one command at a time (`step` returns
 * what each created). Its first track goes on the main track, each clip inserted
 * after the one before, so later clips move along; on a magnetic main track the
 * first lands on the cut nearest `at`, as the model puts it. Its other tracks get
 * tracks of their own above the others, named as the template names them.
 * Returns the new clips' ids.
 */
export async function placeTemplate(
  template: ProjectTemplate,
  project: Project,
  at: number,
  step: (command: Command) => Promise<number[]>,
): Promise<number[]> {
  const settings = project.settings;
  const rate = settings.frameRate;
  const frame = (FLICKS_PER_SECOND * rate.den) / rate.num;
  const main = project.tracks.find((track) => track.id === project.mainTrack);
  const snapped = Math.round(at / frame) * frame;
  const start = project.magnetic && main ? nearestCut(main.clips, snapped) : snapped;
  const after = Math.max(0, ...project.tracks.flatMap((t) => t.clips.map((c) => c.slot ?? 0)));
  const created: number[] = [];
  let count = project.tracks.length;
  for (const [index, track] of template.tracks.entries()) {
    const first = index === 0;
    // An empty track a new project starts with is used before adding one.
    const spare =
      !first && template.kind === 'project'
        ? project.tracks.find(
            (t, i) => i === index && t.id !== project.mainTrack && t.clips.length === 0,
          )
        : undefined;
    let target = first ? project.mainTrack : spare?.id;
    if (target === undefined) {
      [target] = await step({ type: 'addTrack', index: count, name: track.name });
      count++;
    } else if (!first && track.name)
      await step({ type: 'renameTrack', track: target, name: track.name });
    if (track.role)
      await step({ type: 'setTrackSound', track: target, sound: { role: track.role } });
    const ids: number[] = [];
    let next = start;
    for (const clip of track.clips) {
      const spec = clipSpec(clip, settings, frame, after);
      const [id] = await step(
        first
          ? { type: 'insert', track: target, at: next, clip: spec }
          : { type: 'overwrite', track: target, at: start + frames(clip.at, frame), clip: spec },
      );
      next += spec.duration;
      ids.push(id);
      created.push(id);
    }
    for (const transition of track.transitions ?? [])
      await step({
        type: 'addTransition',
        track: target,
        from: transition.from === null ? null : ids[transition.from],
        to: transition.to === null ? null : ids[transition.to],
        transition: {
          kind: transition.kind,
          duration: frames(transition.seconds, frame),
          params: transition.params,
        },
      });
  }
  return created;
}

/** The first clip of each slot (main track first, then by time), by slot number. */
export function slotsOf(project: Project): Map<number, Clip> {
  const slots = new Map<number, Clip>();
  const tracks = [...project.tracks].sort(
    (a, b) => Number(b.id === project.mainTrack) - Number(a.id === project.mainTrack),
  );
  for (const track of tracks)
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start))
      if (clip.slot !== undefined && !slots.has(clip.slot)) slots.set(clip.slot, clip);
  return new Map([...slots].sort((a, b) => a[0] - b[0]));
}

/**
 * The slots a fill goes to, in order: the empty ones, or every one when all are
 * filled (to fill them again).
 */
export function fillTargets(project: Project): Clip[] {
  const slots = [...slotsOf(project).values()];
  const empty = slots.filter((clip) => !clip.media);
  return empty.length ? empty : slots;
}

/** Commands filling the slots `fillTargets` picks, in order, with `media` (ids) in order. */
export function fillCommands(project: Project, media: string[]): Command[] {
  return fillTargets(project)
    .slice(0, media.length)
    .map((clip, i) => ({ type: 'fillSlot', clip: clip.id, media: media[i] }));
}

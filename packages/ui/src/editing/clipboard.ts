import type { ClipSpec, Command, Project } from '@cgv/engine-client';
import { nearestCut } from '../timeline/geometry';

/** A copied clip: what it shows and where it sat relative to the first copied clip. */
export interface ClipboardItem {
  /** The track it came from. */
  track: number;
  /** Start time after the earliest copied clip's start. */
  offset: number;
  clip: ClipSpec;
  /** Copies that were linked share a group number. */
  group: number | null;
}

/** Copies clips `ids` (in time order), keeping their links among themselves. */
export function copyClips(project: Project, ids: number[]): ClipboardItem[] {
  const wanted = new Set(ids);
  const found = project.tracks.flatMap((track) =>
    track.clips.filter((clip) => wanted.has(clip.id)).map((clip) => ({ track: track.id, clip })),
  );
  if (!found.length) return [];
  const first = Math.min(...found.map(({ clip }) => clip.start));
  const groups = new Map<number, number>();
  for (const { clip } of found)
    if (clip.link !== null) groups.set(clip.link, (groups.get(clip.link) ?? 0) + 1);
  return found
    .sort((a, b) => a.clip.start - b.clip.start || a.track - b.track)
    .map(({ track, clip }) => ({
      track,
      offset: clip.start - first,
      clip: {
        kind: clip.kind,
        media: clip.media,
        sourceIn: clip.sourceIn,
        duration: clip.duration,
        video: clip.video,
        audio: clip.audio,
        speed: clip.speed,
        properties: {
          transform: clip.transform,
          crop: clip.crop,
          opacity: clip.opacity,
          volumeDb: clip.volumeDb,
        },
        // Effects keep their ids, so their keyframes follow them to the copy.
        effects: clip.effects?.map(({ id, kind, pack, version, enabled, params }) => ({
          id,
          kind,
          pack,
          version,
          enabled,
          params,
        })),
        keyframes: clip.keyframes,
        title: clip.title,
      },
      group: clip.link !== null && (groups.get(clip.link) ?? 0) > 1 ? clip.link : null,
    }));
}

export interface PastePlan {
  /** Run in order; each places one clip. */
  commands: Command[];
  /** Indices into `commands` whose new clips are linked together afterwards. */
  links: number[][];
}

/**
 * Where a paste with its first clip at `at` puts each copy. Copies go back on
 * their own tracks (or the main track when theirs is gone) and overwrite what is
 * there. On the magnetic main track they are inserted one after another at the
 * cut nearest `at`, and their linked copies keep their place beside them.
 */
export function planPaste(project: Project, items: ClipboardItem[], at: number): PastePlan {
  const known = new Set(project.tracks.map((track) => track.id));
  const main = project.tracks.find((track) => track.id === project.mainTrack);
  const target = (item: ClipboardItem) => (known.has(item.track) ? item.track : project.mainTrack);
  const magnetic = project.magnetic && !!main;
  const onMain = (item: ClipboardItem) => magnetic && target(item) === project.mainTrack;

  // Main-track copies are inserted in order from the cut nearest the paste point.
  const landed = new Map<ClipboardItem, number>();
  let next = main ? nearestCut(main.clips, at + (items.find(onMain)?.offset ?? 0)) : at;
  for (const item of items.filter(onMain)) {
    landed.set(item, next);
    next += item.clip.duration;
  }
  // Other copies keep their place relative to the main-track copy they were linked
  // to, or else to the first main-track copy.
  const shift = new Map<number, number>();
  for (const [item, start] of landed)
    if (item.group !== null && !shift.has(item.group))
      shift.set(item.group, start - (at + item.offset));
  const [first] = landed;
  const overall = first ? first[1] - (at + first[0].offset) : 0;

  const commands: Command[] = [];
  const members = new Map<number, number[]>();
  for (const item of items) {
    const start = landed.get(item) ?? at + item.offset + (shift.get(item.group ?? NaN) ?? overall);
    const track = target(item);
    commands.push(
      onMain(item)
        ? { type: 'insert', track, at: start, clip: item.clip }
        : { type: 'overwrite', track, at: Math.max(0, start), clip: item.clip },
    );
    if (item.group !== null)
      members.set(item.group, [...(members.get(item.group) ?? []), commands.length - 1]);
  }
  return { commands, links: [...members.values()].filter((group) => group.length > 1) };
}

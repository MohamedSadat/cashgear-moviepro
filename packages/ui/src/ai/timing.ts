import { FLICKS_PER_SECOND, type Clip, type Project } from '@cgv/engine-client';
import { sourceAt } from '../speed/timing';

// Where things the AI tools find in a medium (silences, beats, words, scene
// cuts, all in its own time) fall on the timeline. Times are flicks unless named.

/**
 * The timeline time at which `clip` shows source time `source`, or null when it
 * never does (outside its range, or a freeze frame). Ramps and reverse are
 * followed: the clip's time map only ever rises or only falls.
 */
export function timelineAt(clip: Clip, source: number): number | null {
  if (clip.freeze || clip.duration <= 0) return null;
  const first = sourceAt(clip, 0);
  const last = sourceAt(clip, clip.duration);
  const rising = first <= last;
  if (source < Math.min(first, last) || source > Math.max(first, last)) return null;
  if (!clip.ramp?.length) {
    const offset = ((source - clip.sourceIn) * clip.speed.den) / clip.speed.num;
    return clip.reverse ? clip.start + clip.duration - offset : clip.start + offset;
  }
  let low = 0;
  let high = clip.duration;
  for (let i = 0; i < 64 && high - low > 1; i++) {
    const middle = (low + high) / 2;
    const at = sourceAt(clip, middle);
    if (rising ? at < source : at > source) low = middle;
    else high = middle;
  }
  return clip.start + (low + high) / 2;
}

/**
 * Source ranges (`[start, end]` seconds) as timeline ranges inside `clip`, in
 * time order. Parts the clip does not show are left out.
 */
export function timelineRanges(clip: Clip, ranges: [number, number][]): [number, number][] {
  if (clip.freeze) return [];
  const ends = [sourceAt(clip, 0), sourceAt(clip, clip.duration)];
  const [low, high] = [Math.min(...ends), Math.max(...ends)];
  const found: [number, number][] = [];
  for (const [from, to] of ranges) {
    const a = Math.max(low, from * FLICKS_PER_SECOND);
    const b = Math.min(high, to * FLICKS_PER_SECOND);
    if (b <= a) continue;
    const [x, y] = [timelineAt(clip, a), timelineAt(clip, b)];
    if (x === null || y === null) continue;
    // Flicks are whole numbers; the model snaps them to frames.
    found.push([Math.round(Math.min(x, y)), Math.round(Math.max(x, y))]);
  }
  return found.sort((p, q) => p[0] - q[0]);
}

/**
 * The clip that plays `id`'s sound: the clip itself, or the clip its sound was
 * detached to. Null when neither has sound.
 */
export function soundClipOf(project: Project, id: number): Clip | null {
  const clips = project.tracks.flatMap((track) => track.clips);
  const clip = clips.find((c) => c.id === id);
  if (!clip || clip.kind === 'adjustment' || clip.kind === 'title') return null;
  if (clip.audio) return clip;
  if (clip.link === null) return null;
  return clips.find((c) => c.link === clip.link && c.audio && c.media === clip.media) ?? null;
}

/** The timeline times of `clip`'s beats that fall inside it. */
export function beatTimes(clip: Clip): number[] {
  const times: number[] = [];
  for (const beat of clip.beats ?? []) {
    const at = timelineAt(clip, beat);
    if (at !== null && at >= clip.start && at <= clip.start + clip.duration) times.push(at);
  }
  return times.sort((a, b) => a - b);
}

/** Beats per minute from beat times (flicks): the median gap's. */
export function tempoOf(beats: number[]): number | null {
  const gaps = beats.slice(1).map((beat, i) => beat - beats[i]);
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return (60 * FLICKS_PER_SECOND) / gaps[gaps.length >> 1];
}

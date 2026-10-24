import { FLICKS_PER_SECOND, type Clip, type Track, type Transition } from '@cgv/engine-client';

/** A new transition's length, and the default transition. */
export const defaultTransitionDuration = FLICKS_PER_SECOND;
export const defaultTransition = { pack: 'builtin', kind: 'cross-dissolve' };
/** An adjustment layer added from the browser lasts this long. */
export const adjustmentDuration = 5 * FLICKS_PER_SECOND;

/** Where a transition can go: the clips touching at a cut, or a clip's free edge. */
export interface CutTarget {
  from: number | null;
  to: number | null;
  cut: number;
}

const takesTransitions = (clip: Clip) => clip.video && clip.kind !== 'adjustment';

/** Every cut and free edge of `track`'s picture clips, by time. */
export function cutsOf(track: Track): CutTarget[] {
  const cuts = new Map<number, CutTarget>();
  const clips = track.clips.filter(takesTransitions);
  for (const clip of clips) {
    const end = clip.start + clip.duration;
    if (!cuts.has(clip.start)) {
      const before = track.clips.find((c) => c.start + c.duration === clip.start);
      if (!before || takesTransitions(before))
        cuts.set(clip.start, { from: before?.id ?? null, to: clip.id, cut: clip.start });
    }
    if (!cuts.has(end)) {
      const after = track.clips.find((c) => c.start === end);
      if (!after || takesTransitions(after))
        cuts.set(end, { from: clip.id, to: after?.id ?? null, cut: end });
    }
  }
  return [...cuts.values()].sort((a, b) => a.cut - b.cut);
}

/** The cut of `track` nearest `time`, within `tolerance` flicks when given. */
export function cutNear(track: Track, time: number, tolerance = Infinity): CutTarget | null {
  let best: CutTarget | null = null;
  for (const target of cutsOf(track))
    if (
      Math.abs(target.cut - time) <= tolerance &&
      (!best || Math.abs(target.cut - time) < Math.abs(best.cut - time))
    )
      best = target;
  return best;
}

/** The timeline span `transition` covers on `track`, or null when its clips are elsewhere. */
export function transitionWindow(
  track: Track,
  transition: Transition,
  frame: number,
): [number, number] | null {
  const from = transition.from !== null ? track.clips.find((c) => c.id === transition.from) : null;
  const to = transition.to !== null ? track.clips.find((c) => c.id === transition.to) : null;
  const cut = from ? from.start + from.duration : to ? to.start : null;
  if (cut === null) return null;
  const d = transition.duration;
  if (transition.alignment === 'start') return [cut, cut + d];
  if (transition.alignment === 'end') return [cut - d, cut];
  const before = Math.floor(d / 2 / frame) * frame;
  return [cut - before, cut - before + d];
}

/** The cut a transition sits on. */
export function transitionCut(track: Track, transition: Transition): number | null {
  const from = transition.from !== null ? track.clips.find((c) => c.id === transition.from) : null;
  if (from) return from.start + from.duration;
  const to = transition.to !== null ? track.clips.find((c) => c.id === transition.to) : null;
  return to ? to.start : null;
}

/**
 * The duration that puts a transition's dragged `edge` at `time` (whole frames).
 * A centred transition grows on both sides of its cut.
 */
export function durationForEdge(
  transition: Transition,
  cut: number,
  edge: 'start' | 'end',
  time: number,
  frame: number,
): number {
  const reach = edge === 'end' ? time - cut : cut - time;
  const span = transition.alignment === 'center' ? 2 * reach : reach;
  return Math.max(1, Math.round(span / frame)) * frame;
}

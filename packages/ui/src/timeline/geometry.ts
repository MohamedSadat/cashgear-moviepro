// Timeline geometry: time and pixels, track rows, hit testing, snapping and the
// ruler. Pure functions over a project snapshot, so they are tested without a canvas.
import {
  FLICKS_PER_SECOND,
  type Clip,
  type FrameRate,
  type Marker,
  type Project,
  type Track,
} from '@cgv/engine-client';

export const rulerHeight = 28;
export const trackHeight = 58;
/** Room above the top track for dropping clips onto a new track. */
export const dropZoneHeight = 32;
/** Pixels from a clip's edge that grab the edge instead of the clip. */
export const edgeGrab = 7;
/** Pixels within which edges snap. */
export const snapPixels = 8;
/** The closest zoom: one frame at 30 fps is 72 pixels wide. */
export const maxScale = 2160;
export const minScale = 0.02;

/** What the canvas shows: zoom, scroll and size. Times are flicks. */
export interface View {
  /** Pixels per second. */
  scale: number;
  /** The time at the left edge. */
  scrollTime: number;
  /** Pixels scrolled down in the track area. */
  scrollTop: number;
  width: number;
  height: number;
}

export const frameDuration = (rate: FrameRate) => (FLICKS_PER_SECOND * rate.den) / rate.num;

/** The nearest frame boundary to `time`. */
export function snapToFrame(time: number, frame: number): number {
  return Math.round(time / frame) * frame;
}

export function timeToX(view: View, time: number): number {
  return ((time - view.scrollTime) / FLICKS_PER_SECOND) * view.scale;
}

export function xToTime(view: View, x: number): number {
  return view.scrollTime + (x / view.scale) * FLICKS_PER_SECOND;
}

/** A time span in pixels. */
export function span(view: View, duration: number): number {
  return (duration / FLICKS_PER_SECOND) * view.scale;
}

/** A track as the canvas lays it out: tracks are drawn top track first. */
export interface Row {
  track: Track;
  /** The track's index in the project (0 is the bottom track). */
  index: number;
  /** Top edge before vertical scrolling, below the ruler. */
  top: number;
  height: number;
}

export function layoutRows(tracks: Track[]): Row[] {
  const rows: Row[] = [];
  let top = rulerHeight + dropZoneHeight;
  for (let index = tracks.length - 1; index >= 0; index--) {
    rows.push({ track: tracks[index], index, top, height: trackHeight });
    top += trackHeight;
  }
  return rows;
}

/** Height of all rows, without the ruler. */
export function contentHeight(rows: Row[]): number {
  return rows.reduce((sum, row) => sum + row.height, 0) + dropZoneHeight;
}

export function rowTop(view: View, row: Row): number {
  return row.top - view.scrollTop;
}

/** The row under `y` (canvas pixels); `above` when over the drop zone above the top track. */
export function rowAt(rows: Row[], view: View, y: number): Row | null {
  if (y < rulerHeight) return null;
  return rows.find((row) => y >= rowTop(view, row) && y < rowTop(view, row) + row.height) ?? null;
}

/** True when `y` is in the space above the top track, which drops onto a new track. */
export function aboveRows(rows: Row[], view: View, y: number): boolean {
  return y >= rulerHeight && y < (rows[0] ? rowTop(view, rows[0]) : Infinity);
}

/** The index of the first clip that ends after `time`; clips are sorted and never overlap. */
export function firstEndingAfter(clips: Clip[], time: number): number {
  let low = 0;
  let high = clips.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (clips[mid].start + clips[mid].duration <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The clips of a track that show between `start` and `end`. */
export function visibleClips(clips: Clip[], start: number, end: number): Clip[] {
  const visible: Clip[] = [];
  for (let i = firstEndingAfter(clips, start); i < clips.length && clips[i].start < end; i++)
    visible.push(clips[i]);
  return visible;
}

export type Hit =
  | { kind: 'clip'; clip: Clip; row: Row; edge: 'start' | 'end' | null }
  | { kind: 'marker'; marker: Marker }
  | { kind: 'ruler'; time: number }
  | { kind: 'empty'; row: Row | null; time: number };

/** What is under canvas point (`x`, `y`). */
export function hitTest(project: Project, rows: Row[], view: View, x: number, y: number): Hit {
  const time = xToTime(view, x);
  if (y < rulerHeight) {
    const marker = project.markers.find((m) => Math.abs(timeToX(view, m.time) - x) <= 5);
    return marker ? { kind: 'marker', marker } : { kind: 'ruler', time };
  }
  const row = rowAt(rows, view, y);
  if (!row) return { kind: 'empty', row: null, time };
  const clips = row.track.clips;
  const index = firstEndingAfter(clips, time);
  const clip = clips[index];
  if (!clip || clip.start > time) {
    // Just past a clip's end still grabs that edge.
    const previous = clips[index - 1];
    if (previous && x - timeToX(view, previous.start + previous.duration) <= edgeGrab)
      return { kind: 'clip', clip: previous, row, edge: 'end' };
    if (clip && timeToX(view, clip.start) - x <= edgeGrab)
      return { kind: 'clip', clip, row, edge: 'start' };
    return { kind: 'empty', row, time };
  }
  const left = timeToX(view, clip.start);
  const right = timeToX(view, clip.start + clip.duration);
  // Short clips keep a middle to drag by.
  const grab = Math.min(edgeGrab, (right - left) / 3);
  const edge = x - left <= grab ? 'start' : right - x <= grab ? 'end' : null;
  return { kind: 'clip', clip, row, edge };
}

/** Times worth snapping to: 0, the playhead, markers and clip edges other than `exclude`. */
export function snapTargets(project: Project, playhead: number | null, exclude: Set<number>) {
  const points = [0];
  if (playhead !== null) points.push(playhead);
  for (const marker of project.markers) points.push(marker.time);
  for (const track of project.tracks)
    for (const clip of track.clips)
      if (!exclude.has(clip.id)) points.push(clip.start, clip.start + clip.duration);
  points.sort((a, b) => a - b);
  return points.filter((point, i) => i === 0 || point !== points[i - 1]);
}

/** The target nearest `time` within `tolerance` flicks, or null. */
export function nearestTarget(targets: number[], time: number, tolerance: number): number | null {
  let low = 0;
  let high = targets.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (targets[mid] < time) low = mid + 1;
    else high = mid;
  }
  let best: number | null = null;
  for (const candidate of [targets[low - 1], targets[low]])
    if (
      candidate !== undefined &&
      Math.abs(candidate - time) <= tolerance &&
      (best === null || Math.abs(candidate - time) < Math.abs(best - time))
    )
      best = candidate;
  return best;
}

/**
 * Snaps a move: the shift that brings one of `edges` (moved by `delta`) onto the
 * nearest target. Returns the snapped delta and the guide's time, if it snapped.
 */
export function snapDelta(
  targets: number[],
  edges: number[],
  delta: number,
  tolerance: number,
): { delta: number; guide: number | null } {
  let best: { delta: number; guide: number; distance: number } | null = null;
  for (const edge of edges) {
    const target = nearestTarget(targets, edge + delta, tolerance);
    if (target === null) continue;
    const distance = Math.abs(target - (edge + delta));
    if (!best || distance < best.distance) best = { delta: target - edge, guide: target, distance };
  }
  return best ? { delta: best.delta, guide: best.guide } : { delta, guide: null };
}

/**
 * The cut nearest `time` among `clips`: the timeline start, or a clip's start or
 * end. Ties go to the earlier cut. The engine places main-track drops and moves
 * the same way.
 */
export function nearestCut(clips: Clip[], time: number): number {
  let best = 0;
  for (const clip of clips)
    for (const cut of [clip.start, clip.start + clip.duration])
      if (Math.abs(cut - time) < Math.abs(best - time)) best = cut;
  return best;
}

/** Zooms by `factor`, keeping the time under `anchorX` where it is. */
export function zoomAt(view: View, factor: number, anchorX: number): View {
  const anchor = xToTime(view, anchorX);
  const scale = Math.min(maxScale, Math.max(minScale, view.scale * factor));
  const scrollTime = Math.max(0, anchor - (anchorX / scale) * FLICKS_PER_SECOND);
  return { ...view, scale, scrollTime };
}

/** The zoom that shows `duration` (at least 10 s) across `width` pixels, with some room. */
export function fitScale(duration: number, width: number): number {
  const seconds = Math.max(10, duration / FLICKS_PER_SECOND) * 1.05;
  return Math.min(maxScale, Math.max(minScale, Math.max(1, width) / seconds));
}

/** Keeps the view inside the timeline: never before 0, never above the first row. */
export function clampView(view: View, rows: Row[]): View {
  const maxTop = Math.max(0, contentHeight(rows) - (view.height - rulerHeight));
  return {
    ...view,
    scrollTime: Math.max(0, view.scrollTime),
    scrollTop: Math.min(maxTop, Math.max(0, view.scrollTop)),
  };
}

const tickSteps = [1, 2, 5, 10, 15]
  .map((frames) => ({ frames, seconds: 0 }))
  .concat(
    [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((seconds) => ({
      frames: 0,
      seconds,
    })),
  );

export interface Tick {
  time: number;
  x: number;
  label: string;
}

function label(time: number, rate: FrameRate, frames: boolean): string {
  const seconds = Math.floor(time / FLICKS_PER_SECOND + 1e-9);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  const clock = h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
  if (!frames) return clock;
  const frame = Math.round(((time / FLICKS_PER_SECOND) % 1) * (rate.num / rate.den));
  return frame ? `${clock}:${two(frame)}` : clock;
}

/** Labelled ruler ticks at least `spacing` pixels apart, and the minor ticks between them. */
export function rulerTicks(
  view: View,
  rate: FrameRate,
  spacing = 90,
): { major: Tick[]; minor: number[] } {
  const frame = frameDuration(rate);
  const step =
    tickSteps
      .map((s) => (s.frames ? s.frames * frame : s.seconds * FLICKS_PER_SECOND))
      .find((duration) => span(view, duration) >= spacing) ?? 3600 * FLICKS_PER_SECOND;
  const minorStep = step / 5;
  const start = Math.floor(view.scrollTime / step) * step;
  const end = xToTime(view, view.width);
  const major: Tick[] = [];
  const minor: number[] = [];
  const frames = step < FLICKS_PER_SECOND;
  for (let time = start; time <= end; time += step) {
    major.push({ time, x: timeToX(view, time), label: label(time, rate, frames) });
    for (let i = 1; i < 5; i++) minor.push(timeToX(view, time + i * minorStep));
  }
  return { major, minor };
}

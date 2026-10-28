// Timeline geometry: time and pixels, track rows, hit testing, snapping and the
// ruler. Pure functions over a project snapshot, so they are tested without a canvas.
import {
  FLICKS_PER_SECOND,
  type Clip,
  type FrameRate,
  type Marker,
  type Project,
  type Track,
  type Transition,
} from '@cgv/engine-client';
import { beatTimes } from '../ai/timing';
import { transitionCut, transitionWindow } from '../editing/transitions';
import { isAnimated, keyTimes, numberAt } from '../effects/animation';

export const rulerHeight = 28;
export const trackHeight = 58;
/** Room above the top track for dropping clips onto a new track. */
export const dropZoneHeight = 32;
/** Pixels from a clip's edge that grab the edge instead of the clip. */
export const edgeGrab = 7;
/** Pixels within which edges snap. */
export const snapPixels = 8;
/** Transitions sit in the lower part of a row, so the clips' edges above stay grabbable. */
export const transitionBand = 0.46;
/** The clip's name bar, where the keyframes of selected clips show. */
export const nameBar = 15;
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
  | {
      kind: 'transition';
      transition: Transition;
      row: Row;
      /** A draggable end of the transition (one at its cut does not move). */
      edge: 'start' | 'end' | null;
      window: [number, number];
      cut: number;
    }
  | { kind: 'keyframe'; clip: Clip; row: Row; time: number }
  /** A selected clip's sound fade handle. */
  | { kind: 'fade'; clip: Clip; row: Row; edge: 'in' | 'out' }
  /** A selected clip's volume line, or one of its volume keyframes (`key`, from its start). */
  | { kind: 'volume'; clip: Clip; row: Row; key: number | null; time: number }
  | { kind: 'marker'; marker: Marker }
  | { kind: 'ruler'; time: number }
  | { kind: 'empty'; row: Row | null; time: number };

/** Where a row's transitions are drawn: their window and the band's top and height. */
export function transitionBox(
  view: View,
  row: Row,
  window: [number, number],
): { x: number; y: number; w: number; h: number } {
  const top = rowTop(view, row) + 2;
  const height = row.height - 4;
  const h = Math.round(height * transitionBand);
  return {
    x: timeToX(view, window[0]),
    y: top + height - h,
    w: Math.max(4, span(view, window[1] - window[0])),
    h,
  };
}

/** A fade handle with no fade sits this far inside the clip, clear of its trim edge. */
export const fadeInset = 10;
/** The volume line spans this range of decibels over a clip's sound. */
export const volumeFloor = -60;
export const volumeTop = 24;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a clip's sound (its waveform) is drawn; null for clips without sound. */
export function soundBox(view: View, row: Row, clip: Clip): Box | null {
  if (!clip.audio) return null;
  const top = rowTop(view, row) + 2;
  const height = row.height - 4;
  const h = clip.video ? Math.round((height - nameBar) * 0.38) : height - nameBar;
  return {
    x: timeToX(view, clip.start),
    y: top + height - h,
    w: Math.max(1, span(view, clip.duration)),
    h,
  };
}

/** The height on the volume line of `db`. */
export function volumeY(box: Box, db: number): number {
  const position = (db - volumeFloor) / (volumeTop - volumeFloor);
  return box.y + (1 - Math.min(1, Math.max(0, position))) * box.h;
}

/** The volume at height `y` on the line, to a tenth of a decibel. */
export function volumeAtY(box: Box, y: number): number {
  const position = 1 - Math.min(1, Math.max(0, (y - box.y) / box.h));
  return Math.round((volumeFloor + position * (volumeTop - volumeFloor)) * 10) / 10;
}

/** The volume at `offset` from the clip's start: its keyframes, else its level. */
export function volumeAt(clip: Clip, offset: number): number {
  return numberAt(clip, 'volumeDb', offset, clip.volumeDb);
}

/** The fade handles' centres: at the end of each fade, inside the clip. */
export function fadeHandles(view: View, box: Box, clip: Clip) {
  const fadeIn = Math.max(fadeInset, span(view, clip.fadeIn ?? 0));
  const fadeOut = Math.max(fadeInset, span(view, clip.fadeOut ?? 0));
  return { in: box.x + fadeIn, out: box.x + box.w - fadeOut, y: box.y + 5 };
}

/** A selected clip's sound handle under (`x`, `y`): a fade handle, a volume key or the line. */
function soundHit(view: View, row: Row, clip: Clip, x: number, y: number): Hit | null {
  const box = soundBox(view, row, clip);
  if (!box || box.w < 3 * fadeInset || box.h < 10) return null;
  const handles = fadeHandles(view, box, clip);
  for (const edge of ['in', 'out'] as const) {
    const hx = edge === 'in' ? handles.in : handles.out;
    if (Math.abs(x - hx) <= 6 && Math.abs(y - handles.y) <= 6)
      return { kind: 'fade', clip, row, edge };
  }
  const time = xToTime(view, x);
  if (isAnimated(clip, 'volumeDb'))
    for (const key of clip.keyframes!.volumeDb) {
      if (key.time < 0 || key.time > clip.duration) continue;
      const kx = timeToX(view, clip.start + key.time);
      const ky = volumeY(box, key.value as number);
      if (Math.abs(x - kx) <= 5 && Math.abs(y - ky) <= 5)
        return { kind: 'volume', clip, row, key: key.time, time };
    }
  const inside = x - box.x > edgeGrab && box.x + box.w - x > edgeGrab;
  const lineY = volumeY(box, volumeAt(clip, time - clip.start));
  if (inside && Math.abs(y - lineY) <= 4) return { kind: 'volume', clip, row, key: null, time };
  return null;
}

/**
 * What is under canvas point (`x`, `y`). `selected` clips show their keyframes,
 * fade handles and volume line, which can then be grabbed.
 */
export function hitTest(
  project: Project,
  rows: Row[],
  view: View,
  x: number,
  y: number,
  selected?: Set<number>,
): Hit {
  const time = xToTime(view, x);
  if (y < rulerHeight) {
    const marker = project.markers.find((m) => Math.abs(timeToX(view, m.time) - x) <= 5);
    return marker ? { kind: 'marker', marker } : { kind: 'ruler', time };
  }
  const row = rowAt(rows, view, y);
  if (!row) return { kind: 'empty', row: null, time };
  const frame = frameDuration(project.settings.frameRate);
  for (const transition of row.track.transitions ?? []) {
    const window = transitionWindow(row.track, transition, frame);
    const cut = transitionCut(row.track, transition);
    if (!window || cut === null) continue;
    const box = transitionBox(view, row, window);
    if (y < box.y || y > box.y + box.h || x < box.x - 3 || x > box.x + box.w + 3) continue;
    // An end that sits on the cut (a transition starting or ending there) stays put.
    const start = window[0] !== cut && x - box.x <= 5;
    const end = window[1] !== cut && box.x + box.w - x <= 5;
    const edge = start ? 'start' : end ? 'end' : null;
    return { kind: 'transition', transition, row, edge, window, cut };
  }
  const top = rowTop(view, row);
  if (selected && y > top + 2 + nameBar)
    for (const clip of visibleClips(row.track.clips, time - 1, time + 1)) {
      if (!selected.has(clip.id)) continue;
      const sound = soundHit(view, row, clip, x, y);
      if (sound) return sound;
    }
  if (selected && y <= top + 2 + nameBar)
    for (const clip of visibleClips(row.track.clips, time - 1, time + 1)) {
      if (!selected.has(clip.id)) continue;
      const key = keyTimes(clip).find(
        (offset) => Math.abs(timeToX(view, clip.start + offset) - x) <= 5,
      );
      if (key !== undefined) return { kind: 'keyframe', clip, row, time: key };
    }
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

/**
 * Times worth snapping to: 0, the playhead, markers, and the edges and beats of
 * clips other than `exclude`.
 */
export function snapTargets(project: Project, playhead: number | null, exclude: Set<number>) {
  const points = [0];
  if (playhead !== null) points.push(playhead);
  for (const marker of project.markers) points.push(marker.time);
  for (const track of project.tracks)
    for (const clip of track.clips)
      if (!exclude.has(clip.id)) {
        points.push(clip.start, clip.start + clip.duration);
        if (clip.beats?.length) points.push(...beatTimes(clip));
      }
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

// Draws the timeline canvas from a project snapshot: tracks, clips with filmstrips
// and waveforms, the ruler, markers and gesture feedback. Only what is in view is
// drawn, so the cost follows the canvas size, not the clip count. The playhead is
// an element over the canvas, so playback never redraws it.
import { titleName } from '../titles/templates';
import {
  FLICKS_PER_SECOND,
  type Clip,
  type MarkerColor,
  type MediaRef,
  type Project,
  type Transition,
} from '@cgv/engine-client';
import { transitionWindow } from '../editing/transitions';
import { isAnimated, keyTimes } from '../effects/animation';
import type { MediaVisuals } from '../media/useMediaLibrary';
import {
  dropZoneHeight,
  fadeHandles,
  fadeInset,
  frameDuration,
  nameBar,
  rowTop,
  rulerHeight,
  rulerTicks,
  soundBox,
  span,
  timeToX,
  transitionBox,
  visibleClips,
  volumeAt,
  volumeY,
  xToTime,
  type Box,
  type Row,
  type View,
} from './geometry';
import type { ImageCache, PeakCache } from './visuals';

/** Canvas colours, read from the theme's CSS custom properties. */
export interface Palette {
  background: string;
  track: string;
  trackAlt: string;
  trackMain: string;
  trackLine: string;
  ruler: string;
  rulerText: string;
  rulerTick: string;
  clipVideo: string;
  clipAudio: string;
  clipImage: string;
  clipAdjustment: string;
  clipTitle: string;
  clipOffline: string;
  transition: string;
  clipText: string;
  clipBorder: string;
  selection: string;
  invalid: string;
  waveform: string;
  waveformMuted: string;
  volume: string;
  guide: string;
  drop: string;
  markers: Record<MarkerColor, string>;
}

const defaults: Palette = {
  background: '#121418',
  track: '#191c22',
  trackAlt: '#16191e',
  trackMain: '#1c2230',
  trackLine: '#262b34',
  ruler: '#1b1e24',
  rulerText: '#9aa1ad',
  rulerTick: '#3b414c',
  clipVideo: '#2c5a8c',
  clipAudio: '#2b7350',
  clipImage: '#68498f',
  clipAdjustment: '#4f5566',
  clipTitle: '#8c5a2c',
  clipOffline: '#6e2b2b',
  transition: 'rgba(240, 244, 255, 0.82)',
  clipText: '#eef1f6',
  clipBorder: 'rgba(255, 255, 255, 0.16)',
  selection: '#f2b84b',
  invalid: '#ef5a5a',
  volume: '#ffd166',
  waveform: 'rgba(214, 255, 232, 0.75)',
  waveformMuted: 'rgba(200, 200, 200, 0.35)',
  guide: '#f2d24b',
  drop: '#3d8bfd',
  markers: {
    red: '#ef5a5a',
    orange: '#f59f42',
    yellow: '#f2d24b',
    green: '#4cc38a',
    blue: '#3d8bfd',
    purple: '#a874ff',
  },
};

const tokenNames: Record<Exclude<keyof Palette, 'markers'>, string> = {
  background: '--cgv-timeline-bg',
  track: '--cgv-track-bg',
  trackAlt: '--cgv-track-bg-alt',
  trackMain: '--cgv-track-main-bg',
  trackLine: '--cgv-track-line',
  ruler: '--cgv-ruler-bg',
  rulerText: '--cgv-ruler-text',
  rulerTick: '--cgv-ruler-tick',
  clipVideo: '--cgv-clip-video',
  clipAudio: '--cgv-clip-audio',
  clipImage: '--cgv-clip-image',
  clipAdjustment: '--cgv-clip-adjustment',
  clipTitle: '--cgv-clip-title',
  clipOffline: '--cgv-clip-offline',
  transition: '--cgv-transition',
  clipText: '--cgv-clip-text',
  clipBorder: '--cgv-clip-border',
  selection: '--cgv-clip-selected',
  invalid: '--cgv-danger',
  volume: '--cgv-volume-line',
  waveform: '--cgv-waveform',
  waveformMuted: '--cgv-waveform-muted',
  guide: '--cgv-snap-guide',
  drop: '--cgv-accent',
};

/** The palette for `element`'s theme. */
export function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const palette = { ...defaults, markers: { ...defaults.markers } };
  for (const [key, token] of Object.entries(tokenNames) as [keyof typeof tokenNames, string][])
    palette[key] = read(token, defaults[key]);
  for (const color of Object.keys(palette.markers) as MarkerColor[])
    palette.markers[color] = read(`--cgv-marker-${color}`, defaults.markers[color]);
  return palette;
}

export interface DropPreview {
  /** The track it goes on, or null for a new track above the others. */
  row: Row | null;
  start: number;
  duration: number;
  /** Inserted at a cut on the magnetic main track. */
  insert: boolean;
}

/** Where a dragged effect or transition would go. */
export type EffectDropPreview =
  { kind: 'clip'; row: Row; clip: Clip } | { kind: 'cut'; row: Row; cut: number; duration: number };

export interface DrawInput {
  project: Project;
  rows: Row[];
  view: View;
  palette: Palette;
  /** Selected clips and their linked partners. */
  selected: Set<number>;
  /** Where the current gesture snapped. */
  guide: number | null;
  /** The last gesture step could not apply. */
  invalid: boolean;
  drop: DropPreview | null;
  effectDrop: EffectDropPreview | null;
  /** The selected transition. */
  transition: number | null;
  /** A transition's name, as the browser lists it. */
  transitionLabel(transition: Transition): string;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  hover: { clip: number; edge: 'start' | 'end' | null } | null;
  media: Map<string, MediaRef>;
  visuals: Record<string, MediaVisuals>;
  missing: Set<string>;
  images: ImageCache;
  peaks: PeakCache;
}

const font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** The thumbnail nearest each source second, for one media item. */
function thumbnailAt(visuals: MediaVisuals, seconds: number): string | undefined {
  const { thumbnails, times } = visuals;
  if (!thumbnails.length) return undefined;
  if (!times || times.length !== thumbnails.length) return thumbnails[0];
  let best = 0;
  for (let i = 1; i < times.length; i++)
    if (Math.abs(times[i] - seconds) < Math.abs(times[best] - seconds)) best = i;
  return thumbnails[best];
}

function drawFilmstrip(
  ctx: CanvasRenderingContext2D,
  input: DrawInput,
  clip: Clip,
  visuals: MediaVisuals,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const first = input.images.get(visuals.thumbnails[0]);
  if (!first || h < 6) return;
  const tile = Math.max(8, (h * first.width) / first.height);
  const speed = clip.speed.num / clip.speed.den;
  // Tiles are laid from the clip's start, so they stay put while scrolling.
  const firstTile = Math.max(0, Math.floor(-x / tile));
  const lastTile = Math.min(Math.ceil(w / tile), Math.ceil((input.view.width - x) / tile));
  for (let i = firstTile; i < lastTile; i++) {
    const left = x + i * tile;
    const middle = ((i + 0.5) * tile * FLICKS_PER_SECOND) / input.view.scale;
    const seconds = (clip.sourceIn + middle * speed) / FLICKS_PER_SECOND;
    const url = thumbnailAt(visuals, seconds);
    const image = url ? input.images.get(url) : null;
    if (image) ctx.drawImage(image, left, y, tile, h);
  }
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  input: DrawInput,
  clip: Clip,
  visuals: MediaVisuals,
  muted: boolean,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const waveform = visuals.waveform;
  if (!waveform || h < 4) return;
  const pyramid = input.peaks.get(waveform.peaks, waveform.peaksPerSecond);
  const speed = clip.speed.num / clip.speed.den;
  const secondsPerPixel = (speed / input.view.scale) * 1;
  const perPixel = secondsPerPixel * waveform.peaksPerSecond;
  const gain = Math.min(1, 10 ** (clip.volumeDb / 20));
  const middle = y + h / 2;
  const from = Math.max(0, Math.floor(x));
  const to = Math.min(input.view.width, Math.ceil(x + w));
  const source = clip.sourceIn / FLICKS_PER_SECOND;
  if (to <= from) return;
  // One outline (the top edge left to right, the bottom edge back) is far cheaper
  // for the GPU to fill than a rectangle per pixel column.
  const bottoms: number[] = [];
  ctx.beginPath();
  for (let px = from; px < to; px++) {
    const start = source + (px - x) * secondsPerPixel;
    const [min, max] = pyramid.range(start, start + secondsPerPixel, perPixel);
    const top = middle - (max / 127) * (h / 2) * gain;
    const bottom = middle - (min / 127) * (h / 2) * gain;
    // At least a pixel thick, so silence still shows as a line.
    const thick = Math.max(1, bottom - top);
    if (px === from) ctx.moveTo(px, top);
    ctx.lineTo(px, top);
    ctx.lineTo(px + 1, top);
    bottoms.push(top + thick);
  }
  for (let px = to - 1; px >= from; px--) {
    ctx.lineTo(px + 1, bottoms[px - from]);
    ctx.lineTo(px, bottoms[px - from]);
  }
  ctx.closePath();
  ctx.fillStyle = muted ? input.palette.waveformMuted : input.palette.waveform;
  ctx.fill();
}

/** The equal-power rise of a fade, as the mixer plays it. */
const rise = (p: number) => Math.sin(Math.min(1, Math.max(0, p)) * (Math.PI / 2));

/** A clip's sound fades: the part each fade holds back, shaded over its waveform. */
function drawFades(ctx: CanvasRenderingContext2D, input: DrawInput, clip: Clip, box: Box) {
  const fades = [
    { length: span(input.view, clip.fadeIn ?? 0), from: box.x, sign: 1 },
    { length: span(input.view, clip.fadeOut ?? 0), from: box.x + box.w, sign: -1 },
  ];
  for (const { length, from, sign } of fades) {
    if (length < 2) continue;
    const steps = Math.max(4, Math.min(48, Math.round(length / 4)));
    ctx.beginPath();
    ctx.moveTo(from, box.y);
    for (let i = 0; i <= steps; i++) {
      const p = i / steps;
      ctx.lineTo(from + sign * p * length, box.y + box.h * (1 - rise(p)));
    }
    ctx.lineTo(from + sign * length, box.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fill();
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const p = i / steps;
      const px = from + sign * p * length;
      const py = box.y + box.h * (1 - rise(p));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** A selected clip's volume line (or its volume keyframes) and fade handles. */
function drawSoundHandles(ctx: CanvasRenderingContext2D, input: DrawInput, clip: Clip, box: Box) {
  if (box.w < 3 * fadeInset || box.h < 10) return;
  const { view, palette } = input;
  const from = Math.max(box.x, 0);
  const to = Math.min(box.x + box.w, view.width);
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y - 6, box.w, box.h + 12);
  ctx.clip();
  ctx.strokeStyle = palette.volume;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (isAnimated(clip, 'volumeDb')) {
    for (let px = from; px <= to; px += 3) {
      const offset = ((px - box.x) / view.scale) * FLICKS_PER_SECOND;
      const py = volumeY(box, volumeAt(clip, offset));
      if (px === from) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  } else {
    const py = Math.round(volumeY(box, clip.volumeDb)) + 0.5;
    ctx.moveTo(from, py);
    ctx.lineTo(to, py);
  }
  ctx.stroke();
  ctx.fillStyle = palette.volume;
  for (const key of clip.keyframes?.volumeDb ?? []) {
    const kx = timeToX(view, clip.start + key.time);
    if (kx < box.x - 1 || kx > box.x + box.w + 1) continue;
    ctx.beginPath();
    ctx.arc(kx, volumeY(box, key.value as number), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  const handles = fadeHandles(view, box, clip);
  ctx.fillStyle = palette.clipText;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.lineWidth = 1;
  for (const hx of [handles.in, handles.out]) {
    ctx.beginPath();
    ctx.arc(hx, handles.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function speedLabel(clip: Clip) {
  if (clip.speed.num === clip.speed.den) return '';
  const value = clip.speed.num / clip.speed.den;
  return `${Number(value.toFixed(2))}× `;
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  input: DrawInput,
  clip: Clip,
  row: Row,
  top: number,
) {
  const { view, palette } = input;
  const x = timeToX(view, clip.start);
  const w = Math.max(1, span(view, clip.duration));
  const y = top + 2;
  const h = row.height - 4;
  const media = input.media.get(clip.media);
  const adjustment = clip.kind === 'adjustment';
  const title = clip.kind === 'title';
  const generated = adjustment || title;
  const offline = !generated && input.missing.has(clip.media);
  ctx.fillStyle = offline
    ? palette.clipOffline
    : adjustment
      ? palette.clipAdjustment
      : title
        ? palette.clipTitle
        : !clip.video
          ? palette.clipAudio
          : media?.kind === 'image'
            ? palette.clipImage
            : palette.clipVideo;
  if (w < 3) {
    ctx.fillRect(x, y, w, h);
    return;
  }
  roundRect(ctx, x, y, w, h);
  ctx.fill();
  if (w >= 8) {
    // A rectangular clip is a cheap scissor; a rounded one costs a path per clip.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, y + 1, w - 2, h - 2);
    ctx.clip();
    const visuals = input.visuals[clip.media];
    const sound = soundBox(view, row, clip);
    const waveHeight = sound?.h ?? 0;
    if (visuals && !offline && !generated) {
      if (clip.video && visuals.thumbnails.length)
        drawFilmstrip(ctx, input, clip, visuals, x, y + nameBar, w, h - nameBar - waveHeight);
      if (clip.audio)
        drawWaveform(
          ctx,
          input,
          clip,
          visuals,
          row.track.muted,
          x,
          y + h - waveHeight,
          w,
          waveHeight,
        );
    }
    if (sound && ((clip.fadeIn ?? 0) > 0 || (clip.fadeOut ?? 0) > 0))
      drawFades(ctx, input, clip, sound);
    if (w >= 24) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(x, y, w, nameBar);
      ctx.fillStyle = palette.clipText;
      const name =
        (offline ? 'Missing: ' : '') +
        (clip.effects?.length ? 'fx ' : '') +
        speedLabel(clip) +
        (adjustment
          ? 'Adjustment layer'
          : title
            ? titleName(clip.title)
            : (media?.name ?? clip.media));
      ctx.fillText(name, Math.max(x, 0) + 5, y + nameBar / 2 + 0.5);
    }
    ctx.restore();
  }
  const selected = input.selected.has(clip.id);
  const hovered = input.hover?.clip === clip.id;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected
    ? input.invalid
      ? palette.invalid
      : palette.selection
    : hovered
      ? palette.clipText
      : palette.clipBorder;
  roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.stroke();
  if (hovered && input.hover?.edge) {
    // The trim handle under the pointer.
    ctx.fillStyle = palette.selection;
    const handle = input.hover.edge === 'start' ? x : x + w - 4;
    ctx.fillRect(handle, y, 4, h);
  }
  if (selected && w >= 8) drawKeyframes(ctx, input, clip, y);
  const sound = selected ? soundBox(view, row, clip) : null;
  if (sound && !row.track.locked) drawSoundHandles(ctx, input, clip, sound);
}

/** A selected clip's keyframes, as diamonds along its name bar. */
function drawKeyframes(ctx: CanvasRenderingContext2D, input: DrawInput, clip: Clip, y: number) {
  const times = keyTimes(clip);
  if (!times.length) return;
  ctx.fillStyle = input.palette.selection;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.lineWidth = 1;
  const middle = y + nameBar / 2;
  for (const time of times) {
    const kx = Math.round(timeToX(input.view, clip.start + time)) + 0.5;
    if (kx < -6 || kx > input.view.width + 6) continue;
    ctx.beginPath();
    ctx.moveTo(kx, middle - 5);
    ctx.lineTo(kx + 5, middle);
    ctx.lineTo(kx, middle + 5);
    ctx.lineTo(kx - 5, middle);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

/** A row's transitions: boxes over their windows, in the lower part of the row. */
function drawTransitions(ctx: CanvasRenderingContext2D, input: DrawInput, row: Row) {
  const { view, palette } = input;
  const transitions = row.track.transitions;
  if (!transitions?.length) return;
  const frame = frameDuration(input.project.settings.frameRate);
  for (const transition of transitions) {
    const window = transitionWindow(row.track, transition, frame);
    if (!window) continue;
    const box = transitionBox(view, row, window);
    if (box.x > view.width || box.x + box.w < 0) continue;
    const selected = input.transition === transition.id;
    ctx.fillStyle = 'rgba(10, 12, 16, 0.55)';
    roundRect(ctx, box.x, box.y, box.w, box.h);
    ctx.fill();
    ctx.strokeStyle = selected ? palette.selection : palette.transition;
    ctx.lineWidth = selected ? 2 : 1;
    roundRect(ctx, box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
    ctx.stroke();
    // A bow tie: one picture narrowing as the other widens.
    ctx.fillStyle = selected ? palette.selection : palette.transition;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(box.x + 2, box.y + 2);
    ctx.lineTo(box.x + box.w - 2, box.y + box.h - 2);
    ctx.lineTo(box.x + box.w - 2, box.y + 2);
    ctx.lineTo(box.x + 2, box.y + box.h - 2);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    if (box.w >= 48) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x + 2, box.y, box.w - 4, box.h);
      ctx.clip();
      ctx.fillStyle = palette.clipText;
      ctx.textBaseline = 'middle';
      const label = input.transitionLabel(transition);
      const width = ctx.measureText(label).width;
      ctx.fillText(label, box.x + Math.max(4, (box.w - width) / 2), box.y + box.h / 2 + 0.5);
      ctx.restore();
    }
  }
}

function drawRows(ctx: CanvasRenderingContext2D, input: DrawInput) {
  const { view, palette, project } = input;
  const start = xToTime(view, 0);
  const end = xToTime(view, view.width);
  input.rows.forEach((row, order) => {
    const top = rowTop(view, row);
    if (top > view.height || top + row.height < rulerHeight) return;
    ctx.fillStyle =
      row.track.id === project.mainTrack
        ? palette.trackMain
        : order % 2
          ? palette.trackAlt
          : palette.track;
    ctx.fillRect(0, top, view.width, row.height);
    ctx.fillStyle = palette.trackLine;
    ctx.fillRect(0, top + row.height - 1, view.width, 1);
    ctx.globalAlpha = row.track.hidden ? 0.4 : 1;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    for (const clip of visibleClips(row.track.clips, start, end))
      drawClip(ctx, input, clip, row, top);
    drawTransitions(ctx, input, row);
    ctx.globalAlpha = 1;
    if (row.track.locked) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fillRect(0, top, view.width, row.height - 1);
    }
  });
}

function drawEffectDrop(ctx: CanvasRenderingContext2D, input: DrawInput) {
  const { effectDrop: drop, view, palette } = input;
  if (!drop) return;
  const top = rowTop(view, drop.row);
  ctx.strokeStyle = palette.drop;
  ctx.fillStyle = palette.drop;
  ctx.lineWidth = 2;
  if (drop.kind === 'clip') {
    const x = timeToX(view, drop.clip.start);
    const w = Math.max(2, span(view, drop.clip.duration));
    ctx.globalAlpha = 0.25;
    ctx.fillRect(x, top + 2, w, drop.row.height - 4);
    ctx.globalAlpha = 1;
    ctx.strokeRect(x + 1, top + 3, w - 2, drop.row.height - 6);
    return;
  }
  const half = span(view, drop.duration) / 2;
  const x = timeToX(view, drop.cut);
  ctx.globalAlpha = 0.3;
  ctx.fillRect(x - half, top + 2, 2 * half, drop.row.height - 4);
  ctx.globalAlpha = 1;
  ctx.fillRect(x - 1, top, 3, drop.row.height);
}

function drawDrop(ctx: CanvasRenderingContext2D, input: DrawInput) {
  drawEffectDrop(ctx, input);
  const { drop, view, palette } = input;
  if (!drop) return;
  const x = timeToX(view, drop.start);
  const w = Math.max(2, span(view, drop.duration));
  const top = drop.row ? rowTop(view, drop.row) : rulerHeight + 2 - view.scrollTop;
  const height = drop.row ? drop.row.height : dropZoneHeight - 4;
  ctx.fillStyle = palette.drop;
  ctx.globalAlpha = 0.3;
  ctx.fillRect(x, top + 2, w, height - 4);
  ctx.globalAlpha = 1;
  if (drop.insert) ctx.fillRect(x - 1, top, 3, height);
  else {
    ctx.strokeStyle = palette.drop;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, top + 2.5, w - 1, height - 5);
  }
}

function drawRuler(ctx: CanvasRenderingContext2D, input: DrawInput) {
  const { view, palette, project } = input;
  ctx.fillStyle = palette.ruler;
  ctx.fillRect(0, 0, view.width, rulerHeight);
  ctx.fillStyle = palette.rulerTick;
  ctx.fillRect(0, rulerHeight - 1, view.width, 1);
  const { major, minor } = rulerTicks(view, project.settings.frameRate);
  for (const x of minor) ctx.fillRect(Math.round(x), rulerHeight - 5, 1, 4);
  ctx.font = font;
  ctx.textBaseline = 'top';
  for (const tick of major) {
    ctx.fillStyle = palette.rulerTick;
    ctx.fillRect(Math.round(tick.x), rulerHeight - 11, 1, 10);
    ctx.fillStyle = palette.rulerText;
    ctx.fillText(tick.label, Math.round(tick.x) + 4, 4);
  }
  for (const marker of project.markers) {
    const x = timeToX(view, marker.time);
    if (x < -10 || x > view.width + 10) continue;
    ctx.fillStyle = palette.markers[marker.color];
    ctx.beginPath();
    ctx.moveTo(x, rulerHeight - 1);
    ctx.lineTo(x - 5, rulerHeight - 9);
    ctx.lineTo(x - 5, rulerHeight - 15);
    ctx.lineTo(x + 5, rulerHeight - 15);
    ctx.lineTo(x + 5, rulerHeight - 9);
    ctx.closePath();
    ctx.fill();
  }
}

export function drawTimeline(ctx: CanvasRenderingContext2D, input: DrawInput) {
  const { view, palette } = input;
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, view.width, view.height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, rulerHeight, view.width, view.height - rulerHeight);
  ctx.clip();
  drawRows(ctx, input);
  // Markers continue faintly through the tracks.
  for (const marker of input.project.markers) {
    const x = Math.round(timeToX(view, marker.time)) + 0.5;
    if (x < 0 || x > view.width) continue;
    ctx.fillStyle = palette.markers[marker.color];
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x - 0.5, rulerHeight, 1, view.height);
    ctx.globalAlpha = 1;
  }
  drawDrop(ctx, input);
  if (input.marquee) {
    const { x0, y0, x1, y1 } = input.marquee;
    ctx.fillStyle = palette.drop;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = palette.drop;
    ctx.strokeRect(
      Math.min(x0, x1) + 0.5,
      Math.min(y0, y1) + 0.5,
      Math.abs(x1 - x0),
      Math.abs(y1 - y0),
    );
  }
  ctx.restore();
  drawRuler(ctx, input);
  if (input.guide !== null) {
    const x = Math.round(timeToX(view, input.guide)) + 0.5;
    ctx.strokeStyle = palette.guide;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, view.height);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

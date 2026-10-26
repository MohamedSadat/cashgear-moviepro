// The timeline canvas: its view, drawing on animation frames, and pointer, wheel
// and drop gestures. It runs outside React so scrolling, zooming and dragging
// never re-render components; React feeds it snapshots and settings.
import {
  FLICKS_PER_SECOND,
  type Clip,
  type Command,
  type MediaRef,
  type Project,
  type ProjectSnapshot,
  type Transition,
} from '@cgv/engine-client';
import { imageDuration } from '../media/lengths';
import type { MediaVisuals } from '../media/useMediaLibrary';
import type { Gesture } from '../editing/gesture';
import {
  adjustmentDuration,
  cutNear,
  defaultTransitionDuration,
  durationForEdge,
  type CutTarget,
} from '../editing/transitions';
import type { CatalogItem } from '../effects/catalog';
import type { DraggedEffect } from '../effects/dragging';
import type { Sound } from '../sounds/catalog';
import { stickerDuration, type Sticker } from '../stickers/catalog';
import type { TitleTemplate } from '../titles/templates';
import { effectDragType } from '../effects/dragging';
import {
  drawTimeline,
  readPalette,
  type DropPreview,
  type EffectDropPreview,
  type Palette,
} from './draw';
import {
  aboveRows,
  clampView,
  fitScale,
  frameDuration,
  hitTest,
  layoutRows,
  nearestCut,
  nearestTarget,
  rowAt,
  rowTop,
  snapDelta,
  snapPixels,
  snapTargets,
  soundBox,
  snapToFrame,
  timeToX,
  visibleClips,
  volumeAt,
  volumeAtY,
  xToTime,
  zoomAt,
  type Hit,
  type Row,
  type View,
} from './geometry';
import { ImageCache, PeakCache } from './visuals';

/** The MIME type a media library item carries when dragged onto the timeline. */
export const mediaDragType = 'application/x-cgv-media';

/** Stills dropped on the timeline last this long. */
/** Pixels a press must travel before it drags. */
const dragThreshold = 4;

/** What the controller needs from the editor; read fresh on every use. */
export interface TimelineHost {
  project(): ProjectSnapshot | null;
  visuals(): Record<string, MediaVisuals>;
  missing(): Set<string>;
  locked(): boolean;
  tool(): 'select' | 'blade';
  snapping(): boolean;
  /** The selection and the clips linked to it. */
  selected(): Set<number>;
  /** The clips as picked (without their partners). */
  picked(): number[];
  select(ids: number[], mode: 'replace' | 'add' | 'toggle'): void;
  /** The playhead in flicks, moving smoothly while playing. */
  playhead(): number;
  playing(): boolean;
  seek(time: number, scrub: boolean): void;
  execute(command: Command): Promise<number[] | null>;
  /** Adds a track on top and puts a clip on it, as one undo step. */
  executeOnNewTrack(command: Command): Promise<number[] | null>;
  gesture(label: string): Gesture | null;
  finish(gesture: Gesture): Promise<void>;
  openMenu(hit: Hit, clientX: number, clientY: number): void;
  /** The selected transition, and selecting one (which clears the clips). */
  selectedTransition(): number | null;
  selectTransition(id: number | null): void;
  transitionLabel(transition: Transition): string;
  applyEffect(item: CatalogItem, clip: number): Promise<void>;
  applyTransition(item: CatalogItem, target: { track: number } & CutTarget): Promise<void>;
  addAdjustmentLayer(time: number, track: number | null): Promise<void>;
  addTitle(template: TitleTemplate, time: number, track: number | null): Promise<void>;
  addSticker(sticker: Sticker, time: number, track: number | null): Promise<void>;
  addSound(sound: Sound, time: number, track: number | null): Promise<void>;
  /** Vertical scroll, for the track headers. */
  scrolled(scrollTop: number): void;
  /** The zoom changed, in pixels per second. */
  zoomed(scale: number): void;
}

type Drag =
  | {
      kind: 'press';
      hit: Extract<Hit, { kind: 'clip' }>;
      /** The clips a drag would move: the selection as this press leaves it. */
      named: number[];
      x: number;
      y: number;
      time: number;
    }
  | {
      kind: 'move';
      gesture: Gesture;
      origin: Project;
      named: number[];
      moving: Set<number>;
      grab: Row;
      time: number;
    }
  | {
      kind: 'trim';
      gesture: Gesture | null;
      origin: Project;
      clip: Clip;
      edge: 'start' | 'end';
      x: number;
      time: number;
    }
  | { kind: 'marquee'; x0: number; y0: number; base: number[] }
  | { kind: 'scrub' }
  | {
      kind: 'marker';
      id: number;
      gesture: Gesture | null;
      origin: number;
      x: number;
      time: number;
    }
  | {
      kind: 'transition';
      gesture: Gesture | null;
      transition: Transition;
      edge: 'start' | 'end';
      cut: number;
      x: number;
    }
  | {
      kind: 'keyframe';
      gesture: Gesture | null;
      clip: Clip;
      /** The keyframe's time from the clip's start. */
      offset: number;
      x: number;
      time: number;
    }
  | { kind: 'fade'; gesture: Gesture | null; clip: Clip; row: Row; edge: 'in' | 'out'; x: number }
  | {
      kind: 'volume';
      gesture: Gesture | null;
      clip: Clip;
      row: Row;
      /** The volume keyframe dragged (from the clip's start), or null for the line. */
      key: number | null;
      y: number;
    };

export interface DrawStats {
  frames: number;
  /** Milliseconds spent drawing each of the last frames. */
  drawMs: number[];
}

export class TimelineController {
  readonly stats: DrawStats = { frames: 0, drawMs: [] };
  view: View = { scale: 40, scrollTime: 0, scrollTop: 0, width: 300, height: 200 };
  private context: CanvasRenderingContext2D;
  private dpr = 1;
  private rows: Row[] = [];
  private live: ProjectSnapshot | null = null;
  private palette: Palette;
  private media = new Map<string, MediaRef>();
  private images: ImageCache;
  private peaks = new PeakCache();
  private frameRequest = 0;
  private drag: Drag | null = null;
  private guide: number | null = null;
  private invalid = false;
  private hover: { clip: number; edge: 'start' | 'end' | null } | null = null;
  private drop: DropPreview | null = null;
  private effectDrop: EffectDropPreview | null = null;
  private marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private marqueeSelection: Set<number> | null = null;
  /** The project the view was last fitted to. */
  private fitted: string | null = null;
  /**
   * While set, the view keeps fitting the whole edit as it grows or shrinks,
   * until the user zooms or scrolls along the timeline. A new edit then plays
   * without turning pages.
   */
  private following = true;
  private fittedEnd = -1;
  private disposed = false;
  private followRequest = 0;

  /**
   * `playhead` is an element over the canvas that shows the playhead. Moving it
   * costs the compositor nothing, so playback never redraws the canvas.
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: TimelineHost,
    private readonly playheadElement: HTMLElement,
  ) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('2D canvas is unavailable');
    this.context = context;
    this.palette = readPalette(canvas);
    this.images = new ImageCache(() => this.redraw());
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameRequest);
    cancelAnimationFrame(this.followRequest);
    this.canvas.removeEventListener('wheel', this.onWheel);
    void this.cancelDrag();
  }

  /** The snapshot to draw: the open project, or a gesture's current step. */
  show(snapshot: ProjectSnapshot | null) {
    this.live = snapshot;
    this.rows = snapshot ? layoutRows(snapshot.project.tracks) : [];
    this.media = new Map(snapshot?.project.media.map((media) => [media.id, media]) ?? []);
    // Each project opens showing its whole edit.
    if (snapshot && this.fitted !== snapshot.project.id && this.view.width > 1) {
      this.fitted = snapshot.project.id;
      this.fit();
    } else if (
      snapshot &&
      this.following &&
      !this.drag &&
      this.view.width > 1 &&
      projectEnd(snapshot.project) !== this.fittedEnd
    )
      this.fit();
    this.view = clampView(this.view, this.rows);
    this.host.scrolled(this.view.scrollTop);
    this.publish();
    this.redraw();
  }

  /** Theme colours changed. */
  restyle() {
    this.palette = readPalette(this.canvas);
    this.redraw();
  }

  resize(width: number, height: number, dpr: number) {
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.view = clampView({ ...this.view, width, height }, this.rows);
    if (this.live && this.fitted !== this.live.project.id && width > 1) {
      this.fitted = this.live.project.id;
      this.fit();
    }
    this.publish();
    this.redraw();
  }

  zoom(factor: number, anchorX = timeToX(this.view, this.host.playhead())) {
    this.following = false;
    const x = Math.min(this.view.width, Math.max(0, anchorX));
    this.setView(zoomAt(this.view, factor, x));
  }

  /** Shows the whole edit. */
  fit() {
    const duration = this.live ? projectEnd(this.live.project) : 0;
    this.following = true;
    this.fittedEnd = duration;
    this.setView({ ...this.view, scale: fitScale(duration, this.view.width), scrollTime: 0 });
  }

  /** Scrolls so `time` is in view. */
  reveal(time: number) {
    const x = timeToX(this.view, time);
    if (x < 0 || x > this.view.width - 20) {
      this.following = false;
      this.setView({
        ...this.view,
        scrollTime: Math.max(
          0,
          time - (this.view.width * 0.1 * FLICKS_PER_SECOND) / this.view.scale,
        ),
      });
    }
  }

  scrollBy(dx: number, dy: number) {
    if (dx !== 0) this.following = false;
    this.setView({
      ...this.view,
      scrollTime: this.view.scrollTime + (dx / this.view.scale) * FLICKS_PER_SECOND,
      scrollTop: this.view.scrollTop + dy,
    });
  }

  setView(view: View) {
    const scale = this.view.scale;
    this.view = clampView(view, this.rows);
    this.host.scrolled(this.view.scrollTop);
    if (this.view.scale !== scale) this.host.zoomed(this.view.scale);
    this.publish();
    this.redraw();
  }

  /**
   * Shows the zoom and scroll on the canvas element, so assistive tools and
   * tests can find a time on screen from the page alone.
   */
  private publish() {
    const data = this.canvas.dataset;
    data.scale = String(this.view.scale);
    data.scrollTime = String(this.view.scrollTime);
    data.scrollTop = String(this.view.scrollTop);
  }

  /** Where `time` is on screen, in client pixels (tests and tooling). */
  clientX(time: number): number {
    return this.canvas.getBoundingClientRect().left + timeToX(this.view, time);
  }

  /** The vertical middle of track `id` on screen, in client pixels, or null. */
  clientY(track: number): number | null {
    const row = this.rows.find((r) => r.track.id === track);
    if (!row) return null;
    return this.canvas.getBoundingClientRect().top + rowTop(this.view, row) + row.height / 2;
  }

  /** True while a press, drag or scrub is under way. */
  get dragging() {
    return this.drag !== null;
  }

  redraw() {
    if (this.frameRequest || this.disposed) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.draw();
    });
  }

  /** Keeps the playhead element in step with playback, turning the page when it nears the edge. */
  follow() {
    cancelAnimationFrame(this.followRequest);
    const step = () => {
      this.followRequest = 0;
      if (this.disposed) return;
      const playing = this.host.playing();
      const playhead = this.host.playhead();
      const x = timeToX(this.view, playhead);
      if (playing && !this.drag && (x > this.view.width - 30 || x < 0))
        this.setView({
          ...this.view,
          scrollTime: playhead - (this.view.width * 0.05 * FLICKS_PER_SECOND) / this.view.scale,
        });
      this.placePlayhead();
      if (playing) this.followRequest = requestAnimationFrame(step);
    };
    step();
  }

  private placePlayhead() {
    const x = Math.round(timeToX(this.view, this.host.playhead()));
    const style = this.playheadElement.style;
    style.transform = `translateX(${x}px)`;
    style.visibility = x < -8 || x > this.view.width + 8 ? 'hidden' : 'visible';
  }

  /** Draws now. */
  draw() {
    const snapshot = this.live;
    const started = performance.now();
    const context = this.context;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.placePlayhead();
    if (!snapshot) {
      context.fillStyle = this.palette.background;
      context.fillRect(0, 0, this.view.width, this.view.height);
    } else {
      drawTimeline(context, {
        project: snapshot.project,
        rows: this.rows,
        view: this.view,
        palette: this.palette,
        selected: this.marqueeSelection ?? this.host.selected(),
        guide: this.guide,
        invalid: this.invalid,
        drop: this.drop,
        effectDrop: this.effectDrop,
        transition: this.host.selectedTransition(),
        transitionLabel: (transition) => this.host.transitionLabel(transition),
        marquee: this.marquee,
        hover: this.drag ? null : this.hover,
        media: this.media,
        visuals: this.host.visuals(),
        missing: this.host.missing(),
        images: this.images,
        peaks: this.peaks,
      });
    }
    this.publish();
    this.stats.frames++;
    this.stats.drawMs.push(performance.now() - started);
    if (this.stats.drawMs.length > 600) this.stats.drawMs.splice(0, 300);
  }

  // ---- Pointer --------------------------------------------------------------------

  private local(event: { clientX: number; clientY: number }) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private frame(project: Project) {
    return frameDuration(project.settings.frameRate);
  }

  private tolerance() {
    return (snapPixels / this.view.scale) * FLICKS_PER_SECOND;
  }

  pointerDown(event: PointerEvent) {
    const snapshot = this.live;
    if (!snapshot || this.drag) return;
    const { x, y } = this.local(event);
    const project = snapshot.project;
    const hit = hitTest(project, this.rows, this.view, x, y, this.host.selected());
    if (event.button === 2) {
      if (hit.kind === 'clip' && !this.host.selected().has(hit.clip.id))
        this.host.select([hit.clip.id], 'replace');
      if (hit.kind === 'transition') this.host.selectTransition(hit.transition.id);
      this.host.openMenu(hit, event.clientX, event.clientY);
      return;
    }
    if (event.button !== 0) return;
    this.canvas.setPointerCapture(event.pointerId);
    const time = xToTime(this.view, x);
    if (hit.kind === 'ruler') {
      this.drag = { kind: 'scrub' };
      this.host.seek(Math.max(0, time), true);
      return;
    }
    if (hit.kind === 'marker') {
      this.drag = {
        kind: 'marker',
        id: hit.marker.id,
        gesture: null,
        origin: hit.marker.time,
        x,
        time,
      };
      return;
    }
    if (hit.kind === 'transition') {
      this.host.selectTransition(hit.transition.id);
      if (hit.edge && !hit.row.track.locked && !this.host.locked())
        this.drag = {
          kind: 'transition',
          gesture: null,
          transition: hit.transition,
          edge: hit.edge,
          cut: hit.cut,
          x,
        };
      return;
    }
    if (hit.kind === 'keyframe') {
      if (hit.row.track.locked || this.host.locked()) return;
      this.drag = {
        kind: 'keyframe',
        gesture: null,
        clip: hit.clip,
        offset: hit.time,
        x,
        time,
      };
      return;
    }
    if (hit.kind === 'fade' || hit.kind === 'volume') {
      if (hit.row.track.locked || this.host.locked()) return;
      if (hit.kind === 'fade') {
        this.drag = {
          kind: 'fade',
          gesture: null,
          clip: hit.clip,
          row: hit.row,
          edge: hit.edge,
          x,
        };
        return;
      }
      const frame = this.frame(project);
      const clip = hit.clip;
      if (hit.key !== null && event.altKey) {
        // Alt-click takes a volume keyframe away.
        void this.host.execute({
          type: 'removeKeyframes',
          clip: clip.id,
          property: 'volumeDb',
          times: [hit.key],
        });
        return;
      }
      if (hit.key === null && (event.ctrlKey || event.metaKey)) {
        // Ctrl-click adds a volume keyframe on the line, at its level there.
        const offset = Math.min(
          clip.duration - frame,
          Math.max(0, snapToFrame(hit.time - clip.start, frame)),
        );
        void this.host.execute({
          type: 'setKeyframe',
          clip: clip.id,
          property: 'volumeDb',
          time: offset,
          value: Math.round(volumeAt(clip, offset) * 10) / 10,
        });
        return;
      }
      this.drag = { kind: 'volume', gesture: null, clip, row: hit.row, key: hit.key, y };
      return;
    }
    if (hit.kind === 'empty') {
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      if (!additive) this.host.select([], 'replace');
      this.drag = { kind: 'marquee', x0: x, y0: y, base: additive ? this.host.picked() : [] };
      return;
    }
    const clip = hit.clip;
    if (this.host.tool() === 'blade' && !hit.row.track.locked) {
      // Split under the pointer, or across every track with Shift.
      let at = snapToFrame(time, this.frame(project));
      const playhead = this.host.playhead();
      if (this.host.snapping() && Math.abs(playhead - at) <= this.tolerance()) at = playhead;
      void this.host.execute({ type: 'split', at, clips: event.shiftKey ? [] : [clip.id] });
      return;
    }
    // The selection changes through React; the drag uses what it will be.
    const picked = this.host.picked();
    let named: number[];
    if (event.ctrlKey || event.metaKey) {
      this.host.select([clip.id], 'toggle');
      if (picked.includes(clip.id)) return;
      named = [...picked, clip.id];
    } else if (event.shiftKey) {
      this.host.select([clip.id], 'add');
      named = picked.includes(clip.id) ? picked : [...picked, clip.id];
    } else if (!this.host.selected().has(clip.id) || hit.edge) {
      this.host.select([clip.id], 'replace');
      named = [clip.id];
    } else named = picked.length ? picked : [clip.id];
    if (hit.row.track.locked || this.host.locked()) return;
    if (hit.edge)
      this.drag = {
        kind: 'trim',
        gesture: null,
        origin: project,
        clip,
        edge: hit.edge,
        x,
        time,
      };
    else this.drag = { kind: 'press', hit, named, x, y, time };
  }

  pointerMove(event: PointerEvent): void {
    const snapshot = this.live;
    const { x, y } = this.local(event);
    const drag = this.drag;
    if (!snapshot) return;
    if (!drag) {
      const hit = hitTest(snapshot.project, this.rows, this.view, x, y, this.host.selected());
      const hover = hit.kind === 'clip' ? { clip: hit.clip.id, edge: hit.edge } : null;
      this.canvas.style.cursor =
        hit.kind === 'clip'
          ? this.host.tool() === 'blade'
            ? 'crosshair'
            : hit.edge
              ? 'ew-resize'
              : 'grab'
          : hit.kind === 'marker' || hit.kind === 'keyframe' || hit.kind === 'fade'
            ? 'ew-resize'
            : hit.kind === 'volume'
              ? hit.key !== null
                ? 'move'
                : 'ns-resize'
              : hit.kind === 'transition'
                ? hit.edge
                  ? 'ew-resize'
                  : 'pointer'
                : 'default';
      if (hover?.clip !== this.hover?.clip || hover?.edge !== this.hover?.edge) {
        this.hover = hover;
        this.redraw();
      }
      return;
    }
    const time = xToTime(this.view, x);
    switch (drag.kind) {
      case 'scrub':
        this.host.seek(Math.max(0, time), true);
        return;
      case 'marquee':
        return this.updateMarquee(drag, x, y);
      case 'marker': {
        if (!drag.gesture && Math.abs(x - drag.x) < dragThreshold) return;
        drag.gesture ??= this.host.gesture('Move marker');
        if (!drag.gesture) return;
        let at = Math.max(
          0,
          snapToFrame(drag.origin + time - drag.time, this.frame(snapshot.project)),
        );
        this.guide = null;
        if (this.host.snapping()) {
          // Never to the marker itself, which moves with the drag.
          const others = snapshot.project.markers.filter((marker) => marker.id !== drag.id);
          const project = { ...snapshot.project, markers: others };
          const targets = snapTargets(project, this.host.playhead(), new Set());
          const target = nearestTarget(targets, at, this.tolerance());
          if (target !== null) at = this.guide = target;
        }
        drag.gesture.step({ type: 'updateMarker', marker: drag.id, at });
        return;
      }
      case 'press': {
        if (Math.hypot(x - drag.x, y - drag.y) < dragThreshold) return;
        const gesture = this.host.gesture('Move');
        if (!gesture) return;
        const origin = snapshot.project;
        const found = drag.named.filter((id) => findClip(origin, id));
        const named = found.length ? found : [drag.hit.clip.id];
        this.drag = {
          kind: 'move',
          gesture,
          origin,
          named,
          moving: withPartners(origin, named),
          grab: drag.hit.row,
          time: drag.time,
        };
        this.canvas.style.cursor = 'grabbing';
        return this.pointerMove(event);
      }
      case 'move':
        return this.updateMove(drag, x, y);
      case 'trim':
        return this.updateTrim(drag, x);
      case 'transition': {
        if (!drag.gesture && Math.abs(x - drag.x) < 2) return;
        drag.gesture ??= this.host.gesture('Change transition');
        if (!drag.gesture) return;
        const frame = this.frame(snapshot.project);
        const duration = durationForEdge(drag.transition, drag.cut, drag.edge, time, frame);
        drag.gesture.step({ type: 'setTransition', transition: drag.transition.id, duration });
        return;
      }
      case 'fade': {
        if (!drag.gesture && Math.abs(x - drag.x) < 2) return;
        drag.gesture ??= this.host.gesture('Change fade');
        if (!drag.gesture) return;
        const frame = this.frame(snapshot.project);
        const clip = drag.clip;
        const end = clip.start + clip.duration;
        const room =
          clip.duration - (drag.edge === 'in' ? (clip.fadeOut ?? 0) : (clip.fadeIn ?? 0));
        const length = drag.edge === 'in' ? time - clip.start : end - time;
        const fade = Math.min(room - (room % frame), Math.max(0, snapToFrame(length, frame)));
        this.guide = drag.edge === 'in' ? clip.start + fade : end - fade;
        drag.gesture.step({
          type: 'setClipProperties',
          clip: clip.id,
          properties: drag.edge === 'in' ? { fadeIn: fade } : { fadeOut: fade },
        });
        return;
      }
      case 'volume': {
        if (!drag.gesture && Math.abs(y - drag.y) < 2) return;
        drag.gesture ??= this.host.gesture('Change volume');
        if (!drag.gesture) return;
        const box = soundBox(this.view, drag.row, drag.clip);
        if (!box) return;
        const value = volumeAtY(box, y);
        drag.gesture.step(
          drag.key === null
            ? { type: 'setClipProperties', clip: drag.clip.id, properties: { volumeDb: value } }
            : {
                type: 'setKeyframe',
                clip: drag.clip.id,
                property: 'volumeDb',
                time: drag.key,
                value,
              },
        );
        return;
      }
      case 'keyframe': {
        if (!drag.gesture && Math.abs(x - drag.x) < 2) return;
        drag.gesture ??= this.host.gesture('Move keyframes');
        if (!drag.gesture) return;
        const frame = this.frame(snapshot.project);
        const clip = drag.clip;
        const target = Math.min(
          clip.duration - frame,
          Math.max(0, snapToFrame(drag.offset + time - drag.time, frame)),
        );
        this.guide = clip.start + target;
        drag.gesture.step({
          type: 'moveKeyframes',
          clip: clip.id,
          times: [drag.offset],
          delta: target - drag.offset,
        });
        return;
      }
    }
  }

  private updateMarquee(drag: Extract<Drag, { kind: 'marquee' }>, x: number, y: number) {
    const project = this.live?.project;
    if (!project) return;
    this.marquee = { x0: drag.x0, y0: drag.y0, x1: x, y1: y };
    const [t0, t1] = [
      xToTime(this.view, Math.min(drag.x0, x)),
      xToTime(this.view, Math.max(drag.x0, x)),
    ];
    const [top, bottom] = [Math.min(drag.y0, y), Math.max(drag.y0, y)];
    const hits = new Set(drag.base);
    for (const row of this.rows) {
      const rowY = rowTop(this.view, row);
      if (rowY > bottom || rowY + row.height < top) continue;
      for (const clip of visibleClips(row.track.clips, t0, t1)) hits.add(clip.id);
    }
    this.marqueeSelection = withPartners(project, [...hits]);
    this.redraw();
  }

  private updateMove(drag: Extract<Drag, { kind: 'move' }>, x: number, y: number) {
    const origin = drag.origin;
    const frame = this.frame(origin);
    const time = xToTime(this.view, x);
    const count = origin.tracks.length;
    const indices = drag.named.map((id) => findClip(origin, id)?.index ?? 0);
    const target =
      rowAt(this.rows, this.view, y) ??
      (y < (this.rows[0] ? rowTop(this.view, this.rows[0]) : 0)
        ? this.rows[0]
        : this.rows[this.rows.length - 1]);
    let tracks = (target?.index ?? drag.grab.index) - drag.grab.index;
    tracks = Math.max(-Math.min(...indices), Math.min(count - 1 - Math.max(...indices), tracks));
    const moving = drag.moving;
    const clips = origin.tracks.flatMap((track) => track.clips.filter((c) => moving.has(c.id)));
    const start = Math.min(...clips.map((c) => c.start));
    const end = Math.max(...clips.map((c) => c.start + c.duration));
    const mainIndex = origin.magnetic
      ? origin.tracks.findIndex((track) => track.id === origin.mainTrack)
      : -1;
    let delta = snapToFrame(time - drag.time, frame);
    this.guide = null;
    const ontoMain = indices.some((index) => index + tracks === mainIndex);
    if (ontoMain) {
      // The block goes in at the cut nearest the pointer, among the clips that stay.
      const main = origin.tracks[mainIndex];
      const staying = main.clips.filter((c) => !moving.has(c.id));
      const blockStart = Math.min(
        ...drag.named
          .map((id) => findClip(origin, id))
          .filter((found) => found && found.index + tracks === mainIndex)
          .map((found) => found!.clip.start),
      );
      const cut = nearestCut(staying, time);
      delta = cut - blockStart;
      this.guide = cut;
    } else {
      if (this.host.snapping()) {
        const targets = snapTargets(origin, this.host.playhead(), moving);
        const snapped = snapDelta(targets, [start, end], delta, this.tolerance());
        delta = snapped.delta;
        this.guide = snapped.guide;
      }
      delta = Math.max(delta, -start);
    }
    drag.gesture.step({ type: 'move', clips: drag.named, delta, tracks, overwrite: true });
  }

  private updateTrim(drag: Extract<Drag, { kind: 'trim' }>, x: number) {
    if (!drag.gesture && Math.abs(x - drag.x) < 1) return;
    drag.gesture ??= this.host.gesture(drag.edge === 'start' ? 'Trim start' : 'Trim end');
    if (!drag.gesture) return;
    const origin = drag.origin;
    let delta = snapToFrame(xToTime(this.view, x) - drag.time, this.frame(origin));
    const clip = drag.clip;
    const edge = drag.edge === 'start' ? clip.start : clip.start + clip.duration;
    this.guide = null;
    if (this.host.snapping()) {
      const targets = snapTargets(origin, this.host.playhead(), withPartners(origin, [clip.id]));
      const target = nearestTarget(targets, edge + delta, this.tolerance());
      if (target !== null) {
        delta = target - edge;
        this.guide = target;
      }
    }
    drag.gesture.step({ type: 'trim', clip: clip.id, edge: drag.edge, delta, ripple: false });
  }

  async pointerUp(event: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId);
    this.guide = null;
    this.invalid = false;
    this.canvas.style.cursor = 'default';
    if (drag.kind === 'marquee') {
      const ids = this.marqueeSelection;
      this.marquee = null;
      this.marqueeSelection = null;
      const project = this.live?.project;
      if (ids && project) {
        const picked = [...ids].filter((id) => findClip(project, id));
        this.host.select(picked, 'replace');
      }
    } else if (drag.kind === 'marker' && !drag.gesture) {
      this.host.seek(drag.origin, false);
    } else if (drag.kind === 'keyframe' && !drag.gesture) {
      // A click on a keyframe goes to it.
      this.host.seek(drag.clip.start + drag.offset, false);
    } else if (
      drag.kind === 'move' ||
      drag.kind === 'trim' ||
      drag.kind === 'marker' ||
      drag.kind === 'transition' ||
      drag.kind === 'keyframe' ||
      drag.kind === 'fade' ||
      drag.kind === 'volume'
    ) {
      if (drag.gesture) await this.host.finish(drag.gesture);
    }
    this.redraw();
  }

  /** Escape or a lost pointer: undo what the drag did. */
  async cancelDrag() {
    const drag = this.drag;
    this.drag = null;
    this.guide = null;
    this.marquee = null;
    this.marqueeSelection = null;
    if (drag && 'gesture' in drag && drag.gesture) {
      const snapshot = await drag.gesture.cancel();
      this.show(snapshot);
    }
    this.redraw();
  }

  /** A gesture step arrived. */
  stepped(snapshot: ProjectSnapshot, error: string | null) {
    this.invalid = error !== null;
    this.show(snapshot);
  }

  pointerLeave() {
    if (this.hover && !this.drag) {
      this.hover = null;
      this.redraw();
    }
  }

  // ---- Wheel ----------------------------------------------------------------------

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.view.height : 1;
    const dx = event.deltaX * scale;
    const dy = event.deltaY * scale;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      this.zoom(Math.exp(-dy * 0.0025), this.local(event).x);
    } else if (event.shiftKey) {
      this.scrollBy(dy || dx, 0);
    } else {
      this.scrollBy(dx, dy);
    }
  };

  // ---- Drops from the media library ------------------------------------------------

  /** Where media `id` would go if dropped at the pointer, or null. */
  private dropAt(id: string, event: DragEvent): (DropPreview & { media: MediaRef }) | null {
    const snapshot = this.live;
    const media = this.media.get(id);
    if (!snapshot || !media) return null;
    const project = snapshot.project;
    const frame = this.frame(project);
    const duration =
      media.kind === 'image'
        ? imageDuration(media, frame)
        : Math.floor(media.duration / frame) * frame;
    if (duration < frame) return null;
    const { x, y } = this.local(event);
    let start = Math.max(0, snapToFrame(xToTime(this.view, x), frame));
    const above = aboveRows(this.rows, this.view, y);
    const row = above ? null : (rowAt(this.rows, this.view, y) ?? null);
    if (!above && !row) return null;
    if (row?.track.locked) return null;
    // Media dropped on a template slot fills it.
    const time = xToTime(this.view, x);
    const slot = row?.track.clips.find(
      (c) => c.slot !== undefined && c.start <= time && time < c.start + c.duration,
    );
    if (slot && media.hasVideo)
      return {
        row,
        start: slot.start,
        duration: slot.duration,
        insert: false,
        media,
        slot: slot.id,
      };
    const insert = !!row && project.magnetic && row.track.id === project.mainTrack;
    if (insert) start = nearestCut(row.track.clips, start);
    else if (this.host.snapping()) {
      const targets = snapTargets(project, this.host.playhead(), new Set());
      start = Math.max(
        0,
        snapDelta(targets, [start, start + duration], 0, this.tolerance()).delta + start,
      );
    }
    return { row, start, duration, insert, media };
  }

  dragOver(event: DragEvent, id: string | null) {
    if (!event.dataTransfer?.types.includes(mediaDragType)) return;
    event.preventDefault();
    // Browsers hide drag data until the drop; the library says which item it is.
    const drop = id ? this.dropAt(id, event) : null;
    event.dataTransfer.dropEffect = drop ? 'copy' : 'none';
    this.drop = drop;
    this.redraw();
  }

  dragLeave() {
    this.drop = null;
    this.effectDrop = null;
    this.redraw();
  }

  // ---- Drops from the effects browser ----------------------------------------------

  /** Where `dragged` would go if dropped at the pointer. */
  private effectAt(dragged: DraggedEffect, event: DragEvent) {
    const snapshot = this.live;
    if (!snapshot) return null;
    const project = snapshot.project;
    const { x, y } = this.local(event);
    const time = xToTime(this.view, x);
    const row = rowAt(this.rows, this.view, y);
    if (
      dragged.kind === 'adjustment' ||
      dragged.kind === 'title' ||
      dragged.kind === 'sticker' ||
      dragged.kind === 'sound'
    ) {
      // Clips without media go on a free track, or a new one, never the main track.
      const frame = this.frame(project);
      const above = aboveRows(this.rows, this.view, y);
      if (!above && (!row || row.track.locked)) return null;
      const main = row?.track.id === project.mainTrack;
      const start = Math.max(0, snapToFrame(time, frame));
      const duration =
        dragged.kind === 'title'
          ? Math.round((dragged.template.seconds * FLICKS_PER_SECOND) / frame) * frame
          : dragged.kind === 'sticker'
            ? Math.round(stickerDuration / frame) * frame
            : dragged.kind === 'sound'
              ? Math.max(
                  frame,
                  Math.floor((dragged.sound.seconds * FLICKS_PER_SECOND) / frame) * frame,
                )
              : adjustmentDuration;
      return { adjustment: { row: main ? null : row, start, duration } };
    }
    if (!row || row.track.locked) return null;
    if (dragged.item.entry.type === 'effect') {
      const clip = visibleClips(row.track.clips, time, time + 1).find(
        (c) => c.start <= time && c.video,
      );
      return clip ? { effect: { kind: 'clip' as const, row, clip } } : null;
    }
    const tolerance = (40 / this.view.scale) * FLICKS_PER_SECOND;
    const target = cutNear(row.track, time, tolerance);
    return target ? { transition: { row, target } } : null;
  }

  dragOverEffect(event: DragEvent, dragged: DraggedEffect | null) {
    if (!event.dataTransfer?.types.includes(effectDragType)) return;
    event.preventDefault();
    const at = dragged ? this.effectAt(dragged, event) : null;
    event.dataTransfer.dropEffect = at ? 'copy' : 'none';
    this.drop = null;
    this.effectDrop = null;
    if (at?.effect) this.effectDrop = at.effect;
    if (at?.transition)
      this.effectDrop = {
        kind: 'cut',
        row: at.transition.row,
        cut: at.transition.target.cut,
        duration: defaultTransitionDuration,
      };
    if (at?.adjustment)
      this.drop = {
        row: at.adjustment.row,
        start: at.adjustment.start,
        duration: at.adjustment.duration,
        insert: false,
      };
    this.redraw();
  }

  async dropEffect(event: DragEvent, dragged: DraggedEffect | null): Promise<void> {
    this.drop = null;
    this.effectDrop = null;
    this.redraw();
    if (!dragged || !event.dataTransfer?.types.includes(effectDragType)) return;
    event.preventDefault();
    const at = this.effectAt(dragged, event);
    if (!at) return;
    if (at.adjustment) {
      const track = at.adjustment.row?.track.id ?? null;
      if (dragged.kind === 'title')
        return this.host.addTitle(dragged.template, at.adjustment.start, track);
      if (dragged.kind === 'sticker')
        return this.host.addSticker(dragged.sticker, at.adjustment.start, track);
      if (dragged.kind === 'sound')
        return this.host.addSound(dragged.sound, at.adjustment.start, track);
      return this.host.addAdjustmentLayer(at.adjustment.start, track);
    }
    if (dragged.kind !== 'item') return;
    if (at.effect) {
      this.host.select([at.effect.clip.id], 'replace');
      return this.host.applyEffect(dragged.item, at.effect.clip.id);
    }
    if (at.transition)
      return this.host.applyTransition(dragged.item, {
        track: at.transition.row.track.id,
        ...at.transition.target,
      });
  }

  async dropMedia(event: DragEvent): Promise<void> {
    const id = event.dataTransfer?.getData(mediaDragType);
    this.drop = null;
    this.redraw();
    if (!id) return;
    event.preventDefault();
    const drop = this.dropAt(id, event);
    if (!drop) return;
    if (drop.slot !== undefined) {
      const filled = await this.host.execute({ type: 'fillSlot', clip: drop.slot, media: id });
      if (filled) this.host.select([drop.slot], 'replace');
      return;
    }
    const clip = { media: id, duration: drop.duration };
    const created = drop.row
      ? await this.host.execute({
          type: drop.insert ? 'insert' : 'overwrite',
          track: drop.row.track.id,
          at: drop.start,
          clip,
        })
      : await this.host.executeOnNewTrack({ type: 'overwrite', track: 0, at: drop.start, clip });
    if (created?.length) this.host.select([created[0]], 'replace');
  }
}

/** The end of the last clip. */
export function projectEnd(project: Project): number {
  let end = 0;
  for (const track of project.tracks) {
    const last = track.clips[track.clips.length - 1];
    if (last) end = Math.max(end, last.start + last.duration);
  }
  return end;
}

export function findClip(project: Project, id: number): { clip: Clip; index: number } | null {
  for (let index = 0; index < project.tracks.length; index++) {
    const clip = project.tracks[index].clips.find((c) => c.id === id);
    if (clip) return { clip, index };
  }
  return null;
}

/** `ids` and every clip linked to one of them. */
export function withPartners(project: Project, ids: number[]): Set<number> {
  const wanted = new Set(ids);
  const links = new Set<number>();
  for (const track of project.tracks)
    for (const clip of track.clips)
      if (wanted.has(clip.id) && clip.link !== null) links.add(clip.link);
  const all = new Set(ids);
  if (links.size)
    for (const track of project.tracks)
      for (const clip of track.clips)
        if (clip.link !== null && links.has(clip.link)) all.add(clip.id);
  return all;
}

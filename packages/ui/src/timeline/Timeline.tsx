import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CgButton,
  CgContextMenu,
  type CgContextMenuActions,
  type CgContextMenuItem,
} from '@cashgear/ui';
import { FLICKS_PER_SECOND, type MarkerColor, type MediaRef, type Track } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { usePlaybackState, type PlaybackControls } from '../monitor/usePlayback';
import { icons } from '../icons';
import { draggedMedia } from '../media/dragging';
import { formatTime } from '../project/format';
import { TimelineController, findClip, projectEnd, type TimelineHost } from './controller';
import {
  dropZoneHeight,
  frameDuration,
  layoutRows,
  maxScale,
  minScale,
  rulerHeight,
  type Hit,
} from './geometry';

export function trackLabel(track: Track, index: number) {
  return track.name || `Track ${index + 1}`;
}

const markerColors: MarkerColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

function ToolButton({
  label,
  pressed,
  onClick,
  disabled,
  children,
  testId,
}: {
  label: string;
  pressed?: boolean;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <CgButton
      appearance={pressed ? 'soft' : 'ghost'}
      intent={pressed ? 'primary' : 'neutral'}
      size="small"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </CgButton>
  );
}

function Toggle({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cgv-track-toggle"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TrackHeader({
  editor,
  track,
  index,
  main,
  onMenu,
}: {
  editor: EditorState;
  track: Track;
  index: number;
  main: boolean;
  onMenu(x: number, y: number): void;
}) {
  const [editing, setEditing] = useState(false);
  const label = trackLabel(track, index);
  const project = editor.project;
  const commit = (name: string) => {
    setEditing(false);
    if (name.trim() !== track.name)
      void project.execute({ type: 'renameTrack', track: track.id, name });
  };
  return (
    <div
      className={'cgv-track-header' + (main ? ' cgv-track-header-main' : '')}
      data-testid="track"
      data-track-id={track.id}
      data-locked={track.locked}
      data-main={main}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
    >
      {editing ? (
        <input
          className="cgv-track-name-input"
          aria-label={`Name of ${label}`}
          defaultValue={track.name}
          placeholder={label}
          autoFocus
          maxLength={100}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(event.currentTarget.value);
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span
          className="cgv-track-name"
          title={`${label}${main ? ' (main track)' : ''}. Double-click to rename.`}
          onDoubleClick={() => setEditing(true)}
        >
          {label}
        </span>
      )}
      {main && (
        <span className="cgv-track-main" title="The main track">
          Main
        </span>
      )}
      <span className="cgv-track-toggles">
        <Toggle
          label={`${track.locked ? 'Unlock' : 'Lock'} ${label}`}
          pressed={track.locked}
          onClick={() =>
            void project.execute({ type: 'setTrackLocked', track: track.id, locked: !track.locked })
          }
        >
          {track.locked ? icons.lock : icons.unlock}
        </Toggle>
        <Toggle
          label={`${track.muted ? 'Unmute' : 'Mute'} ${label}`}
          pressed={track.muted}
          onClick={() =>
            void project.execute({ type: 'setTrackMuted', track: track.id, muted: !track.muted })
          }
        >
          {track.muted ? icons.muted : icons.sound}
        </Toggle>
        <Toggle
          label={`${track.hidden ? 'Show' : 'Hide'} ${label}`}
          pressed={track.hidden}
          onClick={() =>
            void project.execute({ type: 'setTrackHidden', track: track.id, hidden: !track.hidden })
          }
        >
          {track.hidden ? icons.eyeOff : icons.eye}
        </Toggle>
      </span>
    </div>
  );
}

type MenuItem = CgContextMenuItem<null>;

/** The playhead's timecode; only this re-renders while playing. */
function Timecode({ playback }: { playback: PlaybackControls }) {
  const state = usePlaybackState(playback);
  return (
    <span className="cgv-timecode" data-testid="timeline-timecode">
      {state?.timecode ?? '00:00:00:00'}
    </span>
  );
}

/** Zoom slider positions are logarithmic, from the farthest zoom to the closest. */
const sliderSteps = 1000;
const toSlider = (scale: number) =>
  Math.round((Math.log(scale / minScale) / Math.log(maxScale / minScale)) * sliderSteps);
const fromSlider = (value: number) =>
  minScale * Math.exp((value / sliderSteps) * Math.log(maxScale / minScale));

/**
 * The zoom slider keeps its own state, so zooming re-renders only the slider,
 * never the timeline around it.
 */
function ZoomSlider({
  listen,
  onZoom,
}: {
  listen(update: (scale: number) => void): void;
  onZoom(scale: number): void;
}) {
  const [scale, setScale] = useState(40);
  useLayoutEffect(() => listen(setScale), [listen]);
  return (
    <input
      className="cgv-zoom"
      type="range"
      aria-label="Timeline zoom"
      data-testid="zoom"
      min={0}
      max={sliderSteps}
      value={toSlider(scale)}
      onChange={(event) => onZoom(fromSlider(Number(event.currentTarget.value)))}
    />
  );
}

/** The clips as a list for screen readers (and tests): the canvas has no DOM per clip. */
const ClipList = memo(function ClipList({
  tracks,
  media,
  missing,
  selected,
  onSelect,
}: {
  tracks: Track[];
  media: MediaRef[];
  missing: Set<string>;
  selected: Set<number>;
  onSelect(id: number): void;
}) {
  const names = new Map(media.map((item) => [item.id, item.name]));
  return (
    <ul className="cgv-sr-only" aria-label="Clips on the timeline">
      {tracks.map((track, index) =>
        track.clips.map((clip) => (
          <li
            key={clip.id}
            data-testid="clip"
            data-clip-id={clip.id}
            data-track-id={track.id}
            data-start={clip.start}
            data-duration={clip.duration}
            data-offline={missing.has(clip.media)}
            aria-selected={selected.has(clip.id)}
          >
            <button type="button" onClick={() => onSelect(clip.id)}>
              {missing.has(clip.media) && 'Missing: '}
              {names.get(clip.media) ?? clip.media}, {formatTime(clip.start)} to{' '}
              {formatTime(clip.start + clip.duration)} on {trackLabel(track, index)}
            </button>
          </li>
        )),
      )}
    </ul>
  );
});

/**
 * The editing timeline. The canvas draws tracks, clips, the ruler and the
 * playhead; React draws the toolbar, track headers, menus and an accessible
 * list of the clips. Every change is an engine command.
 */
export function Timeline({ editor, diagnostic }: { editor: EditorState; diagnostic?: boolean }) {
  const { project, playback } = editor;
  const snapshot = project.snapshot;
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const playheadElement = useRef<HTMLDivElement>(null);
  const headers = useRef<HTMLDivElement>(null);
  const controller = useRef<TimelineController | null>(null);
  const menu = useRef<CgContextMenuActions<null>>(null);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const zoomed = useRef<(scale: number) => void>(() => {});
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const missing = useMemo(
    () => new Set(project.missing.map((media) => media.id)),
    [project.missing],
  );
  const missingRef = useRef(missing);
  missingRef.current = missing;
  const playhead = useRef({ time: 0, rate: 0, at: 0, playing: false });

  // The playhead follows playback without re-rendering the timeline.
  useEffect(() => {
    const update = () => {
      const state = playback.state;
      playhead.current = {
        time: state?.time ?? 0,
        rate: state?.playing && !state.starting ? state.rate : 0,
        at: performance.now(),
        playing: !!state?.playing && !state.starting,
      };
      controller.current?.follow();
    };
    update();
    return playback.subscribe(update);
  }, [playback]);

  const openMenu = useRef<(hit: Hit, x: number, y: number) => void>(() => {});
  openMenu.current = (hit, x, y) => {
    const items = menuFor(editorRef.current, hit);
    if (!items.length) return;
    setMenuItems(items);
    // The menu reads its items on open, after React has rendered them.
    requestAnimationFrame(() => void menu.current?.showAt(x, y, null));
  };

  useLayoutEffect(() => {
    const element = canvas.current;
    const box = area.current;
    const marker = playheadElement.current;
    if (!element || !box || !marker) return;
    const host: TimelineHost = {
      project: () => editorRef.current.project.snapshot,
      visuals: () => editorRef.current.project.library.visuals,
      missing: () => missingRef.current,
      locked: () => !editorRef.current.project.snapshot,
      tool: () => editorRef.current.tool,
      snapping: () => editorRef.current.snapping,
      selected: () => editorRef.current.selected,
      picked: () => editorRef.current.selection,
      select: (ids, mode) => editorRef.current.select(ids, mode),
      playhead: () => {
        const p = playhead.current;
        if (!p.playing) return p.time;
        return Math.max(
          0,
          p.time + ((performance.now() - p.at) / 1000) * p.rate * FLICKS_PER_SECOND,
        );
      },
      playing: () => playhead.current.playing,
      seek: (time, scrub) => {
        const current = editorRef.current.project.snapshot?.project;
        if (!current) return;
        const frame = frameDuration(current.settings.frameRate);
        editorRef.current.playback.seekFrame(Math.floor(time / frame), scrub);
      },
      execute: async (command) =>
        (await editorRef.current.project.execute(command))?.created ?? null,
      executeOnNewTrack: (command) =>
        editorRef.current.project.transaction('Add to timeline', async (step) => {
          const count = editorRef.current.project.snapshot?.project.tracks.length ?? 0;
          const [track] = await step({ type: 'addTrack', index: count });
          return step({ ...command, track } as typeof command);
        }),
      gesture: (label) =>
        editorRef.current.project.gesture(label, (next, preview) =>
          controller.current?.stepped(next, preview.error),
        ),
      finish: (gesture) => editorRef.current.project.finish(gesture),
      openMenu: (hit, x, y) => openMenu.current(hit, x, y),
      scrolled: (top) => {
        if (headers.current) headers.current.style.transform = `translateY(${-top}px)`;
      },
      zoomed: (scale) => zoomed.current(scale),
    };
    const timeline = new TimelineController(element, host, marker);
    controller.current = timeline;
    editorRef.current.timeline.current = {
      zoom: (factor) => timeline.zoom(factor),
      fit: () => timeline.fit(),
      reveal: (time) => timeline.reveal(time),
    };
    if (diagnostic) Reflect.set(window, '__cgvTimeline', timeline);
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      timeline.resize(width, height, window.devicePixelRatio || 1);
    });
    observer.observe(box);
    const onKey = (event: KeyboardEvent) => {
      // Escape during a drag undoes it, instead of clearing the selection.
      if (event.key === 'Escape' && timeline.dragging) {
        event.preventDefault();
        event.stopPropagation();
        void timeline.cancelDrag();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      observer.disconnect();
      timeline.dispose();
      controller.current = null;
      editorRef.current.timeline.current = null;
    };
  }, [diagnostic]);

  useEffect(() => controller.current?.show(snapshot), [snapshot]);
  // Gestures elsewhere (inspector scrubs) show on the timeline as they happen.
  const onLive = project.onLive;
  useEffect(() => onLive((next) => controller.current?.show(next)), [onLive]);
  useEffect(
    () => controller.current?.redraw(),
    [editor.selected, project.library.visuals, missing, editor.tool],
  );

  const tracks = useMemo(() => snapshot?.project.tracks ?? [], [snapshot]);
  const rows = useMemo(() => layoutRows(tracks), [tracks]);
  const end = snapshot ? projectEnd(snapshot.project) : 0;
  const media = useMemo(() => snapshot?.project.media ?? [], [snapshot]);
  const select = useMemo(() => (id: number) => editorRef.current.select([id]), []);
  const listenZoom = useMemo(
    () => (update: (scale: number) => void) => {
      zoomed.current = update;
      update(controller.current?.view.scale ?? 40);
    },
    [],
  );
  const disabled = !snapshot;
  const magnetic = !!snapshot?.project.magnetic;
  const run = editor.run;

  const trackMenu = (track: Track, index: number, x: number, y: number) => {
    const isMain = track.id === snapshot?.project.mainTrack;
    const items: MenuItem[] = [
      {
        key: 'up',
        text: 'Move track up',
        disabled: index >= tracks.length - 1,
        command: () =>
          void project.execute({ type: 'moveTrack', track: track.id, index: index + 1 }),
      },
      {
        key: 'down',
        text: 'Move track down',
        disabled: index === 0,
        command: () =>
          void project.execute({ type: 'moveTrack', track: track.id, index: index - 1 }),
      },
      {
        key: 'remove',
        text: isMain ? 'The main track stays' : 'Delete track',
        disabled: isMain || tracks.length < 2,
        beginGroup: true,
        command: () => void project.execute({ type: 'removeTrack', track: track.id }),
      },
    ];
    setMenuItems(items);
    requestAnimationFrame(() => void menu.current?.showAt(x, y, null));
  };

  return (
    <section
      className="cgv-timeline"
      data-testid="timeline"
      aria-label="Timeline"
      data-tool={editor.tool}
      data-snapping={editor.snapping}
      data-magnetic={magnetic}
    >
      <div className="cgv-timeline-toolbar" role="toolbar" aria-label="Timeline tools">
        <ToolButton
          label="Select tool"
          pressed={editor.tool === 'select'}
          onClick={() => run('selectTool')}
          testId="tool-select"
        >
          {icons.select}
        </ToolButton>
        <ToolButton
          label="Blade tool"
          pressed={editor.tool === 'blade'}
          onClick={() => run('bladeTool')}
          testId="tool-blade"
        >
          {icons.blade}
        </ToolButton>
        <span className="cgv-toolbar-separator" />
        <ToolButton label="Split at the playhead" onClick={() => run('split')} disabled={disabled}>
          {icons.split}
        </ToolButton>
        <ToolButton
          label="Delete the selected clips"
          onClick={() => run('delete')}
          disabled={!editor.selection.length}
        >
          {icons.trash}
        </ToolButton>
        <ToolButton
          label="Add a marker at the playhead"
          onClick={() => run('addMarker')}
          disabled={disabled}
        >
          {icons.marker}
        </ToolButton>
        <span className="cgv-toolbar-separator" />
        <ToolButton
          label="Magnetic main track"
          pressed={magnetic}
          onClick={() => run('toggleMagnetic')}
          disabled={disabled}
          testId="magnetic"
        >
          {icons.magnet}
        </ToolButton>
        <ToolButton
          label="Snapping"
          pressed={editor.snapping}
          onClick={() => run('toggleSnapping')}
          testId="snapping"
        >
          {icons.snap}
        </ToolButton>
        <span className="cgv-toolbar-gap" />
        <span className="cgv-muted cgv-timeline-duration" data-testid="timeline-duration">
          {formatTime(end)}
        </span>
        <ToolButton label="Zoom out" onClick={() => run('zoomOut')}>
          {icons.zoomOut}
        </ToolButton>
        <ZoomSlider
          listen={listenZoom}
          onZoom={(scale) => {
            const timeline = controller.current;
            if (timeline) timeline.zoom(scale / timeline.view.scale);
          }}
        />
        <ToolButton label="Zoom in" onClick={() => run('zoomIn')}>
          {icons.zoomIn}
        </ToolButton>
        <ToolButton label="Zoom to fit" onClick={() => run('zoomToFit')}>
          {icons.fit}
        </ToolButton>
        <CgButton
          appearance="ghost"
          size="small"
          disabled={disabled}
          onClick={() => void project.execute({ type: 'addTrack', index: tracks.length })}
        >
          {icons.plus} Add track
        </CgButton>
      </div>
      <div className="cgv-timeline-body">
        <div className="cgv-timeline-headers">
          <div className="cgv-timeline-corner" style={{ height: rulerHeight }}>
            <Timecode playback={playback} />
          </div>
          <div className="cgv-timeline-header-rows">
            <div ref={headers}>
              <div className="cgv-timeline-drop-hint" style={{ height: dropZoneHeight }} />
              {rows.map((row) => (
                <div key={row.track.id} style={{ height: row.height }}>
                  <TrackHeader
                    editor={editor}
                    track={row.track}
                    index={row.index}
                    main={row.track.id === snapshot?.project.mainTrack}
                    onMenu={(x, y) => trackMenu(row.track, row.index, x, y)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div
          ref={area}
          className="cgv-timeline-canvas"
          onDragOver={(event) => controller.current?.dragOver(event.nativeEvent, draggedMedia.id)}
          onDragLeave={() => controller.current?.dragLeave()}
          onDrop={(event) => {
            event.preventDefault();
            void controller.current?.dropMedia(event.nativeEvent);
          }}
        >
          <canvas
            ref={canvas}
            data-testid="timeline-canvas"
            aria-label="Timeline tracks"
            onPointerDown={(event) => controller.current?.pointerDown(event.nativeEvent)}
            onPointerMove={(event) => controller.current?.pointerMove(event.nativeEvent)}
            onPointerUp={(event) => void controller.current?.pointerUp(event.nativeEvent)}
            onPointerCancel={() => void controller.current?.cancelDrag()}
            onPointerLeave={() => controller.current?.pointerLeave()}
            onContextMenu={(event) => event.preventDefault()}
          />
          <div ref={playheadElement} className="cgv-playhead" aria-hidden="true" />
        </div>
      </div>
      <ClipList
        tracks={tracks}
        media={media}
        missing={missing}
        selected={editor.selected}
        onSelect={select}
      />
      <ul className="cgv-sr-only" aria-label="Markers">
        {(snapshot?.project.markers ?? []).map((marker) => (
          <li
            key={marker.id}
            data-testid="marker"
            data-time={marker.time}
            data-color={marker.color}
          >
            {marker.name || 'Marker'} at {formatTime(marker.time)}
          </li>
        ))}
      </ul>
      <CgContextMenu<null>
        items={menuItems}
        actionsRef={menu}
        ariaLabel="Timeline actions"
        density="compact"
      />
    </section>
  );
}

/** The right-click menu for what is under the pointer. */
function menuFor(editor: EditorState, hit: Hit): MenuItem[] {
  const snapshot = editor.project.snapshot;
  if (!snapshot) return [];
  const project = editor.project;
  const run = editor.run;
  const time = editor.playhead();
  const paste: MenuItem = {
    key: 'paste',
    text: 'Paste at the playhead',
    disabled: !editor.clipboard.length,
    command: () => run('paste'),
  };
  if (hit.kind === 'marker') {
    const marker = hit.marker;
    return [
      ...markerColors.map<MenuItem>((color) => ({
        key: color,
        text: color[0].toUpperCase() + color.slice(1),
        checked: marker.color === color,
        command: () => void project.execute({ type: 'updateMarker', marker: marker.id, color }),
      })),
      {
        key: 'remove',
        text: 'Delete marker',
        beginGroup: true,
        command: () => void project.execute({ type: 'removeMarker', marker: marker.id }),
      },
    ];
  }
  if (hit.kind !== 'clip')
    return [
      paste,
      {
        key: 'marker',
        text: 'Add a marker here',
        command: () =>
          void project.execute({
            type: 'addMarker',
            at: Math.max(0, hit.time),
            color: 'blue',
          }),
      },
      { key: 'all', text: 'Select all clips', command: () => run('selectAll') },
    ];
  const clip = hit.clip;
  const found = findClip(snapshot.project, clip.id);
  const under = clip.start < time && time < clip.start + clip.duration;
  const many = editor.selection.length > 1;
  return [
    { key: 'split', text: 'Split at the playhead', disabled: !under, command: () => run('split') },
    { key: 'copy', text: 'Copy', beginGroup: true, command: () => run('copy') },
    { key: 'cut', text: 'Cut', command: () => run('cut') },
    paste,
    {
      key: 'detach',
      text: 'Detach audio',
      beginGroup: true,
      disabled: !(clip.video && clip.audio) || !found,
      command: () => void project.execute({ type: 'detachAudio', clip: clip.id }),
    },
    {
      key: 'link',
      text: 'Link clips',
      disabled: !many,
      command: () => void project.execute({ type: 'link', clips: editor.selection }),
    },
    {
      key: 'unlink',
      text: 'Unlink',
      disabled: clip.link === null,
      command: () => void project.execute({ type: 'unlink', clips: [...editor.selected] }),
    },
    { key: 'delete', text: 'Delete', beginGroup: true, command: () => run('delete') },
    { key: 'ripple', text: 'Ripple delete', command: () => run('rippleDelete') },
  ];
}

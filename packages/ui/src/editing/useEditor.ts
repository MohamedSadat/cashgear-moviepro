import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Clip, Command, Project } from '@cgv/engine-client';
import type { PlaybackControls } from '../monitor/usePlayback';
import type { ProjectState } from '../project/useProject';
import type { ActionId } from '../shortcuts/keymap';
import { findClip, projectEnd, withPartners } from '../timeline/controller';
import { frameDuration } from '../timeline/geometry';
import { copyClips, planPaste, type ClipboardItem } from './clipboard';

export type Tool = 'select' | 'blade';

/** What the timeline lets the editor do to its view. */
export interface TimelineHandle {
  zoom(factor: number): void;
  fit(): void;
  reveal(time: number): void;
}

export interface EditorState {
  project: ProjectState;
  playback: PlaybackControls;
  /** Selected clips as picked, first picked first. */
  selection: number[];
  /** The selection with the clips linked to it. */
  selected: Set<number>;
  select(ids: number[], mode?: 'replace' | 'add' | 'toggle'): void;
  /** The clip the inspector shows: the first selected one. */
  focused: Clip | null;
  tool: Tool;
  setTool(tool: Tool): void;
  snapping: boolean;
  setSnapping(on: boolean): void;
  clipboard: ClipboardItem[];
  /** The playhead in flicks. */
  playhead(): number;
  /** Runs a shortcut, toolbar or menu action. */
  run(action: ActionId): void;
  timeline: MutableRefObject<TimelineHandle | null>;
}

/** Clip starts and ends, and markers: where Up and Down move the playhead. */
function editPoints(project: Project): number[] {
  const points = new Set<number>([0]);
  for (const track of project.tracks)
    for (const clip of track.clips) {
      points.add(clip.start);
      points.add(clip.start + clip.duration);
    }
  for (const marker of project.markers) points.add(marker.time);
  return [...points].sort((a, b) => a - b);
}

/**
 * The editing session: selection, tools, snapping, the clipboard and every
 * editing action. Each action becomes engine commands, so all of them undo.
 */
export function useEditor(
  project: ProjectState,
  playback: PlaybackControls,
  options: { snapping: boolean; onSnapping(on: boolean): void },
): EditorState {
  const [selection, setSelection] = useState<number[]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [clipboard, setClipboard] = useState<ClipboardItem[]>([]);
  const timeline = useRef<TimelineHandle | null>(null);
  const snapshot = project.snapshot;
  const current = snapshot?.project ?? null;

  // Clips that are gone (undo, delete) leave the selection.
  useEffect(() => {
    if (!current) return setSelection((list) => (list.length ? [] : list));
    setSelection((list) => {
      const kept = list.filter((id) => findClip(current, id));
      return kept.length === list.length ? list : kept;
    });
  }, [current]);

  const selected = useMemo(
    () => (current ? withPartners(current, selection) : new Set<number>()),
    [current, selection],
  );
  const focused = useMemo(
    () => (current && selection.length ? (findClip(current, selection[0])?.clip ?? null) : null),
    [current, selection],
  );

  const select = useCallback((ids: number[], mode: 'replace' | 'add' | 'toggle' = 'replace') => {
    setSelection((list) => {
      if (mode === 'replace') return ids;
      if (mode === 'add') return [...list, ...ids.filter((id) => !list.includes(id))];
      const removed = list.filter((id) => !ids.includes(id));
      return [...removed, ...ids.filter((id) => !list.includes(id))];
    });
  }, []);

  const state = useRef({ project, playback, selection, clipboard, current, options });
  state.current = { project, playback, selection, clipboard, current, options };

  const playhead = useCallback(() => state.current.playback.state?.time ?? 0, []);

  const run = useCallback((action: ActionId) => {
    const { project, playback, selection, clipboard, current, options } = state.current;
    const time = playback.state?.time ?? 0;
    const frame = current ? frameDuration(current.settings.frameRate) : 1;
    const seekTo = (to: number) => playback.seekFrame(Math.round(to / frame));
    const execute = (command: Command) => void project.execute(command);
    const removeSelected = (ripple: boolean) => {
      if (!selection.length) return;
      execute({ type: ripple ? 'rippleDelete' : 'delete', clips: selection });
      setSelection([]);
    };
    const copy = () => {
      if (!current || !selection.length) return false;
      setClipboard(copyClips(current, [...withPartners(current, selection)]));
      return true;
    };
    const trimToPlayhead = (edge: 'start' | 'end') => {
      if (!current) return;
      // The selected clip under the playhead, or the main-track clip there.
      const under = (clip: Clip) => clip.start < time && time < clip.start + clip.duration;
      const target =
        selection.map((id) => findClip(current, id)?.clip).find((clip) => clip && under(clip)) ??
        current.tracks.find((track) => track.id === current.mainTrack)?.clips.find(under);
      if (!target) return project.notice('No clip is under the playhead to trim.');
      const delta =
        edge === 'start' ? time - target.start : time - (target.start + target.duration);
      execute({ type: 'trim', clip: target.id, edge, delta, ripple: true });
    };
    // Exporting opens a dialog: the app shell takes that key.
    const handlers: Record<Exclude<ActionId, 'exportVideo'>, () => void> = {
      playPause: playback.toggle,
      shuttleBack: () => playback.shuttle('j'),
      shuttleStop: () => playback.shuttle('k'),
      shuttleForward: () => playback.shuttle('l'),
      previousFrame: () => playback.step(-1),
      nextFrame: () => playback.step(1),
      back10Frames: () => playback.step(-10),
      forward10Frames: () => playback.step(10),
      goToStart: playback.toStart,
      goToEnd: playback.toEnd,
      previousEdit: () => {
        if (!current) return;
        const before = editPoints(current).filter((point) => point < time);
        if (before.length) seekTo(before[before.length - 1]);
      },
      nextEdit: () => {
        if (!current) return;
        const after = editPoints(current).find((point) => point > time);
        if (after !== undefined && after <= projectEnd(current)) seekTo(after);
      },
      undo: () => void project.undo(),
      redo: () => void project.redo(),
      save: () => void project.save(),
      saveAs: () => void (project.savesInPlace ? project.save() : project.saveAs()),
      split: () => {
        if (!current) return;
        const under = selection.filter((id) => {
          const clip = findClip(current, id)?.clip;
          return clip && clip.start < time && time < clip.start + clip.duration;
        });
        execute({ type: 'split', at: time, clips: under });
      },
      delete: () => removeSelected(false),
      rippleDelete: () => removeSelected(true),
      copy: () => void copy(),
      cut: () => {
        if (copy()) removeSelected(false);
      },
      paste: () => {
        if (!current || !clipboard.length) return;
        const plan = planPaste(current, clipboard, time);
        void project
          .transaction('Paste', async (step) => {
            const created: number[] = [];
            for (const command of plan.commands) created.push((await step(command))[0]);
            for (const group of plan.links)
              await step({ type: 'link', clips: group.map((index) => created[index]) });
            return created;
          })
          .then((created) => created && setSelection(created));
      },
      selectAll: () => {
        if (current) setSelection(current.tracks.flatMap((track) => track.clips.map((c) => c.id)));
      },
      deselect: () => setSelection([]),
      trimStartToPlayhead: () => trimToPlayhead('start'),
      trimEndToPlayhead: () => trimToPlayhead('end'),
      addMarker: () => execute({ type: 'addMarker', at: time, color: 'blue' }),
      toggleSnapping: () => options.onSnapping(!options.snapping),
      toggleMagnetic: () =>
        current && execute({ type: 'setMagnetic', magnetic: !current.magnetic }),
      zoomIn: () => timeline.current?.zoom(1.5),
      zoomOut: () => timeline.current?.zoom(1 / 1.5),
      zoomToFit: () => timeline.current?.fit(),
      selectTool: () => setTool('select'),
      bladeTool: () => setTool('blade'),
    };
    if (action !== 'exportVideo') handlers[action]();
  }, []);

  return {
    project,
    playback,
    selection,
    selected,
    select,
    focused,
    tool,
    setTool,
    snapping: options.snapping,
    setSnapping: options.onSnapping,
    clipboard,
    playhead,
    run,
    timeline,
  };
}

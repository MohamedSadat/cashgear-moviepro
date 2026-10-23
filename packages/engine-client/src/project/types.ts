// Mirrors the JSON of crates/cgv-model (Project, Command, Outcome, Snapshot).
// Times are flicks (705,600,000 per second), exact integers below 2^53.
import type { FrameRate } from '../media/types';

export const FLICKS_PER_SECOND = 705_600_000;

export interface ProjectSettings {
  width: number;
  height: number;
  frameRate: FrameRate;
  sampleRate: number;
  channels: number;
}

export interface Preset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export type MediaLocation = { kind: 'path'; path: string } | { kind: 'browser' };

/** A media file a project uses. */
export interface MediaRef {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'image';
  /** Zero for stills. */
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  frameRate: FrameRate | null;
  size: number;
  /** Milliseconds since 1970, when known. */
  modified: number | null;
  location: MediaLocation;
}

export interface Speed {
  num: number;
  den: number;
}
export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  anchorX: number;
  anchorY: number;
}
export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Clip {
  id: number;
  media: string;
  start: number;
  duration: number;
  sourceIn: number;
  speed: Speed;
  video: boolean;
  audio: boolean;
  link: number | null;
  transform: Transform;
  crop: Crop;
  opacity: number;
  volumeDb: number;
  effects?: unknown[];
  keyframes?: Record<string, unknown[]>;
}

export interface Track {
  id: number;
  /** Empty: shown by position ("Track 2"). */
  name: string;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
  clips: Clip[];
}

export type MarkerColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export interface Marker {
  id: number;
  time: number;
  name: string;
  color: MarkerColor;
}

export interface Project {
  id: string;
  name: string;
  settings: ProjectSettings;
  media: MediaRef[];
  /** Bottom track first. */
  tracks: Track[];
  markers: Marker[];
  nextId: number;
}

export interface ClipSpec {
  media: string;
  sourceIn?: number;
  duration: number;
  video?: boolean;
  audio?: boolean;
}

export type Edge = 'start' | 'end';

/** Every project change. See `cgv_model::Command` for what each one does. */
export type Command =
  | { type: 'rename'; name: string }
  | { type: 'setSettings'; settings: ProjectSettings }
  | { type: 'addMedia'; media: MediaRef }
  | { type: 'removeMedia'; media: string }
  | { type: 'addTrack'; index: number; name?: string }
  | { type: 'removeTrack'; track: number }
  | { type: 'moveTrack'; track: number; index: number }
  | { type: 'renameTrack'; track: number; name: string }
  | { type: 'setTrackLocked'; track: number; locked: boolean }
  | { type: 'setTrackMuted'; track: number; muted: boolean }
  | { type: 'setTrackHidden'; track: number; hidden: boolean }
  | { type: 'insert'; track: number; at: number; clip: ClipSpec }
  | { type: 'overwrite'; track: number; at: number; clip: ClipSpec }
  | { type: 'append'; track: number; clip: ClipSpec }
  | { type: 'delete'; clips: number[] }
  | { type: 'rippleDelete'; clips: number[] }
  | { type: 'split'; at: number; clips?: number[] }
  | { type: 'trim'; clip: number; edge: Edge; delta: number; ripple?: boolean }
  | { type: 'roll'; clip: number; edge: Edge; delta: number }
  | { type: 'move'; clips: number[]; delta: number; tracks?: number; overwrite?: boolean }
  | { type: 'slip'; clip: number; delta: number }
  | { type: 'slide'; clip: number; delta: number }
  | { type: 'link'; clips: number[] }
  | { type: 'unlink'; clips: number[] }
  | { type: 'detachAudio'; clip: number; track?: number | null }
  | { type: 'setSpeed'; clip: number; speed: Speed }
  | {
      type: 'setClipProperties';
      clip: number;
      properties: { transform?: Transform; crop?: Crop; opacity?: number; volumeDb?: number };
    }
  | { type: 'addMarker'; at: number; name?: string; color: MarkerColor }
  | { type: 'updateMarker'; marker: number; at?: number; name?: string; color?: MarkerColor }
  | { type: 'removeMarker'; marker: number };

/** Ids a command created: the new clip, track or marker first. */
export interface Outcome {
  created: number[];
}

/** The open project with its history and save state. */
export interface ProjectSnapshot {
  project: Project;
  /** Identifies this state; undo and redo bring earlier ones back. */
  generation: number;
  /** Differs from the saved file. */
  dirty: boolean;
  /** Has changes the autosave has not written. */
  needsAutosave: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  grouping: boolean;
}

export interface ClipAt {
  track: number;
  trackIndex: number;
  clip: Clip;
}

/** The project file's text and the state it holds. */
export interface SavedText {
  text: string;
  generation: number;
}

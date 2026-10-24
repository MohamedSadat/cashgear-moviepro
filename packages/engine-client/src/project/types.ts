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

/** A colour as a picker shows it: sRGB-encoded, straight alpha, 0 to 1. */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A setting of an effect or transition: a number, switch, colour, choice or LUT reference. */
export type ParamValue = number | boolean | Color | string;
export type Params = Record<string, ParamValue>;

/** A video effect on a clip; effects run in list order. */
export interface Effect {
  id: number;
  /** The effect's id in its pack, such as `gaussian-blur`. */
  kind: string;
  pack: string;
  version: number;
  enabled: boolean;
  /** Missing settings take the definition's defaults. */
  params: Params;
}

/** An effect to add. `id` is where it was copied from, so its keyframes follow it. */
export interface EffectSpec {
  id?: number;
  kind: string;
  pack?: string;
  version?: number;
  enabled?: boolean;
  params?: Params;
}

/** How the value moves from a keyframe to the next. Eases follow CSS. */
export type Interpolation =
  | { kind: 'linear' }
  | { kind: 'hold' }
  | { kind: 'easeIn' }
  | { kind: 'easeOut' }
  | { kind: 'easeInOut' }
  | { kind: 'bezier'; x1: number; y1: number; x2: number; y2: number };

export type KeyValue = number | Color;

/** A property's value at a time from the clip's start. */
export interface Keyframe {
  time: number;
  value: KeyValue;
  interpolation: Interpolation;
}

export type Alignment = 'start' | 'center' | 'end';

/** A transition between touching clips (`from`, then `to`), or at a free edge. */
export interface Transition {
  id: number;
  kind: string;
  pack: string;
  version: number;
  from: number | null;
  to: number | null;
  duration: number;
  alignment: Alignment;
  params: Params;
}

export interface TransitionSpec {
  kind: string;
  pack?: string;
  version?: number;
  duration: number;
  alignment?: Alignment;
  params?: Params;
}

/** A project LUT, without its data. */
export interface LutInfo {
  id: number;
  name: string;
  shape: '1d' | '3d';
  size: number;
}

export interface Clip {
  id: number;
  /** An adjustment layer has no media: its effects apply to the tracks below. */
  kind?: 'media' | 'adjustment';
  /** Empty for an adjustment layer. */
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
  effects?: Effect[];
  /** Animated properties by name: `opacity`, `transform.x`, `effects.<id>.<setting>`… */
  keyframes?: Record<string, Keyframe[]>;
}

export interface Track {
  id: number;
  /** Empty: shown by position ("Track 2"). */
  name: string;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
  clips: Clip[];
  /** By time. */
  transitions?: Transition[];
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
  /** The main track; it cannot be removed. */
  mainTrack: number;
  /** The main track has no gaps, and clips linked to its clips follow them. */
  magnetic: boolean;
  markers: Marker[];
  /** LUTs kept in the project for its effects. */
  luts: LutInfo[];
  nextId: number;
}

/** Clip values to change; missing ones stay as they are. */
export interface ClipProperties {
  transform?: Partial<Transform>;
  crop?: Partial<Crop>;
  opacity?: number;
  volumeDb?: number;
}

export interface ClipSpec {
  kind?: 'media' | 'adjustment';
  /** Empty (or left out) for an adjustment layer. */
  media?: string;
  sourceIn?: number;
  /** Timeline length, at `speed`. */
  duration: number;
  video?: boolean;
  audio?: boolean;
  speed?: Speed;
  /** Picture and sound settings, as when pasting a copy. */
  properties?: ClipProperties;
  /** Effects and keyframes, as when pasting a copy. */
  effects?: EffectSpec[];
  keyframes?: Record<string, Keyframe[]>;
}

export type Edge = 'start' | 'end';

/** Every project change. See `cgv_model::Command` for what each one does. */
export type Command =
  | { type: 'rename'; name: string }
  | { type: 'setSettings'; settings: ProjectSettings }
  | { type: 'setMagnetic'; magnetic: boolean }
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
  | { type: 'setClipProperties'; clip: number; properties: ClipProperties }
  | { type: 'addEffect'; clip: number; effect: EffectSpec; index?: number }
  | { type: 'removeEffect'; clip: number; effect: number }
  | { type: 'moveEffect'; clip: number; effect: number; index: number }
  | { type: 'setEffectEnabled'; clip: number; effect: number; enabled: boolean }
  | { type: 'setEffectParams'; clip: number; effect: number; params: Params }
  | { type: 'resetEffect'; clip: number; effect: number; params?: Params }
  | {
      type: 'setKeyframe';
      clip: number;
      property: string;
      time: number;
      value: KeyValue;
      interpolation?: Interpolation;
    }
  | { type: 'removeKeyframes'; clip: number; property: string; times: number[] }
  | { type: 'moveKeyframes'; clip: number; properties?: string[]; times: number[]; delta: number }
  | {
      type: 'setInterpolation';
      clip: number;
      property: string;
      times: number[];
      interpolation: Interpolation;
    }
  | { type: 'clearKeyframes'; clip: number; property: string; at?: number }
  | {
      type: 'addTransition';
      track: number;
      from?: number | null;
      to?: number | null;
      transition: TransitionSpec;
    }
  | {
      type: 'setTransition';
      transition: number;
      duration?: number;
      alignment?: Alignment;
      params?: Params;
    }
  | { type: 'removeTransition'; transition: number }
  | { type: 'removeLut'; lut: number }
  | { type: 'addMarker'; at: number; name?: string; color: MarkerColor }
  | { type: 'updateMarker'; marker: number; at?: number; name?: string; color?: MarkerColor }
  | { type: 'removeMarker'; marker: number };

/** Ids a command created: the new clip, track, marker, effect, transition or LUT first. */
export interface Outcome {
  created: number[];
}

/** One step of a gesture: the snapshot to draw, and why the step failed, if it did. */
export interface Preview {
  outcome: Outcome | null;
  error: string | null;
  snapshot: ProjectSnapshot;
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

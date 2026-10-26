// Mirrors the JSON of crates/cgv-model (Project, Command, Outcome, Snapshot).
// Times are flicks (705,600,000 per second), exact integers below 2^53.
import type { FrameRate } from '../media/types';
import type { Title } from './title';

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

export type MediaLocation =
  | { kind: 'path'; path: string }
  | { kind: 'browser' }
  /** A file of the app's own pack (a sticker), by its path under assets. */
  | { kind: 'pack'; path: string };

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

/** A point of a speed ramp: at `time` from the clip's start it plays at `speed` times its speed. */
export interface RampPoint {
  time: number;
  speed: number;
}

/** A ramp point by fraction of the clip's length (0 to 1), as presets give them. */
export interface RampShape {
  at: number;
  speed: number;
}

/** How a picture mixes with what is below it. */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'softLight'
  | 'hardLight'
  | 'add'
  | 'darken'
  | 'lighten'
  | 'difference'
  | 'exclusion'
  | 'colorDodge'
  | 'colorBurn';

export type MaskShape = 'rectangle' | 'ellipse' | 'path';
export type MaskMode = 'add' | 'subtract' | 'intersect';

/** A drawn mask's point in its box (-0.5 to 0.5); handles are offsets, zero for a corner. */
export interface MaskPoint {
  x: number;
  y: number;
  inX?: number;
  inY?: number;
  outX?: number;
  outY?: number;
}

/**
 * A shape that cuts a clip's picture, in the picture: positions and sizes are
 * fractions of its width and height; feather and expansion of its shorter side.
 */
export interface Mask {
  id: number;
  shape: MaskShape;
  mode?: MaskMode;
  invert?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  roundness?: number;
  feather?: number;
  expansion?: number;
  opacity: number;
  points?: MaskPoint[];
}

export interface Clip {
  id: number;
  /**
   * An adjustment layer has no media: its effects apply to the tracks below. A
   * title has none either: it draws `title`.
   */
  kind?: 'media' | 'adjustment' | 'title';
  /** Empty for an adjustment layer or a title. */
  media: string;
  start: number;
  duration: number;
  sourceIn: number;
  speed: Speed;
  /** A speed ramp, by time from the clip's start; missing plays at `speed` throughout. */
  ramp?: RampPoint[];
  /** Plays its source range from the out point back. */
  reverse?: boolean;
  /** Shows the frame at `sourceIn` throughout, without sound. */
  freeze?: boolean;
  /** Sound at other speeds keeps its pitch (missing means it does). */
  keepPitch?: boolean;
  /** Slow motion blends neighbouring frames. */
  frameBlending?: boolean;
  video: boolean;
  audio: boolean;
  link: number | null;
  transform: Transform;
  crop: Crop;
  opacity: number;
  blendMode?: BlendMode;
  /** Shapes that cut the picture, after its effects. */
  masks?: Mask[];
  volumeDb: number;
  /** Sound fades at the start and end, in flicks; missing means none. */
  fadeIn?: number;
  fadeOut?: number;
  /** Noise reduction, 0 (off) to 1. */
  denoise?: number;
  effects?: Effect[];
  /** Sound effects, in the order they run, after noise reduction. */
  audioEffects?: Effect[];
  /**
   * Animated properties by name: `opacity`, `transform.x`, `effects.<id>.<setting>`,
   * `title.<element id>.<setting>`…
   */
  keyframes?: Record<string, Keyframe[]>;
  /** What a title clip draws. */
  title?: Title;
}

/** What a track carries, so music can dip under dialogue. */
export type TrackRole = 'none' | 'dialogue' | 'music' | 'effects';

/** How a music track dips while a dialogue track plays. */
export interface Ducking {
  enabled: boolean;
  /** Decibels down, positive. */
  amountDb: number;
  /** Dialogue counts above this level (dBFS RMS). */
  thresholdDb: number;
  /** Seconds. */
  attack: number;
  hold: number;
  release: number;
}

export const defaultDucking: Ducking = {
  enabled: true,
  amountDb: 12,
  thresholdDb: -40,
  attack: 0.2,
  hold: 0.3,
  release: 0.6,
};

export interface Track {
  id: number;
  /** Empty: shown by position ("Track 2"). */
  name: string;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
  /** Missing values are the defaults: 0 dB, centre, not soloed, no role. */
  volumeDb?: number;
  /** -1 (left) to 1 (right). */
  pan?: number;
  solo?: boolean;
  role?: TrackRole;
  ducking?: Ducking;
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
  fadeIn?: number;
  fadeOut?: number;
  denoise?: number;
  blendMode?: BlendMode;
  keepPitch?: boolean;
  frameBlending?: boolean;
}

/** Track sound settings to change; missing ones stay as they are. */
export interface TrackSound {
  volumeDb?: number;
  pan?: number;
  solo?: boolean;
  role?: TrackRole;
  ducking?: Ducking;
}

export interface ClipSpec {
  kind?: 'media' | 'adjustment' | 'title';
  /** Empty (or left out) for an adjustment layer or a title. */
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
  audioEffects?: EffectSpec[];
  keyframes?: Record<string, Keyframe[]>;
  /** What a new title clip draws; its elements get new ids, and keyframes follow them. */
  title?: Title;
  /** A pasted copy's timing. */
  ramp?: RampPoint[];
  reverse?: boolean;
  freeze?: boolean;
  /** A pasted copy's masks; they get new ids, and keyframes follow them. */
  masks?: Mask[];
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
  | { type: 'setTrackSound'; track: number; sound: TrackSound }
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
  /** Points by fraction of the clip's length; an empty list removes the ramp. */
  | { type: 'setRamp'; clip: number; points: RampShape[] }
  | { type: 'setReverse'; clip: number; reverse: boolean }
  | { type: 'freezeFrame'; clip: number; at: number; duration: number }
  | { type: 'addMask'; clip: number; mask: Mask; index?: number }
  | { type: 'setMask'; clip: number; mask: Mask }
  | { type: 'removeMask'; clip: number; mask: number }
  | { type: 'moveMask'; clip: number; mask: number; index: number }

  /** `audio` adds it to the clip's sound effects. */
  | { type: 'addEffect'; clip: number; effect: EffectSpec; index?: number; audio?: boolean }
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
  | { type: 'setKeyframes'; clip: number; property: string; keys: Keyframe[] }
  /** Replaces a title; elements it names keep their ids and keyframes. */
  | { type: 'setTitle'; clip: number; title: Title }
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
  | { type: 'removeMarker'; marker: number }
  /** Clip property, effect, keyframe and transition changes as one command (one gesture step). */
  | { type: 'batch'; commands: Command[] };

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

// Mirrors the JSON of crates/cgv-engine (plan::FramePlan, stats::StatsSummary).
import type { Crop, Params, Speed, Transform } from '../project/types';
import type { AudioReport } from './audio-player';

export type QualityMode = 'auto' | 'full' | 'half' | 'quarter';

/** An effect to run at a frame, with its settings there (keyframes applied). */
export interface EffectPlan {
  pack: string;
  kind: string;
  params: Params;
}

/** One picture of a planned frame. Times are flicks. */
export interface LayerPlan {
  clip: number;
  track: number;
  media: string;
  still: boolean;
  /** Media time to show (zero for stills). */
  sourceTime: number;
  transform: Transform;
  crop: Crop;
  opacity: number;
  clipStart: number;
  clipEnd: number;
  sourceIn: number;
  speed: Speed;
  /** Seconds from the clip's start (negative, or past its end, in a transition). */
  clipSeconds: number;
  seed: number;
  effects?: EffectPlan[];
}

/** How a frame is drawn, bottom first. */
export type PlanStep =
  | { kind: 'layer'; layer: number }
  | {
      kind: 'transition';
      from: number | null;
      to: number | null;
      transition: EffectPlan;
      progress: number;
    }
  | {
      kind: 'adjustment';
      clip: number;
      effects: EffectPlan[];
      opacity: number;
      clipSeconds: number;
      seed: number;
    };

/** A project LUT a frame's effects read; `key` is what the GPU caches it by. */
export interface LutPlan {
  id: number;
  key: string;
  shape: '1d' | '3d';
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

/** What one project frame shows: its pictures, and how they are drawn. */
export interface FramePlan {
  frame: number;
  time: number;
  width: number;
  height: number;
  layers: LayerPlan[];
  steps: PlanStep[];
  luts?: LutPlan[];
}

/** The playhead and transport, as the monitor shows them. */
export interface PlaybackState {
  playing: boolean;
  /** Waiting for decoders and sound before the clock starts. */
  starting: boolean;
  /** Playback rate: negative backwards, zero when paused. */
  rate: number;
  /** The playhead in flicks: the start of the frame on screen. */
  time: number;
  frame: number;
  timecode: string;
  /** The end of the last clip, in flicks. */
  duration: number;
  durationTimecode: string;
  /** The last frame, and its start: as far as the playhead goes. */
  lastFrame: number;
  lastFrameTime: number;
  quality: QualityMode;
  /** What is drawn now: 0 full, 1 half, 2 quarter resolution. */
  level: number;
  /** What drives the playhead while playing. */
  clock: 'audio' | 'wall' | null;
}

export interface Timing {
  mean: number;
  max: number;
}

/** Playback measurements since the last play (or reset). */
export interface PlaybackStatsReport {
  presented: number;
  /** Frames due at normal speed that were never shown. */
  dropped: number;
  late: number;
  renderMs: Timing;
  gpuMs: Timing;
  /** Frame on screen minus sound heard, sampled at every display refresh. */
  offset: {
    count: number;
    meanMs: number;
    maxAbsMs: number;
    lastMs: number | null;
    p50AbsMs: number;
    p95AbsMs: number;
    p99AbsMs: number;
  };
  audio: AudioReport | null;
  clock: 'audio' | 'wall' | null;
  /** Why the latest playback left the audio clock, if it did. */
  fallback: string | null;
  /** The latest skips: the frame shown, frames skipped before it, how many were undecoded. */
  recentDrops: { frame: number; missed: number; undecoded: number; afterMs: number; at: number }[];
  /** The latest ticks that kept the worker busy over 8 ms, and the decoders they started. */
  slowTicks: { ms: number; created: number; at: number }[];
  streams: number;
  vsyncMs: number;
  quality: QualityMode;
  level: number;
  compositionFormat: string;
}

/** A composition read back as sRGB RGBA bytes. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

import type { MediaSourceRef } from '../media/types';

/** Readings per second of the sound envelopes. */
export const envelopeRate = 100;
/**
 * The version of cgv-ai's sound analysis. Raise it when the envelopes change,
 * so analyses cached before are made again.
 */
export const soundAnalysisVersion = 1;

/**
 * A medium's sound measured once: its level (dBFS) and onset envelopes, each
 * a reading every 10 ms. Silences and beats come from them with any settings.
 */
export interface SoundAnalysis {
  /** Source time of the first reading, in seconds. */
  start: number;
  levels: Float32Array;
  onsets: Float32Array;
}

/** What counts as a silence worth cutting. */
export interface SilenceSettings {
  /** Quieter than this (dBFS) is silent; null picks it from the recording. */
  thresholdDb: number | null;
  /** Seconds a silence lasts at least. */
  minLength: number;
  /** Seconds of quiet kept next to the sound on each side. */
  padding: number;
}

export const defaultSilenceSettings: SilenceSettings = {
  thresholdDb: null,
  minLength: 0.5,
  padding: 0.15,
};

/**
 * The version of cgv-ai's scene scores. Raise it when they change, so analyses
 * cached before are made again.
 */
export const sceneAnalysisVersion = 1;

/** A video's frames measured once: when each shows and how much it changed. */
export interface SceneAnalysis {
  /** Source time of each frame, in seconds. */
  times: Float64Array;
  /** Each frame's change from the one before (0 to 255). */
  scores: Float32Array;
  /** Each frame's change from the one two before, which tells flashes from cuts. */
  skips: Float32Array;
}

/** How a scene change must stand out. */
export interface SceneSettings {
  /** Times the mean change of the frames around it. */
  ratio: number;
  /** Change (0 to 255) a cut needs at least. */
  minScore: number;
  /** Seconds a scene lasts at least. */
  minLength: number;
}

export const defaultSceneSettings: SceneSettings = { ratio: 3, minScore: 15, minLength: 0.5 };

/** The speech models captions can use: turbo for real work, tiny for quick tests. */
export type CaptionModel = 'whisper-large-v3-turbo' | 'whisper-tiny';

export interface ModelState {
  id: CaptionModel;
  name: string;
  license: string;
  /** Bytes it downloads. */
  bytes: number;
  installed: boolean;
}

export interface TranscriptWord {
  /** With its leading space; without one it joins the word before ("100", "%"). */
  text: string;
  /** Source seconds. */
  start: number;
  end: number;
  /** The model's confidence, 0 to 1. */
  probability: number;
}

/** A stretch Whisper wrote as one piece: usually a sentence or a clause. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

export interface Transcript {
  /** The language code, such as `en` or `ar`. */
  language: string;
  segments: TranscriptSegment[];
}

export interface TranscribeRequest {
  model: CaptionModel;
  /** A language code, or null to detect it. */
  language: string | null;
  /** Source seconds to transcribe. */
  start: number;
  end: number;
}

export interface BeatAnalysis {
  /** Beats per minute, or null without a steady pulse. */
  tempo: number | null;
  /** Source times in seconds. */
  beats: number[];
}

/**
 * The AI worker: analysis and models off the engine's thread. Each job takes
 * an id that `cancel` stops it by; a cancelled job rejects with an AbortError.
 */
export interface AiApi {
  /** Decodes a medium's sound once and measures it; null when it has none. */
  analyzeSound(
    job: number,
    source: MediaSourceRef,
    onProgress: (fraction: number) => void,
  ): Promise<SoundAnalysis | null>;
  /** Silences as `[start, end]` source seconds, in order. */
  silences(analysis: SoundAnalysis, settings: SilenceSettings): Promise<[number, number][]>;
  beats(analysis: SoundAnalysis): Promise<BeatAnalysis>;
  /** Decodes every frame of a medium's picture and scores it; null when it has none. */
  analyzeScenes(
    job: number,
    source: MediaSourceRef,
    onProgress: (fraction: number) => void,
  ): Promise<SceneAnalysis | null>;
  /** The source times (seconds) at which new scenes start, in order. */
  sceneCuts(analysis: SceneAnalysis, settings: SceneSettings): Promise<number[]>;
  modelState(id: CaptionModel): Promise<ModelState>;
  /** Downloads a model's missing files, checking each one. */
  installModel(
    job: number,
    id: CaptionModel,
    onProgress: (fraction: number) => void,
  ): Promise<void>;
  removeModel(id: CaptionModel): Promise<void>;
  /** Where models download from: null for Hugging Face, or a folder of local copies (tests). */
  setModelBase(url: string | null): Promise<void>;
  /** Speech to text for a range of a medium's sound, with word times in source seconds. */
  transcribe(
    job: number,
    source: MediaSourceRef,
    request: TranscribeRequest,
    onProgress: (fraction: number) => void,
  ): Promise<Transcript & { provider: 'webgpu' | 'wasm' }>;
  cancel(job: number): void;
}

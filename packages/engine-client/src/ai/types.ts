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
  cancel(job: number): void;
}

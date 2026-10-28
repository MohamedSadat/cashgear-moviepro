/// <reference lib="webworker" />
// The AI worker: long analysis jobs and models, away from the engine worker's
// playback and the jobs worker's thumbnails. Its arithmetic is the cgv-ai WASM
// module; decoding is WebCodecs through Mediabunny.
import { expose, transfer } from 'comlink';
import { AudioSampleSink } from 'mediabunny';
import init, { SoundAnalysis as Analysis, beats, silences } from '../pkg/ai/cgv_ai';
import { openInput } from '../media/sources';
import type { MediaSourceRef } from '../media/types';
import type { AiApi, SilenceSettings, SoundAnalysis } from './types';

const ready = init();
const cancelled = new Set<number>();

/** Stops job `job` if it was cancelled. */
function check(job: number) {
  if (!cancelled.delete(job)) return;
  const error = new Error('Cancelled');
  error.name = 'AbortError';
  throw error;
}

/** Passes progress on at most every 100 ms, and always the end. */
function throttle(report: (fraction: number) => void) {
  let last = 0;
  return (fraction: number) => {
    const now = performance.now();
    if (now - last < 100 && fraction < 1) return;
    last = now;
    void report(Math.min(1, Math.max(0, fraction)));
  };
}

const api: AiApi = {
  async analyzeSound(job: number, source: MediaSourceRef, onProgress: (fraction: number) => void) {
    await ready;
    const input = await openInput(source);
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) return null;
      const duration = Math.max(await track.computeDuration(), 1e-3);
      const analysis = new Analysis(await track.getSampleRate());
      const progress = throttle(onProgress);
      try {
        let start: number | null = null;
        for await (const sample of new AudioSampleSink(track).samples()) {
          try {
            check(job);
            start ??= sample.timestamp;
            const frames = sample.numberOfFrames;
            const channels = sample.numberOfChannels;
            const data = new Float32Array(frames * channels);
            for (let plane = 0; plane < channels; plane++)
              sample.copyTo(data.subarray(plane * frames, (plane + 1) * frames), {
                planeIndex: plane,
                format: 'f32-planar',
              });
            analysis.push(channels, data);
            progress((sample.timestamp + sample.duration) / duration);
          } finally {
            sample.close();
          }
        }
        analysis.finish();
        const levels = analysis.levels();
        const onsets = analysis.onsets();
        progress(1);
        const result: SoundAnalysis = { start: start ?? 0, levels, onsets };
        return transfer(result, [levels.buffer, onsets.buffer]);
      } finally {
        analysis.free();
      }
    } finally {
      cancelled.delete(job);
      input.dispose();
    }
  },

  async silences(analysis: SoundAnalysis, settings: SilenceSettings) {
    await ready;
    const flat = silences(
      analysis.levels,
      settings.thresholdDb ?? Number.NaN,
      settings.minLength,
      settings.padding,
    );
    const ranges: [number, number][] = [];
    for (let i = 0; i + 1 < flat.length; i += 2)
      ranges.push([analysis.start + flat[i], analysis.start + flat[i + 1]]);
    return ranges;
  },

  async beats(analysis: SoundAnalysis) {
    await ready;
    const [tempo, ...times] = beats(analysis.onsets);
    return {
      tempo: Number.isFinite(tempo) ? tempo : null,
      beats: times.map((time) => analysis.start + time),
    };
  },

  cancel(job: number) {
    cancelled.add(job);
  },
};
expose(api);

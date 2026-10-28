/// <reference lib="webworker" />
// The AI worker: long analysis jobs and models, away from the engine worker's
// playback and the jobs worker's thumbnails. Its arithmetic is the cgv-ai WASM
// module; decoding is WebCodecs through Mediabunny.
import { expose, transfer } from 'comlink';
import { AudioSampleSink, VideoSampleSink } from 'mediabunny';
import init, {
  Resampler16k,
  SceneScores,
  SoundAnalysis as Analysis,
  beats,
  scene_cuts,
  silences,
} from '../pkg/ai/cgv_ai';
import { openInput } from '../media/sources';
import type { MediaSourceRef } from '../media/types';
import { install, isInstalled, modelInfo, modelSize, removeModel, setModelBase } from './models';
import { hasWebGpu } from './runtime';
import type {
  AiApi,
  CaptionModel,
  SceneAnalysis,
  SceneSettings,
  SilenceSettings,
  SoundAnalysis,
  TranscribeRequest,
} from './types';
import { Whisper } from './whisper';

/** Frames are scored this many pixels wide: enough to see a cut, cheap to compare. */
const sceneWidth = 64;

const ready = init();
const cancelled = new Set<number>();
/** The speech model last used, kept loaded for the next job. */
let whisper: Whisper | null = null;

async function loadWhisper(id: CaptionModel, provider?: 'webgpu' | 'wasm'): Promise<Whisper> {
  const wanted = provider ?? ((await hasWebGpu()) ? 'webgpu' : 'wasm');
  if (whisper?.id === id && whisper.provider === wanted) return whisper;
  await whisper?.release();
  whisper = null;
  try {
    whisper = await Whisper.load(id, wanted);
  } catch (error) {
    if (wanted !== 'webgpu') throw error;
    console.warn('Whisper could not start on WebGPU; using the CPU:', error);
    whisper = await Whisper.load(id, 'wasm');
  }
  return whisper;
}

/** A medium's sound from `start` to `end` seconds, as 16 kHz mono. */
async function speech(
  source: MediaSourceRef,
  start: number,
  end: number,
  progress: (fraction: number) => void,
  check: () => void,
): Promise<Float32Array> {
  const input = await openInput(source);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('This clip has no sound to transcribe.');
    const resampler = new Resampler16k(await track.getSampleRate());
    const chunks: Float32Array[] = [];
    let first: number | null = null;
    try {
      for await (const sample of new AudioSampleSink(track).samples(start, end)) {
        try {
          check();
          first ??= sample.timestamp;
          const frames = sample.numberOfFrames;
          const channels = sample.numberOfChannels;
          const plane = new Float32Array(frames);
          const mono = new Float32Array(frames);
          for (let c = 0; c < channels; c++) {
            sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            for (let i = 0; i < frames; i++) mono[i] += plane[i] / channels;
          }
          chunks.push(resampler.push(mono));
          progress((sample.timestamp - start) / Math.max(1e-3, end - start));
        } finally {
          sample.close();
        }
      }
      chunks.push(resampler.finish());
    } finally {
      resampler.free();
    }
    const all = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    // Decoding starts at the packet holding `start`, which may begin earlier.
    const skip = Math.max(0, Math.round((start - (first ?? start)) * 16_000));
    return all.subarray(Math.min(skip, all.length));
  } finally {
    input.dispose();
  }
}

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

  async analyzeScenes(job: number, source: MediaSourceRef, onProgress: (fraction: number) => void) {
    await ready;
    const input = await openInput(source);
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return null;
      const duration = Math.max(await track.computeDuration(), 1e-3);
      const width = sceneWidth;
      const height = Math.max(
        8,
        Math.round((sceneWidth * track.displayHeight) / Math.max(1, track.displayWidth)),
      );
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      const scores = new SceneScores();
      const progress = throttle(onProgress);
      const times: number[] = [];
      try {
        // Software decoding: hardware decoders stall the GPU process when a file
        // ends, and playback shares it.
        const sink = new VideoSampleSink(track, { hardwareAcceleration: 'prefer-software' });
        for await (const sample of sink.samples()) {
          try {
            check(job);
            sample.draw(context, 0, 0, width, height);
            scores.push(new Uint8Array(context.getImageData(0, 0, width, height).data.buffer));
            times.push(sample.timestamp);
            progress((sample.timestamp + sample.duration) / duration);
          } finally {
            sample.close();
          }
        }
        progress(1);
        const result: SceneAnalysis = {
          times: Float64Array.from(times),
          scores: scores.scores(),
          skips: scores.skips(),
        };
        return transfer(result, [result.times.buffer, result.scores.buffer, result.skips.buffer]);
      } finally {
        scores.free();
      }
    } finally {
      cancelled.delete(job);
      input.dispose();
    }
  },

  async sceneCuts(analysis: SceneAnalysis, settings: SceneSettings) {
    await ready;
    const frames = scene_cuts(
      analysis.scores,
      analysis.skips,
      analysis.times,
      settings.ratio,
      settings.minScore,
      settings.minLength,
    );
    return Array.from(frames, (frame) => analysis.times[frame]);
  },

  async modelState(id: CaptionModel) {
    await ready;
    const model = modelInfo(id);
    return {
      id,
      name: model.name,
      license: model.license,
      bytes: modelSize(model),
      installed: await isInstalled(model),
    };
  },

  async installModel(job: number, id: CaptionModel, onProgress: (fraction: number) => void) {
    await ready;
    try {
      await install(modelInfo(id), throttle(onProgress), () => check(job));
    } finally {
      cancelled.delete(job);
    }
  },

  async removeModel(id: CaptionModel) {
    if (whisper?.id === id) {
      await whisper.release();
      whisper = null;
    }
    await removeModel(modelInfo(id));
  },

  async setModelBase(url: string | null) {
    setModelBase(url);
  },

  async transcribe(
    job: number,
    source: MediaSourceRef,
    request: TranscribeRequest,
    onProgress: (fraction: number) => void,
  ) {
    await ready;
    const model = modelInfo(request.model);
    try {
      if (!(await isInstalled(model))) throw new Error(`${model.name} is not downloaded yet.`);
      const progress = throttle(onProgress);
      const samples = await speech(
        source,
        request.start,
        request.end,
        (fraction) => progress(0.05 * fraction),
        () => check(job),
      );
      const run = (speaker: Whisper) =>
        speaker.run(
          samples,
          request.language,
          (fraction) => progress(0.05 + 0.95 * fraction),
          () => check(job),
        );
      let speaker = await loadWhisper(request.model);
      let transcript;
      try {
        transcript = await run(speaker);
      } catch (error) {
        // A lost or failing GPU: the CPU gives the same words, more slowly.
        if ((error as Error).name === 'AbortError' || speaker.provider !== 'webgpu') throw error;
        console.warn('Whisper failed on WebGPU; trying the CPU:', error);
        speaker = await loadWhisper(request.model, 'wasm');
        transcript = await run(speaker);
      }
      const shift = (time: number) => time + request.start;
      progress(1);
      return {
        language: transcript.language,
        provider: speaker.provider,
        segments: transcript.segments.map((segment) => ({
          ...segment,
          start: shift(segment.start),
          end: shift(segment.end),
          words: segment.words.map((word) => ({
            ...word,
            start: shift(word.start),
            end: shift(word.end),
          })),
        })),
      };
    } finally {
      cancelled.delete(job);
    }
  },

  cancel(job: number) {
    cancelled.add(job);
  },
};
expose(api);

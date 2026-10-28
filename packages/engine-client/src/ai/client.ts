import { proxy, releaseProxy, wrap } from 'comlink';
import type { MediaSourceRef } from '../media/types';
import type {
  AiApi,
  BeatAnalysis,
  CaptionModel,
  ModelState,
  TranscribeRequest,
  Transcript,
  SceneAnalysis,
  SceneSettings,
  SilenceSettings,
  SoundAnalysis,
} from './types';

/** True for the error a cancelled AI job rejects with. */
export function isCancelled(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Starts the AI worker. Jobs report progress from 0 to 1 and stop when their
 * signal aborts.
 */
export function createAiClient() {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'cgv-ai',
  });
  const api = wrap<AiApi>(worker);
  let next = 1;

  async function run<T>(signal: AbortSignal | undefined, job: (id: number) => Promise<T>) {
    const id = next++;
    const abort = () => void api.cancel(id);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort);
    try {
      return await job(id);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  return {
    analyzeSound(
      source: MediaSourceRef,
      onProgress: (fraction: number) => void,
      signal?: AbortSignal,
    ): Promise<SoundAnalysis | null> {
      return run(signal, (id) => api.analyzeSound(id, source, proxy(onProgress)));
    },
    silences(analysis: SoundAnalysis, settings: SilenceSettings): Promise<[number, number][]> {
      return api.silences(analysis, settings);
    },
    beats(analysis: SoundAnalysis): Promise<BeatAnalysis> {
      return api.beats(analysis);
    },
    analyzeScenes(
      source: MediaSourceRef,
      onProgress: (fraction: number) => void,
      signal?: AbortSignal,
    ): Promise<SceneAnalysis | null> {
      return run(signal, (id) => api.analyzeScenes(id, source, proxy(onProgress)));
    },
    sceneCuts(analysis: SceneAnalysis, settings: SceneSettings): Promise<number[]> {
      return api.sceneCuts(analysis, settings);
    },
    modelState(id: CaptionModel): Promise<ModelState> {
      return api.modelState(id);
    },
    installModel(id: CaptionModel, onProgress: (fraction: number) => void, signal?: AbortSignal) {
      return run(signal, (job) => api.installModel(job, id, proxy(onProgress)));
    },
    removeModel(id: CaptionModel): Promise<void> {
      return api.removeModel(id);
    },
    setModelBase(url: string | null): Promise<void> {
      return api.setModelBase(url);
    },
    transcribe(
      source: MediaSourceRef,
      request: TranscribeRequest,
      onProgress: (fraction: number) => void,
      signal?: AbortSignal,
    ): Promise<Transcript & { provider: 'webgpu' | 'wasm' }> {
      return run(signal, (job) => api.transcribe(job, source, request, proxy(onProgress)));
    },
    dispose() {
      api[releaseProxy]();
      worker.terminate();
    },
  };
}
export type AiClient = ReturnType<typeof createAiClient>;

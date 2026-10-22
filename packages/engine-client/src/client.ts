import { releaseProxy, transfer, wrap } from 'comlink';
import type { EngineApi, EngineEvent, FrameStats, InitOptions } from './types';

export interface EngineClient {
  api: ReturnType<typeof wrap<EngineApi>>;
  init(canvas: OffscreenCanvas, options: InitOptions): ReturnType<EngineApi['init']>;
  /** Receives frame stats from the worker's render loop (about ten times a second). */
  onStats(listener: ((stats: FrameStats) => void) | null): void;
  /** Proves this page and the worker share memory (needs cross-origin isolation). */
  checkSharedMemory(): Promise<boolean>;
  dispose(): void;
}

/** Starts an engine worker. `onError` reports fatal errors (worker crash, GPU loss, Rust panic). */
export function createEngineClient(onError: (message: string) => void): EngineClient {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'cgv-engine',
  });
  const api = wrap<EngineApi>(worker);
  let disposed = false;
  let statsListener: ((stats: FrameStats) => void) | null = null;
  worker.addEventListener('message', (event: MessageEvent<EngineEvent | undefined>) => {
    if (disposed || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'engine-fatal') onError(event.data.message);
    else if (event.data.type === 'engine-stats') {
      const { frames, presented, width, height } = event.data;
      statsListener?.({ frames, presented, width, height });
    }
  });
  worker.addEventListener('error', (event) => {
    event.preventDefault();
    if (!disposed) onError(event.message || 'The engine worker stopped unexpectedly.');
  });
  worker.addEventListener('messageerror', () => {
    if (!disposed) onError('Could not read an engine response.');
  });
  return {
    api,
    init(canvas, options) {
      return api.init(transfer(canvas, [canvas]), options);
    },
    onStats(listener) {
      statsListener = listener;
    },
    async checkSharedMemory() {
      if (typeof SharedArrayBuffer !== 'function' || !crossOriginIsolated) return false;
      const buffer = new SharedArrayBuffer(4);
      const value = 0x0c95;
      await api.touchSharedMemory(buffer, value);
      return Atomics.load(new Int32Array(buffer), 0) === value;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      statsListener = null;
      // A crashed WASM instance may never answer RPC. Always terminate its worker.
      const timer = setTimeout(() => worker.terminate(), 200);
      void api
        .dispose()
        .catch(() => {})
        .finally(() => {
          clearTimeout(timer);
          api[releaseProxy]();
          worker.terminate();
        });
    },
  };
}

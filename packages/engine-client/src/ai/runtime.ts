import * as ort from 'onnxruntime-web/webgpu';
import mjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { shimNestedWorkers } from '../nested-worker';

// ONNX Runtime Web in the AI worker: the WebGPU build, which also runs models on
// the CPU through WASM. Its script and WASM are files of their own (see the
// Vite config), so its threads can start from them. Its threads are workers
// this worker starts, so they start through the nested-worker shim.

export type Provider = 'webgpu' | 'wasm';

let configured = false;

function configure() {
  if (configured) return;
  configured = true;
  shimNestedWorkers();
  ort.env.wasm.wasmPaths = { mjs: mjsUrl, wasm: wasmUrl };
  // Half the cores: the engine and the decoders need the rest.
  ort.env.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) >> 1));
  ort.env.logLevel = 'error';
}

/**
 * Whether this worker can reach a hardware WebGPU adapter. A fallback one
 * (SwiftShader) runs models far slower than the CPU path does.
 */
export async function hasWebGpu(): Promise<boolean> {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    const info = adapter?.info as (GPUAdapterInfo & { isFallbackAdapter?: boolean }) | undefined;
    return !!adapter && !info?.isFallbackAdapter;
  } catch {
    return false;
  }
}

/**
 * A session for model bytes on `provider`. On WebGPU, outputs named in
 * `onGpu` stay in GPU buffers (to feed the next run), and the caller disposes them.
 */
export async function createSession(
  bytes: Uint8Array,
  provider: Provider,
  onGpu: string[] = [],
): Promise<ort.InferenceSession> {
  configure();
  return ort.InferenceSession.create(bytes, {
    executionProviders: [provider],
    graphOptimizationLevel: 'all',
    ...(provider === 'webgpu' && onGpu.length
      ? {
          preferredOutputLocation: Object.fromEntries(
            onGpu.map((name) => [name, 'gpu-buffer' as const]),
          ),
        }
      : {}),
  });
}

export { ort };

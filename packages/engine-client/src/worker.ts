import { expose } from 'comlink';
import { FrameLoop, workerScheduler } from './frame-loop';
import type { EngineApi, EngineEvent, EngineInfo, GpuFault, InitOptions } from './types';
import initWasm, { Engine } from './pkg/cgv_wasm';

let engine: Engine | undefined;
let loop: FrameLoop | undefined;
let initializing = false;
let disposed = false;
let diagnostic = false;

function post(event: EngineEvent) {
  self.postMessage(event);
}
function fatal(message: string) {
  loop?.stop();
  post({ type: 'engine-fatal', message });
}

// Worker-local fault injection lets browser tests exercise the real Rust
// fallback path without changing browser flags or the renderer policy.
function simulateGpuFailure(fault: GpuFault) {
  const gpu = Reflect.get(navigator, 'gpu') as
    { requestAdapter: (...args: unknown[]) => Promise<object | null> } | undefined;
  if (!gpu) throw new Error('GPU failure diagnostics require the WebGPU API');
  const requestAdapter = gpu.requestAdapter.bind(gpu);
  Object.defineProperty(gpu, 'requestAdapter', {
    value: async (...args: unknown[]) => {
      if (fault === 'adapter') return null;
      const adapter = await requestAdapter(...args);
      if (adapter)
        Object.defineProperty(adapter, 'requestDevice', {
          value: () => Promise.reject(new Error('Diagnostic device request failure')),
        });
      return adapter;
    },
  });
}

const api: EngineApi = {
  async init(canvas: OffscreenCanvas, options: InitOptions): Promise<EngineInfo> {
    if (engine || initializing || disposed)
      throw new Error('Engine worker cannot be initialized twice');
    initializing = true;
    diagnostic = options.diagnostic;
    if (diagnostic && options.simulateGpuFailure) simulateGpuFailure(options.simulateGpuFailure);
    await initWasm({ module_or_path: new URL('./pkg/cgv_wasm_bg.wasm', import.meta.url) });
    const created = await Engine.create(canvas, options.backend, fatal);
    if (disposed) {
      created.dispose();
      created.free();
      throw new Error('Engine disposed during initialization');
    }
    engine = created;
    const backend = engine.backend();
    if (backend !== 'WebGPU' && backend !== 'WebGL2')
      throw new Error('Unexpected GPU backend: ' + backend);
    const running = engine;
    loop = new FrameLoop(
      {
        resize: (size) => running.resize(size.width, size.height),
        frame: (now) => ({
          presented: running.frame(now),
          frames: running.frames(),
          width: running.width(),
          height: running.height(),
        }),
      },
      workerScheduler(),
      (stats) => post({ type: 'engine-stats', ...stats }),
      fatal,
    );
    loop.start({ width: options.width, height: options.height });
    return { backend, adapter: engine.adapter_name() };
  },
  resize(size) {
    if (!disposed) loop?.resize(size);
  },
  touchSharedMemory(buffer, value) {
    const view = new Int32Array(buffer);
    Atomics.store(view, 0, value);
    Atomics.notify(view, 0);
  },
  dispose() {
    disposed = true;
    loop?.stop();
    loop = undefined;
    engine?.dispose();
    engine?.free();
    engine = undefined;
  },
  diagnosticFault(kind) {
    if (!diagnostic || !engine) throw new Error('Diagnostics are disabled');
    if (kind === 'device-loss') engine.diagnostic_device_loss();
    else engine.diagnostic_panic();
  },
};
expose(api);

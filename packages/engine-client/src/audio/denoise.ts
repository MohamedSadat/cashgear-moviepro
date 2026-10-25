/**
 * Noise reduction: RNNoise in a WASM module of its own, run in a worker of its
 * own that starts the first time a clip asks for it. The mixer reads a clip's
 * cleaned sound as blocks of `<media>#nr`; this turns decoded source sound into
 * those blocks without holding up the thread that asked.
 */

/** Media keys ending with this are a medium's noise-reduced sound. */
const suffix = '#nr';
/** Seconds of sound the denoiser hears before a block, so blocks join closely. */
export const denoiseLeadIn = 1;

type Reply = { id: number; data: Float32Array } | { id: number; error: string };

let worker: Worker | null = null;
let next = 0;
const waiting = new Map<
  number,
  { resolve(data: Float32Array): void; reject(error: Error): void }
>();

function start(): Worker {
  if (worker) return worker;
  const started = new Worker(new URL('./denoise-worker.ts', import.meta.url), {
    type: 'module',
    name: 'cgv-denoise',
  });
  started.onmessage = (event: MessageEvent<Reply>) => {
    const reply = event.data;
    const request = waiting.get(reply.id);
    waiting.delete(reply.id);
    if ('error' in reply) request?.reject(new Error(reply.error));
    else request?.resolve(reply.data);
  };
  started.onerror = (event) => {
    event.preventDefault();
    for (const request of waiting.values())
      request.reject(new Error(event.message || 'The noise reduction worker stopped'));
    waiting.clear();
    worker = null;
  };
  worker = started;
  return started;
}

export function isDenoised(key: string) {
  return key.endsWith(suffix);
}

/** The medium a block key reads from. */
export function sourceOf(key: string) {
  return isDenoised(key) ? key.slice(0, -suffix.length) : key;
}

/**
 * Cleans planar sound (`channels` planes at `rate`); resolves to it planar at
 * 48 kHz, starting at the same moment. `data` is handed over to the worker.
 */
export function denoise(
  rate: number,
  channels: number,
  data: Float32Array,
): Promise<{ rate: number; data: Float32Array }> {
  const id = next++;
  return new Promise<Float32Array>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    start().postMessage({ id, rate, channels, data }, [data.buffer]);
  }).then((clean) => ({ rate: 48_000, data: clean }));
}

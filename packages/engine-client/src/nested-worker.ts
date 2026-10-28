/// <reference lib="webworker" />
// Workers started by a worker. WebView2 never asks the desktop's asset server
// for a nested worker's script, so a worker started from a worker by its URL
// never loads there. Imports and fetches from any worker do reach the server,
// so a nested worker starts from a one-line blob module that imports its
// script. The script keeps its own `import.meta.url`, so the files beside it
// resolve as before.

const shims = new Map<string, string>();

/** A blob module that runs the module script at `url`, made once per script. */
function shimFor(url: string | URL): string {
  const href = new URL(url, self.location.href).href;
  if (href.startsWith('blob:') || href.startsWith('data:')) return href;
  let shim = shims.get(href);
  if (!shim) {
    shim = URL.createObjectURL(
      new Blob([`import ${JSON.stringify(href)};`], { type: 'text/javascript' }),
    );
    shims.set(href, shim);
  }
  return shim;
}

/** Starts a module worker from inside a worker. */
export function startNestedWorker(url: string | URL, options: WorkerOptions = {}): Worker {
  return new Worker(shimFor(url), { ...options, type: 'module' });
}

/**
 * Starts every module worker this worker starts through the shim, for libraries
 * that start their own (ONNX Runtime's threads). Classic workers are left alone.
 */
export function shimNestedWorkers() {
  const Native = self.Worker as typeof Worker & { shimmed?: true };
  if (Native.shimmed) return;
  self.Worker = class extends Native {
    static shimmed = true as const;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(options?.type === 'module' ? shimFor(url) : url, options);
    }
  };
}

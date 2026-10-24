import { proxy, releaseProxy, wrap } from 'comlink';
import { opfsExportFolder } from './targets';
import type {
  ExportJob,
  ExportProgress,
  ExportResult,
  ExportTarget,
  ExportWorkerApi,
} from './types';

export interface RunningExport {
  /** Resolves when the file is written; rejects with an `AbortError` when cancelled. */
  result: Promise<ExportResult>;
  cancel(): void;
}

export interface ExportHandlers {
  progress(progress: ExportProgress): void;
  /** Desktop (`sink` target): writes `data` at byte `position` of the native file. */
  write?(position: number, data: Uint8Array): Promise<void>;
}

/** Starts an export in a fresh worker, which is terminated when it ends. */
export function startExport(
  job: ExportJob,
  target: ExportTarget,
  handlers: ExportHandlers,
): RunningExport {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'cgv-export',
  });
  const api = wrap<ExportWorkerApi>(worker);
  const crashed = new Promise<never>((_, reject) => {
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      reject(new Error(event.message || 'The export worker stopped unexpectedly.'));
    });
  });
  const events = proxy({
    progress: (progress: ExportProgress) => handlers.progress(progress),
    write:
      handlers.write && ((position: number, data: Uint8Array) => handlers.write!(position, data)),
  });
  const result = Promise.race([api.run(job, target, events), crashed]).finally(() => {
    api[releaseProxy]();
    worker.terminate();
  });
  return {
    result,
    cancel: () => void api.cancel().catch(() => {}),
  };
}

async function exportFolder() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(opfsExportFolder, { create: true });
}

/**
 * Downloads an export written to OPFS (`opfs` target) under `name`. The copy
 * stays in OPFS until the next export, so the download can finish reading it.
 */
export async function downloadOpfsExport(name: string, downloadName = name): Promise<void> {
  const file = await (await (await exportFolder()).getFileHandle(name)).getFile();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = downloadName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 120_000);
}

/** Removes earlier exports from OPFS (their downloads have long finished). */
export async function clearOpfsExports(): Promise<void> {
  const folder = await exportFolder();
  const names: string[] = [];
  for await (const name of (folder as unknown as { keys(): AsyncIterable<string> }).keys())
    names.push(name);
  for (const name of names) await folder.removeEntry(name).catch(() => {});
}

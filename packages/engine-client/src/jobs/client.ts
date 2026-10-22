import { releaseProxy, wrap } from 'comlink';
import type { JobsApi } from './types';

/** Starts the background jobs worker (thumbnails, waveforms). */
export function createJobsClient() {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'cgv-jobs',
  });
  const api = wrap<JobsApi>(worker);
  return {
    api,
    dispose() {
      api[releaseProxy]();
      worker.terminate();
    },
  };
}
export type JobsClient = ReturnType<typeof createJobsClient>;

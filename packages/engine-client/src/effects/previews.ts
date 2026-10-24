import { releaseProxy, wrap } from 'comlink';
import type { Params } from '../project/types';
import type { EffectKind } from './types';

/** One browser item to preview: an effect on a sample picture, or a transition between two. */
export interface PreviewRequest {
  type: EffectKind;
  pack: string;
  kind: string;
  params: Params;
  /** The LUT setting to point at a built-in look, for LUT effects. */
  lut?: string;
  /** Transitions: how far along to show (0.5 by default). */
  progress?: number;
}

export interface PreviewWorkerApi {
  render(requests: PreviewRequest[], size: { width: number; height: number }): Promise<(Blob | null)[]>;
}

/**
 * Renders previews in a fresh worker with its own engine, terminated when done.
 * Each image is a WebP, or null when its effect could not be drawn.
 */
export async function renderPreviews(
  requests: PreviewRequest[],
  size: { width: number; height: number } = { width: 160, height: 90 },
): Promise<(Blob | null)[]> {
  const worker = new Worker(new URL('./preview-worker.ts', import.meta.url), {
    type: 'module',
    name: 'cgv-previews',
  });
  const api = wrap<PreviewWorkerApi>(worker);
  const crashed = new Promise<never>((_, reject) =>
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      reject(new Error(event.message || 'The preview worker stopped unexpectedly.'));
    }),
  );
  try {
    return await Promise.race([api.render(requests, size), crashed]);
  } finally {
    api[releaseProxy]();
    worker.terminate();
  }
}

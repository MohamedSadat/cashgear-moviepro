import type { MediaSourceRef } from '../media/types';
import { transaction } from './database';

/**
 * Where the browser keeps a media file: a File System Access handle or an OPFS
 * copy, by media id. Plain Files are never stored (they become OPFS copies).
 * Desktop entries (`url`) are Phase 1 leftovers, moved into a project on first start.
 */
export interface StoredMedia {
  id: string;
  order: number;
  source: Exclude<MediaSourceRef, { kind: 'file' }>;
}

/** Media sources remembered across reloads: one IndexedDB record per item. */
export const mediaStore = {
  async list(): Promise<StoredMedia[]> {
    const all = await transaction<StoredMedia[]>('media', 'readonly', (store) => store.getAll());
    return all.sort((a, b) => a.order - b.order);
  },
  async get(id: string): Promise<StoredMedia | null> {
    return (
      (await transaction<StoredMedia | undefined>('media', 'readonly', (store) => store.get(id))) ??
      null
    );
  },
  async put(entry: StoredMedia) {
    await transaction('media', 'readwrite', (store) => store.put(entry));
  },
  async remove(id: string) {
    await transaction('media', 'readwrite', (store) => store.delete(id));
  },
};

import type { MediaSourceRef } from '../media/types';

/** A library entry remembered across reloads. Plain Files are never stored (they become OPFS copies). */
export interface StoredMedia {
  id: string;
  order: number;
  source: Exclude<MediaSourceRef, { kind: 'file' }>;
}

const databaseName = 'cashgear-video';
const storeName = 'media';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(database.transaction(storeName, mode).objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

/** The media library's persistence: one IndexedDB record per item, in import order. */
export const mediaStore = {
  async list(): Promise<StoredMedia[]> {
    const all = await transaction<StoredMedia[]>('readonly', (store) => store.getAll());
    return all.sort((a, b) => a.order - b.order);
  },
  async put(entry: StoredMedia) {
    await transaction('readwrite', (store) => store.put(entry));
  },
  async remove(id: string) {
    await transaction('readwrite', (store) => store.delete(id));
  },
};

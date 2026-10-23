const databaseName = 'cashgear-video';
/** 1: the media library (Phase 1). 2: adds the project list. */
const version = 2;
export type StoreName = 'media' | 'projects';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const name of ['media', 'projects'])
        if (!database.objectStoreNames.contains(name))
          database.createObjectStore(name, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      // Let a newer tab upgrade instead of blocking it.
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Runs one request in its own transaction and closes the database after. */
export async function transaction<T>(
  name: StoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(database.transaction(name, mode).objectStore(name));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

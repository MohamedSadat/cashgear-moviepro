/** Derived data (thumbnails, waveform peaks) keyed by path-like strings. */
export interface CacheStore {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  remove(prefix: string): Promise<void>;
}

export function validateCacheKey(key: string): string[] {
  const parts = key.split('/');
  if (!parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== '.' && part !== '..'))
    throw new Error(`Invalid cache key: ${key}`);
  return parts;
}

async function directory(parts: string[], create: boolean) {
  let current = await navigator.storage.getDirectory();
  for (const part of ['cache', ...parts])
    current = await current.getDirectoryHandle(part, { create });
  return current;
}

/** The web cache: files under `cache/` in the origin-private file system. */
export function opfsCacheStore(): CacheStore {
  return {
    async read(key) {
      const parts = validateCacheKey(key);
      const name = parts.pop()!;
      try {
        const file = await (await (await directory(parts, false)).getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch {
        return null;
      }
    },
    async write(key, bytes) {
      const parts = validateCacheKey(key);
      const name = parts.pop()!;
      const handle = await (await directory(parts, true)).getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes as Uint8Array<ArrayBuffer>);
      await writable.close();
    },
    async remove(prefix) {
      const parts = validateCacheKey(prefix);
      const name = parts.pop()!;
      try {
        await (await directory(parts, false)).removeEntry(name, { recursive: true });
      } catch {
        /* Nothing cached under this prefix. */
      }
    },
  };
}

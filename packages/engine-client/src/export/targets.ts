import { transfer } from 'comlink';
import type { StreamTargetChunk } from 'mediabunny';
import type { ExportEvents, ExportTarget } from './types';

/** An export file being written. */
export interface OpenTarget {
  writable: WritableStream<StreamTargetChunk>;
  /** The file's size so far. */
  bytes(): number;
  /** Lets the next close keep the file; until then, closing drops what was written. */
  commit(): void;
  /** Drops the partial file (after a failure or a cancel). */
  discard(): Promise<void>;
}

/** The folder in OPFS for exports on their way to a download. */
export const opfsExportFolder = 'exports';

type SyncAccessHandle = {
  write(data: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
};

function sizeTracker() {
  let size = 0;
  return {
    grow: (chunk: StreamTargetChunk) =>
      (size = Math.max(size, chunk.position + chunk.data.byteLength)),
    get: () => size,
  };
}

/** Opens `target` in the export worker. */
export async function openTarget(target: ExportTarget, events: ExportEvents): Promise<OpenTarget> {
  const size = sizeTracker();
  let committed = false;
  switch (target.kind) {
    case 'handle': {
      const handle = target.handle;
      // A file the picker just created is empty; an existing one keeps its old
      // contents if the export fails, because writes go to a swap file until close.
      const existed = (await handle.getFile()).size > 0;
      const stream = await handle.createWritable();
      let open = true;
      const abort = async () => {
        if (!open) return;
        open = false;
        await stream.abort().catch(() => {});
      };
      return {
        writable: new WritableStream<StreamTargetChunk>({
          write: (chunk) => {
            size.grow(chunk);
            return stream.write(chunk);
          },
          close: async () => {
            if (!committed) return abort();
            open = false;
            await stream.close();
          },
          abort,
        }),
        bytes: size.get,
        commit: () => (committed = true),
        async discard() {
          await abort();
          const removable = handle as FileSystemFileHandle & { remove?(): Promise<void> };
          if (!existed) await removable.remove?.().catch(() => {});
        },
      };
    }
    case 'opfs': {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle(opfsExportFolder, { create: true });
      const file = await folder.getFileHandle(target.name, { create: true });
      const access = await (
        file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> }
      ).createSyncAccessHandle();
      access.truncate(0);
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        access.flush();
        access.close();
      };
      return {
        writable: new WritableStream<StreamTargetChunk>({
          write: (chunk) => {
            size.grow(chunk);
            access.write(chunk.data, { at: chunk.position });
          },
          close,
          abort: close,
        }),
        bytes: size.get,
        commit: () => (committed = true),
        async discard() {
          close();
          await folder.removeEntry(target.name).catch(() => {});
        },
      };
    }
    case 'sink': {
      const write = events.write;
      if (!write) throw new Error('The desktop export has nowhere to write');
      return {
        writable: new WritableStream<StreamTargetChunk>({
          write: async (chunk) => {
            size.grow(chunk);
            // Mediabunny may hand out views of one buffer: send a copy of its own.
            const data = chunk.data.slice();
            await write(chunk.position, transfer(data, [data.buffer]));
          },
        }),
        bytes: size.get,
        commit: () => (committed = true),
        // The page removes the native file.
        discard: async () => {},
      };
    }
  }
}

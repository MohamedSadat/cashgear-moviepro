import {
  mediaStore,
  opfsCacheStore,
  type ImportRequest,
  type MediaSourceRef,
} from '@cgv/engine-client';
import { mediaAccept, newMediaId, type MediaPlatform } from '@cgv/ui';

type PermissionedHandle = FileSystemFileHandle & {
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
};
type OpenFilePicker = (options: {
  multiple: boolean;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle[]>;
type HandleItem = DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> };

const cache = opfsCacheStore();
/** Remembered handles the browser wants permission for again, waiting for a click. */
let waitingHandles: { id: string; handle: PermissionedHandle }[] = [];

function pickWithInput(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = Object.values(mediaAccept).flat().join(',');
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

async function removeOpfsCopy(path: string) {
  // OPFS copies live at media/<id>/<name>; remove the item's folder.
  const [root, id] = path.split('/');
  if (root !== 'media' || !id) return;
  try {
    const media = await (await navigator.storage.getDirectory()).getDirectoryHandle('media');
    await media.removeEntry(id, { recursive: true });
  } catch {
    /* Already gone. */
  }
}

/**
 * The browser: File System Access handles where available (Chrome, Edge), with
 * files copied into OPFS elsewhere. The library is remembered in IndexedDB.
 */
export const webPlatform: MediaPlatform = {
  kind: 'web',

  async pickFiles() {
    const picker = Reflect.get(window, 'showOpenFilePicker') as OpenFilePicker | undefined;
    if (picker) {
      try {
        const handles = await picker({
          multiple: true,
          types: [{ description: 'Video, audio and images', accept: mediaAccept }],
        });
        return handles.map((handle) => ({ id: newMediaId(), source: { kind: 'handle', handle } }));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return [];
        throw error;
      }
    }
    const files = await pickWithInput();
    return files.map((file) => ({ id: newMediaId(), source: { kind: 'file', file } }));
  },

  async fromDrop(data) {
    const requests: ImportRequest[] = [];
    const items = [...data.items].filter((item) => item.kind === 'file') as HandleItem[];
    // Ask for every handle before awaiting any: the DataTransfer is only valid during the event.
    const pending = items.map((item) => ({
      handle: item.getAsFileSystemHandle?.() ?? Promise.resolve(null),
      file: item.getAsFile(),
    }));
    for (const { handle, file } of pending) {
      const resolved = await handle.catch(() => null);
      if (resolved?.kind === 'file')
        requests.push({
          id: newMediaId(),
          source: { kind: 'handle', handle: resolved as FileSystemFileHandle },
        });
      else if (file) requests.push({ id: newMediaId(), source: { kind: 'file', file } });
    }
    return requests;
  },

  async restore() {
    const ready: ImportRequest[] = [];
    waitingHandles = [];
    for (const entry of await mediaStore.list()) {
      if (entry.source.kind === 'handle') {
        const handle = entry.source.handle as PermissionedHandle;
        const permission = await handle.queryPermission({ mode: 'read' }).catch(() => 'denied');
        if (permission === 'granted') ready.push({ id: entry.id, source: entry.source });
        else waitingHandles.push({ id: entry.id, handle });
      } else if (entry.source.kind === 'opfs') ready.push({ id: entry.id, source: entry.source });
    }
    return { ready, waiting: waitingHandles.length };
  },

  async grantAccess() {
    const granted: ImportRequest[] = [];
    const stillWaiting: typeof waitingHandles = [];
    for (const entry of waitingHandles) {
      const permission = await entry.handle
        .requestPermission({ mode: 'read' })
        .catch(() => 'denied');
      if (permission === 'granted')
        granted.push({ id: entry.id, source: { kind: 'handle', handle: entry.handle } });
      else stillWaiting.push(entry);
    }
    waitingHandles = stillWaiting;
    return granted;
  },

  async remember(entries) {
    const base = Date.now();
    for (const [index, { id, source }] of entries.entries()) {
      if (source.kind === 'handle' || source.kind === 'opfs')
        await mediaStore.put({ id, order: base + index, source });
    }
  },

  async forget(id: string, source: MediaSourceRef) {
    await mediaStore.remove(id);
    await cache.remove(`media/${id}`);
    if (source.kind === 'opfs') await removeOpfsCopy(source.path);
  },

  cache,
  nativeInfo: async () => undefined,
};

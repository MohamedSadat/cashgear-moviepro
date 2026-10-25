import {
  clearOpfsExports,
  downloadOpfsExport,
  mediaStore,
  opfsCacheStore,
  opfsProjectFiles,
  projectIndex,
  type ImportRequest,
  type MediaRef,
  type MediaSourceRef,
  type ProjectEntry,
} from '@cgv/engine-client';
import {
  mediaAccept,
  newMediaId,
  type ExportChoice,
  type ExportDestination,
  type MediaPlatform,
  type ProjectStore,
} from '@cgv/ui';

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

type SaveFilePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

const filePicker = () => Reflect.get(window, 'showOpenFilePicker') as OpenFilePicker | undefined;
const savePicker = () => Reflect.get(window, 'showSaveFilePicker') as SaveFilePicker | undefined;

/**
 * Where an export goes: straight into a file picked in the save dialog (Chrome,
 * Edge), or into OPFS and then the browser's downloads.
 */
async function chooseExport({
  fileName,
  format,
  download,
}: ExportChoice): Promise<ExportDestination | null> {
  const picker = savePicker();
  if (picker && !download) {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({
        suggestedName: fileName,
        types: [
          { description: format.label, accept: { [format.mimeType]: ['.' + format.extension] } },
        ],
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
    return {
      target: { kind: 'handle', handle },
      name: handle.name,
      finish: async () => handle.name,
      // The worker drops what it wrote.
      discard: async () => {},
    };
  }
  // Earlier exports' downloads have finished long ago.
  await clearOpfsExports();
  const stored = `${crypto.randomUUID()}.${format.extension}`;
  return {
    target: { kind: 'opfs', name: stored },
    name: fileName,
    async finish() {
      await downloadOpfsExport(stored, fileName);
      return 'Downloads';
    },
    discard: async () => {},
  };
}

function pickWithInput(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = accept;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

/** Handles from the File System Access picker, or null where the browser has none. */
async function pickHandles(
  description: string,
  accept: Record<string, string[]>,
  multiple: boolean,
): Promise<FileSystemFileHandle[] | null> {
  const picker = filePicker();
  if (!picker) return null;
  try {
    return await picker({ multiple, types: [{ description, accept }] });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return [];
    throw error;
  }
}

async function permitted(handle: PermissionedHandle) {
  return (await handle.queryPermission({ mode: 'read' }).catch(() => 'denied')) === 'granted';
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

async function forget(id: string, source: MediaSourceRef | null) {
  const stored = source ?? (await mediaStore.get(id))?.source ?? null;
  await mediaStore.remove(id);
  await cache.remove(`media/${id}`);
  if (stored?.kind === 'opfs') await removeOpfsCopy(stored.path);
}

/** Projects in the origin-private file system, listed in IndexedDB. */
const projects: ProjectStore = {
  savesInPlace: true,
  list: () => projectIndex.list(),
  async read(entry) {
    return (await opfsProjectFiles.read(entry.id, 'project'))?.text ?? null;
  },
  async save(entry, text) {
    await opfsProjectFiles.write(entry.id, 'project', text);
    const saved: ProjectEntry = {
      id: entry.id,
      name: entry.name,
      savedAt: Date.now(),
      openedAt: entry.openedAt,
    };
    await projectIndex.put(saved);
    return saved;
  },
  readAutosave: (id) => opfsProjectFiles.read(id, 'autosave'),
  writeAutosave: (id, text) => opfsProjectFiles.write(id, 'autosave', text),
  removeAutosave: (id) => opfsProjectFiles.remove(id, 'autosave'),
  touch: (entry) => projectIndex.put({ ...entry, openedAt: Date.now() }),
  async remove(id) {
    await opfsProjectFiles.removeAll(id);
    await projectIndex.remove(id);
  },
  async openFile() {
    const accept = { 'application/json': ['.cgvproj'] };
    const handles = await pickHandles('CashGear Video project', accept, false);
    const file = handles
      ? await handles[0]?.getFile()
      : (await pickWithInput('.cgvproj', false))[0];
    return file ? { text: await file.text() } : null;
  },
  async exportFile(name, text) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    link.download = `${name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Untitled project'}.cgvproj`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  },
};

/**
 * The browser: File System Access handles where available (Chrome, Edge), with
 * files copied into OPFS elsewhere, remembered by media id in IndexedDB. Projects
 * live in browser storage.
 */
export const webPlatform: MediaPlatform = {
  kind: 'web',
  projects,

  async pickFiles() {
    const handles = await pickHandles('Video, audio and images', mediaAccept, true);
    if (handles)
      return handles.map((handle) => ({ id: newMediaId(), source: { kind: 'handle', handle } }));
    const files = await pickWithInput(Object.values(mediaAccept).flat().join(','), true);
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

  async locate(media: MediaRef[]) {
    const ready: ImportRequest[] = [];
    const missing: string[] = [];
    waitingHandles = [];
    for (const ref of media) {
      const entry = await mediaStore.get(ref.id);
      if (!entry || entry.source.kind === 'url' || entry.source.kind === 'pack')
        missing.push(ref.id);
      else if (entry.source.kind === 'opfs') ready.push({ id: ref.id, source: entry.source });
      else {
        const handle = entry.source.handle as PermissionedHandle;
        if (await permitted(handle)) ready.push({ id: ref.id, source: entry.source });
        else waitingHandles.push({ id: ref.id, handle });
      }
    }
    return { ready, waiting: waitingHandles.length, missing };
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

  async legacyMedia() {
    const ready: ImportRequest[] = [];
    for (const entry of await mediaStore.list()) {
      if (entry.source.kind === 'opfs') ready.push({ id: entry.id, source: entry.source });
      else if (
        entry.source.kind === 'handle' &&
        (await permitted(entry.source.handle as PermissionedHandle))
      )
        ready.push({ id: entry.id, source: entry.source });
    }
    return ready;
  },

  // The Phase 1 records are the ones projects use now.
  clearLegacy: async () => {},

  async remember(entries) {
    const base = Date.now();
    for (const [index, { id, source }] of entries.entries()) {
      if (source.kind === 'handle' || source.kind === 'opfs')
        await mediaStore.put({ id, order: base + index, source });
    }
  },

  forget,

  async sweep(keep, rememberedBefore) {
    for (const entry of await mediaStore.list())
      if (!keep.has(entry.id) && entry.order < rememberedBefore)
        await forget(entry.id, entry.source);
  },

  async pickReplacement(media) {
    const accept = {
      'video/*': mediaAccept['video/*'],
      'audio/*': mediaAccept['audio/*'],
      'image/*': mediaAccept['image/*'],
    };
    const handles = await pickHandles(`Locate ${media.name}`, accept, false);
    if (handles)
      return handles[0] ? { id: media.id, source: { kind: 'handle', handle: handles[0] } } : null;
    const [file] = await pickWithInput(Object.values(mediaAccept).flat().join(','), false);
    return file ? { id: media.id, source: { kind: 'file', file } } : null;
  },

  chooseExport,
  cache,
  nativeInfo: async () => undefined,
};

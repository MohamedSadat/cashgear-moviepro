import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  mediaStore,
  projectIndex,
  type CacheStore,
  type FontFamilyEntry,
  type ImportRequest,
  type NativeProbe,
  type ProjectEntry,
} from '@cgv/engine-client';
import type {
  ExportChoice,
  ExportDestination,
  MediaPlatform,
  NativeInfo,
  ProjectStore,
  UpdateInfo,
} from '@cgv/ui';

/** A file the native side has registered for streaming through `cgv-media`. */
interface RegisteredMedia {
  id: string;
  path: string;
  name: string;
  size: number;
  modified: number | null;
  url: string;
  /** ffprobe's view of the file; null if it could not read it. */
  probe?: NativeProbe | null;
  probeError?: string | null;
}
/** An installed font file the native side has made readable, with its faces. */
interface InstalledFontFile {
  id: string;
  url: string;
  name: string;
  faces: { family: string; weight: number; italic: boolean }[];
}
type ProxyEvent = { event: 'progress'; progress: number };
type ExportEvent = ProxyEvent;
interface ProjectFile {
  path: string;
  modified: number | null;
}
interface OpenedProject extends ProjectFile {
  contents: string;
}

const toRequest = (media: RegisteredMedia): ImportRequest => ({
  id: media.id,
  source: {
    kind: 'url',
    url: media.url,
    path: media.path,
    name: media.name,
    size: media.size,
    modified: media.modified,
    probe: media.probe ?? undefined,
  },
});

/** Derived data in the app cache folder, written and read by the native side. */
const nativeCache: CacheStore = {
  async read(key) {
    // The native side answers an empty body for "not cached".
    const bytes = await invoke<ArrayBuffer>('cache_read', { key });
    return bytes.byteLength ? new Uint8Array(bytes) : null;
  },
  async write(key, bytes) {
    await invoke('cache_write', bytes, { headers: { 'x-cache-key': key } });
  },
  async remove(prefix) {
    await invoke('cache_remove', { prefix });
  },
};

/** Project files where the user saves them, autosaves in the app data folder, recents in IndexedDB. */
const projects: ProjectStore = {
  savesInPlace: false,
  list: () => projectIndex.list(),
  async read(entry) {
    if (!entry.path) return null;
    return (await invoke<OpenedProject>('project_read', { path: entry.path })).contents;
  },
  async save(entry, text, options) {
    const file = await invoke<ProjectFile | null>('project_save', {
      path: options?.saveAs ? null : (entry.path ?? null),
      contents: text,
      name: entry.name,
    });
    if (!file) return null;
    const saved: ProjectEntry = { ...entry, path: file.path, savedAt: file.modified ?? Date.now() };
    await projectIndex.put(saved);
    return saved;
  },
  async readAutosave(id) {
    const autosave = await invoke<{ contents: string; modified: number | null } | null>(
      'autosave_read',
      { id },
    );
    return autosave && { text: autosave.contents, modified: autosave.modified };
  },
  writeAutosave: (id, text) => invoke('autosave_write', { id, contents: text }),
  removeAutosave: (id) => invoke('autosave_remove', { id }),
  touch: (entry) => projectIndex.put({ ...entry, openedAt: Date.now() }),
  async remove(id) {
    await invoke('autosave_remove', { id });
    await projectIndex.remove(id);
  },
  async openFile() {
    const opened = await invoke<OpenedProject | null>('project_open');
    return opened && { text: opened.contents, path: opened.path };
  },
};

/**
 * Where a desktop export goes: the native save dialog (opening in Videos) picks
 * the file, the export worker's bytes are written into it through the native
 * side, and FFmpeg converts it afterwards for GIF and MP3.
 */
async function chooseExport({
  fileName,
  format,
  settings,
  path,
  estimatedBytes,
}: ExportChoice): Promise<ExportDestination | null> {
  const opened = await invoke<{ id: string; path: string } | null>('export_open', {
    name: fileName,
    extension: format.extension,
    path: path ?? null,
    convert: format.convertedFrom ? format.id : null,
    needs: estimatedBytes ? Math.round(estimatedBytes) : null,
  });
  if (!opened) return null;
  const { id } = opened;
  return {
    target: { kind: 'sink' },
    name: opened.path.split(/[\\/]/).pop() ?? fileName,
    write: (position, data) =>
      invoke('export_write', data, {
        headers: { 'x-export-id': id, 'x-position': String(position) },
      }),
    async finish(result, onProgress) {
      const events = new Channel<ExportEvent>();
      events.onmessage = (message) => onProgress(message.progress);
      return invoke<string>('export_finish', {
        id,
        durationSeconds: result.durationSeconds,
        audioBitrate: settings.audio?.bitrate ?? null,
        events,
      });
    },
    discard: () => invoke('export_cancel', { id }),
  };
}

/**
 * The desktop app: native file dialog and drops give real paths, the native side
 * streams them to the engine through the `cgv-media` protocol, probes them with
 * ffprobe and makes proxies with ffmpeg. Projects record media by path.
 */
/** The installed families, each with every file that holds one of its faces. */
async function installedFonts(): Promise<FontFamilyEntry[]> {
  const files = await invoke<InstalledFontFile[]>('fonts_installed');
  const families = new Map<string, FontFamilyEntry>();
  for (const file of files)
    for (const family of new Set(file.faces.map((face) => face.family))) {
      const entry = families.get(family) ?? {
        family,
        script: 'other' as const,
        origin: 'system' as const,
        files: [],
      };
      entry.files.push({ source: `system:${file.id}`, url: file.url });
      families.set(family, entry);
    }
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family));
}

export const desktopPlatform: MediaPlatform = {
  kind: 'desktop',
  projects,

  async pickFiles() {
    return (await invoke<RegisteredMedia[]>('media_pick')).map(toRequest);
  },

  onNativeDrop(listener) {
    let stop: (() => void) | undefined;
    let stopped = false;
    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== 'drop' || !event.payload.paths.length) return;
        const media = await invoke<RegisteredMedia[]>('media_register', {
          files: event.payload.paths.map((path) => ({ path })),
        });
        listener(media.map(toRequest));
      })
      .then((unlisten) => (stopped ? unlisten() : (stop = unlisten)));
    return () => {
      stopped = true;
      stop?.();
    };
  },

  async locate(media) {
    const ready: ImportRequest[] = [];
    const missing: string[] = [];
    // The protocol's registry lives in the native process: register each path again.
    for (const ref of media) {
      if (ref.location.kind !== 'path') {
        missing.push(ref.id);
        continue;
      }
      try {
        const [registered] = await invoke<RegisteredMedia[]>('media_register', {
          files: [{ id: ref.id, path: ref.location.path }],
        });
        ready.push(toRequest(registered));
      } catch {
        missing.push(ref.id);
      }
    }
    return { ready, waiting: 0, missing };
  },

  async legacyMedia() {
    const files = (await mediaStore.list())
      .filter((entry) => entry.source.kind === 'url')
      .map((entry) => ({ id: entry.id, path: (entry.source as { path: string }).path }));
    const requests: ImportRequest[] = [];
    for (const file of files) {
      try {
        const [registered] = await invoke<RegisteredMedia[]>('media_register', { files: [file] });
        requests.push(toRequest(registered));
      } catch {
        /* Gone since Phase 1. */
      }
    }
    return requests;
  },

  async clearLegacy() {
    for (const entry of await mediaStore.list()) await mediaStore.remove(entry.id);
  },

  // Projects record paths; nothing else needs remembering.
  remember: async () => {},

  async forget(id) {
    await nativeCache.remove(`media/${id}`);
    await invoke('media_forget', { id });
  },

  async pickReplacement(media) {
    const located = await invoke<RegisteredMedia | null>('media_locate', {
      id: media.id,
      name: media.name,
    });
    return located && toRequest(located);
  },

  async searchFolder(media) {
    const found = await invoke<RegisteredMedia[]>('media_search', {
      wanted: media.map(({ id, name, size }) => ({ id, name, size })),
    });
    return found.map(toRequest);
  },

  async makeProxy(id, onProgress) {
    const events = new Channel<ProxyEvent>();
    events.onmessage = (message) => {
      if (message.event === 'progress') onProgress(message.progress);
    };
    const proxy = await invoke<RegisteredMedia>('media_make_proxy', { id, events });
    return toRequest(proxy).source;
  },

  async dropProxy(id) {
    await invoke('media_drop_proxy', { id });
  },

  async saveRecording(name, bytes, projectPath) {
    const key = `recordings/${crypto.randomUUID()}.wav`;
    await invoke('cache_write', bytes, { headers: { 'x-cache-key': key } });
    const media = await invoke<RegisteredMedia>('recording_save', {
      key,
      name,
      project: projectPath,
    });
    return toRequest(media);
  },

  async registerPaths(paths) {
    const media = await invoke<RegisteredMedia[]>('media_register', {
      files: paths.map((path) => ({ path })),
    });
    return media.map(toRequest);
  },

  chooseExport,
  saveTextFile: (name, extension, label, text) =>
    invoke<string | null>('text_file_save', { name, extension, label, contents: text }),
  cache: nativeCache,
  nativeInfo: () => invoke<NativeInfo>('native_info'),
  machineId: () => invoke<string>('licence_machine'),
  updates: {
    check: () => invoke<UpdateInfo | null>('update_check'),
    async install(onProgress) {
      const stop = await listen<[number, number | null]>('update-progress', ({ payload }) =>
        onProgress(...payload),
      );
      try {
        await invoke('update_install');
      } finally {
        stop();
      }
    },
  },
  installedFonts,
};

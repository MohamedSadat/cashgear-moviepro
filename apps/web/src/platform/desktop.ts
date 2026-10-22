import { Channel, invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  mediaStore,
  type CacheStore,
  type ImportRequest,
  type NativeProbe,
} from '@cgv/engine-client';
import type { MediaPlatform, NativeInfo } from '@cgv/ui';

/** A file the native side has registered for streaming through `cgv-media`. */
interface RegisteredMedia {
  id: string;
  path: string;
  name: string;
  size: number;
  url: string;
  /** ffprobe's view of the file; null if it could not read it. */
  probe?: NativeProbe | null;
  probeError?: string | null;
}
type ProxyEvent = { event: 'progress'; progress: number };

const toRequest = (media: RegisteredMedia): ImportRequest => ({
  id: media.id,
  source: {
    kind: 'url',
    url: media.url,
    path: media.path,
    name: media.name,
    size: media.size,
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

/**
 * The desktop app: native file dialog and drops give real paths, the native side
 * streams them to the engine through the `cgv-media` protocol, probes them with
 * ffprobe and makes proxies with ffmpeg.
 */
export const desktopPlatform: MediaPlatform = {
  kind: 'desktop',

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

  async restore() {
    const files = (await mediaStore.list())
      .filter((entry) => entry.source.kind === 'url')
      .map((entry) => ({ id: entry.id, path: (entry.source as { path: string }).path }));
    if (!files.length) return { ready: [], waiting: 0 };
    // The protocol's registry lives in the native process, so register the paths again.
    const media = await invoke<RegisteredMedia[]>('media_register', { files });
    return { ready: media.map(toRequest), waiting: 0 };
  },

  async remember(entries) {
    const base = Date.now();
    for (const [index, { id, source }] of entries.entries())
      if (source.kind === 'url') await mediaStore.put({ id, order: base + index, source });
  },

  async forget(id) {
    await mediaStore.remove(id);
    await nativeCache.remove(`media/${id}`);
    await invoke('media_forget', { id });
  },

  async makeProxy(id, onProgress) {
    const events = new Channel<ProxyEvent>();
    events.onmessage = (message) => {
      if (message.event === 'progress') onProgress(message.progress);
    };
    const proxy = await invoke<RegisteredMedia>('media_make_proxy', { id, events });
    return toRequest(proxy).source;
  },

  async registerPaths(paths) {
    const media = await invoke<RegisteredMedia[]>('media_register', {
      files: paths.map((path) => ({ path })),
    });
    return media.map(toRequest);
  },

  cache: nativeCache,
  nativeInfo: () => invoke<NativeInfo>('native_info'),
};

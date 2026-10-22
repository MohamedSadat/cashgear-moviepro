import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createJobsClient,
  type CacheStore,
  type EngineClient,
  type ImportRequest,
  type JobsClient,
  type MediaItem,
  type MediaSourceRef,
  type MediaStatus,
} from '@cgv/engine-client';
import type { MediaPlatform } from '../platform';

export interface MediaVisuals {
  /** Object URLs of filmstrip thumbnails, in time order. */
  thumbnails: string[];
  waveform?: { peaks: Int8Array; peaksPerSecond: number };
}

export interface MediaLibraryState {
  items: MediaItem[];
  visuals: Record<string, MediaVisuals>;
  /** Import or proxy problems to show the user, newest last. */
  notices: string[];
  /** Remembered files that need permission again (web). */
  waiting: number;
  busy: boolean;
  pick(): Promise<void>;
  importDrop(data: DataTransfer): Promise<void>;
  importFiles(files: FileList | File[]): Promise<void>;
  grantAccess(): Promise<void>;
  remove(id: string): Promise<void>;
  dismissNotice(index: number): void;
  /** Test support: imports requests directly. */
  importRequests(requests: ImportRequest[]): Promise<void>;
}

const setUpClients = new WeakMap<EngineClient, Promise<ImportRequest[]>>();

const thumbsKey = (id: string) => `media/${id}/filmstrip.json`;
const thumbKey = (id: string, index: number) => `media/${id}/thumb-${index}.jpg`;
const peaksKey = (id: string) => `media/${id}/peaks.bin`;
const peaksMetaKey = (id: string) => `media/${id}/peaks.json`;

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const jpegUrl = (bytes: Uint8Array) =>
  URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));

/** Reads filmstrip and waveform from the cache, computing (and caching) what is missing. */
async function loadVisuals(
  item: MediaItem,
  source: MediaSourceRef,
  cache: CacheStore,
  jobs: JobsClient,
): Promise<MediaVisuals> {
  const visuals: MediaVisuals = { thumbnails: [] };
  const decodableVideo =
    item.kind === 'image' ||
    (item.video && (item.video.decodable || item.status.state === 'proxyReady'));
  if (decodableVideo) {
    const index = await cache.read(thumbsKey(item.id));
    if (index) {
      const { count } = JSON.parse(text(index)) as { count: number };
      for (let i = 0; i < count; i++) {
        const bytes = await cache.read(thumbKey(item.id, i));
        if (bytes) visuals.thumbnails.push(jpegUrl(bytes));
      }
    }
    if (!visuals.thumbnails.length) {
      const filmstrip = await jobs.api.filmstrip(source);
      for (const [i, image] of filmstrip.images.entries()) {
        await cache.write(thumbKey(item.id, i), image);
        visuals.thumbnails.push(jpegUrl(image));
      }
      await cache.write(
        thumbsKey(item.id),
        json({ count: filmstrip.images.length, times: filmstrip.times }),
      );
    }
  }
  if (item.audio?.decodable) {
    const meta = await cache.read(peaksMetaKey(item.id));
    const peaks = meta ? await cache.read(peaksKey(item.id)) : null;
    if (meta && peaks) {
      const { peaksPerSecond } = JSON.parse(text(meta)) as { peaksPerSecond: number };
      visuals.waveform = {
        peaks: new Int8Array(peaks.buffer, peaks.byteOffset, peaks.byteLength),
        peaksPerSecond,
      };
    } else {
      const waveform = await jobs.api.waveform(source);
      if (waveform) {
        const bytes = new Uint8Array(
          waveform.peaks.buffer,
          waveform.peaks.byteOffset,
          waveform.peaks.byteLength,
        );
        await cache.write(peaksKey(item.id), bytes);
        await cache.write(peaksMetaKey(item.id), json({ peaksPerSecond: waveform.peaksPerSecond }));
        visuals.waveform = { peaks: waveform.peaks, peaksPerSecond: waveform.peaksPerSecond };
      }
    }
  }
  return visuals;
}

/** The media library as seen by the UI: engine snapshots plus thumbnails and waveforms. */
export function useMediaLibrary(
  client: EngineClient | null,
  platform: MediaPlatform,
): MediaLibraryState {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [visuals, setVisuals] = useState<Record<string, MediaVisuals>>({});
  const [notices, setNotices] = useState<string[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [busy, setBusy] = useState(false);
  const jobs = useRef<JobsClient | null>(null);
  const sources = useRef(new Map<string, { source: MediaSourceRef; proxy?: MediaSourceRef }>());
  const shownClient = useRef<EngineClient | null>(null);

  const notice = useCallback((message: string) => setNotices((list) => [...list, message]), []);

  useEffect(() => {
    jobs.current = createJobsClient();
    return () => {
      jobs.current?.dispose();
      jobs.current = null;
    };
  }, []);

  const upsert = useCallback((item: MediaItem) => {
    setItems((list) => {
      const index = list.findIndex((existing) => existing.id === item.id);
      if (index < 0) return [...list, item];
      const next = [...list];
      next[index] = item;
      return next;
    });
  }, []);

  const refreshVisuals = useCallback(
    (item: MediaItem) => {
      const entry = sources.current.get(item.id);
      const jobsClient = jobs.current;
      if (!entry || !jobsClient) return;
      loadVisuals(item, entry.proxy ?? entry.source, platform.cache, jobsClient)
        .then((loaded) =>
          setVisuals((all) => {
            for (const url of all[item.id]?.thumbnails ?? []) URL.revokeObjectURL(url);
            return { ...all, [item.id]: loaded };
          }),
        )
        .catch((error) => notice(`${item.name}: thumbnails failed (${String(error)})`));
    },
    [notice, platform.cache],
  );

  const runProxy = useCallback(
    async (engine: EngineClient, item: MediaItem) => {
      if (!platform.makeProxy) return;
      const status = (next: MediaStatus) => engine.api.setMediaStatus(item.id, next).then(upsert);
      await status({ state: 'proxyRunning', progress: 0 });
      let last = 0;
      try {
        const proxy = await platform.makeProxy(item.id, (progress) => {
          if (progress - last < 0.02 && progress < 1) return;
          last = progress;
          void status({ state: 'proxyRunning', progress });
        });
        const ready = await engine.api.attachProxy(item.id, proxy);
        const entry = sources.current.get(item.id);
        if (entry) entry.proxy = proxy;
        upsert(ready);
        refreshVisuals(ready);
      } catch (error) {
        await status({
          state: 'proxyFailed',
          message: String(error instanceof Error ? error.message : error),
        });
      }
    },
    [platform, refreshVisuals, upsert],
  );

  const importInto = useCallback(
    async (engine: EngineClient, requests: ImportRequest[], remember: boolean) => {
      if (!requests.length) return;
      setBusy(true);
      try {
        const outcomes = await engine.api.importMedia(requests);
        const remembered: { id: string; source: MediaSourceRef }[] = [];
        for (const outcome of outcomes) {
          if ('error' in outcome) {
            const request = requests.find((r) => r.id === outcome.id);
            notice(
              `${request ? requestName(request) : 'A file'} could not be imported: ${outcome.error}`,
            );
            continue;
          }
          sources.current.set(outcome.id, { source: outcome.source });
          remembered.push({ id: outcome.id, source: outcome.source });
          upsert(outcome.item);
          refreshVisuals(outcome.item);
          if (outcome.item.status.state === 'proxyNeeded') void runProxy(engine, outcome.item);
        }
        if (remember && remembered.length) await platform.remember(remembered);
      } finally {
        setBusy(false);
      }
    },
    [notice, platform, refreshVisuals, runProxy, upsert],
  );

  // Each engine worker gets its own library: restore the remembered media into it.
  useEffect(() => {
    if (!client) return;
    if (shownClient.current !== client) {
      // A new worker (first start or Retry) starts with an empty library.
      shownClient.current = client;
      setItems([]);
      sources.current.clear();
    }
    let setup = setUpClients.get(client);
    if (!setup) {
      setup = client.api.configureMedia(platform.kind).then(async () => {
        const { ready, waiting: pending } = await platform.restore();
        setWaiting(pending);
        return ready;
      });
      setUpClients.set(client, setup);
      setup
        .then((ready) => importInto(client, ready, false))
        .catch((error) => notice(`The media library could not start: ${String(error)}`));
    }
  }, [client, importInto, notice, platform]);

  useEffect(() => {
    if (!client || !platform.onNativeDrop) return;
    return platform.onNativeDrop((requests) => {
      void setUpClients.get(client)?.then(() => importInto(client, requests, true));
    });
  }, [client, importInto, platform]);

  const withClient = useCallback(
    async (run: (engine: EngineClient) => Promise<void>) => {
      if (!client) return;
      await setUpClients.get(client);
      await run(client);
    },
    [client],
  );

  return {
    items,
    visuals,
    notices,
    waiting,
    busy,
    pick: () => withClient(async (engine) => importInto(engine, await platform.pickFiles(), true)),
    importDrop: (data) =>
      withClient(async (engine) => {
        if (platform.fromDrop) await importInto(engine, await platform.fromDrop(data), true);
      }),
    importFiles: (files) =>
      withClient((engine) =>
        importInto(
          engine,
          [...files].map((file) => ({ id: crypto.randomUUID(), source: { kind: 'file', file } })),
          true,
        ),
      ),
    grantAccess: () =>
      withClient(async (engine) => {
        if (!platform.grantAccess) return;
        const granted = await platform.grantAccess();
        setWaiting((count) => Math.max(0, count - granted.length));
        await importInto(engine, granted, false);
      }),
    remove: (id) =>
      withClient(async (engine) => {
        await engine.api.removeMedia(id);
        const entry = sources.current.get(id);
        sources.current.delete(id);
        if (entry) await platform.forget(id, entry.source);
        setItems((list) => list.filter((item) => item.id !== id));
        setVisuals((all) => {
          for (const url of all[id]?.thumbnails ?? []) URL.revokeObjectURL(url);
          const rest = { ...all };
          delete rest[id];
          return rest;
        });
      }),
    dismissNotice: (index) => setNotices((list) => list.filter((_, i) => i !== index)),
    importRequests: (requests) => withClient((engine) => importInto(engine, requests, true)),
  };
}

function requestName(request: ImportRequest) {
  const source = request.source;
  switch (source.kind) {
    case 'handle':
      return source.handle.name;
    case 'file':
      return source.file.name;
    case 'opfs':
      return source.path.split('/').pop() ?? source.path;
    case 'url':
      return source.name;
  }
}

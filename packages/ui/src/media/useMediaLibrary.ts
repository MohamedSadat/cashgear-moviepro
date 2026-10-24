import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createJobsClient,
  fileChanged,
  type CacheStore,
  type EngineClient,
  type ImportOutcome,
  type ImportRequest,
  type JobsClient,
  type MediaItem,
  type MediaRef,
  type MediaSourceRef,
  type MediaStatus,
} from '@cgv/engine-client';
import type { MediaPlatform } from '../platform';

export interface MediaVisuals {
  /** Object URLs of filmstrip thumbnails, in time order. */
  thumbnails: string[];
  /** Source time of each thumbnail, in seconds. */
  times?: number[];
  waveform?: { peaks: Int8Array; peaksPerSecond: number };
}

/** What loading a project's media found. */
export interface LoadResult {
  /** Media ids with no file to open. */
  missing: string[];
  /** Files that changed since the project last saw them, with their new details. */
  changed: MediaRef[];
}

export interface MediaLibraryState {
  /** Media open in the engine: the project's, plus removed items kept for undo. */
  items: MediaItem[];
  visuals: Record<string, MediaVisuals>;
  /** Import or proxy problems to show the user, newest last. */
  notices: string[];
  /** Files that need permission again (web). */
  waiting: number;
  busy: boolean;
  /** True once the engine's media library has started. */
  ready: boolean;
  /** Opens a project's media, closing whatever was open before. */
  load(media: MediaRef[]): Promise<LoadResult>;
  /** Imports new files; the project adds the references they return. */
  pick(): Promise<MediaRef[]>;
  importDrop(data: DataTransfer): Promise<MediaRef[]>;
  importFiles(files: FileList | File[]): Promise<MediaRef[]>;
  /** Test support: imports requests directly. */
  importRequests(requests: ImportRequest[]): Promise<MediaRef[]>;
  /** Opens a replacement for a missing or moved file under the media's id. */
  relink(request: ImportRequest): Promise<MediaRef | null>;
  /** Asks for access to remembered files again; returns any that changed meanwhile. */
  grantAccess(): Promise<MediaRef[]>;
  /** Imports what Phase 1 remembered, before projects existed. */
  importLegacy(): Promise<MediaRef[]>;

  /** The source of an open item. */
  source(id: string): MediaSourceRef | null;
  dismissNotice(index: number): void;
  notice(message: string): void;
}

/** Native drops arrive outside any UI action: the project adds what they import. */
export interface MediaLibraryEvents {
  imported(media: MediaRef[]): void;
}

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
      const { count, times } = JSON.parse(text(index)) as { count: number; times?: number[] };
      for (let i = 0; i < count; i++) {
        const bytes = await cache.read(thumbKey(item.id, i));
        if (bytes) visuals.thumbnails.push(jpegUrl(bytes));
      }
      if (times?.length === visuals.thumbnails.length) visuals.times = times;
    }
    if (!visuals.thumbnails.length) {
      const filmstrip = await jobs.api.filmstrip(source);
      for (const [i, image] of filmstrip.images.entries()) {
        await cache.write(thumbKey(item.id, i), image);
        visuals.thumbnails.push(jpegUrl(image));
      }
      visuals.times = filmstrip.times;
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

type Success = Extract<ImportOutcome, { item: MediaItem }>;

const configured = new WeakMap<EngineClient, Promise<void>>();

/** The engine's open media as the UI sees it: items, thumbnails and waveforms. */
export function useMediaLibrary(
  client: EngineClient | null,
  platform: MediaPlatform,
  events: MediaLibraryEvents,
): MediaLibraryState {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [visuals, setVisuals] = useState<Record<string, MediaVisuals>>({});
  const [notices, setNotices] = useState<string[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const jobs = useRef<JobsClient | null>(null);
  const sources = useRef(new Map<string, { source: MediaSourceRef; proxy?: MediaSourceRef }>());
  /** What the open project expects of each file, for change detection. */
  const expected = useRef(new Map<string, MediaRef>());
  const eventsRef = useRef(events);
  eventsRef.current = events;

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

  const dropVisuals = useCallback((ids: string[] | null) => {
    setVisuals((all) => {
      const rest: Record<string, MediaVisuals> = {};
      for (const [id, entry] of Object.entries(all)) {
        if (ids === null || ids.includes(id))
          for (const url of entry.thumbnails) URL.revokeObjectURL(url);
        else rest[id] = entry;
      }
      return rest;
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

  /**
   * Imports `requests`. Files that differ from what the project expects (or are
   * relinked, with `invalidate`) lose their cached thumbnails, waveform and proxy
   * before anything is drawn from them.
   */
  const importInto = useCallback(
    async (
      engine: EngineClient,
      requests: ImportRequest[],
      options: { remember: boolean; invalidate?: boolean },
    ) => {
      const done: Success[] = [];
      const failed: string[] = [];
      const changed: MediaRef[] = [];
      if (!requests.length) return { done, failed, changed };
      setBusy(true);
      try {
        const outcomes = await engine.api.importMedia(requests);
        for (const outcome of outcomes) {
          if ('error' in outcome) {
            const request = requests.find((r) => r.id === outcome.id);
            notice(
              `${request ? requestName(request) : 'A file'} could not be opened: ${outcome.error}`,
            );
            failed.push(outcome.id);
            continue;
          }
          const before = expected.current.get(outcome.id);
          const stale =
            options.invalidate || (before && fileChanged(before, outcome.media, outcome.source));
          if (stale) {
            await platform.cache.remove(`media/${outcome.id}`);
            await platform.dropProxy?.(outcome.id);
            if (before && !options.invalidate) {
              changed.push(outcome.media);
              notice(`${outcome.item.name} changed since the project last used it.`);
            }
          }
          expected.current.set(outcome.id, outcome.media);
          sources.current.set(outcome.id, { source: outcome.source });
          upsert(outcome.item);
          refreshVisuals(outcome.item);
          if (outcome.item.status.state === 'proxyNeeded') void runProxy(engine, outcome.item);
          done.push(outcome);
        }
        if (options.remember && done.length)
          await platform.remember(done.map(({ id, source }) => ({ id, source })));
      } finally {
        setBusy(false);
      }
      return { done, failed, changed };
    },
    [notice, platform, refreshVisuals, runProxy, upsert],
  );

  useEffect(() => {
    if (!client) return;
    // A new worker (first start or Retry) starts with nothing open.
    setReady(false);
    setItems([]);
    dropVisuals(null);
    sources.current.clear();
    let setup = configured.get(client);
    if (!setup) {
      setup = client.api.configureMedia(platform.kind);
      configured.set(client, setup);
    }
    let live = true;
    setup
      .then(() => live && setReady(true))
      .catch((error) => notice(`The media library could not start: ${String(error)}`));
    return () => {
      live = false;
    };
  }, [client, dropVisuals, notice, platform.kind]);

  const withClient = useCallback(
    async <T>(run: (engine: EngineClient) => Promise<T>, fallback: T): Promise<T> => {
      if (!client) return fallback;
      await configured.get(client);
      return run(client);
    },
    [client],
  );

  const importNew = useCallback(
    (requests: ImportRequest[]) =>
      withClient(async (engine) => {
        const { done } = await importInto(engine, requests, { remember: true });
        return done.map((outcome) => outcome.media);
      }, [] as MediaRef[]),
    [importInto, withClient],
  );

  useEffect(() => {
    if (!client || !platform.onNativeDrop) return;
    return platform.onNativeDrop((requests) => {
      void importNew(requests).then((media) => media.length && eventsRef.current.imported(media));
    });
  }, [client, importNew, platform]);

  return useMemo<MediaLibraryState>(
    () => ({
      items,
      visuals,
      notices,
      waiting,
      busy,
      ready,
      load: (media) =>
        withClient(
          async (engine) => {
            await engine.api.clearMedia();
            sources.current.clear();
            setItems([]);
            dropVisuals(null);
            expected.current = new Map(media.map((ref) => [ref.id, ref]));
            const located = await platform.locate(media);
            setWaiting(located.waiting);
            const { failed, changed } = await importInto(engine, located.ready, {
              remember: false,
            });
            return { missing: [...located.missing, ...failed], changed };
          },
          { missing: [], changed: [] },
        ),
      pick: () => withClient(async () => importNew(await platform.pickFiles()), [] as MediaRef[]),
      importDrop: (data) =>
        withClient(
          async () => (platform.fromDrop ? importNew(await platform.fromDrop(data)) : []),
          [] as MediaRef[],
        ),
      importFiles: (files) =>
        importNew(
          [...files].map((file) => ({ id: crypto.randomUUID(), source: { kind: 'file', file } })),
        ),
      importRequests: importNew,
      relink: (request) =>
        withClient(async (engine) => {
          if (sources.current.has(request.id)) {
            await engine.api.removeMedia(request.id);
            sources.current.delete(request.id);
          }
          const { done } = await importInto(engine, [request], {
            remember: true,
            invalidate: true,
          });
          return done[0]?.media ?? null;
        }, null),
      grantAccess: () =>
        withClient(async (engine) => {
          if (!platform.grantAccess) return [];
          const granted = await platform.grantAccess();
          setWaiting((count) => Math.max(0, count - granted.length));
          return (await importInto(engine, granted, { remember: false })).changed;
        }, [] as MediaRef[]),
      importLegacy: () =>
        withClient(async (engine) => {
          const { done } = await importInto(engine, await platform.legacyMedia(), {
            remember: true,
          });
          await platform.clearLegacy();
          return done.map((outcome) => outcome.media);
        }, [] as MediaRef[]),
      source: (id) => sources.current.get(id)?.source ?? null,
      dismissNotice: (index) => setNotices((list) => list.filter((_, i) => i !== index)),
      notice,
    }),
    [
      busy,
      dropVisuals,
      importInto,
      importNew,
      items,
      notice,
      notices,
      platform,
      ready,
      visuals,
      waiting,
      withClient,
    ],
  );
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

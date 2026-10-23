import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Autosaver,
  FLICKS_PER_SECOND,
  planOpen,
  projectIdOf,
  referencedMedia,
  type Command,
  type EngineClient,
  type ImportRequest,
  type MediaRef,
  type Outcome,
  type Preset,
  type ProjectEntry,
  type ProjectSettings,
  type ProjectSnapshot,
} from '@cgv/engine-client';
import { useMediaLibrary, type MediaLibraryState } from '../media/useMediaLibrary';
import type { MediaPlatform } from '../platform';

export interface RecoveryPrompt {
  name: string;
  /** When the autosave was written, in milliseconds, if known. */
  modified: number | null;
  /** The project was never saved: discarding deletes it. */
  unsaved: boolean;
}

export interface ProjectState {
  snapshot: ProjectSnapshot | null;
  entry: ProjectEntry | null;
  /** Known projects, most recently opened first. */
  entries: ProjectEntry[];
  library: MediaLibraryState;
  presets: Preset[];
  recovery: RecoveryPrompt | null;
  /** The project's media with no file to open. */
  missing: MediaRef[];
  relinking: boolean;
  notices: string[];
  busy: boolean;
  savesInPlace: boolean;
  canExport: boolean;
  canSearchFolder: boolean;
  /** Runs a command. On failure, shows why and returns null. */
  execute(command: Command): Promise<Outcome | null>;
  /** Runs commands as one undo step. On failure, shows why and returns null. */
  executeGroup(label: string, commands: Command[]): Promise<Outcome[] | null>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  save(): Promise<boolean>;
  saveAs(): Promise<boolean>;
  /** Desktop test support: saves to `path` without asking. */
  saveTo(path: string): Promise<boolean>;
  newProject(): Promise<void>;
  open(entry: ProjectEntry): Promise<void>;
  openFile(): Promise<void>;
  exportFile(): Promise<void>;
  remove(entry: ProjectEntry): Promise<void>;
  recover(choice: 'recover' | 'discard'): Promise<void>;
  rename(name: string): Promise<void>;
  setSettings(settings: ProjectSettings): Promise<void>;
  pick(): Promise<void>;
  importDrop(data: DataTransfer): Promise<void>;
  importFiles(files: FileList | File[]): Promise<void>;
  /** Test support: imports requests directly into the project. */
  importRequests(requests: ImportRequest[]): Promise<void>;
  grantAccess(): Promise<void>;
  removeMedia(id: string): Promise<void>;
  addToTimeline(id: string): Promise<void>;
  locate(media: MediaRef): Promise<void>;
  searchFolder(): Promise<void>;
  showRelink(open: boolean): void;
  /** Writes an autosave now if there are unsaved changes. */
  autosaveNow(): Promise<void>;
  dismissNotice(index: number): void;
}

export interface ProjectOptions {
  /** Milliseconds between autosaves. */
  autosaveMs: number;
}

const untitled = 'Untitled project';
/** Stills dropped on the timeline last this long. */
const stillDuration = 5 * FLICKS_PER_SECOND;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * The open project: opening, saving, autosave and recovery, relinking, and the
 * commands the UI sends. The project itself lives in the engine worker.
 */
export function useProject(
  client: EngineClient | null,
  platform: MediaPlatform,
  options: ProjectOptions,
): ProjectState {
  const store = platform.projects;
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [entry, setEntry] = useState<ProjectEntry | null>(null);
  const [entries, setEntries] = useState<ProjectEntry[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [recovery, setRecovery] = useState<{
    prompt: RecoveryPrompt;
    entry: ProjectEntry;
    saved: string | null;
    autosave: string;
  } | null>(null);
  const [missingIds, setMissingIds] = useState<string[]>([]);
  const [relinking, setRelinking] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const entryRef = useRef(entry);
  const clientRef = useRef(client);
  clientRef.current = client;
  /** Project switches and saves run one at a time. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** Set when this session wrote an autosave that may now be stale. */
  const autosaved = useRef(false);
  const addMedia = useRef<(media: MediaRef[]) => Promise<void>>(async () => {});

  const libraryEvents = useMemo(
    () => ({ imported: (media: MediaRef[]) => void addMedia.current(media) }),
    [],
  );
  const library = useMediaLibrary(client, platform, libraryEvents);
  const libraryRef = useRef(library);
  libraryRef.current = library;

  const notice = useCallback((text: string) => setNotices((list) => [...list, text]), []);

  const api = useCallback(() => {
    const current = clientRef.current;
    if (!current) throw new Error('The engine is not running');
    return current.api;
  }, []);

  const show = useCallback((next: ProjectSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const select = useCallback((next: ProjectEntry | null) => {
    entryRef.current = next;
    setEntry(next);
  }, []);

  /** Runs project switches and saves one at a time. A failure shows as a notice. */
  const serial = useCallback(
    <T>(run: () => Promise<T>): Promise<T | undefined> => {
      const next = queue.current.then(async () => {
        setBusy(true);
        try {
          return await run();
        } catch (error) {
          notice(message(error));
          return undefined;
        } finally {
          setBusy(false);
        }
      });
      queue.current = next;
      return next;
    },
    [notice],
  );

  const refreshEntries = useCallback(async () => setEntries(await store.list()), [store]);

  const autosaver = useMemo(
    () =>
      new Autosaver(
        {
          pending: () => !!snapshotRef.current?.needsAutosave && !!entryRef.current,
          write: async () => {
            const current = entryRef.current!;
            const { text, generation } = await api().projectSave();
            await store.writeAutosave(current.id, text);
            autosaved.current = true;
            // An unsaved desktop project is listed once it has an autosave to recover.
            await store.touch({
              ...current,
              name: snapshotRef.current?.project.name ?? current.name,
            });
            if (entryRef.current?.id === current.id)
              show(await api().projectMarkAutosaved(generation));
          },
          onError: (error) => notice(`Autosave failed: ${message(error)}`),
        },
        options.autosaveMs,
      ),
    [api, notice, options.autosaveMs, show, store],
  );

  useEffect(() => {
    autosaver.start();
    return () => autosaver.stop();
  }, [autosaver]);

  /** Forgets remembered files that no project and no undo step can reach. */
  const sweep = useCallback(async () => {
    if (!platform.sweep) return;
    const before = Date.now();
    const texts: (string | null)[] = [];
    for (const known of await store.list()) {
      texts.push(await store.read(known).catch(() => null));
      texts.push((await store.readAutosave(known.id).catch(() => null))?.text ?? null);
    }
    const keep = referencedMedia(texts);
    for (const media of snapshotRef.current?.project.media ?? []) keep.add(media.id);
    for (const item of libraryRef.current.items) keep.add(item.id);
    await platform.sweep(keep, before);
  }, [platform, store]);

  /** Keeps unsaved changes as an autosave before another project opens. */
  const closeCurrent = useCallback(async () => {
    const current = entryRef.current;
    const state = snapshotRef.current;
    if (!current || !state) return;
    if (state.dirty) {
      await autosaver.flush();
      notice(`Unsaved changes to ${state.project.name} were kept; they are offered when it opens.`);
    } else if (autosaved.current) {
      await store.removeAutosave(current.id).catch(() => {});
    }
    autosaved.current = false;
  }, [autosaver, notice, store]);

  const load = useCallback(
    async (target: ProjectEntry, text: string, open: { recovered?: boolean; id?: string }) => {
      const opened = await api().projectOpen(text, open);
      const now: ProjectEntry = {
        ...target,
        id: opened.project.id,
        name: opened.project.name,
        openedAt: Date.now(),
      };
      select(now);
      show(opened);
      autosaved.current = !!open.recovered;
      await store.touch(now);
      const { missing, changed } = await libraryRef.current.load(opened.project.media);
      let latest = opened;
      for (const media of changed) latest = await api().projectUpdateMedia(media);
      show(latest);
      setMissingIds(missing);
      setRelinking(missing.length > 0);
      await refreshEntries();
      void sweep().catch(() => {});
    },
    [api, refreshEntries, select, show, store, sweep],
  );

  const saveNow = useCallback(
    async (saveAs: boolean) => {
      const current = entryRef.current;
      if (!current) return false;
      const { text, generation } = await api().projectSave();
      const name = snapshotRef.current?.project.name ?? current.name;
      const saved = await store.save({ ...current, name }, text, { saveAs });
      if (!saved) return false;
      select(saved);
      const marked = await api().projectMarkSaved(generation);
      show(marked);
      if (marked.generation === generation) {
        await store.removeAutosave(saved.id);
        autosaved.current = false;
      }
      await refreshEntries();
      return true;
    },
    [api, refreshEntries, select, show, store],
  );

  const createProject = useCallback(
    async (migrate: boolean) => {
      const id = crypto.randomUUID();
      let created = await api().projectCreate(id, untitled);
      select({ id, name: untitled, openedAt: Date.now() });
      show(created);
      autosaved.current = false;
      await libraryRef.current.load([]);
      setMissingIds([]);
      setRelinking(false);
      if (migrate) {
        const media = await libraryRef.current.importLegacy();
        if (media.length) {
          created = (
            await api().projectExecuteGroup(
              'Import media',
              media.map((ref) => ({ type: 'addMedia', media: ref })),
            )
          ).snapshot;
          show(created);
        }
      }
      // Web projects are saved at once, so they are listed from the start.
      if (store.savesInPlace) await saveNow(false);
      await refreshEntries();
    },
    [api, refreshEntries, saveNow, select, show, store],
  );

  const openEntry = useCallback(
    async (target: ProjectEntry, fallbacks: ProjectEntry[]): Promise<void> => {
      let saved: string | null = null;
      let failure: string | null = null;
      try {
        saved = await store.read(target);
      } catch (error) {
        failure = message(error);
      }
      const autosave = await store.readAutosave(target.id).catch(() => null);
      const plan = planOpen(saved, autosave);
      if (plan.kind === 'ask') {
        setRecovery({
          prompt: { name: target.name, modified: plan.autosave.modified, unsaved: saved === null },
          entry: target,
          saved,
          autosave: plan.autosave.text,
        });
        return;
      }
      if (plan.kind === 'saved') {
        if (plan.staleAutosave) await store.removeAutosave(target.id);
        return load(target, plan.text, {});
      }
      if (failure) notice(`${target.name} could not be opened: ${failure}`);
      await store.remove(target.id);
      const [next, ...rest] = fallbacks;
      return next ? openEntry(next, rest) : createProject(false);
    },
    [createProject, load, notice, store],
  );

  // Each engine worker (first start or Retry) opens the most recent project.
  useEffect(() => {
    if (!client || !library.ready) return;
    void serial(async () => {
      setPresets(await client.api.projectPresets());
      const [latest, ...rest] = await store.list();
      if (latest) await openEntry(latest, rest);
      else await createProject(true);
    });
  }, [client, createProject, library.ready, notice, openEntry, serial, store]);

  // Unsaved changes: warn before leaving, and autosave when the page is hidden.
  const dirty = !!snapshot?.dirty;
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const hidden = () => document.visibilityState === 'hidden' && void autosaver.flush();
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [autosaver, dirty]);

  // Undoing back to the saved state leaves the autosave stale.
  useEffect(() => {
    const current = entryRef.current;
    if (dirty || !current || !autosaved.current) return;
    autosaved.current = false;
    void store.removeAutosave(current.id).catch(() => {});
  }, [dirty, store]);

  const execute = useCallback(
    async (command: Command) => {
      try {
        const { outcome, snapshot: next } = await api().projectExecute(command);
        show(next);
        return outcome;
      } catch (error) {
        notice(message(error));
        return null;
      }
    },
    [api, notice, show],
  );

  const executeGroup = useCallback(
    async (label: string, commands: Command[]) => {
      try {
        const { outcomes, snapshot: next } = await api().projectExecuteGroup(label, commands);
        show(next);
        return outcomes;
      } catch (error) {
        notice(message(error));
        return null;
      }
    },
    [api, notice, show],
  );

  addMedia.current = async (media: MediaRef[]) => {
    if (media.length)
      await executeGroup(
        'Import media',
        media.map((ref) => ({ type: 'addMedia', media: ref })),
      );
  };

  const undo = useCallback(async () => show(await api().projectUndo()), [api, show]);
  const redo = useCallback(async () => show(await api().projectRedo()), [api, show]);
  const save = useCallback(
    async () => (await serial(() => saveNow(false))) ?? false,
    [saveNow, serial],
  );
  const saveAs = useCallback(
    async () => (await serial(() => saveNow(true))) ?? false,
    [saveNow, serial],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || editable(event.target)) return;
      const key = event.key.toLowerCase();
      const run = (action: () => Promise<unknown>) => {
        event.preventDefault();
        void action().catch((error) => notice(message(error)));
      };
      if (key === 'z' && !event.shiftKey) run(undo);
      else if ((key === 'z' && event.shiftKey) || key === 'y') run(redo);
      else if (key === 's') run(event.shiftKey && !store.savesInPlace ? saveAs : save);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notice, redo, save, saveAs, store.savesInPlace, undo]);

  const relinkWith = useCallback(
    async (expected: MediaRef, request: ImportRequest) => {
      const media = await libraryRef.current.relink(request);
      if (!media) return false;
      const differs =
        media.kind !== expected.kind ||
        Math.abs(media.duration - expected.duration) > FLICKS_PER_SECOND / 10;
      if (differs)
        notice(
          `${media.name} is not like the original ${expected.name}; check the clips that use it.`,
        );
      show(await api().projectUpdateMedia(media));
      setMissingIds((ids) => ids.filter((id) => id !== media.id));
      return true;
    },
    [api, notice, show],
  );

  const missing = useMemo(
    () => (snapshot?.project.media ?? []).filter((media) => missingIds.includes(media.id)),
    [missingIds, snapshot],
  );

  /** UI actions show failures instead of throwing. */
  const guarded =
    <A extends unknown[]>(run: (...args: A) => Promise<void>) =>
    (...args: A) =>
      run(...args).catch((error) => notice(message(error)));

  return {
    snapshot,
    entry,
    entries,
    library,
    presets,
    recovery: recovery?.prompt ?? null,
    missing,
    relinking: relinking && missing.length > 0,
    notices,
    busy,
    savesInPlace: store.savesInPlace,
    canExport: !!store.exportFile,
    canSearchFolder: !!platform.searchFolder,
    execute,
    executeGroup,
    undo,
    redo,
    save,
    saveAs,
    saveTo: async (path) =>
      (await serial(async () => {
        if (entryRef.current) select({ ...entryRef.current, path });
        return saveNow(false);
      })) ?? false,
    newProject: () =>
      serial(async () => {
        await closeCurrent();
        await createProject(false);
      }),
    open: (target) =>
      serial(async () => {
        if (target.id === entryRef.current?.id) return;
        await closeCurrent();
        await openEntry(target, []);
      }),
    openFile: () =>
      serial(async () => {
        const file = await store.openFile();
        if (!file) return;
        const id = projectIdOf(file.text);
        const known = (await store.list()).find((candidate) => candidate.id === id);
        await closeCurrent();
        if (known && file.path && known.path === file.path) return openEntry(known, []);
        // Another project already has this id: open the file as a copy.
        const copy = !id || known || id === entryRef.current?.id ? crypto.randomUUID() : undefined;
        await load(
          {
            id: copy ?? id!,
            name: '',
            path: file.path,
            savedAt: file.path ? Date.now() : undefined,
            openedAt: Date.now(),
          },
          file.text,
          { id: copy },
        );
        // On the web an opened file becomes a project in browser storage.
        if (store.savesInPlace) await saveNow(false);
      }),
    exportFile: guarded(async () => {
      const current = snapshotRef.current;
      if (!current || !store.exportFile) return;
      await store.exportFile(current.project.name, (await api().projectSave()).text);
    }),
    remove: (target) =>
      serial(async () => {
        if (target.id === entryRef.current?.id) {
          notice('The open project cannot be deleted.');
          return;
        }
        await store.remove(target.id);
        await refreshEntries();
        void sweep().catch(() => {});
      }),
    recover: (choice) =>
      serial(async () => {
        const pending = recovery;
        if (!pending) return;
        setRecovery(null);
        if (choice === 'recover') return load(pending.entry, pending.autosave, { recovered: true });
        await store.removeAutosave(pending.entry.id);
        if (pending.saved !== null) return load(pending.entry, pending.saved, {});
        await store.remove(pending.entry.id);
        const [next, ...rest] = await store.list();
        return next ? openEntry(next, rest) : createProject(false);
      }),
    rename: async (name) => {
      await execute({ type: 'rename', name });
    },
    setSettings: async (settings) => {
      await execute({ type: 'setSettings', settings });
    },
    pick: guarded(async () => addMedia.current(await library.pick())),
    importDrop: guarded(async (data: DataTransfer) =>
      addMedia.current(await library.importDrop(data)),
    ),
    importFiles: async (files) => addMedia.current(await library.importFiles(files)),
    importRequests: async (requests) => addMedia.current(await library.importRequests(requests)),
    grantAccess: guarded(async () => {
      for (const media of await library.grantAccess()) show(await api().projectUpdateMedia(media));
    }),
    removeMedia: async (id) => {
      await execute({ type: 'removeMedia', media: id });
    },
    addToTimeline: async (id) => {
      const current = snapshotRef.current;
      const media = current?.project.media.find((candidate) => candidate.id === id);
      if (!current || !media) return;
      const { num, den } = current.project.settings.frameRate;
      const frame = (FLICKS_PER_SECOND * den) / num;
      const duration =
        media.kind === 'image' ? stillDuration : Math.floor(media.duration / frame) * frame;
      if (duration < frame) {
        notice(`${media.name} is shorter than one frame.`);
        return;
      }
      await execute({
        type: 'append',
        track: current.project.tracks[0].id,
        clip: { media: id, duration },
      });
    },
    locate: guarded(async (media: MediaRef) => {
      const request = await platform.pickReplacement(media);
      if (request) await relinkWith(media, request);
    }),
    searchFolder: guarded(async () => {
      if (!platform.searchFolder) return;
      const wanted = missing;
      const found = await platform.searchFolder(wanted);
      let relinked = 0;
      for (const request of found) {
        const expected = wanted.find((media) => media.id === request.id);
        if (expected && (await relinkWith(expected, request))) relinked++;
      }
      notice(
        relinked
          ? `Found ${relinked} of ${wanted.length} missing file${wanted.length === 1 ? '' : 's'}.`
          : 'No missing files were found there.',
      );
    }),
    showRelink: setRelinking,
    autosaveNow: () => autosaver.flush(),
    dismissNotice: (index) => setNotices((list) => list.filter((_, i) => i !== index)),
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  exportFileName,
  formatInfo,
  startExport,
  type BackendPreference,
  type EngineClient,
  type ExportJob,
  type ExportProgress,
  type ExportResult,
  type ExportSettings,
  type RunningExport,
} from '@cgv/engine-client';
import type { ExportDestination, MediaPlatform } from '../platform';
import type { ProjectState } from '../project/useProject';

export type ExportStatus =
  | { state: 'idle' }
  | {
      state: 'running';
      name: string;
      progress: ExportProgress | null;
      /** Desktop GIF and MP3: FFmpeg's progress once the worker is done. */
      converting: number | null;
    }
  | { state: 'done'; name: string; location: string; result: ExportResult }
  | { state: 'failed'; name: string; message: string }
  | { state: 'cancelled'; name: string };

export interface ExportOptions {
  /** Desktop test support: save here without asking. */
  path?: string;
  /** Web test support: download instead of asking where to save. */
  download?: boolean;
}

export interface ExportState {
  status: ExportStatus;
  running: boolean;
  /** Asks where to save, then exports the project as it is now. False if the user cancelled. */
  start(settings: ExportSettings, options?: ExportOptions): Promise<boolean>;
  cancel(): void;
  /** Forgets a finished, failed or cancelled export. */
  dismiss(): void;
  /** Resolves when the running export ends (tests). */
  settled(): Promise<ExportStatus>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/**
 * Exports run in their own worker with a copy of the project, so editing and
 * preview carry on meanwhile. One export runs at a time.
 */
export function useExport(
  client: EngineClient | null,
  project: ProjectState,
  platform: MediaPlatform,
  options: {
    backend: BackendPreference;
    decode?: ExportJob['decode'];
    /** Why the project cannot export yet (mattes still being made), or null. */
    blocked?: () => Promise<string | null>;
  },
): ExportState {
  const [status, setStatus] = useState<ExportStatus>({ state: 'idle' });
  const running = useRef<{
    export: RunningExport | null;
    destination: ExportDestination | null;
    cancelled: boolean;
  } | null>(null);
  const done = useRef<{ promise: Promise<ExportStatus>; resolve(status: ExportStatus): void }>(
    null,
  );
  const statusRef = useRef(status);
  statusRef.current = status;

  // Leaving the page would stop the export: the browser asks first.
  const busy = status.state === 'running';
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const finishWith = useCallback((next: ExportStatus) => {
    setStatus(next);
    running.current = null;
    done.current?.resolve(next);
    done.current = null;
  }, []);

  const start = useCallback(
    async (settings: ExportSettings, choice: ExportOptions = {}) => {
      if (running.current) throw new Error('An export is already running');
      const snapshot = project.snapshot;
      if (!client || !snapshot) throw new Error('No project is open');
      const blocked = await options.blocked?.();
      if (blocked) {
        project.notice(blocked);
        return false;
      }
      const format = formatInfo(settings.format);
      const fileName = exportFileName(snapshot.project.name, settings.format);
      // Taken now: edits made while the export runs do not change it.
      const { text } = await client.api.projectSave();
      const media = snapshot.project.media.flatMap((ref) => {
        const source = project.library.source(ref.id);
        return source ? [{ id: ref.id, source, proxy: project.library.proxy(ref.id) }] : [];
      });
      running.current = { export: null, destination: null, cancelled: false };
      let destination: ExportDestination | null;
      try {
        destination = await platform.chooseExport({ fileName, format, settings, ...choice });
      } catch (error) {
        running.current = null;
        throw error;
      }
      if (!destination) {
        running.current = null;
        return false;
      }
      running.current.destination = destination;
      const name = destination.name;
      let resolve!: (status: ExportStatus) => void;
      const promise = new Promise<ExportStatus>((r) => (resolve = r));
      done.current = { promise, resolve };
      setStatus({ state: 'running', name, progress: null, converting: null });
      const job: ExportJob = {
        project: text,
        media,
        settings,
        platform: platform.kind,
        backend: options.backend,
        decode: options.decode,
      };
      const current = startExport(job, destination.target, {
        progress: (progress) =>
          setStatus((value) => (value.state === 'running' ? { ...value, progress } : value)),
        write: destination.write,
      });
      running.current.export = current;
      if (running.current.cancelled) current.cancel();
      void (async () => {
        try {
          const result = await current.result;
          if (running.current?.cancelled) throw new DOMException('Cancelled', 'AbortError');
          const location = await destination.finish(result, (converting) =>
            setStatus((value) => (value.state === 'running' ? { ...value, converting } : value)),
          );
          finishWith({ state: 'done', name, location, result });
        } catch (error) {
          await destination.discard().catch(() => {});
          if (isAbort(error) || running.current?.cancelled)
            finishWith({ state: 'cancelled', name });
          else finishWith({ state: 'failed', name, message: message(error) });
        }
      })();
      return true;
    },
    [client, finishWith, options.backend, options.decode, platform, project],
  );

  const cancel = useCallback(() => {
    const current = running.current;
    if (!current) return;
    current.cancelled = true;
    current.export?.cancel();
    // Desktop: also stops a conversion and removes the native file.
    void current.destination?.discard().catch(() => {});
  }, []);

  const dismiss = useCallback(() => {
    if (!running.current) setStatus({ state: 'idle' });
  }, []);

  const settled = useCallback(
    () => done.current?.promise ?? Promise.resolve(statusRef.current),
    [],
  );

  return useMemo(
    () => ({ status, running: busy, start, cancel, dismiss, settled }),
    [busy, cancel, dismiss, settled, start, status],
  );
}

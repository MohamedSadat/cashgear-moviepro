import type { MediaSourceRef } from '../media/types';
import type { MediaRef } from './types';

/** How to open a project, given its saved file and its autosave. */
export type OpenPlan =
  | { kind: 'saved'; text: string; staleAutosave: boolean }
  | { kind: 'ask'; saved: string | null; autosave: { text: string; modified: number | null } }
  | { kind: 'missing' };

/**
 * An autosave that differs from the saved file holds unsaved changes from a
 * session that ended without saving: the user chooses whether to recover them.
 * One that matches is left over and can go.
 */
export function planOpen(
  saved: string | null,
  autosave: { text: string; modified: number | null } | null,
): OpenPlan {
  if (autosave && autosave.text !== saved) return { kind: 'ask', saved, autosave };
  if (saved !== null) return { kind: 'saved', text: saved, staleAutosave: autosave !== null };
  return { kind: 'missing' };
}

/** The media ids that project files use. Unreadable files contribute nothing. */
export function referencedMedia(texts: (string | null | undefined)[]): Set<string> {
  const ids = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    try {
      const file = JSON.parse(text) as { project?: { media?: { id?: unknown }[] } };
      for (const media of file.project?.media ?? [])
        if (typeof media.id === 'string') ids.add(media.id);
    } catch {
      /* Not a project file. */
    }
  }
  return ids;
}

/** The project id inside `.cgvproj` text, if it has one. */
export function projectIdOf(text: string): string | null {
  try {
    const id = (JSON.parse(text) as { project?: { id?: unknown } }).project?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/**
 * True when a file is not the one the project saw: another size, or another
 * modified time. Browser copies (OPFS) never change and get a fresh modified
 * time when copied, so only their size counts.
 */
export function fileChanged(expected: MediaRef, actual: MediaRef, source: MediaSourceRef) {
  if (expected.size !== actual.size) return true;
  if (source.kind === 'opfs') return false;
  return (
    expected.modified !== null && actual.modified !== null && expected.modified !== actual.modified
  );
}

export interface AutosaveTarget {
  /** True when there are changes no autosave holds yet. */
  pending(): boolean;
  write(): Promise<void>;
  onError(error: unknown): void;
}

/**
 * Writes an autosave every `interval` milliseconds while there are unsaved
 * changes, one write at a time. `flush` writes at once (before switching
 * projects, or when the page is hidden).
 */
export class Autosaver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly target: AutosaveTarget,
    private readonly interval: number,
  ) {}

  start() {
    this.stop();
    this.timer = setInterval(() => void this.flush(), this.interval);
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async flush(): Promise<void> {
    if (this.running) await this.running;
    if (!this.target.pending()) return;
    this.running = this.target
      .write()
      .catch((error) => this.target.onError(error))
      .finally(() => (this.running = null));
    await this.running;
  }
}

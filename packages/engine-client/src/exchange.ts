// Timelines to and from other editors: the cgv-exchange WASM module, loaded the
// first time a timeline goes out or comes in.
import init, { export_timeline, import_timeline } from './pkg/exchange/cgv_exchange';

export type TimelineFormat = 'otio' | 'fcp7';

export interface ExportedTimeline {
  text: string;
  /** What the format can't hold, in words for the user. */
  leftOut: string[];
}

export interface ImportedTimeline {
  /** The new project, as `.cgvproj` text. */
  project: string;
  /** What the project can't show, in words for the user. */
  leftOut: string[];
}

let ready: Promise<unknown> | undefined;

function load() {
  ready ??= init({
    module_or_path: new URL('./pkg/exchange/cgv_exchange_bg.wasm', import.meta.url),
  });
  return ready;
}

/** Writes timeline `sequence` (the main one when null) of `.cgvproj` text. */
export async function exportTimeline(
  project: string,
  sequence: number | null,
  format: TimelineFormat,
): Promise<ExportedTimeline> {
  await load();
  return JSON.parse(export_timeline(project, sequence ?? undefined, format));
}

/** Reads a timeline file as a new project with id `id`. */
export async function importTimeline(
  text: string,
  format: TimelineFormat,
  id: string,
): Promise<ImportedTimeline> {
  await load();
  return JSON.parse(import_timeline(text, format, id));
}

/** The format a timeline file's name says it is; null when it says none. */
export function timelineFormatOf(name: string): TimelineFormat | null {
  const extension = name.split('.').pop()?.toLowerCase();
  return extension === 'otio' ? 'otio' : extension === 'xml' ? 'fcp7' : null;
}

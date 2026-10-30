import type { FontFamilyEntry } from '../fonts/catalog';
import type { MediaSourceRef } from '../media/types';
import type { BackendPreference, MediaPlatformKind } from '../types';
import type { ExportSettings, LoudnessPlan } from './settings';

/** One export: a copy of the project as it was when the export started. */
export interface ExportJob {
  /** The project, as `.cgvproj` text. */
  project: string;
  /** Where each of the project's files is, with its desktop proxy if it plays through one. */
  media: { id: string; source: MediaSourceRef; proxy?: MediaSourceRef | null }[];
  settings: ExportSettings;
  platform: MediaPlatformKind;
  backend: BackendPreference;
  /** Diagnostics: force the export's decoders to software or hardware. */
  decode?: 'auto' | 'software' | 'hardware';
  /** Font families beyond the bundled ones (imported, installed); the page's by default. */
  fonts?: FontFamilyEntry[];
  /** The free edition: the picture carries a watermark, and stops at 1080p. */
  free?: boolean;
}

/** Where the export worker writes the file. */
export type ExportTarget =
  /** Web (Chrome, Edge): straight into the file picked in the save dialog. */
  | { kind: 'handle'; handle: FileSystemFileHandle }
  /** Web elsewhere: into the browser's private storage, downloaded afterwards. */
  | { kind: 'opfs'; name: string }
  /** Desktop: the bytes go back to the page, which hands them to the native side. */
  | { kind: 'sink' };

export type ExportPhase = 'preparing' | 'measuring' | 'rendering' | 'finishing' | 'converting';

export interface ExportProgress {
  phase: ExportPhase;
  /** Frames rendered so far, of `frames` (audio-only exports count sound in frames too). */
  frame: number;
  frames: number;
  /** 0 to 1 over the whole export. */
  fraction: number;
  elapsedMs: number;
  /** Null until there is enough to go on. */
  remainingMs: number | null;
  /** Frames rendered per second, lately. */
  speed: number | null;
}

export interface ExportResult {
  /** Bytes written. */
  bytes: number;
  frames: number;
  durationSeconds: number;
  elapsedMs: number;
  /** The codec strings in the file. */
  videoCodec: string | null;
  audioCodec: string | null;
  /** The video encoder ran on the GPU's media engine, as far as the browser says. */
  hardwareEncoder: boolean | null;
  /** The GPU backend that rendered the frames. */
  backend: string;
  /** What loudness normalisation measured and did; null when it was off. */
  loudness: LoudnessPlan | null;
}

/** The page's side of a running export. */
export interface ExportEvents {
  progress(progress: ExportProgress): void;
  /** Desktop sink: writes `data` at byte `position` of the file. */
  write?(position: number, data: Uint8Array): Promise<void>;
}

export interface ExportWorkerApi {
  run(job: ExportJob, target: ExportTarget, events: ExportEvents): Promise<ExportResult>;
  /** Stops the export; `run` rejects with an `AbortError` and the partial file is dropped. */
  cancel(): void;
}

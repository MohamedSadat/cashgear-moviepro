import type {
  CacheStore,
  ExportResult,
  ExportSettings,
  ExportTarget,
  FontFamilyEntry,
  FormatInfo,
  ImportRequest,
  MediaPlatformKind,
  MediaRef,
  MediaSourceRef,
  ProjectEntry,
} from '@cgv/engine-client';

/** Where an export goes, once the user has picked it. */
export interface ExportDestination {
  /** What the export worker writes to. */
  target: ExportTarget;
  /** The file's name as the user sees it. */
  name: string;
  /** Desktop: hands the worker's bytes to the native file. */
  write?(position: number, data: Uint8Array): Promise<void>;
  /**
   * After the worker has written everything: closes the file, converts it on
   * desktop (GIF, MP3), or starts the download. Resolves with where the file is.
   */
  finish(result: ExportResult, onProgress: (fraction: number) => void): Promise<string>;
  /** Removes what was written after a failure or cancel. */
  discard(): Promise<void>;
}

export interface ExportChoice {
  /** The suggested file name. */
  fileName: string;
  format: FormatInfo;
  settings: ExportSettings;
  /** Desktop test support: write to this path without asking. */
  path?: string;
  /** Web test support: download the file (OPFS) instead of asking where to save it. */
  download?: boolean;
}

export interface NativeInfo {
  product: string;
  version: string;
  os: string;
  arch: string;
}

/**
 * Where projects are kept. The web keeps them in browser storage; the desktop app
 * saves files where the user chooses and keeps autosaves in its data folder.
 */
export interface ProjectStore {
  /** True when saving never asks where (web): new projects are saved at once. */
  savesInPlace: boolean;
  /** Known projects, most recently opened first. */
  list(): Promise<ProjectEntry[]>;
  /** The saved project file, or null when there is none yet. Throws when it cannot be read. */
  read(entry: ProjectEntry): Promise<string | null>;
  /**
   * Writes the project file. The desktop app asks where on the first save or with
   * `saveAs`. Returns the updated entry, or null when the user cancels.
   */
  save(
    entry: ProjectEntry,
    text: string,
    options?: { saveAs?: boolean },
  ): Promise<ProjectEntry | null>;
  readAutosave(id: string): Promise<{ text: string; modified: number | null } | null>;
  writeAutosave(id: string, text: string): Promise<void>;
  removeAutosave(id: string): Promise<void>;
  /** Records the entry as just opened (and keeps it in the list). */
  touch(entry: ProjectEntry): Promise<void>;
  /** Web: deletes the project. Desktop: forgets it (the file stays). Removes its autosave. */
  remove(id: string): Promise<void>;
  /** Asks for a project file. Null when the user cancels. */
  openFile(): Promise<{ text: string; path?: string } | null>;
  /** Web: downloads the project as a `.cgvproj` file. */
  exportFile?(name: string, text: string): Promise<void>;
}

/** Where a project's media files are now. */
export interface LocatedMedia {
  ready: ImportRequest[];
  /** Web: files that need permission again (granted with a click). */
  waiting: number;
  /** Media ids with no file to open. */
  missing: string[];
}

/**
 * What differs between the browser and the desktop app. apps/web provides both
 * implementations; the UI only talks to this interface.
 */
export interface MediaPlatform {
  kind: MediaPlatformKind;
  projects: ProjectStore;
  /** Opens the system file picker. An empty list means the user cancelled. */
  pickFiles(): Promise<ImportRequest[]>;
  /** Web: turns dropped items into import requests (handles where the browser offers them). */
  fromDrop?(data: DataTransfer): Promise<ImportRequest[]>;
  /** Desktop: drops arrive from the native window as file paths. Returns an unsubscribe function. */
  onNativeDrop?(listener: (requests: ImportRequest[]) => void): () => void;
  /** Finds the files of a project's media. */
  locate(media: MediaRef[]): Promise<LocatedMedia>;
  /** Web: asks again for access to remembered files. Must run from a click. */
  grantAccess?(): Promise<ImportRequest[]>;
  /** Media remembered by Phase 1, before projects: moved into the first project. */
  legacyMedia(): Promise<ImportRequest[]>;
  /** Forgets the Phase 1 records once they are in a project. */
  clearLegacy(): Promise<void>;
  /** Keeps a newly imported file reachable after a reload. */
  remember(entries: { id: string; source: MediaSourceRef }[]): Promise<void>;
  /** Forgets a file no project uses: its record, its browser copy and its caches. */
  forget(id: string, source: MediaSourceRef | null): Promise<void>;
  /**
   * Web: forgets remembered files whose ids are not in `keep`. Files remembered at
   * or after `rememberedBefore` stay: they are imports still on their way into a project.
   */
  sweep?(keep: Set<string>, rememberedBefore: number): Promise<void>;
  /** Asks the user where a missing file is now. The request keeps the media's id. */
  pickReplacement(media: MediaRef): Promise<ImportRequest | null>;
  /** Desktop: asks for a folder and finds missing files in it by name and size. */
  searchFolder?(media: MediaRef[]): Promise<ImportRequest[]>;
  /** Desktop: transcodes `id` to an H.264 proxy, reporting progress from 0 to 1. */
  makeProxy?(id: string, onProgress: (progress: number) => void): Promise<MediaSourceRef>;
  /** Desktop: drops the proxy of a file that changed, so a new one is made. */
  dropProxy?(id: string): Promise<void>;
  /** Desktop test support: imports local paths as if they were dropped. */
  registerPaths?(paths: string[]): Promise<ImportRequest[]>;
  /** Asks where to save an export. Null when the user cancels. */
  chooseExport(choice: ExportChoice): Promise<ExportDestination | null>;
  /**
   * Desktop: keeps a voiceover as a WAV file in a `Voiceovers` folder beside the
   * project (or in the app's data folder before its first save). The web imports
   * recordings as files instead.
   */
  saveRecording?(
    name: string,
    bytes: Uint8Array,
    projectPath: string | null,
  ): Promise<ImportRequest>;
  cache: CacheStore;
  nativeInfo(): Promise<NativeInfo | undefined>;
  /** Desktop: the fonts installed on this computer, for titles. */
  installedFonts?(): Promise<FontFamilyEntry[]>;
}

export const mediaAccept = {
  'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.mkv'],
  'audio/*': ['.mp3', '.wav', '.aac', '.m4a', '.opus', '.ogg', '.flac'],
  'image/*': ['.png', '.jpg', '.jpeg', '.webp'],
};

export function newMediaId() {
  return crypto.randomUUID();
}

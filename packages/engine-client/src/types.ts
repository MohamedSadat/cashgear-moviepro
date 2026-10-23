import type {
  FrameReadback,
  ImportOutcome,
  ImportRequest,
  MediaItem,
  MediaSourceRef,
  MediaStats,
  MediaStatus,
} from './media/types';
import type {
  ClipAt,
  Command,
  MediaRef,
  Outcome,
  Preset,
  ProjectSnapshot,
  SavedText,
} from './project/types';

export type BackendPreference = 'auto' | 'webgl2';
export type Backend = 'WebGPU' | 'WebGL2';
export type GpuFault = 'adapter' | 'device';
export type DiagnosticFault = 'device-loss' | 'panic';

export interface PhysicalSize {
  width: number;
  height: number;
}
export interface InitOptions extends PhysicalSize {
  backend: BackendPreference;
  diagnostic: boolean;
  /** Diagnostics only: make the worker's WebGPU adapter or device request fail. */
  simulateGpuFailure?: GpuFault;
}
export interface EngineInfo {
  backend: Backend;
  adapter: string;
}
export interface FrameStats extends PhysicalSize {
  frames: number;
  presented: boolean;
}
export type MediaPlatformKind = 'web' | 'desktop';
export type FrameCrop = { x: number; y: number; width: number; height: number };

export interface EngineApi {
  init(canvas: OffscreenCanvas, options: InitOptions): Promise<EngineInfo>;
  resize(size: PhysicalSize): void;
  /** Writes into shared memory from the worker; the caller reads it back. */
  touchSharedMemory(buffer: SharedArrayBuffer, value: number): void;
  dispose(): void;
  diagnosticFault(kind: DiagnosticFault): void;

  /** Starts the media library. Call once per worker, before any other media call. */
  configureMedia(platform: MediaPlatformKind): Promise<void>;
  importMedia(requests: ImportRequest[]): Promise<ImportOutcome[]>;
  mediaSnapshot(): MediaItem[];
  setMediaStatus(id: string, status: MediaStatus): MediaItem;
  attachProxy(id: string, source: MediaSourceRef): Promise<MediaItem>;
  removeMedia(id: string): boolean;
  mediaStats(): MediaStats;
  frameCount(id: string): number;
  /** Decodes exact frame `frame` and reports its barcode and optional crop pixels. */
  readFrame(id: string, frame: number, crop?: FrameCrop): Promise<FrameReadback>;
  /** Closes every cached frame and decoder (leak checks). */
  releaseFrames(): void;
  /** Closes every media item (switching projects). */
  clearMedia(): void;

  /** A new, empty project with the default settings. */
  projectCreate(id: string, name: string): Promise<ProjectSnapshot>;
  /** Opens `.cgvproj` text. `recovered` marks an autosave; `id` makes an imported copy. */
  projectOpen(
    text: string,
    options?: { recovered?: boolean; id?: string },
  ): Promise<ProjectSnapshot>;
  projectClose(): void;
  projectSnapshot(): ProjectSnapshot;
  /** Runs one command: one undo step. Throws with the reason when it cannot apply. */
  projectExecute(command: Command): { outcome: Outcome; snapshot: ProjectSnapshot };
  /** Runs commands as one undo step; all apply or none. */
  projectExecuteGroup(
    label: string,
    commands: Command[],
  ): { outcomes: Outcome[]; snapshot: ProjectSnapshot };
  projectUndo(): ProjectSnapshot;
  projectRedo(): ProjectSnapshot;
  /** Commands until `projectEndGroup` undo as one step (a drag). */
  projectBeginGroup(label: string): void;
  projectEndGroup(): ProjectSnapshot;
  /** Reverts everything since `projectBeginGroup` (a cancelled drag). */
  projectCancelGroup(): ProjectSnapshot;
  /** The project file's text, and the state it holds. */
  projectSave(): SavedText;
  projectMarkSaved(generation: number): ProjectSnapshot;
  projectMarkAutosaved(generation: number): ProjectSnapshot;
  /** Records a relinked or changed media file. Not an undo step. */
  projectUpdateMedia(media: MediaRef): ProjectSnapshot;
  projectClipsAt(time: number): ClipAt[];
  projectSnapPoints(playhead: number | null, exclude: number[]): number[];
  projectPresets(): Promise<Preset[]>;
}

/** Messages the worker posts outside the RPC channel. */
export type EngineEvent =
  { type: 'engine-fatal'; message: string } | ({ type: 'engine-stats' } & FrameStats);

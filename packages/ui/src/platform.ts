import type {
  CacheStore,
  ImportRequest,
  MediaPlatformKind,
  MediaSourceRef,
} from '@cgv/engine-client';

export interface NativeInfo {
  product: string;
  version: string;
  os: string;
  arch: string;
}

/**
 * What differs between the browser and the desktop app. apps/web provides both
 * implementations; the UI only talks to this interface.
 */
export interface MediaPlatform {
  kind: MediaPlatformKind;
  /** Opens the system file picker. An empty list means the user cancelled. */
  pickFiles(): Promise<ImportRequest[]>;
  /** Web: turns dropped items into import requests (handles where the browser offers them). */
  fromDrop?(data: DataTransfer): Promise<ImportRequest[]>;
  /** Desktop: drops arrive from the native window as file paths. Returns an unsubscribe function. */
  onNativeDrop?(listener: (requests: ImportRequest[]) => void): () => void;
  /** Media remembered from earlier sessions: what can import now, and how many wait for permission. */
  restore(): Promise<{ ready: ImportRequest[]; waiting: number }>;
  /** Web: asks again for access to remembered files. Must run from a click. */
  grantAccess?(): Promise<ImportRequest[]>;
  remember(entries: { id: string; source: MediaSourceRef }[]): Promise<void>;
  forget(id: string, source: MediaSourceRef): Promise<void>;
  /** Desktop: transcodes `id` to an H.264 proxy, reporting progress from 0 to 1. */
  makeProxy?(id: string, onProgress: (progress: number) => void): Promise<MediaSourceRef>;
  /** Desktop test support: imports local paths as if they were dropped. */
  registerPaths?(paths: string[]): Promise<ImportRequest[]>;
  cache: CacheStore;
  nativeInfo(): Promise<NativeInfo | undefined>;
}

export const mediaAccept = {
  'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.mkv'],
  'audio/*': ['.mp3', '.wav', '.aac', '.m4a', '.opus', '.ogg', '.flac'],
  'image/*': ['.png', '.jpg', '.jpeg', '.webp'],
};

export function newMediaId() {
  return crypto.randomUUID();
}

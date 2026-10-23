// Mirrors the JSON of crates/cgv-media (MediaProbe, MediaItem, MediaStatus).
import type { MediaRef } from '../project/types';

export interface FrameRate {
  num: number;
  den: number;
}
export interface ColorInfo {
  primaries: string | null;
  transfer: string | null;
  matrix: string | null;
  fullRange: boolean | null;
}
export type MediaSourceKind =
  { kind: 'handle' } | { kind: 'opfs'; path: string } | { kind: 'path'; path: string };

export interface VideoProbe {
  codec: string;
  codecString: string | null;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  frameCount: number;
  frameRate: number;
  constantFrameRate: boolean;
  color: ColorInfo;
  hdr: boolean;
  decodable: boolean;
}
export interface AudioProbe {
  codec: string;
  codecString: string | null;
  sampleRate: number;
  channels: number;
  decodable: boolean;
}
export interface ImageProbe {
  codec: string;
  width: number;
  height: number;
  frameCount: number;
}
export interface MediaProbe {
  id: string;
  name: string;
  size: number;
  source: MediaSourceKind;
  container: string;
  durationSeconds: number;
  video: VideoProbe | null;
  audio: AudioProbe | null;
  image: ImageProbe | null;
}

export type MediaStatus =
  | { state: 'ready' }
  | { state: 'proxyNeeded' }
  | { state: 'proxyRunning'; progress: number }
  | { state: 'proxyReady' }
  | { state: 'proxyFailed'; message: string }
  | { state: 'unsupported'; message: string };

export interface MediaItem {
  id: string;
  name: string;
  size: number;
  source: MediaSourceKind;
  container: string;
  kind: 'video' | 'audio' | 'image';
  /** Flicks (705,600,000 per second). */
  duration: number;
  durationLabel: string;
  video:
    | (Omit<VideoProbe, 'displayWidth' | 'displayHeight' | 'frameRate'> & {
        codecLabel: string;
        width: number;
        height: number;
        frameRate: FrameRate;
        frameRateLabel: string;
      })
    | null;
  audio: (AudioProbe & { codecLabel: string; channelLabel: string }) | null;
  image: {
    codec: string;
    codecLabel: string;
    width: number;
    height: number;
    animated: boolean;
  } | null;
  status: MediaStatus;
}

/** Where the engine reads a file from. Handles and Files are structured-cloneable. */
export type MediaSourceRef =
  | { kind: 'handle'; handle: FileSystemFileHandle }
  /** A plain File (input element, drop without handles): copied into OPFS on import. */
  | { kind: 'file'; file: File }
  | { kind: 'opfs'; path: string }
  /**
   * Desktop: a local file streamed by the native `cgv-media` protocol. `probe` is
   * ffprobe's view, used when the engine's own demuxer cannot read the file.
   */
  | {
      kind: 'url';
      url: string;
      path: string;
      name: string;
      size: number;
      /** Last-modified time in milliseconds, from the native side. */
      modified?: number | null;
      probe?: NativeProbe;
    };

/** ffprobe's description of a file, in MediaProbe terms (everything marked undecodable). */
export type NativeProbe = Pick<MediaProbe, 'container' | 'durationSeconds' | 'video' | 'audio'>;

export interface ImportRequest {
  /** Stable across reloads, so caches and projects keep pointing at the same media. */
  id: string;
  source: MediaSourceRef;
}
export type ImportOutcome =
  | {
      id: string;
      item: MediaItem;
      source: MediaSourceRef;
      /** What a project records about the file (`cgv_model::MediaRef`). */
      media: MediaRef;
    }
  | { id: string; error: string };

export interface MediaStats {
  openFrames: number;
  cachedFrames: number;
  cacheBytes: number;
  cacheBudgetBytes: number;
  decoders: number;
}

export interface FrameReadback {
  frame: number;
  timestampUs: number;
  /** The frame number decoded from the test clips' barcode strip, or -1. */
  barcode: number;
  /** Raw I420 bytes (Y, then Cb, then Cr) of the requested crop, in unrotated frame coordinates. */
  yuv?: Uint8Array;
  decodedFrames: number;
  /** Pixel format and colour space of the frame as the engine holds it. */
  format: VideoPixelFormat | null;
  colorSpace: VideoColorSpaceInit;
}

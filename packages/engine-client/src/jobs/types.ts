import type { MediaSourceRef } from '../media/types';

export interface Filmstrip {
  /** Source time of each thumbnail, in seconds. */
  times: number[];
  /** JPEG bytes, 90 px tall, rotated for display. */
  images: Uint8Array[];
}

export interface Waveform {
  sampleRate: number;
  peaksPerSecond: number;
  /** [min, max] int8 pairs across all channels. */
  peaks: Int8Array;
}

export interface JobsApi {
  filmstrip(source: MediaSourceRef): Promise<Filmstrip>;
  waveform(source: MediaSourceRef): Promise<Waveform | null>;
}

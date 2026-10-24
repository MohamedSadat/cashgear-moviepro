import {
  AudioSample,
  EncodedPacket,
  type AudioSampleSource,
  type EncodedAudioPacketSource,
  type EncodedVideoPacketSource,
} from 'mediabunny';

/** Export frames are BT.709 limited range, as the compositor writes them. */
export const exportColorSpace: VideoColorSpaceInit = {
  primaries: 'bt709',
  transfer: 'bt709',
  matrix: 'bt709',
  fullRange: false,
};

/** Frames or chunks queued in an encoder before the export waits for it. */
const maxQueued = 3;

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

function dequeued(encoder: VideoEncoder | AudioEncoder) {
  return new Promise<void>((resolve) =>
    encoder.addEventListener('dequeue', () => resolve(), { once: true }),
  );
}

/** The encoder configuration to use: hardware when the browser has it for `config`. */
export async function chooseVideoConfig(
  config: VideoEncoderConfig,
): Promise<{ config: VideoEncoderConfig; hardware: boolean } | null> {
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
    const candidate = { ...config, hardwareAcceleration };
    try {
      if ((await VideoEncoder.isConfigSupported(candidate)).supported)
        return { config: candidate, hardware: hardwareAcceleration === 'prefer-hardware' };
    } catch {
      /* Not this one. */
    }
  }
  return null;
}

/**
 * A WebCodecs video encoder feeding a Mediabunny track. `encode` waits while the
 * encoder or the file writer is behind, so memory stays flat on long exports.
 */
export class VideoTrackEncoder {
  private encoder: VideoEncoder;
  private muxing: Promise<void> = Promise.resolve();
  private error: Error | null = null;

  constructor(
    config: VideoEncoderConfig,
    private readonly track: EncodedVideoPacketSource,
  ) {
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const packet = EncodedPacket.fromEncodedChunk(chunk);
        // The container records the colour the frames were made with.
        if (meta?.decoderConfig && !meta.decoderConfig.colorSpace?.matrix)
          meta.decoderConfig.colorSpace = exportColorSpace;
        this.muxing = this.muxing
          .then(() => this.track.add(packet, meta))
          .catch((error) => void (this.error ??= asError(error)));
      },
      error: (error) => void (this.error ??= asError(error)),
    });
    this.encoder.configure(config);
  }

  /** Encodes `frame` (the caller closes it afterwards). */
  async encode(frame: VideoFrame, keyFrame: boolean) {
    if (this.error) throw this.error;
    this.encoder.encode(frame, { keyFrame });
    while (this.encoder.encodeQueueSize > maxQueued && !this.error) await dequeued(this.encoder);
    await this.muxing;
    if (this.error) throw this.error;
  }

  async finish() {
    if (this.error) throw this.error;
    await this.encoder.flush();
    await this.muxing;
    if (this.error) throw this.error;
    this.encoder.close();
  }

  close() {
    if (this.encoder.state !== 'closed') this.encoder.close();
  }
}

/** Where mixed sound goes: interleaved f32 at the project rate. */
export interface AudioTrackSink {
  encode(samples: Float32Array, frames: number, startSample: number): Promise<void>;
  finish(): Promise<void>;
  close(): void;
}

/**
 * A WebCodecs audio encoder (AAC or Opus) feeding a Mediabunny track. Chrome and
 * Edge time their chunks so the encoder's start-up delay is already accounted
 * for: exported clicks land on their flash frames to the sample.
 */
export class AudioTrackEncoder implements AudioTrackSink {
  private encoder: AudioEncoder;
  private muxing: Promise<void> = Promise.resolve();
  private error: Error | null = null;

  constructor(
    private readonly config: AudioEncoderConfig,
    private readonly track: EncodedAudioPacketSource,
  ) {
    const rate = config.sampleRate;
    this.encoder = new AudioEncoder({
      output: (chunk, meta) => {
        const packet = EncodedPacket.fromEncodedChunk(chunk);
        // Sample-exact times: microseconds lose a little at 44.1 kHz.
        const sample = Math.round((chunk.timestamp * rate) / 1e6);
        const timed = packet.clone({ timestamp: sample / rate });
        this.muxing = this.muxing
          .then(() => this.track.add(timed, meta))
          .catch((error) => void (this.error ??= asError(error)));
      },
      error: (error) => void (this.error ??= asError(error)),
    });
    this.encoder.configure(config);
  }

  async encode(samples: Float32Array, frames: number, startSample: number) {
    if (this.error) throw this.error;
    const data = new AudioData({
      format: 'f32',
      sampleRate: this.config.sampleRate,
      numberOfChannels: this.config.numberOfChannels,
      numberOfFrames: frames,
      timestamp: Math.round((startSample * 1e6) / this.config.sampleRate),
      data: samples as Float32Array<ArrayBuffer>,
    });
    try {
      this.encoder.encode(data);
    } finally {
      data.close();
    }
    while (this.encoder.encodeQueueSize > maxQueued && !this.error) await dequeued(this.encoder);
    await this.muxing;
    if (this.error) throw this.error;
  }

  async finish() {
    if (this.error) throw this.error;
    await this.encoder.flush();
    await this.muxing;
    if (this.error) throw this.error;
    this.encoder.close();
  }

  close() {
    if (this.encoder.state !== 'closed') this.encoder.close();
  }
}

/** 16-bit PCM (WAV, and the MP3 intermediate), written by Mediabunny itself. */
export class PcmTrack implements AudioTrackSink {
  constructor(
    private readonly track: AudioSampleSource,
    private readonly rate: number,
    private readonly channels: number,
  ) {}

  async encode(samples: Float32Array, _frames: number, startSample: number) {
    const sample = new AudioSample({
      data: samples as Float32Array<ArrayBuffer>,
      format: 'f32',
      numberOfChannels: this.channels,
      sampleRate: this.rate,
      timestamp: startSample / this.rate,
    });
    try {
      await this.track.add(sample);
    } finally {
      sample.close();
    }
  }

  async finish() {
    this.track.close();
  }

  close() {}
}

import {
  AdtsInputFormat,
  EncodedPacketSink,
  FlacInputFormat,
  MatroskaInputFormat,
  Mp3InputFormat,
  Mp4InputFormat,
  MpegTsInputFormat,
  OggInputFormat,
  QuickTimeInputFormat,
  WaveInputFormat,
  WebMInputFormat,
  type Input,
  type InputAudioTrack,
  type InputFormat,
  type InputVideoTrack,
} from 'mediabunny';
import { FrameIndex } from './frame-index';
import { imageType, readAll, sourceKind, sourceName, sourceSize } from './sources';
import type { AudioProbe, ImageProbe, MediaProbe, MediaSourceRef, VideoProbe } from './types';

export function containerName(format: InputFormat): string {
  if (format instanceof WebMInputFormat) return 'webm';
  if (format instanceof MatroskaInputFormat) return 'matroska';
  if (format instanceof QuickTimeInputFormat) return 'mov';
  if (format instanceof Mp4InputFormat) return 'mp4';
  if (format instanceof Mp3InputFormat) return 'mp3';
  if (format instanceof WaveInputFormat) return 'wav';
  if (format instanceof AdtsInputFormat) return 'adts';
  if (format instanceof OggInputFormat) return 'ogg';
  if (format instanceof FlacInputFormat) return 'flac';
  if (format instanceof MpegTsInputFormat) return 'ts';
  return format.name.toLowerCase();
}

/** PCM is decoded by the engine itself, since WebCodecs PCM support varies. */
export const isPcm = (codec: string) =>
  codec.startsWith('pcm-') || codec === 'ulaw' || codec === 'alaw';

async function supported(check: () => Promise<{ supported?: boolean }>) {
  try {
    return (await check()).supported === true;
  } catch {
    return false;
  }
}

export interface ProbedVideo {
  probe: VideoProbe;
  track: InputVideoTrack;
  sink: EncodedPacketSink;
  index: FrameIndex;
  config: VideoDecoderConfig | null;
}

export async function probeVideo(track: InputVideoTrack): Promise<ProbedVideo> {
  const codec = (await track.getCodec()) ?? '';
  const config = await track.getDecoderConfig();
  const decodable =
    config !== null && (await supported(() => VideoDecoder.isConfigSupported(config)));
  const sink = new EncodedPacketSink(track);
  const index = await FrameIndex.fromPackets(
    sink.packets(undefined, undefined, { metadataOnly: true }),
  );
  const metrics = await track.computeFrameRateMetrics();
  const color = await track.getColorSpace();
  return {
    track,
    sink,
    index,
    config,
    probe: {
      codec,
      codecString: await track.getCodecParameterString(),
      codedWidth: await track.getCodedWidth(),
      codedHeight: await track.getCodedHeight(),
      displayWidth: await track.getDisplayWidth(),
      displayHeight: await track.getDisplayHeight(),
      rotation: await track.getRotation(),
      frameCount: index.frameCount,
      frameRate: metrics.underlyingFrameRate ?? metrics.bestGuessFrameRate ?? index.meanFrameRate(),
      constantFrameRate: metrics.frameRateIsConstant,
      color: {
        primaries: color.primaries ?? null,
        transfer: color.transfer ?? null,
        matrix: color.matrix ?? null,
        fullRange: color.fullRange ?? null,
      },
      hdr: await track.hasHighDynamicRange(),
      decodable,
    },
  };
}

export interface ProbedAudio {
  probe: AudioProbe;
  track: InputAudioTrack;
  config: AudioDecoderConfig | null;
}

export async function probeAudio(track: InputAudioTrack): Promise<ProbedAudio> {
  const codec = (await track.getCodec()) ?? '';
  const config = await track.getDecoderConfig();
  const decodable =
    isPcm(codec) ||
    (config !== null && (await supported(() => AudioDecoder.isConfigSupported(config))));
  return {
    track,
    config,
    probe: {
      codec,
      codecString: await track.getCodecParameterString(),
      sampleRate: await track.getSampleRate(),
      channels: await track.getNumberOfChannels(),
      decodable,
    },
  };
}

/** Browsers show GIF frames shorter than this for 100 ms, as old GIFs expect. */
const shortestFrameUs = 10_000;

/**
 * Measures an image. An animated one (GIF, WebP, APNG) is decoded once to learn
 * when each frame starts; `frames` is then their index, and `durationUs` a loop.
 */
export async function probeImage(
  ref: MediaSourceRef,
  type: string,
): Promise<{ probe: ImageProbe; frames: FrameIndex | null; durationUs: number }> {
  if (!(await ImageDecoder.isTypeSupported(type)))
    throw new Error(`${type} images can't be decoded here`);
  const decoder = new ImageDecoder({ data: await readAll(ref), type });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const { image } = await decoder.decode({ frameIndex: 0 });
    const frameCount = track?.frameCount ?? 1;
    const probe = {
      codec: type.split('/')[1],
      width: image.displayWidth,
      height: image.displayHeight,
      frameCount,
    };
    image.close();
    if (!track?.animated || frameCount < 2) return { probe, frames: null, durationUs: 0 };
    const starts: number[] = [];
    let at = 0;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const { image } = await decoder.decode({ frameIndex });
      const duration = image.duration ?? 0;
      image.close();
      starts.push(at);
      at += duration > shortestFrameUs ? duration : 100_000;
    }
    return { probe, frames: FrameIndex.fromTimestamps(starts), durationUs: at };
  } finally {
    decoder.close();
  }
}

export interface ProbeResult {
  probe: MediaProbe;
  input: Input | null;
  video: ProbedVideo | null;
  audio: ProbedAudio | null;
  /** An animated image's frames, by when each starts in its loop. */
  frames?: FrameIndex | null;
}

/** Measures a file for the media library. `input` stays open for decoding. */
export async function probeMedia(
  id: string,
  ref: MediaSourceRef,
  open: () => Promise<Input>,
): Promise<ProbeResult> {
  const name = sourceName(ref);
  const size = await sourceSize(ref);
  const base = { id, name, size, source: sourceKind(ref) };
  const type = imageType(name);
  if (type) {
    const { probe: image, frames, durationUs } = await probeImage(ref, type);
    return {
      probe: {
        ...base,
        container: image.codec,
        durationSeconds: durationUs / 1e6,
        video: null,
        audio: null,
        image,
      },
      input: null,
      video: null,
      audio: null,
      frames,
    };
  }
  const native = ref.kind === 'url' ? ref.probe : undefined;
  const input = await open();
  try {
    if (!(await input.canRead())) {
      // Desktop: FFmpeg can read more containers than Mediabunny; such files go through a proxy.
      if (native) {
        input.dispose();
        return {
          probe: { ...base, ...native, image: null },
          input: null,
          video: null,
          audio: null,
        };
      }
      throw new Error(`${name} is not a supported audio or video file`);
    }
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    const video = videoTrack ? await probeVideo(videoTrack) : null;
    const audio = audioTrack ? await probeAudio(audioTrack) : null;
    return {
      probe: {
        ...base,
        container: containerName(await input.getFormat()),
        durationSeconds: await input.computeDuration(),
        video: video?.probe ?? null,
        audio: audio?.probe ?? null,
        image: null,
      },
      input,
      video,
      audio,
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

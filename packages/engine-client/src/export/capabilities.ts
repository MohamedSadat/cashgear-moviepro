import {
  audioBitrate,
  audioCodecString,
  videoCodecString,
  type ExportAudioCodec,
  type ExportVideoCodec,
} from './settings';

/** How this browser can encode each codec at a given frame size. */
export interface EncoderSupport {
  video: Partial<Record<ExportVideoCodec, 'hardware' | 'software'>>;
  audio: Partial<Record<ExportAudioCodec, true>>;
}

const videoCodecs: ExportVideoCodec[] = ['avc', 'hevc', 'vp9', 'av1'];

async function supported(check: () => Promise<{ supported?: boolean }>) {
  try {
    return (await check()).supported === true;
  } catch {
    return false;
  }
}

/** Asks the browser which codecs it encodes at `width` × `height` and `frameRate`. */
export async function probeEncoders(
  width: number,
  height: number,
  frameRate: number,
  sampleRate: number,
  channels: number,
): Promise<EncoderSupport> {
  const support: EncoderSupport = { video: {}, audio: { 'pcm-s16': true } };
  if (typeof VideoEncoder === 'function')
    await Promise.all(
      videoCodecs.map(async (codec) => {
        const bitrate = 8e6;
        const config: VideoEncoderConfig = {
          codec: videoCodecString(codec, width, height, frameRate, bitrate),
          width,
          height,
          bitrate,
          framerate: frameRate,
        };
        if (
          await supported(() =>
            VideoEncoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-hardware' }),
          )
        )
          support.video[codec] = 'hardware';
        else if (await supported(() => VideoEncoder.isConfigSupported(config)))
          support.video[codec] = 'software';
      }),
    );
  if (typeof AudioEncoder === 'function')
    for (const codec of ['aac', 'opus'] as const)
      if (
        await supported(() =>
          AudioEncoder.isConfigSupported({
            codec: audioCodecString(codec),
            sampleRate,
            numberOfChannels: channels,
            bitrate: audioBitrate(codec, channels),
          }),
        )
      )
        support.audio[codec] = true;
  return support;
}

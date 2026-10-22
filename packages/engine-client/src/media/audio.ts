import { EncodedPacketSink, type InputAudioTrack } from 'mediabunny';
import { isPcm } from './probe';
import { decodePcm, PeakAccumulator } from './waveform';

const maxQueuedChunks = 16;

/** Decodes a whole audio track and reduces it to waveform peaks. */
export async function computePeaks(
  track: InputAudioTrack,
): Promise<{ sampleRate: number; peaks: Int8Array }> {
  const codec = (await track.getCodec()) ?? '';
  const sampleRate = await track.getSampleRate();
  const channels = await track.getNumberOfChannels();
  const accumulator = new PeakAccumulator(sampleRate);
  const sink = new EncodedPacketSink(track);

  if (isPcm(codec)) {
    for await (const packet of sink.packets()) {
      const planes = decodePcm(codec, packet.data, channels);
      accumulator.add(planes, planes[0]?.length ?? 0);
    }
    return { sampleRate, peaks: accumulator.finish() };
  }

  const config = await track.getDecoderConfig();
  if (!config) throw new Error(`No decoder configuration for ${codec} audio`);
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        const frames = data.numberOfFrames;
        const planes = Array.from({ length: data.numberOfChannels }, (_, plane) => {
          const buffer = new Float32Array(frames);
          data.copyTo(buffer, { planeIndex: plane, format: 'f32-planar' });
          return buffer;
        });
        accumulator.add(planes, frames);
      } finally {
        data.close();
      }
    },
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
      wake?.();
    },
  });
  decoder.addEventListener('dequeue', () => wake?.());
  try {
    decoder.configure(config);
    for await (const packet of sink.packets()) {
      if (failure) throw failure;
      while (decoder.decodeQueueSize >= maxQueuedChunks)
        await new Promise<void>((resolve) => (wake = resolve));
      decoder.decode(packet.toEncodedAudioChunk());
    }
    await decoder.flush();
    if (failure) throw failure;
    return { sampleRate, peaks: accumulator.finish() };
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
}

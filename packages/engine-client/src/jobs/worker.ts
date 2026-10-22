// Background media jobs: filmstrip thumbnails and waveform peaks. They run in
// their own worker so they never compete with the engine worker's playback.
import { expose, transfer } from 'comlink';
import { EncodedPacketSink } from 'mediabunny';
import { computePeaks } from '../media/audio';
import { imageType, openInput, readAll, sourceName } from '../media/sources';
import { encodeThumbnail, filmstripTimes } from '../media/thumbnail';
import type { MediaSourceRef } from '../media/types';
import { peaksPerSecond } from '../media/waveform';
import type { JobsApi, Filmstrip, Waveform } from './types';

const thumbnailHeight = 90;

async function decodeKeyFrames(
  config: VideoDecoderConfig,
  chunks: EncodedVideoChunk[],
  onFrame: (frame: VideoFrame, index: number) => Promise<void>,
) {
  const frames: VideoFrame[] = [];
  let failure: unknown = null;
  const decoder = new VideoDecoder({
    output: (frame) => frames.push(frame),
    error: (error) => (failure = error),
  });
  try {
    decoder.configure(config);
    for (const [index, chunk] of chunks.entries()) {
      // Key frames only, each flushed on its own: no reordering, no reference frames to keep.
      decoder.decode(chunk);
      await decoder.flush();
      if (failure) throw failure;
      const frame = frames.shift();
      if (!frame) continue;
      try {
        await onFrame(frame, index);
      } finally {
        frame.close();
      }
      for (const extra of frames.splice(0)) extra.close();
    }
  } finally {
    for (const frame of frames) frame.close();
    if (decoder.state !== 'closed') decoder.close();
  }
}

const api: JobsApi = {
  async filmstrip(source: MediaSourceRef): Promise<Filmstrip> {
    const type = imageType(sourceName(source));
    if (type) {
      const decoder = new ImageDecoder({ data: await readAll(source), type });
      try {
        const { image } = await decoder.decode({ frameIndex: 0 });
        try {
          const jpeg = await encodeThumbnail(image, 0, thumbnailHeight);
          return transfer({ times: [0], images: [jpeg] }, [jpeg.buffer]);
        } finally {
          image.close();
        }
      } finally {
        decoder.close();
      }
    }
    const input = await openInput(source);
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return { times: [], images: [] };
      const config = await track.getDecoderConfig();
      if (!config) return { times: [], images: [] };
      const rotation = await track.getRotation();
      const sink = new EncodedPacketSink(track);
      const first = await track.getFirstTimestamp();
      const times = filmstripTimes(await track.computeDuration(), first);
      const chunks: EncodedVideoChunk[] = [];
      const keyTimes: number[] = [];
      let previous = -1;
      for (const time of times) {
        const key = await sink.getKeyPacket(time, { verifyKeyPackets: true });
        // Short clips may have one key frame for several sample times; thumbnail it once.
        if (!key || key.sequenceNumber === previous) continue;
        previous = key.sequenceNumber;
        chunks.push(key.toEncodedVideoChunk());
        keyTimes.push(key.timestamp);
      }
      const images: Uint8Array[] = [];
      await decodeKeyFrames(config, chunks, async (frame) => {
        images.push(await encodeThumbnail(frame, rotation, thumbnailHeight));
      });
      return transfer(
        { times: keyTimes.slice(0, images.length), images },
        images.map((image) => image.buffer as ArrayBuffer),
      );
    } finally {
      input.dispose();
    }
  },

  async waveform(source: MediaSourceRef): Promise<Waveform | null> {
    const input = await openInput(source);
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) return null;
      const { sampleRate, peaks } = await computePeaks(track);
      return transfer({ sampleRate, peaksPerSecond, peaks }, [peaks.buffer]);
    } finally {
      input.dispose();
    }
  },
};
expose(api);

import type { EncodedPacketSink } from 'mediabunny';
import { drawsWhole } from './frames';

/** Mean differences (8-bit levels) between a frame's edge and its padding taken as equal. */
const lumaTolerance = 4;
const chromaTolerance = 2;
/** How long the first frame may take before the check gives up. */
const timeoutMs = 3000;

/**
 * Whether the browser draws this track's hardware frames wrongly. Frames coded
 * larger than they show (see `drawsWhole`) are converted with the padding's
 * chroma in their last row or column. Encoders that repeat the edge into the
 * padding (Media Foundation) still convert exactly; those that pad with black
 * (OpenH264) do not. Decodes the first key frame once, in hardware.
 */
export async function paddingShows(
  sink: EncodedPacketSink,
  config: VideoDecoderConfig,
): Promise<boolean> {
  const packet = await sink.getFirstPacket({ verifyKeyPackets: true });
  if (!packet) return false;
  let decoder: VideoDecoder | null = null;
  try {
    const frame = await new Promise<VideoFrame | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const done = (frame: VideoFrame | null) => {
        clearTimeout(timer);
        resolve(frame);
      };
      decoder = new VideoDecoder({ output: done, error: () => done(null) });
      decoder.configure({ ...config, hardwareAcceleration: 'prefer-hardware' });
      decoder.decode(packet.toEncodedVideoChunk());
      decoder.flush().catch(() => done(null));
    });
    if (!frame) return false;
    try {
      return await edgeDiffers(frame);
    } finally {
      frame.close();
    }
  } catch {
    return false;
  } finally {
    const opened = decoder as VideoDecoder | null;
    if (opened && opened.state !== 'closed') opened.close();
  }
}

/** Compares the last two rows (or columns) shown with the first two of the padding. */
async function edgeDiffers(frame: VideoFrame): Promise<boolean> {
  const shown = frame.visibleRect!;
  if (drawsWhole(frame) || (frame.format !== 'NV12' && frame.format !== 'I420')) return false;
  const nv12 = frame.format === 'NV12';
  const below = shown.height + 2 <= frame.codedHeight;
  const beside = shown.width + 2 <= frame.codedWidth;
  for (const rows of [true, false]) {
    if (rows ? !below : !beside) continue;
    const rect = rows
      ? { x: 0, y: shown.height - 2, width: shown.width, height: 4 }
      : { x: shown.width - 2, y: 0, width: 4, height: shown.height };
    const data = new Uint8Array(frame.allocationSize({ rect }));
    const layout = await frame.copyTo(data, { rect });
    const length = rows ? rect.width : rect.height;
    // Mean difference between lines `a` and `b` (rows or columns) of one channel.
    const differs = (plane: number, a: number, b: number, count: number, step = 1, channel = 0) => {
      const { offset, stride } = layout[plane];
      const at = (line: number, i: number) =>
        rows
          ? data[offset + line * stride + i * step + channel]
          : data[offset + i * stride + line * step + channel];
      let total = 0;
      for (let i = 0; i < count; i++) total += Math.abs(at(a, i) - at(b, i));
      return total / count;
    };
    // Luma lines 1 and 2 are the last shown and the first padding; chroma lines 0 and 1.
    const luma = differs(0, 1, 2, length);
    const chroma = nv12
      ? (differs(1, 0, 1, length / 2, 2, 0) + differs(1, 0, 1, length / 2, 2, 1)) / 2
      : (differs(1, 0, 1, length / 2) + differs(2, 0, 1, length / 2)) / 2;
    if (luma > lumaTolerance || chroma > chromaTolerance) return true;
  }
  return false;
}

// A QuickTime or MP4 file's start timecode: the `tmcd` track cameras and
// FFmpeg write, whose first sample is the frame number of the first frame,
// counted from midnight. Mediabunny does not read it.

/** Reads bytes `start` to `end` of a file. */
export type ByteReader = (start: number, end: number) => Promise<Uint8Array>;

/** A start timecode: seconds from midnight, and the frames a second it counts. */
export interface StartTimecode {
  seconds: number;
  /** Rounded frames a second (24, 25, 30…), as the timecode counts them. */
  fps: number;
  dropFrame: boolean;
}

interface Box {
  type: string;
  /** Where its content starts and ends in the file. */
  start: number;
  end: number;
}

/** Atom headers need at most 16 bytes; anything shorter is no atom. */
async function boxAt(read: ByteReader, at: number, limit: number): Promise<Box | null> {
  if (at + 8 > limit) return null;
  const head = await read(at, Math.min(limit, at + 16));
  if (head.length < 8) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let size = view.getUint32(0);
  const type = String.fromCharCode(...head.subarray(4, 8));
  let header = 8;
  if (size === 1) {
    if (head.length < 16) return null;
    size = Number(view.getBigUint64(8));
    header = 16;
  } else if (size === 0) {
    size = limit - at;
  }
  if (size < header || at + size > limit) return null;
  return { type, start: at + header, end: at + size };
}

/** The child boxes of `[start, end)` in `data`, read from memory. */
function children(data: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    boxes.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

function child(data: Uint8Array, box: Box | undefined, type: string): Box | undefined {
  return box ? children(data, box.start, box.end).find((entry) => entry.type === type) : undefined;
}

/**
 * The start timecode of the file `read` reads, `size` bytes long; null when it
 * has no `tmcd` track.
 */
export async function readStartTimecode(
  read: ByteReader,
  size: number,
): Promise<StartTimecode | null> {
  // The movie box, wherever it is among the top-level boxes.
  let at = 0;
  let movie: Box | null = null;
  for (let count = 0; count < 64 && at < size; count++) {
    const box = await boxAt(read, at, size);
    if (!box) return null;
    if (box.type === 'moov') {
      movie = box;
      break;
    }
    at = box.end;
  }
  if (!movie || movie.end - movie.start > 64 << 20) return null;
  const data = await read(movie.start, movie.end);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (const track of children(data, 0, data.length).filter((box) => box.type === 'trak')) {
    const media = child(data, track, 'mdia');
    const table = child(data, child(data, media, 'minf'), 'stbl');
    const descriptions = child(data, table, 'stsd');
    if (!descriptions || descriptions.end - descriptions.start < 8 + 34) continue;
    // A full box (4 bytes), an entry count (4), then the first sample entry.
    const entry = descriptions.start + 8;
    if (String.fromCharCode(...data.subarray(entry + 4, entry + 8)) !== 'tmcd') continue;
    // The entry's header (8), reserved (6), data reference (2), reserved (4).
    const flags = view.getUint32(entry + 20);
    const timescale = view.getUint32(entry + 24);
    const frameDuration = view.getUint32(entry + 28);
    const fps = data[entry + 32];
    if (!timescale || !frameDuration || !fps) continue;
    // The first sample: the first chunk's offset holds a 32-bit frame number.
    const offsets = child(data, table, 'stco') ?? child(data, table, 'co64');
    if (!offsets || view.getUint32(offsets.start + 4) === 0) continue;
    const offset =
      offsets.type === 'co64'
        ? Number(view.getBigUint64(offsets.start + 8))
        : view.getUint32(offsets.start + 8);
    const sample = await read(offset, offset + 4);
    if (sample.length < 4) continue;
    const frame = new DataView(sample.buffer, sample.byteOffset, 4).getUint32(0);
    return {
      seconds: (frame * frameDuration) / timescale,
      fps,
      dropFrame: (flags & 1) === 1,
    };
  }
  return null;
}

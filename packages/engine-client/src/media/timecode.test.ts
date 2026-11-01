import { describe, expect, it } from 'vitest';
import { readStartTimecode, type ByteReader } from './timecode';

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  values.forEach((value, index) => new DataView(out.buffer).setUint32(index * 4, value));
  return out;
}

/** A file with a `tmcd` track whose first sample (in `mdat`) is `frame`. */
function movie(
  frame: number,
  rate: { timescale: number; duration: number; fps: number },
  drop = false,
) {
  const ftyp = box('ftyp', new TextEncoder().encode('qt  '), u32(0));
  const mdat = box('mdat', u32(frame));
  const sampleAt = ftyp.length + 8;
  const entry = box(
    'tmcd',
    new Uint8Array(6),
    new Uint8Array([0, 1]),
    u32(0, drop ? 1 : 0, rate.timescale, rate.duration),
    new Uint8Array([rate.fps, 0]),
  );
  const table = box(
    'stbl',
    box('stsd', u32(0, 1), entry),
    box('stsc', u32(0, 1, 1, 1, 1)),
    box('stsz', u32(0, 4, 1)),
    box('stco', u32(0, 1, sampleAt)),
  );
  const track = box('trak', box('mdia', box('minf', table)));
  // A video track first, as cameras write.
  const video = box('trak', box('mdia', box('minf', box('stbl', box('stsd', u32(0, 0))))));
  const file = new Uint8Array(ftyp.length + mdat.length);
  file.set(ftyp);
  file.set(mdat, ftyp.length);
  const moov = box('moov', video, track);
  const all = new Uint8Array(file.length + moov.length);
  all.set(file);
  all.set(moov, file.length);
  return all;
}

const reader =
  (bytes: Uint8Array): ByteReader =>
  async (start, end) =>
    bytes.subarray(start, Math.min(end, bytes.length));

describe('start timecode', () => {
  it('reads the frame number of a tmcd track as seconds from midnight', async () => {
    // 01:00:10:12 at 25 fps.
    const frame = (3600 + 10) * 25 + 12;
    const bytes = movie(frame, { timescale: 25, duration: 1, fps: 25 });
    expect(await readStartTimecode(reader(bytes), bytes.length)).toEqual({
      seconds: 3610.48,
      fps: 25,
      dropFrame: false,
    });
  });

  it('counts 29.97 frames at their own length, and says when they drop', async () => {
    const bytes = movie(107_892, { timescale: 30_000, duration: 1001, fps: 30 }, true);
    const found = await readStartTimecode(reader(bytes), bytes.length);
    expect(found?.dropFrame).toBe(true);
    expect(found?.seconds).toBeCloseTo((107_892 * 1001) / 30_000, 9);
  });

  it('is null without a timecode track', async () => {
    const bytes = movie(0, { timescale: 25, duration: 1, fps: 25 }).slice();
    // Rename the tmcd entry: the file then has no timecode.
    const at = bytes.findIndex(
      (_, i) =>
        bytes[i] === 116 && bytes[i + 1] === 109 && bytes[i + 2] === 99 && bytes[i + 3] === 100,
    );
    bytes.set([97, 118, 99, 49], at);
    expect(await readStartTimecode(reader(bytes), bytes.length)).toBeNull();
  });
});

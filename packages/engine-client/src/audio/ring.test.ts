import { describe, expect, it } from 'vitest';
import {
  buffered,
  C,
  consistent,
  createRing,
  flush,
  H,
  heardFrame,
  publish,
  readQuantum,
  ringViews,
  writeFrames,
  type ClockMemo,
} from './ring';

/** Interleaved stereo frames whose left channel counts from `from` and right is its negative. */
function frames(from: number, count: number) {
  const data = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    data[i * 2] = from + i;
    data[i * 2 + 1] = -(from + i);
  }
  return data;
}

function quantum(size = 128) {
  return [new Float32Array(size), new Float32Array(size)];
}

describe('audio ring', () => {
  it('plays written frames in order across the wrap-around', () => {
    const ring = ringViews(createRing(256, 2, 48000));
    expect(writeFrames(ring, frames(0, 200), 200)).toBe(200);
    const out = quantum();
    readQuantum(ring, out, 1);
    expect(Array.from(out[0].subarray(0, 3))).toEqual([0, 1, 2]);
    expect(out[1][127]).toBe(-127);
    // 72 frames left; 184 free, so 150 more fit and wrap past the end.
    expect(writeFrames(ring, frames(200, 150), 150)).toBe(150);
    expect(buffered(ring)).toBe(222);
    readQuantum(ring, out, 2);
    expect(out[0][0]).toBe(128);
    expect(out[0][127]).toBe(255);
    readQuantum(ring, out, 3);
    expect(Array.from(out[0].subarray(0, 2))).toEqual([256, 257]);
    // That read drained the ring: it takes 256 more frames and no more.
    expect(buffered(ring)).toBe(0);
    expect(writeFrames(ring, frames(0, 400), 400)).toBe(256);
  });

  it('pads short reads with silence and counts them only while sound is expected', () => {
    const ring = ringViews(createRing(256, 2, 48000));
    writeFrames(ring, frames(1, 10), 10);
    const out = quantum();
    out[0].fill(9);
    readQuantum(ring, out, 1);
    expect(out[0][9]).toBe(10);
    expect(out[0][10]).toBe(0);
    expect(ring.header[H.underruns]).toBe(0);
    Atomics.store(ring.header, H.active, 1);
    readQuantum(ring, out, 2);
    expect(ring.header[H.underruns]).toBe(1);
  });

  it('a flush drops what is unplayed and plays what follows it', () => {
    const ring = ringViews(createRing(256, 2, 48000));
    writeFrames(ring, frames(0, 200), 200);
    const start = flush(ring);
    expect(start).toBe(200);
    writeFrames(ring, frames(1000, 50), 50);
    const out = quantum();
    readQuantum(ring, out, 1);
    expect(out[0][0]).toBe(1000);
    expect(ring.header[H.read]).toBe(250);
  });

  it('copies mono rings to every output channel', () => {
    const ring = ringViews(createRing(64, 1, 48000));
    writeFrames(ring, Float32Array.from([0.5, 0.25]), 2);
    const out = quantum(4);
    readQuantum(ring, out, 1);
    expect(Array.from(out[1].subarray(0, 2))).toEqual([0.5, 0.25]);
  });

  it('tells which ring frame is heard from the worklet and device timestamps', () => {
    const ring = ringViews(createRing(48000, 2, 48000));
    expect(heardFrame(ring, 1000)).toBeNull();
    // The worklet rendered ring frame 4,800 at context time 2.1 s; the device plays
    // context time 2.0 s at page time 10,000 ms (100 ms of output latency).
    readQuantumAt(ring, 2.1, 4800);
    publish(ring.header, H.outputSeq, () => {
      ring.clock[C.outputContextTime] = 2.0;
      ring.clock[C.outputPerfTime] = 10_000;
    });
    expect(heardFrame(ring, 10_000)).toBeCloseTo(0, 6);
    expect(heardFrame(ring, 10_250)).toBeCloseTo(12_000, 6);
  });

  it('keeps the last reading when a writer is caught mid-update', () => {
    const ring = ringViews(createRing(48000, 2, 48000));
    readQuantumAt(ring, 1, 0);
    publish(ring.header, H.outputSeq, () => {
      ring.clock[C.outputContextTime] = 1;
      ring.clock[C.outputPerfTime] = 5000;
    });
    const memo: ClockMemo = {};
    expect(heardFrame(ring, 5100, memo)).toBeCloseTo(4800, 6);
    // The page is paused half way through its next update.
    Atomics.add(ring.header, H.outputSeq, 1);
    ring.clock[C.outputPerfTime] = 99_999;
    expect(consistent(ring.header, H.outputSeq, () => 1)).toBeNull();
    expect(heardFrame(ring, 5200, memo)).toBeCloseTo(9600, 6);
    expect(heardFrame(ring, 5200)).toBeNull();
  });
});

/** Records that the worklet played ring frame `frame` at `contextTime`. */
function readQuantumAt(ring: ReturnType<typeof ringViews>, contextTime: number, frame: number) {
  ring.header[H.read] = frame;
  ring.header[H.write] = frame;
  readQuantum(ring, quantum(), contextTime);
}

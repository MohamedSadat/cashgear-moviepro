import { describe, expect, it } from 'vitest';
import { readBarcode } from './barcode';
import { DecoderPool } from './decoder-pool';
import { FrameCache } from './frame-cache';
import { FrameIndex } from './frame-index';
import { ManagedFrame, openFrameCount, type FrameLike } from './frames';
import { filmstripTimes } from './thumbnail';
import { decodePcm, PeakAccumulator } from './waveform';

class FakeFrame implements FrameLike {
  closed = false;
  constructor(
    readonly timestamp: number,
    private size = 100,
  ) {}
  clone() {
    return new FakeFrame(this.timestamp, this.size);
  }
  close() {
    this.closed = true;
  }
  allocationSize() {
    return this.size;
  }
}

describe('ManagedFrame', () => {
  it('counts open frames and closes each exactly once', () => {
    const before = openFrameCount();
    const raw = new FakeFrame(1000);
    const frame = ManagedFrame.wrap(raw);
    const copy = frame.clone();
    expect(openFrameCount()).toBe(before + 2);
    frame.close();
    frame.close();
    expect(raw.closed).toBe(true);
    expect(frame.closed).toBe(true);
    expect(() => frame.raw).toThrow('already closed');
    expect(copy.timestamp).toBe(1000);
    copy.close();
    expect(openFrameCount()).toBe(before);
  });
});

describe('FrameCache', () => {
  const entry = (bytes: number) => {
    const frame = { bytes, closed: false, close: () => (frame.closed = true) };
    return frame;
  };

  it('evicts least recently used entries over the byte budget and closes them', () => {
    const cache = new FrameCache<ReturnType<typeof entry>>(250);
    const a = entry(100);
    const b = entry(100);
    const c = entry(100);
    cache.put('a', a);
    cache.put('b', b);
    cache.get('a');
    cache.put('c', c);
    expect(b.closed).toBe(true);
    expect(cache.has('a') && cache.has('c')).toBe(true);
    expect(cache.bytes).toBe(200);
  });

  it('replaces, deletes by prefix, shrinks and clears, closing as it goes', () => {
    const cache = new FrameCache<ReturnType<typeof entry>>(1000);
    const old = entry(10);
    cache.put('m1:0', old);
    cache.put('m1:0', entry(10));
    expect(old.closed).toBe(true);
    cache.put('m1:1', entry(10));
    cache.put('m2:0', entry(10));
    cache.deletePrefix('m1:');
    expect(cache.size).toBe(1);
    cache.put('m2:1', entry(500));
    cache.setBudget(100);
    expect(cache.size).toBe(1);
    expect(cache.has('m2:1')).toBe(true);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});

describe('DecoderPool', () => {
  const decoder = () => {
    const d = { closed: false, close: () => (d.closed = true) };
    return d;
  };

  it('reuses one decoder per key and closes the least recently used', () => {
    const pool = new DecoderPool<ReturnType<typeof decoder>>(2);
    const a = pool.acquire('a', decoder);
    const b = pool.acquire('b', decoder);
    expect(pool.acquire('a', decoder)).toBe(a);
    const c = pool.acquire('c', decoder);
    expect(b.closed).toBe(true);
    expect(a.closed || c.closed).toBe(false);
    a.close();
    expect(pool.acquire('a', decoder)).not.toBe(a);
    pool.clear();
    expect(pool.size).toBe(0);
  });
});

describe('FrameIndex', () => {
  it('orders frames by presentation time whatever the decode order', () => {
    // Decode order of an IBBP stream: 0, 3, 1, 2, 6, 4, 5.
    const index = FrameIndex.fromTimestamps([0, 3, 1, 2, 6, 4, 5].map((n) => n * 40_000));
    expect(index.frameCount).toBe(7);
    expect(index.timestampOf(2)).toBe(80_000);
    expect(index.frameAt(0)).toBe(0);
    expect(index.frameAt(119_999)).toBe(2);
    expect(index.frameAt(120_000)).toBe(3);
    expect(index.frameAt(10_000_000)).toBe(6);
    expect(index.frameAt(-5)).toBe(0);
    expect(index.meanFrameRate()).toBeCloseTo(25);
    expect(() => index.timestampOf(7)).toThrow(RangeError);
    expect(() => index.timestampOf(1.5)).toThrow(RangeError);
  });

  it('builds from packet metadata', async () => {
    async function* packets() {
      for (const t of [33_367, 0, 66_733]) yield { microsecondTimestamp: t };
    }
    const index = await FrameIndex.fromPackets(packets());
    expect([0, 1, 2].map((n) => index.timestampOf(n))).toEqual([0, 33_367, 66_733]);
  });
});

describe('readBarcode', () => {
  const row = (value: number, width = 1920) => {
    const luma = new Uint8Array(width);
    for (let x = 0; x < width; x++)
      luma[x] = (value >> Math.floor((x * 16) / width)) & 1 ? 235 : 16;
    return luma;
  };

  it('reads the frame number from a luma row through the strip', () => {
    for (const value of [0, 1, 150, 299, 65535]) expect(readBarcode(row(value), 1920)).toBe(value);
    expect(readBarcode(row(150, 1280), 1280)).toBe(150);
  });

  it('refuses mid-grey pixels', () => {
    expect(readBarcode(new Uint8Array(1920).fill(128), 1920)).toBe(-1);
  });
});

describe('waveform', () => {
  it('reduces samples to int8 min/max pairs per bucket', () => {
    const peaks = new PeakAccumulator(200); // 2 samples per bucket at 100 peaks/s
    peaks.add([Float32Array.of(0.5, -0.25, 1, 0), Float32Array.of(-1, 0, 0.1, 0.2)], 4);
    peaks.add([Float32Array.of(0.3)], 1);
    expect([...peaks.finish()]).toEqual([-127, 64, 0, 127, 38, 38]);
  });

  it('decodes interleaved PCM', () => {
    const s16 = new Uint8Array(new Int16Array([16384, -32768, 0, 32767]).buffer);
    const [left, right] = decodePcm('pcm-s16', s16, 2);
    expect([...left]).toEqual([0.5, 0]);
    expect(right[0]).toBe(-1);
    expect(right[1]).toBeCloseTo(1, 4);

    const s24 = Uint8Array.of(0x00, 0x00, 0x80, 0xff, 0xff, 0x7f);
    expect([...decodePcm('pcm-s24', s24, 1)[0]]).toEqual([-1, 8388607 / 8388608]);

    const f32be = new Uint8Array(4);
    new DataView(f32be.buffer).setFloat32(0, 0.75, false);
    expect([...decodePcm('pcm-f32be', f32be, 1)[0]]).toEqual([0.75]);

    expect([...decodePcm('pcm-u8', Uint8Array.of(128, 0), 1)[0]]).toEqual([0, -1]);
    expect(() => decodePcm('pcm-s12', s16, 1)).toThrow('Unsupported PCM');
  });
});

describe('filmstripTimes', () => {
  it('spreads one thumbnail per 2 s, between 1 and 20', () => {
    expect(filmstripTimes(10)).toEqual([1, 3, 5, 7, 9]);
    expect(filmstripTimes(0.5)).toEqual([0.25]);
    expect(filmstripTimes(600)).toHaveLength(20);
    expect(filmstripTimes(4, 1)).toEqual([2, 4]);
  });
});

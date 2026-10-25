import { describe, expect, it } from 'vitest';
import { levelDb, MeterQueue, parseReadings, type MeterReading } from './meters';
import { encodeWav, recordingOffset, type Recording } from './recorder';

describe('meter readings', () => {
  it('parse the mixer layout with any number of tracks', () => {
    const flat = [
      ...[
        480, -20, -21, -22, 0.5, 0.4, 0.3, 0.2, 2, 7, 0.1, 0.1, 0.05, 0.05, 9, 0.2, 0.2, 0.1, 0.1,
      ],
      ...[960, -19, -20, -21, 0.6, 0.5, 0.4, 0.3, 0],
    ];
    const readings = parseReadings(flat);
    expect(readings).toHaveLength(2);
    expect(readings[0]).toEqual({
      sample: 480,
      momentary: -20,
      shortTerm: -21,
      integrated: -22,
      master: { peak: [0.5, 0.4], rms: [0.3, 0.2] },
      tracks: [
        { id: 7, level: { peak: [0.1, 0.1], rms: [0.05, 0.05] } },
        { id: 9, level: { peak: [0.2, 0.2], rms: [0.1, 0.1] } },
      ],
    });
    expect(readings[1].tracks).toEqual([]);
  });

  it('wait in a queue until their sample is heard', () => {
    const reading = (sample: number): MeterReading => ({
      sample,
      momentary: 0,
      shortTerm: 0,
      integrated: 0,
      master: { peak: [0, 0], rms: [0, 0] },
      tracks: [],
    });
    const queue = new MeterQueue();
    queue.push([480, 960, 1440, 1920].map(reading));
    expect(queue.at(400)).toBeNull();
    expect(queue.at(1000)?.sample).toBe(960);
    // Older readings went; the one heard stays until a newer one is due.
    expect(queue.at(1000)?.sample).toBe(960);
    expect(queue.at(5000)?.sample).toBe(1920);
    queue.clear();
    expect(queue.at(5000)).toBeNull();
  });

  it('keep the highest peak of the readings a display skipped', () => {
    const reading = (sample: number, peak: number): MeterReading => ({
      sample,
      momentary: sample,
      shortTerm: 0,
      integrated: 0,
      master: { peak: [peak, peak / 2], rms: [peak / 4, peak / 4] },
      tracks: [{ id: 3, level: { peak: [peak, peak], rms: [0, 0] } }],
    });
    const queue = new MeterQueue();
    queue.push([reading(480, 0.2), reading(960, 0.9), reading(1440, 0.1)]);
    const shown = queue.at(1500)!;
    expect(shown.sample).toBe(1440);
    expect(shown.momentary).toBe(1440);
    expect(shown.master.peak).toEqual([0.9, 0.45]);
    expect(shown.master.rms).toEqual([0.025, 0.025]);
    expect(shown.tracks[0].level.peak).toEqual([0.9, 0.9]);
  });

  it('show levels in decibels with a floor', () => {
    expect(levelDb(1)).toBe(0);
    expect(levelDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(levelDb(0)).toBe(-96);
    expect(levelDb(1e-9, -60)).toBe(-60);
  });
});

describe('voiceover recordings', () => {
  const recording = (anchor: Recording['anchor'], latency: number): Recording => ({
    rate: 48_000,
    planes: [new Float32Array(48_000 * 6)],
    firstFrame: 100_000,
    anchor,
    latency,
  });

  it('line up with the sample the speakers played when they were captured', () => {
    // Timeline sample 240,000 (5 s) was rendered at context frame 250,000; the
    // speakers and microphone add 30 ms between them.
    const taken = recording({ frame: 250_000, sample: 240_000 }, 0.03);
    // Sample k was captured at frame 100,000 + k, against what was rendered 1,440
    // frames earlier: timeline sample 240,000 + (100,000 + k - 1,440 - 250,000).
    expect(recordingOffset(taken, 240_000)).toBe(151_440);
    expect(recordingOffset(taken, 240_000 + 48_000)).toBe(151_440 + 48_000);
    expect(recordingOffset(recording(null, 0.03), 240_000)).toBe(0);
  });

  it('become 16-bit WAV files', () => {
    const wav = encodeWav([new Float32Array([0, 0.5, -1, 2]), new Float32Array(4)], 48_000);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(40, true)).toBe(16);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 4, true))).toEqual([
      0, 16384, -32767, 32767,
    ]);
  });
});

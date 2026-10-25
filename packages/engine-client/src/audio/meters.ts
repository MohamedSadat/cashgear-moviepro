/** Linear levels of one channel pair (the second is the first for mono). */
export interface MeterLevel {
  peak: [number, number];
  rms: [number, number];
}

/**
 * One reading of the mixer's meters, at the end of a 10 ms hop of the timeline.
 * Loudness is in LUFS (-200 for silence); levels are linear, after each track's
 * volume, pan and ducking.
 */
export interface MeterReading {
  /** The timeline sample just after the hop. */
  sample: number;
  momentary: number;
  shortTerm: number;
  /** Since playback started. */
  integrated: number;
  master: MeterLevel;
  tracks: { id: number; level: MeterLevel }[];
}

/** Reads `Mixer.take_readings`' flat layout. */
export function parseReadings(flat: ArrayLike<number>): MeterReading[] {
  const readings: MeterReading[] = [];
  let at = 0;
  const level = (): MeterLevel => {
    const value: MeterLevel = {
      peak: [flat[at], flat[at + 1]],
      rms: [flat[at + 2], flat[at + 3]],
    };
    at += 4;
    return value;
  };
  while (at < flat.length) {
    const sample = flat[at];
    const momentary = flat[at + 1];
    const shortTerm = flat[at + 2];
    const integrated = flat[at + 3];
    at += 4;
    const master = level();
    const count = flat[at++];
    const tracks: MeterReading['tracks'] = [];
    for (let i = 0; i < count; i++) {
      const id = flat[at++];
      tracks.push({ id, level: level() });
    }
    readings.push({ sample, momentary, shortTerm, integrated, master, tracks });
  }
  return readings;
}

const maxPeaks = (a: MeterLevel, b: MeterLevel): MeterLevel => ({
  peak: [Math.max(a.peak[0], b.peak[0]), Math.max(a.peak[1], b.peak[1])],
  rms: b.rms,
});

/**
 * Readings mixed ahead of the speakers, waiting for the moment they are heard.
 * `at(sample)` gives the latest reading at or before the sample heard, with the
 * highest peaks of every reading since the last call, so a display that updates
 * less often than readings come never misses a peak.
 */
export class MeterQueue {
  private readings: MeterReading[] = [];
  private last: MeterReading | null = null;

  push(readings: MeterReading[]) {
    for (const reading of readings) this.readings.push(reading);
    // Two seconds at most, should nothing read them.
    if (this.readings.length > 200) this.readings.splice(0, this.readings.length - 200);
  }

  clear() {
    this.readings = [];
    this.last = null;
  }

  at(sample: number): MeterReading | null {
    let count = 0;
    while (count < this.readings.length && this.readings[count].sample <= sample) count++;
    if (count === 0) return this.last;
    const heard = this.readings.splice(0, count);
    let merged = heard[0];
    for (const reading of heard.slice(1))
      merged = {
        ...reading,
        master: maxPeaks(merged.master, reading.master),
        tracks: reading.tracks.map((track) => {
          const before = merged.tracks.find((t) => t.id === track.id);
          return before ? { id: track.id, level: maxPeaks(before.level, track.level) } : track;
        }),
      };
    this.last = merged;
    return merged;
  }
}

/** Decibels of a linear level, with silence at `floor`. */
export function levelDb(value: number, floor = -96) {
  return value > 0 ? Math.max(floor, 20 * Math.log10(value)) : floor;
}

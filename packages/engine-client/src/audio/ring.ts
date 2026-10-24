// The audio ring: one SharedArrayBuffer the engine worker fills with mixed PCM
// and the audio worklet plays. It also carries the clock: the worklet records
// which ring frame it plays at which context time, and the page records when
// the device outputs a context time (getOutputTimestamp). Together they tell the
// worker which sample is heard at any moment, the master clock for playback.
//
// Counters are frame totals that wrap at 2^31 (about 12 hours at 48 kHz per
// play session; sessions start from zero after every flush).

/** The worklet's registered name. */
export const processorName = 'cgv-ring-player';

/** Int32 header slots. */
export const H = {
  /** Frames written by the worker. */
  write: 0,
  /** Frames read by the worklet. */
  read: 1,
  /** Bumped by the worker to make the worklet jump `read` to `flushTo`. */
  flush: 2,
  flushTo: 3,
  /** 1 while the worker expects continuous sound, so a short read is an underrun. */
  active: 4,
  underruns: 5,
  capacity: 6,
  channels: 7,
  /** The flush generation the worklet last applied. */
  seenFlush: 8,
  /** Seqlocks for the two clock pairs (odd while being written). */
  workletSeq: 9,
  outputSeq: 10,
} as const;
const headerInts = 16;

/** Float64 clock slots. */
export const C = {
  /** Context time at the start of the latest render quantum (worklet). */
  contextTime: 0,
  /** `read` at the start of that quantum (worklet). */
  readFrame: 1,
  /** getOutputTimestamp().contextTime (page). */
  outputContextTime: 2,
  /** getOutputTimestamp().performanceTime as absolute milliseconds (page). */
  outputPerfTime: 3,
  sampleRate: 4,
  /** 1 while the context is running (page). */
  running: 5,
  outputLatency: 6,
} as const;
const clockDoubles = 8;

export interface RingViews {
  header: Int32Array;
  clock: Float64Array;
  /** Interleaved samples. */
  data: Float32Array;
  capacity: number;
  channels: number;
}

/** A ring holding `capacity` frames of `channels`-channel audio. */
export function createRing(capacity: number, channels: number, sampleRate: number) {
  const bytes = headerInts * 4 + clockDoubles * 8 + capacity * channels * 4;
  const buffer = new SharedArrayBuffer(bytes);
  const views = ringViews(buffer, capacity, channels);
  views.header[H.capacity] = capacity;
  views.header[H.channels] = channels;
  views.clock[C.sampleRate] = sampleRate;
  return buffer;
}

export function ringViews(buffer: SharedArrayBuffer, capacity?: number, channels?: number) {
  const header = new Int32Array(buffer, 0, headerInts);
  const frames = capacity ?? header[H.capacity];
  const width = channels ?? header[H.channels];
  return {
    header,
    clock: new Float64Array(buffer, headerInts * 4, clockDoubles),
    data: new Float32Array(buffer, headerInts * 4 + clockDoubles * 8, frames * width),
    capacity: frames,
    channels: width,
  } satisfies RingViews;
}

/** Frames written but not yet read. */
export function buffered(ring: RingViews) {
  return (Atomics.load(ring.header, H.write) - Atomics.load(ring.header, H.read)) | 0;
}

/** Worker: appends interleaved samples. Returns how many frames fitted. */
export function writeFrames(ring: RingViews, samples: Float32Array, frames: number) {
  const { header, data, capacity, channels } = ring;
  const write = Atomics.load(header, H.write);
  const free = capacity - ((write - Atomics.load(header, H.read)) | 0);
  const count = Math.max(0, Math.min(frames, free));
  const start = (write >>> 0) % capacity;
  const first = Math.min(count, capacity - start);
  data.set(samples.subarray(0, first * channels), start * channels);
  if (count > first) data.set(samples.subarray(first * channels, count * channels), 0);
  Atomics.store(header, H.write, (write + count) | 0);
  return count;
}

/** Worker: drops everything unplayed. Returns the frame the next write starts at. */
export function flush(ring: RingViews) {
  const write = Atomics.load(ring.header, H.write);
  Atomics.store(ring.header, H.flushTo, write);
  Atomics.add(ring.header, H.flush, 1);
  return write;
}

/**
 * Worklet: fills `outputs` (one Float32Array per channel) for a render quantum
 * starting at `contextTime`. Missing frames are silent.
 */
export function readQuantum(ring: RingViews, outputs: Float32Array[], contextTime: number) {
  const { header, clock, data, capacity, channels } = ring;
  const generation = Atomics.load(header, H.flush);
  if (generation !== header[H.seenFlush]) {
    Atomics.store(header, H.read, Atomics.load(header, H.flushTo));
    header[H.seenFlush] = generation;
  }
  const read = Atomics.load(header, H.read);
  const frames = outputs[0]?.length ?? 0;
  publish(header, H.workletSeq, () => {
    clock[C.contextTime] = contextTime;
    clock[C.readFrame] = read;
  });
  const available = (Atomics.load(header, H.write) - read) | 0;
  const count = Math.max(0, Math.min(frames, available));
  const start = (read >>> 0) % capacity;
  for (let i = 0; i < count; i++) {
    const at = ((start + i) % capacity) * channels;
    for (let channel = 0; channel < outputs.length; channel++)
      outputs[channel][i] = data[at + Math.min(channel, channels - 1)];
  }
  for (const output of outputs) output.fill(0, count);
  if (count < frames && Atomics.load(header, H.active) === 1) Atomics.add(header, H.underruns, 1);
  Atomics.store(header, H.read, (read + count) | 0);
}

/** Writes a pair of clock values so readers never see half of an update. */
export function publish(header: Int32Array, seq: number, write: () => void) {
  Atomics.add(header, seq, 1);
  write();
  Atomics.add(header, seq, 1);
}

/** Reads clock values written with `publish`; null if a write kept interrupting. */
export function consistent<T>(header: Int32Array, seq: number, read: () => T): T | null {
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = Atomics.load(header, seq);
    if (before & 1) continue;
    const value = read();
    if (Atomics.load(header, seq) === before) return value;
  }
  return null;
}

/** The latest clock readings, kept for when a writer is caught mid-update. */
export interface ClockMemo {
  output?: { contextTime: number; perfTime: number };
  worklet?: { contextTime: number; readFrame: number };
}

/**
 * The ring frame the listener hears at absolute time `nowMs` (performance.timeOrigin
 * plus performance.now()), or null until the page has reported an output timestamp.
 * A writer paused mid-update (a garbage collection on the page, say) leaves its
 * pair unreadable for a moment; `memo` then supplies the previous reading.
 */
export function heardFrame(ring: RingViews, nowMs: number, memo: ClockMemo = {}): number | null {
  const { header, clock } = ring;
  const output = (memo.output =
    consistent(header, H.outputSeq, () => ({
      contextTime: clock[C.outputContextTime],
      perfTime: clock[C.outputPerfTime],
    })) ?? memo.output);
  const worklet = (memo.worklet =
    consistent(header, H.workletSeq, () => ({
      contextTime: clock[C.contextTime],
      readFrame: clock[C.readFrame],
    })) ?? memo.worklet);
  if (!output || !worklet || output.perfTime <= 0 || worklet.contextTime <= 0) return null;
  const rate = clock[C.sampleRate];
  // The context time being heard now, then the ring frame played at that time.
  const heardContextTime = output.contextTime + (nowMs - output.perfTime) / 1000;
  return worklet.readFrame + (heardContextTime - worklet.contextTime) * rate;
}

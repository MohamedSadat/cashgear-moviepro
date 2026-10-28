// Background removal's mattes, kept per media file in the origin-private file
// system under `ai-mattes/<media>/<model>/`, on the web and on the desktop
// alike: the engine and export workers read them while they draw. The AI
// worker writes a chunk file every two seconds of frames, each frame one byte
// of coverage a texel (deflated), then the index naming it, so a chunk the
// index names is complete.

/** What the index records. */
export interface MatteIndex {
  version: number;
  width: number;
  height: number;
  chunks: { file: string; first: number; last: number; count: number }[];
  /** Source-second ranges every frame of which has a matte, in order. */
  done: [number, number][];
}

/** One frame's matte: its source time and coverage. */
export interface Matte {
  time: number;
  width: number;
  height: number;
  data: Uint8Array;
}

/** Bumped when mattes change, so those made before are made again. */
export const matteVersion = 2;
const magic = 0x4d564743; // "CGVM", little-endian.
/** Frames a chunk holds at most. */
export const chunkFrames = 60;

async function folder(media: string, model: string, create: boolean) {
  let directory = await navigator.storage.getDirectory();
  for (const part of ['ai-mattes', media, model])
    directory = await directory.getDirectoryHandle(part, { create });
  return directory;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes as Uint8Array<ArrayBuffer>);
  await writable.close();
}

/** The index of a medium's mattes, or null when none were made. */
export async function readIndex(media: string, model: string): Promise<MatteIndex | null> {
  try {
    const directory = await folder(media, model, false);
    const file = await (await directory.getFileHandle('index.json')).getFile();
    const index = JSON.parse(await file.text()) as MatteIndex;
    return index.version === matteVersion ? index : null;
  } catch {
    return null;
  }
}

/** Whether every frame from `start` to `end` source seconds has a matte. */
export function covers(index: MatteIndex | null, start: number, end: number): boolean {
  return !!index?.done.some(([from, to]) => from <= start + 1e-6 && to >= end - 1e-6);
}

/** Adds a range to a list of ranges, joining those it touches. */
export function addRange(ranges: [number, number][], range: [number, number]): [number, number][] {
  const all = [...ranges, range].sort((a, b) => a[0] - b[0]);
  const joined: [number, number][] = [];
  for (const [from, to] of all) {
    const last = joined[joined.length - 1];
    if (last && from <= last[1] + 0.05) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined;
}

/** Writes a medium's mattes as they are made, a chunk at a time. */
export class MatteWriter {
  private frames: { time: number; data: Uint8Array }[] = [];
  private constructor(
    private readonly directory: FileSystemDirectoryHandle,
    private index: MatteIndex,
  ) {}

  /** A writer for `width` by `height` mattes, keeping what was made before at that size. */
  static async open(media: string, model: string, width: number, height: number) {
    const directory = await folder(media, model, true);
    let index = await readIndex(media, model);
    if (!index || index.width !== width || index.height !== height)
      index = { version: matteVersion, width, height, chunks: [], done: [] };
    return new MatteWriter(directory, index);
  }

  async add(time: number, data: Uint8Array) {
    this.frames.push({ time, data });
    if (this.frames.length >= chunkFrames) await this.flush();
  }

  /** Writes what is held, then the index, marking `range` done when given. */
  async flush(range?: [number, number]) {
    if (this.frames.length) {
      const frames = this.frames;
      this.frames = [];
      const packed = await Promise.all(frames.map((frame) => deflate(frame.data)));
      const header = 16 + frames.length * 12;
      const bytes = new Uint8Array(header + packed.reduce((sum, part) => sum + part.length, 0));
      const view = new DataView(bytes.buffer);
      view.setUint32(0, magic, true);
      view.setUint16(4, matteVersion, true);
      view.setUint16(6, frames.length, true);
      view.setUint32(8, this.index.width, true);
      view.setUint32(12, this.index.height, true);
      let at = header;
      frames.forEach((frame, i) => {
        view.setFloat64(16 + i * 8, frame.time, true);
        view.setUint32(16 + frames.length * 8 + i * 4, packed[i].length, true);
        bytes.set(packed[i], at);
        at += packed[i].length;
      });
      const first = frames[0].time;
      const file = `chunk-${Math.round(first * 1000)}.bin`;
      await writeFile(this.directory, file, bytes);
      this.index.chunks = this.index.chunks
        .filter((chunk) => chunk.file !== file)
        .concat({ file, first, last: frames[frames.length - 1].time, count: frames.length })
        .sort((a, b) => a.first - b.first);
    }
    if (range) this.index.done = addRange(this.index.done, range);
    await writeFile(
      this.directory,
      'index.json',
      new TextEncoder().encode(JSON.stringify(this.index)),
    );
  }
}

/**
 * Reads mattes for drawing: chunks are loaded and inflated ahead (`ensure`),
 * then each frame's matte is at hand at once (`at`). Keeps the few chunks
 * around the frames asked for.
 */
export class MatteReader {
  private indexes = new Map<string, { index: MatteIndex | null; read: number }>();
  private chunks = new Map<string, Promise<Matte[]>>();
  private ready = new Map<string, Matte[]>();
  private order: string[] = [];

  constructor(private readonly model = 'selfie') {}

  private async index(media: string, fresh = false): Promise<MatteIndex | null> {
    const known = this.indexes.get(media);
    // Mattes being made add chunks: look again after a second.
    if (known && !fresh && performance.now() - known.read < 1000) return known.index;
    const index = await readIndex(media, this.model);
    this.indexes.set(media, { index, read: performance.now() });
    return index;
  }

  /** The chunk holding `time`, if the index names one. */
  private chunkFor(index: MatteIndex, time: number) {
    return index.chunks.find((chunk, i) => {
      const next = index.chunks[i + 1];
      return time >= chunk.first - 1e-6 && (next ? time < next.first : time <= chunk.last + 1);
    });
  }

  /**
   * Whether `media` has a matte for `time` (made, if not yet loaded), as far as
   * the index last read says.
   */
  made(media: string, time: number): boolean {
    return covers(this.indexes.get(media)?.index ?? null, time, time);
  }

  /** Loads the chunks holding `time` and the next `ahead` seconds. */
  async ensure(media: string, time: number, ahead = 2): Promise<void> {
    const index = await this.index(media);
    if (!index) return;
    const wanted = new Set<string>();
    for (const chunk of index.chunks)
      if (chunk.last >= time - 0.1 && chunk.first <= time + ahead) wanted.add(chunk.file);
    await Promise.all([...wanted].map((file) => this.load(media, file)));
  }

  private load(media: string, file: string): Promise<Matte[]> {
    const key = `${media}/${file}`;
    let loading = this.chunks.get(key);
    if (!loading) {
      loading = (async () => {
        const directory = await folder(media, this.model, false);
        const bytes = new Uint8Array(
          await (await (await directory.getFileHandle(file)).getFile()).arrayBuffer(),
        );
        const view = new DataView(bytes.buffer);
        if (view.getUint32(0, true) !== magic) throw new Error(`${file} is not a matte chunk`);
        const count = view.getUint16(6, true);
        const width = view.getUint32(8, true);
        const height = view.getUint32(12, true);
        const header = 16 + count * 12;
        let at = header;
        const parts: { time: number; packed: Uint8Array }[] = [];
        for (let i = 0; i < count; i++) {
          const size = view.getUint32(16 + count * 8 + i * 4, true);
          parts.push({
            time: view.getFloat64(16 + i * 8, true),
            packed: bytes.subarray(at, at + size),
          });
          at += size;
        }
        const mattes = await Promise.all(
          parts.map(async ({ time, packed }) => ({
            time,
            width,
            height,
            data: await inflate(packed),
          })),
        );
        this.ready.set(key, mattes);
        this.order = [...this.order.filter((k) => k !== key), key];
        // Four chunks (eight seconds) stay inflated.
        while (this.order.length > 4) {
          const old = this.order.shift()!;
          this.ready.delete(old);
          this.chunks.delete(old);
        }
        return mattes;
      })();
      loading.catch(() => this.chunks.delete(key));
      this.chunks.set(key, loading);
    }
    return loading;
  }

  /**
   * The matte of the frame showing at `time`, if loaded: the last one at or
   * before it (within a frame's worth of slack).
   */
  at(media: string, time: number): Matte | null {
    const known = this.indexes.get(media)?.index;
    if (!known) return null;
    const chunk = this.chunkFor(known, time);
    const mattes = chunk ? this.ready.get(`${media}/${chunk.file}`) : undefined;
    if (!mattes?.length) return null;
    let best: Matte | null = null;
    for (const matte of mattes) if (matte.time <= time + 1e-3) best = matte;
    return best ?? mattes[0];
  }

  /** Forgets loaded mattes (a file relinked or its mattes made again). */
  forget(media?: string) {
    for (const key of [...this.ready.keys()])
      if (!media || key.startsWith(media + '/')) {
        this.ready.delete(key);
        this.chunks.delete(key);
      }
    if (media) this.indexes.delete(media);
    else this.indexes.clear();
    this.order = this.order.filter((key) => this.ready.has(key));
  }
}

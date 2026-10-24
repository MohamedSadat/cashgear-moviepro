// What the timeline draws inside clips: filmstrip images and waveform peaks, kept
// ready for the canvas. They come from the jobs worker through the media library.

/**
 * Decoded filmstrip images by object URL. They are decoded off the main thread
 * (`createImageBitmap`), so a filmstrip coming into view never stalls a frame.
 */
export class ImageCache {
  private images = new Map<string, ImageBitmap | null>();

  constructor(private readonly onLoad: () => void) {}

  /** The image for `url` once it is decoded; starts decoding it otherwise. */
  get(url: string): ImageBitmap | null {
    if (!this.images.has(url)) {
      this.images.set(url, null);
      fetch(url)
        .then((response) => response.blob())
        .then((blob) => createImageBitmap(blob))
        .then((bitmap) => {
          this.images.set(url, bitmap);
          this.onLoad();
        })
        .catch(() => {});
    }
    return this.images.get(url) ?? null;
  }
}

/**
 * Waveform peaks at halving resolutions: level 0 is the original [min, max]
 * pairs, and each level above pairs up the one below. Drawing picks the level
 * with about one pair per pixel, so any zoom costs the same.
 */
export class PeakPyramid {
  readonly levels: Int8Array[];

  constructor(
    peaks: Int8Array,
    readonly peaksPerSecond: number,
  ) {
    this.levels = [peaks];
    let level = peaks;
    while (level.length > 4) {
      const pairs = Math.ceil(level.length / 4);
      const next = new Int8Array(pairs * 2);
      for (let i = 0; i < pairs; i++) {
        const a = 4 * i;
        const hasB = a + 2 < level.length;
        next[2 * i] = hasB ? Math.min(level[a], level[a + 2]) : level[a];
        next[2 * i + 1] = hasB ? Math.max(level[a + 1], level[a + 3]) : level[a + 1];
      }
      this.levels.push(next);
      level = next;
    }
  }

  /**
   * The [min, max] of the source between `from` and `to` seconds, read from the
   * level with about `perPixel` pairs or fewer per step. Values are -127 to 127.
   */
  range(from: number, to: number, perPixel: number): [number, number] {
    const levelIndex = Math.max(
      0,
      Math.min(this.levels.length - 1, Math.floor(Math.log2(Math.max(1, perPixel)))),
    );
    const level = this.levels[levelIndex];
    const rate = this.peaksPerSecond / 2 ** levelIndex;
    const pairs = level.length / 2;
    const start = Math.max(0, Math.floor(from * rate));
    const end = Math.min(pairs, Math.max(start + 1, Math.ceil(to * rate)));
    let min = 0;
    let max = 0;
    for (let i = start; i < end; i++) {
      if (level[2 * i] < min) min = level[2 * i];
      if (level[2 * i + 1] > max) max = level[2 * i + 1];
    }
    return [min, max];
  }
}

/** Waveform pyramids, built once per peaks array. */
export class PeakCache {
  private pyramids = new WeakMap<Int8Array, PeakPyramid>();

  get(peaks: Int8Array, peaksPerSecond: number): PeakPyramid {
    let pyramid = this.pyramids.get(peaks);
    if (!pyramid) {
      pyramid = new PeakPyramid(peaks, peaksPerSecond);
      this.pyramids.set(peaks, pyramid);
    }
    return pyramid;
  }
}

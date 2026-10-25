// Every VideoFrame the engine creates is wrapped so it is closed exactly once
// and counted while open. A leaked frame stalls hardware decoders, so the open
// count is shown in the dev overlay and checked by the seek stress test.

let openFrames = 0;

/** The minimal part of VideoFrame the wrapper needs; tests substitute fakes. */
export interface FrameLike {
  readonly timestamp: number;
  clone(): FrameLike;
  close(): void;
  allocationSize(): number;
}

export class ManagedFrame<F extends FrameLike = VideoFrame> {
  private frame: F | null;
  readonly timestamp: number;
  readonly bytes: number;

  private constructor(frame: F) {
    this.frame = frame;
    this.timestamp = frame.timestamp;
    this.bytes = safeAllocationSize(frame);
    openFrames++;
  }

  static wrap<F extends FrameLike>(frame: F): ManagedFrame<F> {
    return new ManagedFrame(frame);
  }

  get closed() {
    return this.frame === null;
  }

  /** The underlying frame, for drawing or handing to the GPU. Do not close it. */
  get raw(): F {
    if (!this.frame) throw new Error('Frame is already closed');
    return this.frame;
  }

  /** An independent reference the caller must close. */
  clone(): ManagedFrame<F> {
    return ManagedFrame.wrap(this.raw.clone() as F);
  }

  close() {
    if (!this.frame) return;
    this.frame.close();
    this.frame = null;
    openFrames--;
  }
}

/**
 * Copies a decoder output into memory the page owns, in its own pixel format
 * (NV12 or I420, about 1.5 bytes per pixel). Decoders have a small, fixed pool of
 * output surfaces; frames kept for later (the frame cache) must not hold one, or
 * the decoder stalls waiting for it.
 *
 * Do not draw these copies with canvas `drawImage`: for CPU-backed YUV frames
 * Chrome converts with the BT.601 matrix whatever the colour space says. Read
 * their planes (`readPlanes`), or convert them on the GPU with their own matrix.
 */
export async function detachFrame(frame: VideoFrame): Promise<VideoFrame> {
  // Opaque GPU frames (format null) can only be read back as RGBA.
  const options: VideoFrameCopyToOptions = frame.format
    ? {}
    : { format: 'RGBA', colorSpace: 'srgb' };
  const buffer = new Uint8Array(frame.allocationSize(options));
  const layout = await frame.copyTo(buffer, options);
  return new VideoFrame(buffer, {
    format: options.format ?? frame.format!,
    codedWidth: frame.visibleRect!.width,
    codedHeight: frame.visibleRect!.height,
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
    timestamp: frame.timestamp,
    duration: frame.duration ?? undefined,
    colorSpace: options.format
      ? { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true }
      : frame.colorSpace.toJSON(),
    layout,
  });
}

/** The parts of a decoder frame `drawsWhole` reads; tests substitute fakes. */
export type FrameRect = Pick<VideoFrame, 'codedWidth' | 'codedHeight' | 'visibleRect'>;

/**
 * Whether the browser may draw a hardware decoder frame as it is. Chrome converts
 * a frame coded larger than it shows (1080p H.264 is coded 1088 rows high) by
 * sampling chroma across the padding, so its last visible row shows its colour a
 * quarter weaker. Such frames take their planes, converted by the compositor.
 */
export function drawsWhole(frame: FrameRect): boolean {
  const rect = frame.visibleRect;
  return (
    !!rect &&
    rect.x === 0 &&
    rect.y === 0 &&
    rect.width === frame.codedWidth &&
    rect.height === frame.codedHeight
  );
}

export interface Planes {
  width: number;
  height: number;
  /** Full-resolution luma, then quarter-resolution Cb and Cr (I420 order). */
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

/**
 * The raw 4:2:0 planes of a rectangle of an 8-bit NV12 or I420 frame, with no
 * colour conversion. `rect` must start and end on even coordinates.
 */
export async function readPlanes(frame: VideoFrame, rect: DOMRectInit): Promise<Planes> {
  if (frame.format !== 'NV12' && frame.format !== 'I420')
    throw new Error(`Cannot read planes of ${frame.format ?? 'opaque'} frames`);
  const width = rect.width!;
  const height = rect.height!;
  const buffer = new Uint8Array(frame.allocationSize({ rect }));
  const layout = await frame.copyTo(buffer, { rect });
  const plane = (index: number, w: number, h: number, step = 1, offset = 0) => {
    const out = new Uint8Array(w * h);
    const { offset: start, stride } = layout[index];
    for (let row = 0; row < h; row++)
      for (let col = 0; col < w; col++)
        out[row * w + col] = buffer[start + row * stride + col * step + offset];
    return out;
  };
  const y = plane(0, width, height);
  const chromaWidth = width / 2;
  const chromaHeight = height / 2;
  if (frame.format === 'I420')
    return {
      width,
      height,
      y,
      u: plane(1, chromaWidth, chromaHeight),
      v: plane(2, chromaWidth, chromaHeight),
    };
  return {
    width,
    height,
    y,
    u: plane(1, chromaWidth, chromaHeight, 2, 0),
    v: plane(1, chromaWidth, chromaHeight, 2, 1),
  };
}

function safeAllocationSize(frame: FrameLike) {
  try {
    return frame.allocationSize();
  } catch {
    return 0;
  }
}

export function openFrameCount() {
  return openFrames;
}

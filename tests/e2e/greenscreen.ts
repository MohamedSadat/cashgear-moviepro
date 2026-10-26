import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';

// A synthetic green-screen test set with its ground truth. A person-like subject
// (skin, a blue shirt, dark hair with fine strands, a white card) stands before a
// screen; edges are antialiased from signed distances and mixed with the screen
// in linear light, as a camera sees them. Each scenario is encoded as H.264
// 4:2:0 by the pinned LGPL FFmpeg, so the keyer sees what real footage gives it.
// Nothing here is a recording, so nothing needs licensing or a release.

export const width = 640;
export const height = 360;
export const frames = 15;
/** The frame scored: the middle one, between keyframes and with motion on both sides. */
export const shown = 7;

export interface Scenario {
  name: string;
  /** Light falling off towards the corners, folds and a slight hue drift. */
  uneven?: boolean;
  /** Pixels the subject moves each frame; a 180° shutter blurs half of that. */
  motion?: number;
  /** Green light bounced onto the subject, as a share of the screen's. */
  spill?: number;
  /** Sensor noise, in 8-bit levels (standard deviation). */
  noise?: number;
  bitrate: string;
}

export const scenarios: Scenario[] = [
  { name: 'even', bitrate: '4M' },
  { name: 'uneven', uneven: true, bitrate: '4M' },
  { name: 'motion', motion: 18, bitrate: '4M' },
  { name: 'spill', spill: 0.3, uneven: true, bitrate: '4M' },
  { name: 'noise', noise: 5, uneven: true, bitrate: '1500k' },
];

/** The screen, as sRGB levels: a typical lit chroma-key green. */
export const screen = [26, 170, 74];
/** What the keyed subject goes over: a purple that shows green fringes and grey halos. */
export const background = [118, 52, 150];

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toLevel = (v: number) => {
  const c = Math.min(1, Math.max(0, v));
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
};

const skin = [222, 170, 138].map(toLinear);
const shirt = [52, 78, 128].map(toLinear);
const hair = [58, 40, 30].map(toLinear);
const card = [240, 240, 234].map(toLinear);
const screenLinear = screen.map(toLinear);

// Signed distances in pixels: negative inside.
function ellipse(px: number, py: number, rx: number, ry: number) {
  const k0 = Math.hypot(px / rx, py / ry);
  const k1 = Math.hypot(px / (rx * rx), py / (ry * ry));
  return k1 === 0 ? -Math.min(rx, ry) : (k0 * (k0 - 1)) / k1;
}

function box(px: number, py: number, hx: number, hy: number, r: number) {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function segment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

const coverage = (d: number) => Math.max(0, Math.min(1, 0.5 - d));

/** Hair strands: short bent lines leaving the top of the head, as [ax, ay, bx, by, cx, cy]. */
const strands: number[][] = Array.from({ length: 22 }, (_, i) => {
  const angle = Math.PI * (1.08 + (0.84 * i) / 21);
  const length = 14 + ((i * 37) % 17);
  const bend = ((i % 3) - 1) * 0.35;
  const [sx, sy] = [Math.cos(angle) * 54, 118 + Math.sin(angle) * 50];
  const [mx, my] = [
    sx + Math.cos(angle + bend) * length * 0.5,
    sy + Math.sin(angle + bend) * length * 0.5,
  ];
  const [ex, ey] = [
    mx + Math.cos(angle + bend * 2) * length * 0.5,
    my + Math.sin(angle + bend * 2) * length * 0.5,
  ];
  return [sx, sy, mx, my, ex, ey];
});

/**
 * The subject at a point relative to its centre: premultiplied linear colour and
 * coverage, its layers put over one another back to front.
 */
function subject(px: number, py: number): [number, number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const over = (cover: number, color: number[]) => {
    if (cover <= 0) return;
    r = color[0] * cover + r * (1 - cover);
    g = color[1] * cover + g * (1 - cover);
    b = color[2] * cover + b * (1 - cover);
    a = cover + a * (1 - cover);
  };
  if (px < -150 || px > 215 || py < 50) return [0, 0, 0, 0];
  over(coverage(ellipse(px, py - 345, 135, 125)), shirt);
  over(coverage(box(px, py - 215, 22, 32, 8)), skin);
  over(coverage(ellipse(px, py - 140, 50, 62)), skin);
  over(coverage(Math.max(ellipse(px, py - 118, 56, 52), py - 112)), hair);
  if (py < 140)
    for (const [ax, ay, bx, by, cx, cy] of strands) {
      const d = Math.min(segment(px, py, ax, ay, bx, by), segment(px, py, bx, by, cx, cy));
      if (d < 2) over(coverage(d - 0.45) * 0.85, hair);
    }
  over(coverage(box(px - 165, py - 255, 40, 56, 6)), card);
  return [r, g, b, a];
}

/** The screen's linear colour at a pixel. */
function screenAt(x: number, y: number, uneven: boolean): number[] {
  if (!uneven) return screenLinear;
  const u = x / width;
  const v = y / height;
  const light =
    0.84 +
    0.28 * Math.exp(-((u - 0.42) ** 2 + (v - 0.45) ** 2) / 0.12) +
    0.035 * Math.sin(u * 31 + v * 9);
  // Warmer at the top, where the lights are.
  return [screenLinear[0] * (1 + 0.25 * (0.5 - v)), screenLinear[1], screenLinear[2]].map(
    (c) => c * light,
  );
}

/** A repeatable random generator (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Truth {
  /** The subject's coverage at each pixel of the shown frame. */
  alpha: Float32Array;
  /** The subject composited over `background`, as sRGB levels (RGB). */
  composite: Float32Array;
}

/** Every frame of `scenario` as RGB bytes, and the shown frame's truth. */
export function renderScenario(scenario: Scenario): { video: Buffer; truth: Truth } {
  const video = Buffer.alloc(width * height * 3 * frames);
  const alpha = new Float32Array(width * height);
  const composite = new Float32Array(width * height * 3);
  const backgroundLinear = background.map(toLinear);
  const motion = scenario.motion ?? 0;
  // A 180° shutter: eight instants across half the frame's travel.
  const offsets = motion ? Array.from({ length: 8 }, (_, i) => ((i + 0.5) / 8 - 0.5) * 0.5) : [0];
  const noise = random(7);
  const gaussian = () => Math.sqrt(-2 * Math.log(1 - noise())) * Math.cos(2 * Math.PI * noise());
  for (let f = 0; f < frames; f++) {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let [r, g, b, a] = [0, 0, 0, 0];
        for (const offset of offsets) {
          const cx = 260 + motion * (f - shown + offset);
          const [sr, sg, sb, sa] = subject(x + 0.5 - cx, y + 0.5);
          r += sr / offsets.length;
          g += sg / offsets.length;
          b += sb / offsets.length;
          a += sa / offsets.length;
        }
        const i = y * width + x;
        if (f === shown) {
          alpha[i] = a;
          composite[i * 3] = toLevel(r + (1 - a) * backgroundLinear[0]);
          composite[i * 3 + 1] = toLevel(g + (1 - a) * backgroundLinear[1]);
          composite[i * 3 + 2] = toLevel(b + (1 - a) * backgroundLinear[2]);
        }
        const lit = screenAt(x, y, !!scenario.uneven);
        // Bounced screen light tints the subject, more where it is lighter.
        const spill = (scenario.spill ?? 0) * a * 0.6;
        const camera = [
          r + (1 - a) * lit[0] + spill * lit[0],
          g + (1 - a) * lit[1] + spill * lit[1],
          b + (1 - a) * lit[2] + spill * lit[2],
        ];
        const o = (f * width * height + i) * 3;
        for (let c = 0; c < 3; c++) {
          const level = toLevel(camera[c]) + (scenario.noise ? gaussian() * scenario.noise : 0);
          video[o + c] = Math.max(0, Math.min(255, Math.round(level)));
        }
      }
  }
  return { video, truth: { alpha, composite } };
}

/** Encodes RGB frames as H.264 High 4:2:0, tagged BT.709 limited range, at 30 fps. */
export function encode(ffmpeg: string, video: Buffer, bitrate: string, file: string) {
  const result = spawnSync(
    ffmpeg,
    [
      '-y',
      '-v',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${width}x${height}`,
      '-r',
      '30',
      '-i',
      '-',
      '-vf',
      'scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd+full_chroma_int,' +
        'format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      '-c:v',
      'libopenh264',
      '-profile:v',
      'high',
      '-b:v',
      bitrate,
      '-g',
      String(frames),
      '-movflags',
      '+faststart',
      file,
    ],
    { input: video, maxBuffer: 1 << 28 },
  );
  if (result.status !== 0) throw new Error(`Encoding ${file} failed: ${String(result.stderr)}`);
}

/** The background still, as a PNG. */
export function backgroundPng(): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = background[0];
    png.data[i * 4 + 1] = background[1];
    png.data[i * 4 + 2] = background[2];
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** Distance in pixels from each pixel to the nearest one on the other side of the subject's edge. */
function edgeDistance(alpha: Float32Array): Float32Array {
  // Two-pass chamfer distance to the nearest edge pixel (one partly covered, or
  // next to a pixel on the other side).
  const far = 1e6;
  const d = new Float32Array(width * height).fill(far);
  const inside = (i: number) => alpha[i] >= 0.5;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const partial = alpha[i] > 0.002 && alpha[i] < 0.998;
      const boundary =
        (x > 0 && inside(i - 1) !== inside(i)) || (y > 0 && inside(i - width) !== inside(i));
      if (partial || boundary) d[i] = 0;
    }
  const step = (i: number, j: number, cost: number) => {
    if (d[j] + cost < d[i]) d[i] = d[j] + cost;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x > 0) step(i, i - 1, 1);
      if (y > 0) step(i, i - width, 1);
      if (x > 0 && y > 0) step(i, i - width - 1, 1.4142);
      if (x < width - 1 && y > 0) step(i, i - width + 1, 1.4142);
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x < width - 1) step(i, i + 1, 1);
      if (y < height - 1) step(i, i + width, 1);
      if (x < width - 1 && y < height - 1) step(i, i + width + 1, 1.4142);
      if (x > 0 && y < height - 1) step(i, i + width - 1, 1.4142);
    }
  return d;
}

export interface KeyScore {
  /** Mean matte error over the frame, 0 to 1. */
  matteMean: number;
  /** Mean matte error within 3 pixels of the subject's edge. */
  matteEdge: number;
  /** Shares of solid screen and solid subject (over 3 pixels from the edge) keyed wrongly by over 0.1. */
  screenLeaks: number;
  holes: number;
  /** Mean composite error in levels: on the screen, in the subject, within 3 pixels of the edge. */
  screenError: number;
  subjectError: number;
  edgeError: number;
  /** Green left on the subject: mean excess of G over max(R, B) above the truth's, and the share over 12 levels. */
  spillMean: number;
  spillShare: number;
}

/** Scores a keyed render (`result`) and its matte view (`matte`) against the truth. */
export function scoreKey(
  truth: Truth,
  result: { data: Uint8Array },
  matte: { data: Uint8Array },
): KeyScore {
  const distance = edgeDistance(truth.alpha);
  let matteSum = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  let leaks = 0;
  let screenCount = 0;
  let holes = 0;
  let solidCount = 0;
  const error = { screen: 0, subject: 0, edge: 0 };
  let spillSum = 0;
  let spillOver = 0;
  let subjectCount = 0;
  for (let i = 0; i < width * height; i++) {
    const a = truth.alpha[i];
    const estimate = matte.data[i * 4] / 255;
    const miss = Math.abs(estimate - a);
    matteSum += miss;
    let difference = 0;
    for (let c = 0; c < 3; c++)
      difference = Math.max(
        difference,
        Math.abs(result.data[i * 4 + c] - truth.composite[i * 3 + c]),
      );
    if (distance[i] <= 3) {
      edgeSum += miss;
      edgeCount++;
      error.edge += difference;
    } else if (a < 0.5) {
      screenCount++;
      if (estimate > 0.1) leaks++;
      error.screen += difference;
    } else {
      solidCount++;
      if (estimate < 0.9) holes++;
      error.subject += difference;
    }
    if (a >= 0.5) {
      const [r, g, b] = [result.data[i * 4], result.data[i * 4 + 1], result.data[i * 4 + 2]];
      const [tr, tg, tb] = [
        truth.composite[i * 3],
        truth.composite[i * 3 + 1],
        truth.composite[i * 3 + 2],
      ];
      const excess = Math.max(0, g - Math.max(r, b) - Math.max(0, tg - Math.max(tr, tb)));
      spillSum += excess;
      if (excess > 12) spillOver++;
      subjectCount++;
    }
  }
  return {
    matteMean: matteSum / (width * height),
    matteEdge: edgeSum / edgeCount,
    screenLeaks: leaks / screenCount,
    holes: holes / solidCount,
    screenError: error.screen / screenCount,
    subjectError: error.subject / solidCount,
    edgeError: error.edge / edgeCount,
    spillMean: spillSum / subjectCount,
    spillShare: spillOver / subjectCount,
  };
}

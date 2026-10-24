// Generates the built-in pack's binary assets, so no third-party art or LUT
// licences are involved: the luma-wipe gradients (8-bit greyscale PNGs) and the
// built-in looks (17-point .cube LUTs). Run it after changing a generator; the
// outputs are committed.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { root } from './lib.mjs';

const SIZE = 256;

/** Smooth value noise in [0, 1], repeatable. */
function noise(x, y) {
  const hash = (i, j) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * u;
  const b = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * u;
  return a + (b - a) * v;
}

/** Each gradient maps a point (x, y from 0 to 1, y down) to the time it is revealed. */
const gradients = {
  // Clockwise from twelve o'clock.
  clock: (x, y) => {
    const angle = Math.atan2(x - 0.5, 0.5 - y);
    return (angle < 0 ? angle + 2 * Math.PI : angle) / (2 * Math.PI);
  },
  iris: (x, y) => Math.hypot(x - 0.5, y - 0.5) / Math.SQRT1_2,
  diamond: (x, y) => Math.abs(x - 0.5) + Math.abs(y - 0.5),
  diagonal: (x, y) => (x + y) / 2,
  blinds: (_x, y) => (y * 8) % 1,
  clouds: (x, y) => {
    let sum = 0;
    let scale = 4;
    let weight = 0.5;
    for (let octave = 0; octave < 5; octave++) {
      sum += noise(x * scale + 11, y * scale + 7) * weight;
      scale *= 2;
      weight /= 2;
    }
    return sum;
  },
};

async function writeGradient(name, at) {
  const values = new Float64Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      values[y * SIZE + x] = at((x + 0.5) / SIZE, (y + 0.5) / SIZE);
    }
  }
  // Rank the levels so the reveal moves at an even pace whatever the pattern.
  const order = [...values.keys()].sort((a, b) => values[a] - values[b]);
  const data = Buffer.alloc(SIZE * SIZE);
  order.forEach((index, rank) => {
    data[index] = Math.round((rank / (order.length - 1)) * 255);
  });
  const png = new PNG({
    width: SIZE,
    height: SIZE,
    colorType: 0,
    inputColorType: 0,
    inputHasAlpha: false,
  });
  png.data = data;
  const bytes = PNG.sync.write(png, { colorType: 0, inputColorType: 0, inputHasAlpha: false });
  const folder = join(root, 'assets/transitions/luma-wipe/gradients');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, name + '.png'), bytes);
}

const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const clamp = (v) => Math.min(1, Math.max(0, v));
const saturate = (rgb, amount) => {
  const y = luma(rgb);
  return rgb.map((c) => y + (c - y) * amount);
};
const contrast = (rgb, amount) => rgb.map((c) => (c - 0.5) * amount + 0.5);
const sCurve = (c) => c * c * (3 - 2 * c);

/** Each look maps sRGB-encoded colour to sRGB-encoded colour. */
const looks = {
  warm: ['Warm', ([r, g, b]) => [r * 1.06 + 0.01, g * 1.01, b * 0.9]],
  cool: ['Cool', ([r, g, b]) => [r * 0.92, g * 0.99, b * 1.07 + 0.01]],
  'teal-orange': [
    'Teal & Orange',
    (rgb) => {
      const y = luma(rgb);
      const shadow = (1 - y) * (1 - y);
      const highlight = y * y;
      const toned = [
        rgb[0] - 0.07 * shadow + 0.08 * highlight,
        rgb[1] + 0.03 * shadow + 0.02 * highlight,
        rgb[2] + 0.07 * shadow - 0.09 * highlight,
      ];
      return saturate(toned, 1.12);
    },
  ],
  'bleach-bypass': [
    'Bleach Bypass',
    (rgb) => {
      const y = luma(rgb);
      const overlay = rgb.map((c) => (y < 0.5 ? 2 * c * y : 1 - 2 * (1 - c) * (1 - y)));
      return contrast(
        rgb.map((c, i) => c + (overlay[i] - c) * 0.6),
        1.12,
      );
    },
  ],
  'vintage-fade': [
    'Vintage Fade',
    (rgb) => {
      const faded = saturate(rgb, 0.78).map((c) => 0.08 + c * 0.86);
      return [faded[0] * 1.03, faded[1] * 1.0, faded[2] * 0.93 + 0.02];
    },
  ],
  'mono-contrast': [
    'High-Contrast Mono',
    (rgb) => [sCurve(clamp(luma(contrast(rgb, 1.1))))].flatMap((y) => [y, y, y]),
  ],
};

async function writeLook(id, name, map) {
  const points = 17;
  const lines = [
    `TITLE "${name}"`,
    '# CashGear Video built-in look, made by scripts/make-effect-assets.mjs',
    `LUT_3D_SIZE ${points}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  for (let b = 0; b < points; b++) {
    for (let g = 0; g < points; g++) {
      for (let r = 0; r < points; r++) {
        const input = [r, g, b].map((v) => v / (points - 1));
        lines.push(
          map(input)
            .map((c) => clamp(c).toFixed(6))
            .join(' '),
        );
      }
    }
  }
  const folder = join(root, 'assets/luts');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, id + '.cube'), lines.join('\n') + '\n');
}

for (const [name, at] of Object.entries(gradients)) await writeGradient(name, at);
for (const [id, [name, map]] of Object.entries(looks)) await writeLook(id, name, map);
console.log(
  `Wrote ${Object.keys(gradients).length} gradients and ${Object.keys(looks).length} looks.`,
);

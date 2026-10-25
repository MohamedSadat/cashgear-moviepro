// Writes the built-in stickers (assets/stickers/*.webp and stickers.json): two-second
// loops at 15 fps, 256×256, drawn frame by frame on a canvas in Chrome and encoded
// as animated WebP with alpha by the pinned LGPL FFmpeg. The emoji are Noto Emoji's
// images from its last commit under Apache-2.0 (the repository moved to the OFL in
// July 2024), animated here; the callouts and badges are drawn here. Run it after
// changing a sticker; the outputs are committed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { ffmpegTool, root } from './lib.mjs';

const out = join(root, 'assets/stickers');
const cache = join(root, '.tools/sticker-sources');
const commit = '41e31b110b4eb929dffb410264694a06205b7ad7';
const size = 256;
const fps = 15;
const frames = 30;

/** Emoji by code point, each with its animation. */
const emoji = [
  ['grinning', 'Grinning face', '1f600', 'bounce'],
  ['joy', 'Tears of joy', '1f602', 'wiggle'],
  ['heart-eyes', 'Heart eyes', '1f60d', 'pulse'],
  ['cool', 'Sunglasses', '1f60e', 'bounce'],
  ['thinking', 'Thinking', '1f914', 'tilt'],
  ['wow', 'Open mouth', '1f62e', 'pop'],
  ['crying', 'Crying', '1f622', 'droop'],
  ['angry', 'Angry', '1f621', 'shake'],
  ['thumbs-up', 'Thumbs up', '1f44d', 'bounce'],
  ['clap', 'Clapping', '1f44f', 'beat'],
  ['pray', 'Folded hands', '1f64f', 'float'],
  ['heart', 'Heart', '2764', 'heartbeat'],
  ['fire', 'Fire', '1f525', 'flicker'],
  ['star', 'Star', '2b50', 'spin'],
  ['party', 'Party popper', '1f389', 'shake'],
  ['hundred', 'Hundred points', '1f4af', 'pop'],
  ['check', 'Check mark', '2705', 'pop'],
  ['cross', 'Cross mark', '274c', 'shake'],
  ['eyes', 'Eyes', '1f440', 'look'],
  ['rocket', 'Rocket', '1f680', 'rocket'],
];

/** Drawn stickers: their names and categories. */
const drawn = [
  ['arrow', 'Pointing arrow', 'Callouts'],
  ['circle', 'Circle highlight', 'Callouts'],
  ['underline', 'Underline', 'Callouts'],
  ['bubble', 'Speech bubble', 'Callouts'],
  ['click', 'Click', 'Callouts'],
  ['new', 'New badge', 'Badges'],
  ['sale', 'Sale tag', 'Badges'],
  ['burst', 'Starburst', 'Badges'],
  ['tick', 'Done', 'Badges'],
  ['sparkles', 'Sparkles', 'Badges'],
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fetchCached(name, url) {
  await mkdir(cache, { recursive: true });
  const path = join(cache, name);
  if (existsSync(path)) return readFile(path);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(path, bytes);
  return bytes;
}

const raw = (path) => `https://raw.githubusercontent.com/googlefonts/noto-emoji/${commit}/${path}`;
const sources = {};
for (const [, , code] of emoji) {
  const name = `emoji_u${code}.png`;
  const bytes = await fetchCached(name, raw(`png/512/${name}`));
  sources[code] = { bytes: bytes.toString('base64'), sha256: sha256(bytes) };
}
const licence = await fetchCached('LICENSE', raw('LICENSE'));
if (!licence.toString().includes('Apache License'))
  throw new Error('Noto Emoji is not Apache-2.0 here');
const inter = await readFile(join(root, 'assets/fonts/inter/Inter-Variable.ttf'));

/** Runs in the page: draws frame `index` of sticker `id` and returns its PNG as base64. */
const pageScript = `
const TAU = Math.PI * 2;
const ease = (t) => t * t * (3 - 2 * t);
async function setUp(emoji, font) {
  window.images = {};
  for (const [code, b64] of Object.entries(emoji)) {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    window.images[code] = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  }
  const face = new FontFace('Sticker', Uint8Array.from(atob(font), (c) => c.charCodeAt(0)), { weight: '100 900' });
  await face.load();
  document.fonts.add(face);
}
function emojiFrame(ctx, s, code, kind, t) {
  const image = window.images[code];
  let x = 0, y = 0, sx = 1, sy = 1, r = 0, a = 1;
  const wave = Math.sin(TAU * t);
  switch (kind) {
    case 'bounce': { const h = Math.abs(Math.sin(TAU * t)); y = -0.12 * h; sy = 1 - 0.08 * (1 - h); sx = 1 + 0.06 * (1 - h); break; }
    case 'wiggle': r = 0.18 * Math.sin(TAU * t * 2); break;
    case 'pulse': sx = sy = 1 + 0.08 * wave; break;
    case 'tilt': r = 0.12 * wave; x = 0.02 * wave; break;
    case 'pop': sx = sy = 1 + 0.16 * Math.pow(Math.max(0, wave), 3); break;
    case 'droop': y = 0.03 * wave; sy = 1 - 0.04 * wave; break;
    case 'shake': x = 0.04 * Math.sin(TAU * t * 6) * (t < 0.5 ? 1 : 0.2); r = 0.05 * Math.sin(TAU * t * 6); break;
    case 'beat': sx = sy = 1 + 0.1 * Math.abs(Math.sin(TAU * t * 2)); break;
    case 'float': y = 0.05 * wave; r = 0.06 * Math.cos(TAU * t); break;
    case 'heartbeat': { const beat = (u) => Math.exp(-Math.pow(((u % 1) + 1) % 1 * 14, 2)); sx = sy = 1 + 0.14 * (beat(t) + 0.7 * beat(t - 0.2)); break; }
    case 'flicker': sy = 1 + 0.07 * Math.sin(TAU * t * 3); sx = 1 - 0.03 * Math.sin(TAU * t * 3); r = 0.04 * Math.sin(TAU * t * 2); break;
    case 'spin': r = TAU * t; break;
    case 'look': x = 0.06 * wave; break;
    case 'rocket': x = 0.03 * Math.sin(TAU * t * 2); y = -0.05 * wave; r = 0.05 * Math.sin(TAU * t * 2); break;
  }
  const box = s * 0.72;
  ctx.globalAlpha = a;
  ctx.translate(s / 2 + x * s, s / 2 + y * s + (kind === 'bounce' ? box * (1 - sy) / 2 : 0));
  ctx.rotate(r);
  ctx.scale(sx, sy);
  ctx.drawImage(image, -box / 2, -box / 2, box, box);
}
function star(ctx, points, outer, inner) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / points;
    const radius = i % 2 ? inner : outer;
    ctx[i ? 'lineTo' : 'moveTo'](Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  ctx.closePath();
}
function rounded(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function drawnFrame(ctx, s, id, t) {
  const wave = Math.sin(TAU * t);
  ctx.translate(s / 2, s / 2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (id) {
    case 'arrow': {
      ctx.translate(0.07 * s * wave, 0);
      ctx.fillStyle = '#ffd23f';
      ctx.strokeStyle = '#1b1b1b';
      ctx.lineWidth = s * 0.03;
      ctx.beginPath();
      const w = s * 0.62, t2 = s * 0.12, head = s * 0.26;
      ctx.moveTo(-w / 2, -t2 / 2); ctx.lineTo(w / 2 - head, -t2 / 2); ctx.lineTo(w / 2 - head, -head * 0.75);
      ctx.lineTo(w / 2, 0); ctx.lineTo(w / 2 - head, head * 0.75); ctx.lineTo(w / 2 - head, t2 / 2); ctx.lineTo(-w / 2, t2 / 2);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      break;
    }
    case 'circle': {
      const p = ease(Math.min(1, t / 0.55));
      ctx.globalAlpha = t > 0.85 ? (1 - t) / 0.15 : 1;
      ctx.strokeStyle = '#ff2d55';
      ctx.lineWidth = s * 0.045;
      ctx.beginPath();
      for (let i = 0; i <= 64 * p * 1.08; i++) {
        const angle = -2.2 + (i / 64) * TAU;
        const radius = s * (0.36 + 0.02 * Math.sin(angle * 3));
        ctx[i ? 'lineTo' : 'moveTo'](Math.cos(angle) * radius * 1.12, Math.sin(angle) * radius * 0.8);
      }
      ctx.stroke();
      break;
    }
    case 'underline': {
      const p = ease(Math.min(1, t / 0.5));
      ctx.globalAlpha = t > 0.85 ? (1 - t) / 0.15 : 1;
      ctx.strokeStyle = '#ffd23f';
      ctx.lineWidth = s * 0.06;
      ctx.beginPath();
      for (let i = 0; i <= 40 * p; i++) {
        const u = i / 40;
        const px = -s * 0.4 + u * s * 0.8;
        const py = s * 0.05 + Math.sin(u * Math.PI) * -s * 0.06 + u * s * 0.04;
        ctx[i ? 'lineTo' : 'moveTo'](px, py);
      }
      ctx.stroke();
      break;
    }
    case 'bubble': {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#1b1b1b';
      ctx.lineWidth = s * 0.025;
      rounded(ctx, -s * 0.36, -s * 0.26, s * 0.72, s * 0.42, s * 0.12);
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s * 0.12, s * 0.15); ctx.lineTo(-s * 0.2, s * 0.32); ctx.lineTo(0, s * 0.155); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.fillRect(-s * 0.13, s * 0.13, s * 0.14, s * 0.04);
      ctx.fillStyle = '#2b2b2b';
      for (let i = 0; i < 3; i++) {
        const lift = Math.max(0, Math.sin(TAU * (t - i * 0.12))) * s * 0.05;
        ctx.beginPath(); ctx.arc((i - 1) * s * 0.14, -s * 0.05 - lift, s * 0.045, 0, TAU); ctx.fill();
      }
      break;
    }
    case 'click': {
      for (let i = 0; i < 2; i++) {
        const u = (t + i * 0.5) % 1;
        ctx.globalAlpha = 1 - u;
        ctx.strokeStyle = '#3d8bfd';
        ctx.lineWidth = s * 0.03;
        ctx.beginPath(); ctx.arc(-s * 0.08, -s * 0.08, s * (0.05 + 0.3 * u), 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const press = Math.max(0, Math.sin(TAU * t)) * s * 0.02;
      ctx.translate(-s * 0.08 + press, -s * 0.08 + press);
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#1b1b1b'; ctx.lineWidth = s * 0.025;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(0, s * 0.36); ctx.lineTo(s * 0.09, s * 0.27); ctx.lineTo(s * 0.15, s * 0.4);
      ctx.lineTo(s * 0.2, s * 0.38); ctx.lineTo(s * 0.14, s * 0.25); ctx.lineTo(s * 0.26, s * 0.25); ctx.closePath();
      ctx.fill(); ctx.stroke();
      break;
    }
    case 'new': {
      const k = 1 + 0.07 * wave;
      ctx.scale(k, k); ctx.rotate(-0.12);
      ctx.fillStyle = '#e63946';
      star(ctx, 14, s * 0.4, s * 0.33); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.font = '800 ' + Math.round(s * 0.2) + 'px Sticker';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('NEW', 0, s * 0.01);
      break;
    }
    case 'sale': {
      ctx.translate(0, -s * 0.3); ctx.rotate(0.14 * wave); ctx.translate(0, s * 0.3);
      ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = '#1b1b1b'; ctx.lineWidth = s * 0.025;
      ctx.beginPath();
      ctx.moveTo(-s * 0.16, -s * 0.18); ctx.lineTo(s * 0.16, -s * 0.18); ctx.lineTo(s * 0.26, -s * 0.04);
      ctx.lineTo(s * 0.26, s * 0.32); ctx.lineTo(-s * 0.26, s * 0.32); ctx.lineTo(-s * 0.26, -s * 0.04); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -s * 0.06, s * 0.035, 0, TAU); ctx.fillStyle = '#1b1b1b'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(0, -s * 0.06); ctx.lineTo(0, -s * 0.34); ctx.stroke();
      ctx.fillStyle = '#1b1b1b'; ctx.font = '900 ' + Math.round(s * 0.13) + 'px Sticker';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('SALE', 0, s * 0.15);
      break;
    }
    case 'burst': {
      ctx.rotate((TAU * t) / 6);
      ctx.fillStyle = '#ff9f1c'; star(ctx, 12, s * 0.42, s * 0.3); ctx.fill();
      ctx.fillStyle = '#ffd23f'; star(ctx, 12, s * 0.32, s * 0.24); ctx.fill();
      break;
    }
    case 'tick': {
      const p = ease(Math.min(1, t / 0.45));
      ctx.fillStyle = '#1fbf6f';
      ctx.beginPath(); ctx.arc(0, 0, s * 0.36 * (0.9 + 0.1 * ease(Math.min(1, t / 0.2))), 0, TAU); ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = s * 0.07;
      ctx.beginPath();
      const points = [[-s * 0.16, 0], [-s * 0.04, s * 0.12], [s * 0.18, -s * 0.12]];
      const first = Math.min(1, p * 2), second = Math.max(0, p * 2 - 1);
      ctx.moveTo(...points[0]);
      ctx.lineTo(points[0][0] + (points[1][0] - points[0][0]) * first, points[0][1] + (points[1][1] - points[0][1]) * first);
      if (second > 0) ctx.lineTo(points[1][0] + (points[2][0] - points[1][0]) * second, points[1][1] + (points[2][1] - points[1][1]) * second);
      ctx.stroke();
      break;
    }
    case 'sparkles': {
      const spots = [[-0.18, -0.12, 0.2, 0], [0.2, -0.2, 0.13, 0.33], [0.12, 0.2, 0.16, 0.66]];
      for (const [px, py, r, phase] of spots) {
        const k = Math.max(0, Math.sin(TAU * (t + phase)));
        ctx.save(); ctx.translate(px * s, py * s); ctx.rotate(0.3 * k);
        ctx.globalAlpha = 0.25 + 0.75 * k;
        ctx.fillStyle = '#fff6b0';
        star(ctx, 4, r * s * (0.6 + 0.4 * k), r * s * 0.22); ctx.fill();
        ctx.restore();
      }
      break;
    }
  }
}
async function frame(kind, id, code, animation, index, frames, s) {
  const canvas = new OffscreenCanvas(s, s);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  const t = index / frames;
  if (kind === 'emoji') emojiFrame(ctx, s, code, animation, t);
  else drawnFrame(ctx, s, id, t);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
`;

const browser = await chromium.launch({ channel: 'chrome' });
const manifest = [];
try {
  const page = await browser.newPage();
  await page.setContent(`<script>${pageScript}</script>`);
  await page.evaluate(({ emoji, font }) => window.setUp(emoji, font), {
    emoji: Object.fromEntries(Object.entries(sources).map(([code, s]) => [code, s.bytes])),
    font: inter.toString('base64'),
  });
  await mkdir(out, { recursive: true });
  for (const file of await readdir(out)) if (file.endsWith('.webp')) await rm(join(out, file));
  const stickers = [
    ...emoji.map(([id, name, code, animation]) => ({
      id,
      name,
      category: 'Emoji',
      kind: 'emoji',
      code,
      animation,
    })),
    ...drawn.map(([id, name, category]) => ({ id, name, category, kind: 'drawn' })),
  ];
  const work = join(cache, 'frames');
  for (const sticker of stickers) {
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    for (let index = 0; index < frames; index++) {
      const png = await page.evaluate(
        ({ sticker, index, frames, size }) =>
          window.frame(
            sticker.kind,
            sticker.id,
            sticker.code,
            sticker.animation,
            index,
            frames,
            size,
          ),
        { sticker, index, frames, size },
      );
      await writeFile(
        join(work, `${String(index).padStart(3, '0')}.png`),
        Buffer.from(png, 'base64'),
      );
    }
    const target = join(out, `${sticker.id}.webp`);
    const result = spawnSync(ffmpegTool('ffmpeg'), [
      ...['-v', 'error', '-y', '-framerate', String(fps), '-i', join(work, '%03d.png')],
      ...['-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', '75', '-compression_level', '4'],
      ...['-loop', '0', '-pix_fmt', 'yuva420p', target],
    ]);
    if (result.status !== 0) throw new Error(String(result.stderr));
    manifest.push({
      id: sticker.id,
      name: sticker.name,
      category: sticker.category,
      file: `stickers/${sticker.id}.webp`,
      bytes: (await stat(target)).size,
      seconds: frames / fps,
    });
  }
} finally {
  await browser.close();
}
await writeFile(join(out, 'LICENSE-noto-emoji.txt'), licence);
await writeFile(
  join(out, 'stickers.json'),
  JSON.stringify(
    {
      comment:
        'Built-in stickers, written by scripts/make-stickers.mjs. The Emoji are animated from Noto Emoji images (Apache-2.0, see LICENSE-noto-emoji.txt) at the commit below.',
      notoEmoji: {
        commit,
        images: Object.fromEntries(Object.entries(sources).map(([c, s]) => [c, s.sha256])),
      },
      stickers: manifest,
    },
    null,
    2,
  ) + '\n',
);
const total = manifest.reduce((sum, s) => sum + s.bytes, 0);
console.log(`${manifest.length} stickers in assets/stickers, ${(total / 1e6).toFixed(2)} MB.`);

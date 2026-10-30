// Draws the web app's install icons from the app icon (apps/desktop/icon.svg) into
// apps/web/public/icons: 192 and 512 pixels, a maskable 512 (the icon within the
// middle 70%, on the icon's own background, as Android crops it) and Apple's 180.
// Chrome draws them, so they match the SVG exactly.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { root } from './lib.mjs';

const svg = readFileSync(join(root, 'apps/desktop/icon.svg'), 'utf8');
const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const out = join(root, 'apps/web/public/icons');
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function draw(file, size, { inset = 1, background = 'transparent' } = {}) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:${background};display:grid;place-items:center;height:${size}px">` +
      `<img src="${source}" width="${Math.round(size * inset)}" height="${Math.round(size * inset)}"></body>`,
  );
  await page.locator('img').evaluate((img) => img.decode());
  await page.screenshot({ path: join(out, file), omitBackground: background === 'transparent' });
  console.log('Drew ' + file);
}
await draw('icon-192.png', 192);
await draw('icon-512.png', 512);
await draw('icon-maskable-512.png', 512, { inset: 0.7, background: '#1b1e24' });
await draw('apple-touch-icon.png', 180, { background: '#1b1e24' });
await browser.close();

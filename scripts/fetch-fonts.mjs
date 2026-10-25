// Fetches the bundled fonts listed in assets/fonts/fonts.json from google/fonts at
// the pinned commit, with each family's licence, into assets/fonts/<folder>/. The
// fonts are committed; this script records where they came from and checks or
// refreshes them. `--pin` writes each file's SHA-256 into the manifest; without
// it, a file whose hash differs from the manifest fails.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { root } from './lib.mjs';

const fontsDir = join(root, 'assets/fonts');
const manifestPath = join(fontsDir, 'fonts.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const pin = process.argv.includes('--pin');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** The folder a family's files go in: its name in lower case, words joined by dashes. */
const folder = (family) => family.family.toLowerCase().replaceAll(' ', '-');

async function download(dir, name) {
  const url = `https://raw.githubusercontent.com/google/fonts/${manifest.commit}/${dir}/${encodeURIComponent(name)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Download failed: ' + response.status + ' ' + url);
  return Buffer.from(await response.arrayBuffer());
}

let fetched = 0;
let total = 0;
for (const family of manifest.families) {
  const target = join(fontsDir, folder(family));
  await mkdir(target, { recursive: true });
  const entries = [
    ...family.files,
    { from: family.license, file: family.license, licence: true, sha256: family.licenseSha256 },
  ];
  for (const entry of entries) {
    const name = entry.file ?? entry.from;
    if (basename(name) !== name) throw new Error('Font file names must be plain: ' + name);
    const path = join(target, name);
    let bytes = existsSync(path) ? await readFile(path) : null;
    if (!bytes || (entry.sha256 && sha256(bytes) !== entry.sha256)) {
      bytes = await download(family.dir, entry.from);
      await writeFile(path, bytes);
      fetched++;
    }
    const hash = sha256(bytes);
    if (pin) {
      if (entry.licence) family.licenseSha256 = hash;
      else entry.sha256 = hash;
    } else if (entry.sha256 && hash !== entry.sha256) {
      throw new Error(`${folder(family)}/${name} has SHA-256 ${hash}, expected ${entry.sha256}`);
    }
    if (!entry.licence) total += bytes.length;
  }
}
if (pin) await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `${manifest.families.length} font families, ${(total / 1e6).toFixed(1)} MB of fonts: ` +
    `${fetched} files fetched.`,
);

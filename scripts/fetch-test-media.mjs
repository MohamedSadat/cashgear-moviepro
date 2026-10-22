// Downloads the test clips listed in tests/media/manifest.json into tests/media/
// (gitignored) and verifies each file's SHA-256. Clips already present with the
// right hash are skipped. Large media never goes into git.
//
// Manifest entries: { "file": "h264-1080p30.mp4", "url": "https://…", "sha256": "…",
//                     "license": "CC0-1.0", "source": "where it came from" }
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { root } from './lib.mjs';

const mediaDir = join(root, 'tests/media');
const manifest = JSON.parse(await readFile(join(mediaDir, 'manifest.json'), 'utf8'));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

let fetched = 0;
for (const clip of manifest.clips) {
  if (basename(clip.file) !== clip.file)
    throw new Error('Clip names must be plain file names: ' + clip.file);
  const path = join(mediaDir, clip.file);
  if (existsSync(path) && sha256(await readFile(path)) === clip.sha256) continue;
  console.log('Fetching ' + clip.file + ' from ' + clip.url);
  const response = await fetch(clip.url);
  if (!response.ok) throw new Error('Download failed: ' + response.status + ' ' + clip.url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== clip.sha256)
    throw new Error(clip.file + ' has SHA-256 ' + actual + ', expected ' + clip.sha256);
  await writeFile(path + '.part', bytes);
  await rename(path + '.part', path);
  fetched++;
}
console.log(
  manifest.clips.length +
    ' test clip(s) listed, ' +
    fetched +
    ' fetched, ' +
    (manifest.clips.length - fetched) +
    ' already present.',
);

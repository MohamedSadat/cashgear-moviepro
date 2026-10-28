// Builds the caption test set into tests/media: English and Arabic read speech
// from Google's FLEURS test split (CC BY 4.0, https://huggingface.co/datasets/google/fleurs),
// with what was said, and rewrites tests/media/speech.json with each file's
// SHA-256, size and release URL. Run it only when the set changes; then upload
// the files as the `test-speech-v1` release (see --publish).
//
// Each language gets 24 different sentences of 5 to 15 s, the first ones of the
// test split in file order, read by its speakers and joined with 0.8 s pauses
// into one AAC file. `speech-<language>.json` holds each sentence's text and
// where it starts and ends.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { ffmpegBuildInfo, ffmpegTool, root } from './lib.mjs';

export const release = 'test-speech-v1';
const repo = 'MohamedSadat/cashgear-moviepro';
const mediaDir = join(root, 'tests/media');
const cacheDir = join(root, '.tools/fleurs');
const revision = '70bb2e84b976b7e960aa89f1c648e09c59f894dd';
const base = `https://huggingface.co/datasets/google/fleurs/resolve/${revision}/data`;
const sentences = 24;
const pause = 0.8;
const rate = 16_000;

const sets = [
  {
    language: 'en',
    split: 'en_us',
    archive: {
      size: 289851356,
      sha256: 'd9c2e37b41aacd41bc283554a0a82b5476b36887049774ecb2819dcaaa55a356',
    },
  },
  {
    language: 'ar',
    split: 'ar_eg',
    archive: {
      size: 243532527,
      sha256: '787dc348725c0924ff58c8e379d4ef41a7e488dc2ab2990a0eba4a063856edb1',
    },
  },
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Downloads `url` to `path` unless a file with `sha256` is there already. */
async function fetchTo(url, path, expected) {
  if (existsSync(path) && (!expected || (await hashFile(path)) === expected.sha256)) return;
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error('Download failed: ' + response.status + ' ' + url);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path + '.part'));
  if (expected && (await hashFile(path + '.part')) !== expected.sha256)
    throw new Error(url + ' did not download intact');
  await rm(path, { force: true });
  await (await import('node:fs/promises')).rename(path + '.part', path);
}

/** The files named in `wanted` from a .tar.gz, as bytes by name (without folders). */
async function extract(path, wanted) {
  const found = new Map();
  let buffer = Buffer.alloc(0);
  let skip = 0;
  let take = null;
  const stream = createReadStream(path).pipe(createGunzip());
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (skip) {
        const dropped = Math.min(skip, buffer.length);
        buffer = buffer.subarray(dropped);
        skip -= dropped;
        if (skip) break;
      }
      if (take) {
        if (buffer.length < take.size) break;
        found.set(take.name, Buffer.from(buffer.subarray(0, take.size)));
        buffer = buffer.subarray(take.size);
        skip = (512 - (take.size % 512)) % 512;
        take = null;
        continue;
      }
      if (buffer.length < 512) break;
      const header = buffer.subarray(0, 512);
      buffer = buffer.subarray(512);
      if (header.every((byte) => byte === 0)) continue;
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
      const size = parseInt(
        header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0',
        8,
      );
      const file = name.split('/').pop();
      if (wanted.has(file)) take = { name: file, size };
      else skip = Math.ceil(size / 512) * 512;
    }
    if (found.size === wanted.size) break;
  }
  return found;
}

/** A sound file's samples as 16 kHz 16-bit mono, decoded by FFmpeg. */
function samplesOf(bytes, name) {
  const result = spawnSync(
    ffmpegTool('ffmpeg'),
    ['-v', 'error', '-i', '-', '-f', 's16le', '-ac', '1', '-ar', String(rate), '-'],
    { input: bytes, maxBuffer: 1 << 28 },
  );
  if (result.status !== 0) throw new Error('Decoding ' + name + ' failed: ' + result.stderr);
  const out = result.stdout;
  return new Int16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
}

async function build(set) {
  await mkdir(cacheDir, { recursive: true });
  const table = join(cacheDir, `${set.split}-test.tsv`);
  const archive = join(cacheDir, `${set.split}-test.tar.gz`);
  await fetchTo(`${base}/${set.split}/test.tsv`, table);
  await fetchTo(`${base}/${set.split}/audio/test.tar.gz`, archive, set.archive);
  const rows = (await readFile(table, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, file, raw, normalized, , samples] = line.split('\t');
      return { id, file, raw, normalized, seconds: Number(samples) / rate };
    });
  const chosen = [];
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id) || row.seconds < 5 || row.seconds > 15) continue;
    seen.add(row.id);
    chosen.push(row);
    if (chosen.length === sentences) break;
  }
  const audio = await extract(archive, new Set(chosen.map((row) => row.file)));
  const gap = new Int16Array(Math.round(pause * rate));
  const parts = [gap];
  const utterances = [];
  let at = gap.length;
  for (const row of chosen) {
    const bytes = audio.get(row.file);
    if (!bytes) throw new Error(row.file + ' is not in the archive');
    const samples = samplesOf(bytes, row.file);
    utterances.push({
      id: row.id,
      file: row.file,
      start: at / rate,
      end: (at + samples.length) / rate,
      text: row.raw,
      normalized: row.normalized,
    });
    parts.push(samples, gap);
    at += samples.length + gap.length;
  }
  const pcm = new Int16Array(at);
  let offset = 0;
  for (const part of parts) {
    pcm.set(part, offset);
    offset += part.length;
  }
  const raw = join(cacheDir, `speech-${set.language}.pcm`);
  await writeFile(raw, Buffer.from(pcm.buffer));
  const file = `speech-${set.language}.m4a`;
  const result = spawnSync(
    ffmpegTool('ffmpeg'),
    [
      '-y',
      '-v',
      'error',
      '-f',
      's16le',
      '-ar',
      String(rate),
      '-ac',
      '1',
      '-i',
      raw,
      '-ar',
      '48000',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      join(mediaDir, file),
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('Encoding ' + file + ' failed');
  await rm(raw);
  const reference = `speech-${set.language}.json`;
  await writeFile(
    join(mediaDir, reference),
    JSON.stringify(
      {
        source: `FLEURS (Google), ${set.split} test split, revision ${revision}`,
        license: 'CC BY 4.0, https://creativecommons.org/licenses/by/4.0/',
        language: set.language,
        seconds: at / rate,
        utterances,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`  ${file}: ${utterances.length} sentences, ${(at / rate).toFixed(1)} s`);
  return [file, reference];
}

async function main() {
  const info = ffmpegBuildInfo();
  if (info.gpl || info.nonfree) throw new Error('Refusing to use a GPL or nonfree FFmpeg.');
  await mkdir(mediaDir, { recursive: true });
  const entries = [];
  for (const set of sets)
    for (const file of await build(set)) {
      const bytes = await readFile(join(mediaDir, file));
      entries.push({
        file,
        url: `https://github.com/${repo}/releases/download/${release}/${file}`,
        sha256: sha256(bytes),
        size: (await stat(join(mediaDir, file))).size,
      });
    }
  const manifest = {
    comment:
      'Generated by scripts/make-speech-media.mjs from FLEURS (CC BY 4.0); fetched by pnpm fetch-test-media. Do not edit by hand.',
    release,
    files: entries,
  };
  await writeFile(join(mediaDir, 'speech.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (process.argv.includes('--publish')) {
    const gh = spawnSync(
      'gh',
      [
        'release',
        'create',
        release,
        '--repo',
        repo,
        '--title',
        'Test speech v1',
        '--notes',
        'English and Arabic read speech from Google FLEURS (CC BY 4.0, https://huggingface.co/datasets/google/fleurs), made by scripts/make-speech-media.mjs. Fetch with `pnpm fetch-test-media`.',
        ...entries.map((e) => join(mediaDir, e.file)),
      ],
      { stdio: 'inherit' },
    );
    if (gh.status !== 0) throw new Error('gh release create failed');
  }
}

await main();

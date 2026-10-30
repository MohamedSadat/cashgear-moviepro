// Fetches the pinned LGPL FFmpeg build into .tools/ffmpeg and checks it.
// The desktop app runs ffmpeg/ffprobe as child processes; this is the copy
// development, tests and (from Phase 11) the installer use.
//
// Refuses any archive whose SHA-256 differs from the pin, and any build
// configured with --enable-gpl or --enable-nonfree.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegBuildInfo, ffmpegPin, root, run } from './lib.mjs';

const { release, builds } = ffmpegPin;

const key = process.platform + '-' + process.arch;
const build = builds[key];
if (!build)
  throw new Error(
    'No pinned LGPL FFmpeg build for ' +
      key +
      ' yet. macOS and Linux arrive with their desktop targets.',
  );
const tools = join(root, '.tools');
const target = join(tools, 'ffmpeg');
const stamp = join(target, 'BUILD');

if (existsSync(stamp) && (await readFile(stamp, 'utf8')).trim() === build.file) {
  console.log('LGPL FFmpeg ' + build.file + ' is ready in .tools/ffmpeg.');
} else {
  await mkdir(tools, { recursive: true });
  const url =
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/' + release + '/' + build.file;
  console.log('Downloading ' + url);
  const response = await fetch(url);
  if (!response.ok) throw new Error('FFmpeg download failed: ' + response.status + ' ' + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== build.sha256)
    throw new Error('FFmpeg archive SHA-256 is ' + digest + ', expected ' + build.sha256);
  const archive = join(tools, build.file);
  const staging = join(tools, 'ffmpeg-staging');
  await writeFile(archive, bytes);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  // Windows' own bsdtar reads .zip; Git Bash's GNU tar does not.
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  await run(tar, ['-xf', archive, '-C', staging]);
  const [inner] = await readdir(staging);
  await rm(target, { recursive: true, force: true });
  await rename(join(staging, inner), target);
  await rm(staging, { recursive: true, force: true });
  await rm(archive);
  await writeFile(stamp, build.file + '\n');
}

const info = ffmpegBuildInfo(join(target, 'bin'));
if (info.gpl || info.nonfree)
  throw new Error('This FFmpeg build is configured with --enable-gpl or --enable-nonfree.');
if (!existsSync(join(target, 'LICENSE.txt')))
  throw new Error('The FFmpeg build is missing LICENSE.txt, which must ship with it.');
console.log(
  info.version + ' (' + (info.version3 ? 'LGPL-3.0' : 'LGPL-2.1') + ', no GPL, no nonfree)',
);

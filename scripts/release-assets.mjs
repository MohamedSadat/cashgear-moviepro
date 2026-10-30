// Gathers a release's files into a folder, after pnpm desktop:installer built the
// installer with the updater's key (the release workflow):
//   CashGear-Video_<version>_x64-setup.exe and its .sig
//   latest.json          the update feed the desktop app reads (tauri.conf.json)
//   ffmpeg-source.tar.gz FFmpeg's source at the shipped commit, and the scripts the
//                        build came from, which name every library's exact source
//   third-party-notices.txt
//   node scripts/release-assets.mjs <folder> [notes file]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpegPin, root } from './lib.mjs';

const out = process.argv[2];
if (!out) throw new Error('Usage: node scripts/release-assets.mjs <folder> [notes file]');
const notes = process.argv[3] ? readFileSync(process.argv[3], 'utf8').trim() : '';
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const repository = process.env.GITHUB_REPOSITORY ?? 'MohamedSadat/cashgear-moviepro';
mkdirSync(out, { recursive: true });

// GitHub swaps spaces in asset names for dots: the release names its files plainly.
const built = join(root, 'target/release/bundle/nsis', `CashGear Video_${version}_x64-setup.exe`);
const setup = `CashGear-Video_${version}_x64-setup.exe`;
if (!existsSync(built + '.sig')) {
  throw new Error(
    `${built}.sig is missing: build with the updater's key (TAURI_SIGNING_PRIVATE_KEY).`,
  );
}
copyFileSync(built, join(out, setup));
copyFileSync(built + '.sig', join(out, setup + '.sig'));
const signature = readFileSync(built + '.sig', 'utf8');
const url = `https://github.com/${repository}/releases/download/v${version}/${setup}`;
writeFileSync(
  join(out, 'latest.json'),
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: {
        'windows-x86_64': { signature, url },
        'windows-x86_64-nsis': { signature, url },
      },
    },
    null,
    2,
  ),
);
copyFileSync(
  join(root, 'apps/web/dist/third-party-notices.txt'),
  join(out, 'third-party-notices.txt'),
);

// FFmpeg's corresponding source, for the LGPL.
const staging = join(root, 'target/ffmpeg-source');
mkdirSync(staging, { recursive: true });
const sources = [
  [
    `https://github.com/FFmpeg/FFmpeg/archive/${ffmpegPin.commit}.tar.gz`,
    `FFmpeg-${ffmpegPin.commit}.tar.gz`,
  ],
  [
    `https://github.com/BtbN/FFmpeg-Builds/archive/refs/tags/${ffmpegPin.release}.tar.gz`,
    `FFmpeg-Builds-${ffmpegPin.release}.tar.gz`,
  ],
];
for (const [from, name] of sources) {
  const response = await fetch(from);
  if (!response.ok) throw new Error(`${from}: ${response.status}`);
  writeFileSync(join(staging, name), Buffer.from(await response.arrayBuffer()));
}
writeFileSync(
  join(staging, 'README.txt'),
  `The source of the FFmpeg that CashGear Video ${version} ships (LGPL-3.0-or-later).

${sources[0][1]}  FFmpeg at commit ${ffmpegPin.commit}
${sources[1][1]}  BtbN/FFmpeg-Builds at ${ffmpegPin.release}: the scripts that built it
    (${ffmpegPin.builds['win32-x64'].file}); they name the exact source of each library
    it was built with.
`,
);
// Windows' own bsdtar writes .tar.gz; Git Bash's GNU tar would too, elsewhere.
const tar =
  process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe')
    : 'tar';
execFileSync(tar, ['-czf', join(out, 'ffmpeg-source.tar.gz'), '-C', staging, '.']);
console.log(`Release ${version} files are in ${out}`);

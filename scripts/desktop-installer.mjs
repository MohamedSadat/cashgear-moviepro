// Builds the Windows installer (pnpm desktop:installer, after pnpm build):
// target/release/bundle/nsis/CashGear Video_<version>_x64-setup.exe, installing per
// user. It ships the pinned LGPL FFmpeg (.tools/ffmpeg) unchanged in an `ffmpeg`
// folder beside the app, with FFmpeg's licence and a notice of the build and where
// its source is, plus the app's third-party notices, and signs every file it builds
// through scripts/sign-windows.mjs.
//
// Settings, from the environment:
//   CGV_VERSION        build this version instead of tauri.conf.json's (tests)
//   TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD): the updater's private key. With it
//                      the build also signs the update (the installer's .sig) for
//                      latest.json.
//   CGV_UPDATER_PUBKEY the updater's public key, when it is not the config's
//   CGV_UPDATER_URL    the update feed, when it is not the config's (tests: http)
//   CGV_SIGN_*         code signing: see scripts/sign-windows.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpegBuildInfo, ffmpegDir, ffmpegPin, pnpmCommand, root, run } from './lib.mjs';

const ffmpeg = ffmpegDir();
if (!ffmpeg) throw new Error('FFmpeg is missing: run pnpm setup:ffmpeg first.');
const build = ffmpegBuildInfo(ffmpeg);
if (build.gpl || build.nonfree) throw new Error('This FFmpeg build is not LGPL: ' + build.version);
if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
  throw new Error('The web build is missing: run pnpm build first.');
}

// What goes beside the app.
const staging = join(root, 'target/installer');
rmSync(staging, { recursive: true, force: true });
const ffmpegOut = join(staging, 'ffmpeg');
const licences = join(staging, 'licences');
mkdirSync(ffmpegOut, { recursive: true });
mkdirSync(licences, { recursive: true });
for (const name of readdirSync(ffmpeg)) {
  // ffplay is a player the app never runs.
  if (/^(ffmpeg|ffprobe)\.exe$|\.dll$/i.test(name))
    copyFileSync(join(ffmpeg, name), join(ffmpegOut, name));
}
// Signed as the app is: Windows and antivirus software look harder at unsigned programs.
for (const name of readdirSync(ffmpegOut)) {
  await run(process.execPath, [join(root, 'scripts/sign-windows.mjs'), join(ffmpegOut, name)]);
}
copyFileSync(join(ffmpeg, '..', 'LICENSE.txt'), join(ffmpegOut, 'LICENSE.txt'));
const configuration = execFileSync(join(ffmpeg, 'ffmpeg.exe'), ['-hide_banner', '-version'], {
  encoding: 'utf8',
}).match(/^configuration:\s*(.*)$/m)?.[1];
const zip = ffmpegPin.builds[`${process.platform}-${process.arch}`].file;
writeFileSync(
  join(ffmpegOut, 'README.txt'),
  `FFmpeg in CashGear Video

CashGear Video runs FFmpeg (https://ffmpeg.org) as separate programs: ffmpeg.exe
and ffprobe.exe in this folder, with the FFmpeg libraries beside them (the .dll
files), as they were built. CashGear Video does not link to them, and you may
replace them with another build of FFmpeg ${build.version.split(' ')[2]}.

FFmpeg is free software under the GNU Lesser General Public License, version 3
(LICENSE.txt in this folder). The libraries it was built with keep their own
licences. The build has no GPL or non-free parts.

Version:        ${build.version}
Built by:       BtbN/FFmpeg-Builds, release ${ffmpegPin.release} (${zip})
Configuration:  ${configuration}

The source:
  FFmpeg:       https://github.com/FFmpeg/FFmpeg/tree/${ffmpegPin.commit}
  The build:    https://github.com/BtbN/FFmpeg-Builds/tree/${ffmpegPin.release}
                (its scripts name the exact source of each library it builds with)
  Each CashGear Video release also carries both, as ffmpeg-source.tar.gz, at
  https://github.com/MohamedSadat/cashgear-moviepro/releases
`,
);
const notices = join(root, 'apps/web/dist/third-party-notices.txt');
if (existsSync(notices)) copyFileSync(notices, join(licences, 'THIRD-PARTY-NOTICES.txt'));

// The bundle's settings on top of tauri.conf.json.
const env = process.env;
const forward = (path) => path.replace(/\\/g, '/');
const config = {
  ...(env.CGV_VERSION ? { version: env.CGV_VERSION } : {}),
  bundle: {
    resources: {
      [forward(join(ffmpegOut, '*'))]: 'ffmpeg/',
      ...(readdirSync(licences).length ? { [forward(join(licences, '*'))]: 'licences/' } : {}),
    },
    createUpdaterArtifacts: !!env.TAURI_SIGNING_PRIVATE_KEY,
    windows: {
      // Tauri splits the command at spaces, runs it in src-tauri, and passes the
      // file as one argument.
      signCommand: 'node ../../../scripts/sign-windows.mjs %1',
    },
  },
  plugins: {
    updater: {
      ...(env.CGV_UPDATER_PUBKEY ? { pubkey: env.CGV_UPDATER_PUBKEY } : {}),
      ...(env.CGV_UPDATER_URL
        ? {
            endpoints: [env.CGV_UPDATER_URL],
            dangerousInsecureTransportProtocol: env.CGV_UPDATER_URL.startsWith('http:'),
          }
        : {}),
    },
  },
};
const configFile = join(staging, 'tauri.installer.json');
writeFileSync(configFile, JSON.stringify(config, null, 2));
await run(...pnpmCommand(['--filter', '@cgv/desktop', 'tauri', 'build', '--config', configFile]));

const out = join(root, 'target/release/bundle/nsis');
for (const name of readdirSync(out)) console.log('Built ' + join(out, name));

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const bindgenVersion = '0.2.129';
export const wasmOutput = join(root, 'packages/engine-client/src/pkg');

/** WASM_BINDGEN_PATH, then the copy `pnpm setup:wasm` builds into .tools, then PATH. */
export function bindgenPath() {
  const exe = process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen';
  const candidates = [process.env.WASM_BINDGEN_PATH, join(root, '.tools', 'bin', exe)].filter(
    Boolean,
  );
  return candidates.find(existsSync) ?? 'wasm-bindgen';
}

/** The folder holding ffmpeg and ffprobe: CGV_FFMPEG_DIR, then .tools/ffmpeg/bin, else PATH (''). */
export function ffmpegDir() {
  if (process.env.CGV_FFMPEG_DIR) return process.env.CGV_FFMPEG_DIR;
  const tools = join(root, '.tools', 'ffmpeg', 'bin');
  return existsSync(tools) ? tools : '';
}
export function ffmpegTool(name, dir = ffmpegDir()) {
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  return dir ? join(dir, exe) : exe;
}
/** Reads `ffmpeg -version` and reports its license-relevant configure flags. */
export function ffmpegBuildInfo(dir = ffmpegDir()) {
  const result = spawnSync(ffmpegTool('ffmpeg', dir), ['-hide_banner', '-version'], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error('ffmpeg is not runnable: ' + (result.stderr || result.error));
  const configuration = result.stdout.match(/^configuration:(.*)$/m)?.[1] ?? '';
  return {
    version: result.stdout.split('\n')[0].trim(),
    gpl: configuration.includes('--enable-gpl'),
    nonfree: configuration.includes('--enable-nonfree'),
    version3: configuration.includes('--enable-version3'),
  };
}

export function run(command, args = [], options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolveRun() : reject(new Error(command + ' failed (' + (signal ?? code) + ')')),
    );
  });
}

/** How to run pnpm again from a script that pnpm started. */
export function pnpmCommand(args) {
  if (!process.env.npm_execpath) throw new Error('Run this command through pnpm.');
  return /\.[cm]?js$/.test(process.env.npm_execpath)
    ? [process.execPath, [process.env.npm_execpath, ...args]]
    : [process.env.npm_execpath, args];
}

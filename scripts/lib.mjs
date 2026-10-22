import { spawn } from 'node:child_process';
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

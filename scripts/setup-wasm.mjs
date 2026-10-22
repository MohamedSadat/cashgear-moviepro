import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { bindgenPath, bindgenVersion, root, run } from './lib.mjs';

await run('rustup', ['target', 'add', 'wasm32-unknown-unknown']);
const check = spawnSync(bindgenPath(), ['--version'], { encoding: 'utf8' });
if (check.status === 0 && check.stdout.trim() === 'wasm-bindgen ' + bindgenVersion) {
  console.log(check.stdout.trim() + ' is ready.');
} else {
  // Built from crates.io, so no prebuilt binary is downloaded.
  await run('cargo', [
    'install',
    'wasm-bindgen-cli',
    '--version',
    bindgenVersion,
    '--locked',
    '--root',
    join(root, '.tools'),
  ]);
  await run(bindgenPath(), ['--version']);
}

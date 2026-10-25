import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { bindgenPath, bindgenVersion, root, run, wasmOutput } from './lib.mjs';

const release = process.argv.includes('--release');
const limitBytes = 2000000;
const bindgen = bindgenPath();
const check = spawnSync(bindgen, ['--version'], { encoding: 'utf8' });
if (check.status !== 0 || check.stdout.trim() !== 'wasm-bindgen ' + bindgenVersion) {
  throw new Error('wasm-bindgen ' + bindgenVersion + ' is missing. Run pnpm setup:wasm.');
}
await run('cargo', [
  'build',
  '-p',
  'cgv-wasm',
  '--target',
  'wasm32-unknown-unknown',
  ...(release ? ['--release'] : []),
]);
await mkdir(wasmOutput, { recursive: true });
await run(bindgen, [
  join(root, 'target/wasm32-unknown-unknown', release ? 'release' : 'debug', 'cgv_wasm.wasm'),
  '--target',
  'web',
  '--out-dir',
  wasmOutput,
  '--out-name',
  'cgv_wasm',
]);
if (release) {
  const { default: binaryen } = await import('binaryen');
  const path = join(wasmOutput, 'cgv_wasm_bg.wasm');
  const module = binaryen.readBinary(await readFile(path));
  module.setFeatures(binaryen.Features.All);
  binaryen.setOptimizeLevel(3);
  binaryen.setShrinkLevel(1);
  module.optimize();
  if (!module.validate()) throw new Error('Optimized WASM failed validation');
  const bytes = module.emitBinary();
  module.dispose();
  await writeFile(path, bytes);
  const gzippedBytes = gzipSync(bytes, { level: 9 }).length;
  const report = { wasmBytes: bytes.length, gzippedBytes, limitBytes };
  await mkdir(join(root, 'bench/results'), { recursive: true });
  await writeFile(
    join(root, 'bench/results/wasm-size.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    'Release WASM: ' + bytes.length + ' bytes; gzip: ' + gzippedBytes + ' / ' + limitBytes,
  );
  if (gzippedBytes > limitBytes) throw new Error('Release WASM gzip size exceeds 2 MB');
}

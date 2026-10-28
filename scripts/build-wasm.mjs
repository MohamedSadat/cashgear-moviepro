import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { bindgenPath, bindgenVersion, root, run, wasmOutput } from './lib.mjs';

const release = process.argv.includes('--release');
const limitBytes = 2250000;
const bindgen = bindgenPath();
const check = spawnSync(bindgen, ['--version'], { encoding: 'utf8' });
if (check.status !== 0 || check.stdout.trim() !== 'wasm-bindgen ' + bindgenVersion) {
  throw new Error('wasm-bindgen ' + bindgenVersion + ' is missing. Run pnpm setup:wasm.');
}
// The engine, and noise reduction and the AI tools' analysis as modules of their
// own (each loaded when first used).
const modules = [
  { crate: 'cgv-wasm', name: 'cgv_wasm', out: wasmOutput },
  { crate: 'cgv-denoise', name: 'cgv_denoise', out: join(wasmOutput, 'denoise') },
  { crate: 'cgv-ai', name: 'cgv_ai', out: join(wasmOutput, 'ai') },
];
await run('cargo', [
  'build',
  ...modules.flatMap((module) => ['-p', module.crate]),
  '--target',
  'wasm32-unknown-unknown',
  ...(release ? ['--release'] : []),
]);
for (const { name, out } of modules) {
  await mkdir(out, { recursive: true });
  await run(bindgen, [
    join(root, 'target/wasm32-unknown-unknown', release ? 'release' : 'debug', `${name}.wasm`),
    '--target',
    'web',
    '--out-dir',
    out,
    '--out-name',
    name,
  ]);
}

/** Optimizes a release module with binaryen; returns its size and gzipped size. */
async function optimize(path) {
  const { default: binaryen } = await import('binaryen');
  const module = binaryen.readBinary(await readFile(path));
  module.setFeatures(binaryen.Features.All);
  binaryen.setOptimizeLevel(3);
  binaryen.setShrinkLevel(1);
  module.optimize();
  if (!module.validate()) throw new Error('Optimized WASM failed validation: ' + path);
  const bytes = module.emitBinary();
  module.dispose();
  await writeFile(path, bytes);
  return { wasmBytes: bytes.length, gzippedBytes: gzipSync(bytes, { level: 9 }).length };
}

if (release) {
  const denoise = await optimize(join(modules[1].out, 'cgv_denoise_bg.wasm'));
  console.log(
    'Noise reduction WASM: ' + denoise.wasmBytes + ' bytes; gzip: ' + denoise.gzippedBytes,
  );
  const ai = await optimize(join(modules[2].out, 'cgv_ai_bg.wasm'));
  console.log('AI analysis WASM: ' + ai.wasmBytes + ' bytes; gzip: ' + ai.gzippedBytes);
  const { wasmBytes, gzippedBytes } = await optimize(join(wasmOutput, 'cgv_wasm_bg.wasm'));
  const report = { wasmBytes, gzippedBytes, limitBytes, denoise, ai };
  await mkdir(join(root, 'bench/results'), { recursive: true });
  await writeFile(
    join(root, 'bench/results/wasm-size.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log('Release WASM: ' + wasmBytes + ' bytes; gzip: ' + gzippedBytes + ' / ' + limitBytes);
  if (gzippedBytes > limitBytes) throw new Error('Release WASM gzip size exceeds 2.25 MB');
}

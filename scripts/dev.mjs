// Builds the debug engine, serves the web app and rebuilds the engine when Rust,
// WGSL or Cargo manifests change. Vite then reloads the engine worker.
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { root, run } from './lib.mjs';

await run(process.execPath, [root + '/scripts/build-wasm.mjs']);
const require = createRequire(root + '/apps/web/package.json');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const vite = await createServer({
  root: root + '/apps/web',
  configFile: root + '/apps/web/vite.config.ts',
});
await vite.listen();
vite.printUrls();
let timer;
let building = false;
let dirty = false;
let closing = false;
async function rebuild() {
  if (closing || building || !dirty) return;
  building = true;
  dirty = false;
  try {
    await run(process.execPath, [root + '/scripts/build-wasm.mjs']);
  } catch (error) {
    console.error(error.message);
  } finally {
    building = false;
    if (dirty) void rebuild();
  }
}
function schedule() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 180);
}
const watcher = watch(root + '/crates', { recursive: true }, (_event, name) => {
  if (!name || !/\.(rs|wgsl|toml)$/.test(name)) return;
  schedule();
});
const manifestWatcher = watch(root + '/Cargo.toml', schedule);
async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  watcher.close();
  manifestWatcher.close();
  await vite.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());

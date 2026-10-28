// Downloads the AI models listed in packages/engine-client/src/ai/models.json
// into tests/models/<id>/, checking each file's size and SHA-256, for tests and
// development (the app downloads them itself on first use). Files already there
// with the right hash are skipped. Models never go into git.
//
//   pnpm fetch-models              every model
//   pnpm fetch-models whisper-tiny only the models named
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { root } from './lib.mjs';

const registry = JSON.parse(
  await readFile(join(root, 'packages/engine-client/src/ai/models.json'), 'utf8'),
);
const wanted = process.argv.slice(2);
const models = registry.models.filter((model) => !wanted.length || wanted.includes(model.id));
const unknown = wanted.filter((id) => !registry.models.some((model) => model.id === id));
if (unknown.length) throw new Error('No such model: ' + unknown.join(', '));

async function hashOf(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

let fetched = 0;
let present = 0;
for (const model of models) {
  for (const file of model.files) {
    if (file.path.split('/').some((part) => part === '..' || part === ''))
      throw new Error('Model file paths stay inside their folder: ' + file.path);
    const path = join(root, 'tests/models', model.id, file.path);
    if (existsSync(path) && (await stat(path)).size === file.size) {
      if ((await hashOf(path)) === file.sha256) {
        present++;
        continue;
      }
    }
    const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`;
    const response = await fetch(url);
    if (!response.ok || !response.body)
      throw new Error('Download failed: ' + response.status + ' ' + url);
    await mkdir(dirname(path), { recursive: true });
    const hash = createHash('sha256');
    const part = path + '.part';
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(part),
    );
    const actual = hash.digest('hex');
    if (actual !== file.sha256)
      throw new Error(`${model.id}/${file.path} has SHA-256 ${actual}, expected ${file.sha256}`);
    await rename(part, path);
    fetched++;
    console.log(`${model.id}/${file.path}: ${(file.size / 1e6).toFixed(1)} MB`);
  }
}
console.log(`${models.length} models: ${fetched} files fetched, ${present} already present.`);

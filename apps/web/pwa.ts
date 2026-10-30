import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';

// Builds the service worker (sw.js beside this file) with the build's files: the
// app shell it caches when it installs, and every file, which it caches as they
// are used. The AI runtime and the pack's media are large and only some projects
// use them, so they are cached on use rather than up front.

const onUse = /\.(ttf|otf|woff2?|webm|webp|onnx)$|ort-wasm/;

export function serviceWorker(): Plugin {
  let publicDir = '';
  return {
    name: 'cgv-service-worker',
    apply: 'build',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle(_, bundle) {
      const built = Object.keys(bundle).map((name) => '/' + name);
      const listPublic = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          return statSync(path).isDirectory() ? listPublic(path) : [path];
        });
      const extras = publicDir
        ? listPublic(publicDir)
            .map((path) => '/' + relative(publicDir, path).replace(/\\/g, '/'))
            .filter((path) => !/^\/(_headers|staticwebapp\.config\.json)$/.test(path))
        : [];
      const files = ['/', ...built.filter((name) => name !== '/index.html'), ...extras].sort();
      const shell = files.filter((name) => !onUse.test(name) && name !== '/sw.js');
      const build = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      const template = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
      const source = template
        .replace('self.__SHELL__', JSON.stringify(shell))
        .replace('self.__FILES__', JSON.stringify(files))
        .replace('self.__BUILD__', JSON.stringify(build));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

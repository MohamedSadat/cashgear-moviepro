// Writes the third-party notices the app shows (About › Third-party notices) and
// the installer ships: every Rust crate built into the WASM modules and the desktop
// app, every npm package in the web bundle, the bundled fonts, the AI models and
// FFmpeg, each with its licence, followed by the licence texts their packages carry.
//   node scripts/third-party-notices.mjs [output]   (default apps/web/dist/third-party-notices.txt)
// pnpm build runs it after the web build.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ffmpegPin, pnpmCommand, root } from './lib.mjs';

const output = process.argv[2] ?? join(root, 'apps/web/dist/third-party-notices.txt');
const licenceFile = /^(licen[cs]e|copying|notice|copyright)([-._].*)?$/i;

function licenceTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => licenceFile.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').trim() }));
}

// Rust: the normal dependencies of what ships, for the platform it ships on.
function crates(roots, platform) {
  const result = spawnSync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--filter-platform', platform],
    { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error('cargo metadata failed: ' + result.stderr);
  const metadata = JSON.parse(result.stdout);
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const seen = new Set();
  const queue = metadata.packages.filter((pkg) => roots.includes(pkg.name)).map((pkg) => pkg.id);
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg);
    }
  }
  return [...seen]
    .map((id) => packages.get(id))
    .filter((pkg) => pkg.source) // our own crates are not third-party
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      licence: pkg.license ?? pkg.license_file ?? 'see its files',
      home: pkg.repository ?? pkg.homepage ?? '',
      texts: licenceTexts(dirname(pkg.manifest_path)),
    }));
}

const rust = new Map();
for (const pkg of [
  ...crates(['cgv-wasm', 'cgv-ai', 'cgv-denoise'], 'wasm32-unknown-unknown'),
  ...crates(['cgv-desktop'], 'x86_64-pc-windows-msvc'),
]) {
  rust.set(`${pkg.name} ${pkg.version}`, pkg);
}

// npm: what the web bundle ships.
const [command, args] = pnpmCommand(['-r', '--prod', 'licenses', 'list', '--json']);
const listed = spawnSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (listed.status !== 0) throw new Error('pnpm licenses list failed: ' + listed.stderr);
const npm = Object.values(JSON.parse(listed.stdout))
  .flat()
  .filter((pkg) => !pkg.name.startsWith('@cgv/') && pkg.name !== '@cashgear/ui')
  .map((pkg) => ({
    name: pkg.name,
    version: pkg.versions.join(', '),
    licence: pkg.license,
    home: pkg.homepage ?? '',
    texts: licenceTexts(pkg.paths[0]),
  }));

const fonts = JSON.parse(readFileSync(join(root, 'assets/fonts/fonts.json'), 'utf8')).families.map(
  (family) => {
    const dir = join(root, 'assets/fonts', family.family.toLowerCase().replace(/\s+/g, '-'));
    const path = join(dir, family.license);
    return {
      name: family.family,
      version: '',
      licence: family.license.startsWith('OFL') ? 'OFL-1.1' : 'Apache-2.0',
      home: `https://github.com/google/fonts/tree/${JSON.parse(readFileSync(join(root, 'assets/fonts/fonts.json'), 'utf8')).commit}/${family.dir}`,
      texts: existsSync(path)
        ? [{ name: family.license, text: readFileSync(path, 'utf8').trim() }]
        : [],
    };
  },
);

const models = JSON.parse(
  readFileSync(join(root, 'packages/engine-client/src/ai/models.json'), 'utf8'),
).models.map((model) => ({ name: model.name, licence: model.license, home: model.origin ?? '' }));

const line = (pkg) =>
  `  ${[pkg.name, pkg.version].filter(Boolean).join(' ')}: ${pkg.licence}${pkg.home ? `  <${pkg.home}>` : ''}`;
const sorted = (list) => [...list].sort((a, b) => a.name.localeCompare(b.name));
const sections = [
  'CashGear Video: third-party notices',
  '',
  'CashGear Video is built with the open-source software below. Each is listed with',
  'its licence; the licence texts and notices its authors ship follow.',
  '',
  `Rust crates (${rust.size}):`,
  ...sorted(rust.values()).map(line),
  '',
  `JavaScript packages (${npm.length}):`,
  ...sorted(npm).map(line),
  '',
  `Fonts (${fonts.length}), fetched from Google Fonts:`,
  ...fonts.map(line),
  '',
  'AI models, downloaded when an AI tool is first used:',
  ...models.map(line),
  '',
  'FFmpeg (the desktop app):',
  `  FFmpeg ${ffmpegPin.builds['win32-x64'].file}: LGPL-3.0-or-later  <https://ffmpeg.org>`,
  '  The desktop app runs it as separate programs, unchanged. Its notice, licence and',
  '  where its source is are in the ffmpeg folder beside the app (README.txt).',
  '',
  '',
  'Licence texts and notices',
  '=========================',
];
// Many packages ship the same text (Apache-2.0 above all): each text appears once,
// headed by every package that ships it.
const texts = new Map();
for (const pkg of [...sorted(rust.values()), ...sorted(npm), ...fonts]) {
  for (const text of pkg.texts) {
    const label = `${[pkg.name, pkg.version].filter(Boolean).join(' ')} (${text.name})`;
    texts.set(text.text, [...(texts.get(text.text) ?? []), label]);
  }
}
for (const [text, labels] of texts) sections.push('', `--- ${labels.join(', ')} ---`, '', text);
writeFileSync(output, sections.join('\n') + '\n');
console.log(
  `Third-party notices: ${rust.size} crates, ${npm.length} npm packages, ${fonts.length} fonts -> ${output}`,
);

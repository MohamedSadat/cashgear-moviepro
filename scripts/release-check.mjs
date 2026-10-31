// Checks a release before it is built (pnpm release:check; the release workflow runs
// it on a version tag):
//   - one version everywhere: package.json files, the Cargo workspace, tauri.conf.json,
//     the tag (GITHUB_REF_NAME, when set), and a CHANGELOG.md section for it;
//   - which release settings are present. Without all of them the workflow builds
//     and tests the release but does not draft it. Licensing is optional: without a
//     licence server and keys the release has every feature.
// Prints the version, and writes `version`, `notes` (the changelog section, as a
// file) and `complete` to GITHUB_OUTPUT when it is set.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const problems = [];
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const version = json('package.json').version;
const versions = { 'package.json': version };
for (const group of ['apps', 'packages', 'services']) {
  for (const name of readdirSync(join(root, group))) {
    const path = `${group}/${name}/package.json`;
    if (existsSync(join(root, path))) versions[path] = json(path).version;
  }
}
versions['apps/desktop/src-tauri/tauri.conf.json'] = json(
  'apps/desktop/src-tauri/tauri.conf.json',
).version;
versions['Cargo.toml'] = readFileSync(join(root, 'Cargo.toml'), 'utf8').match(
  /\[workspace\.package\][^[]*?version\s*=\s*"([^"]+)"/,
)?.[1];
for (const [path, found] of Object.entries(versions)) {
  if (found !== version) problems.push(`${path} is version ${found}, not ${version}.`);
}
// A run on a branch (workflow_dispatch) has no tag to check.
const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : null;
if (tag && tag !== `v${version}`) problems.push(`The tag ${tag} is not v${version}.`);

const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const section = changelog.match(
  new RegExp(
    `^## \\[?${version.replace(/\./g, '\\.')}\\]?[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
    'm',
  ),
)?.[1];
if (!section?.trim()) problems.push(`CHANGELOG.md has no section for ${version}.`);

const env = process.env;
const licensing = !!(env.VITE_CGV_LICENCE_SERVER && env.VITE_CGV_LICENCE_KEYS);
if (!!env.VITE_CGV_LICENCE_SERVER !== !!env.VITE_CGV_LICENCE_KEYS)
  problems.push('Set both CGV_LICENCE_SERVER and CGV_LICENCE_KEYS, or neither.');
const settings = {
  "updater's public key (CGV_UPDATER_PUBKEY)": env.CGV_UPDATER_PUBKEY,
  "updater's private key (TAURI_SIGNING_PRIVATE_KEY)": env.TAURI_SIGNING_PRIVATE_KEY,
  'Azure Artifact Signing (CGV_SIGN_ENDPOINT, CGV_SIGN_ACCOUNT, CGV_SIGN_PROFILE)':
    env.CGV_SIGN_ENDPOINT && env.CGV_SIGN_ACCOUNT && env.CGV_SIGN_PROFILE,
};
const missing = Object.entries(settings)
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (problems.length) {
  console.error('The release is not ready:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`Release ${version}: versions agree, and the changelog has its notes.`);
console.log(
  missing.length
    ? 'Missing release settings (the release is built and tested, not drafted):\n  ' +
        missing.join('\n  ')
    : 'Every release setting is present.',
);
console.log(
  licensing
    ? 'Licensing is set up: the free edition applies until a key is activated.'
    : 'Licensing is not set up: the release has every feature.',
);
if (env.GITHUB_OUTPUT) {
  mkdirSync(join(root, 'target'), { recursive: true });
  const notes = join(root, 'target/release-notes.md');
  writeFileSync(notes, section.trim() + '\n');
  appendFileSync(
    env.GITHUB_OUTPUT,
    `version=${version}\nnotes=${notes}\ncomplete=${!missing.length}\n`,
  );
}

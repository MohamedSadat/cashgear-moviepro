// OpenTimelineIO's Python package and its FCP7 adapter in .tools/otio, a test
// tool that reads the timelines we write (crates/cgv-exchange/tests). It is never
// shipped. Its wheels stop at Python 3.13, so a newer Python gets uv to fetch one.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const OTIO = 'opentimelineio==0.18.1';
const ADAPTER = 'otio-fcp-adapter==1.0.0';
const windows = process.platform === 'win32';
const venv = join(root, '.tools/otio');
const python = join(venv, windows ? 'Scripts/python.exe' : 'bin/python');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

/** The minor version of Python 3 that `command` runs, or null. */
function minorOf(command) {
  const result = spawnSync(command, ['-c', 'import sys; print(sys.version_info[1])'], {
    encoding: 'utf8',
  });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}

function makeVenv() {
  const candidates = [
    process.env.CGV_OTIO_BASE_PYTHON,
    'python3.12',
    'python3.13',
    'python3.11',
    'python3',
    'python',
  ].filter(Boolean);
  const usable = candidates.find((command) => {
    const minor = minorOf(command);
    return minor !== null && minor >= 9 && minor <= 13;
  });
  if (usable) return run(usable, ['-m', 'venv', venv]);
  // Only a newer Python here: uv brings its own 3.12.
  const tools = join(root, '.tools/uv');
  const base = candidates.find((command) => minorOf(command) !== null);
  if (!base) throw new Error('Python is missing');
  run(base, ['-m', 'pip', 'install', '--quiet', '--target', tools, 'uv==0.9.5']);
  const env = { ...process.env, PYTHONPATH: tools };
  const made = spawnSync(base, ['-m', 'uv', 'venv', '--seed', '--python', '3.12', venv], {
    stdio: 'inherit',
    cwd: root,
    env,
  });
  if (made.status !== 0) throw new Error('uv could not make the Python 3.12 environment');
}

if (!existsSync(python)) makeVenv();
run(python, ['-m', 'pip', 'install', '--quiet', OTIO, ADAPTER]);
run(python, [
  '-c',
  'import opentimelineio as otio; print("OpenTimelineIO", otio.__version__, "is ready")',
]);

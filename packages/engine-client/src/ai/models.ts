import { Hasher } from '../pkg/ai/cgv_ai';
import registry from './models.json';

// The AI models, downloaded on first use into the browser's private storage
// (OPFS, in the desktop's webview as on the web) under `models/<id>/`. Each file
// is checked by size and SHA-256 as it streams in; a model counts as installed
// once `ready.json` names its revision and files, which is written last.

export type ModelId = 'whisper-large-v3-turbo' | 'whisper-tiny' | 'selfie' | 'selfie-landscape';

export interface ModelFile {
  role: string;
  path: string;
  size: number;
  sha256: string;
}

export interface ModelInfo {
  id: ModelId;
  /** The model's answer to a fixed input on the CPU, which a GPU must match. */
  check?: { samples: number[]; top?: number[] };
  /**
   * Whether each window of speech is prompted with the text before it. Large
   * models skip less with it; small ones skip more.
   */
  previousText?: boolean;
  name: string;
  use: string;
  license: string;
  origin: string;
  repo: string;
  revision: string;
  files: ModelFile[];
}

export const models = registry.models as ModelInfo[];

export function modelInfo(id: ModelId): ModelInfo {
  const model = models.find((entry) => entry.id === id);
  if (!model) throw new Error(`No model ${id}`);
  return model;
}

/** Bytes a model downloads, all files together. */
export function modelSize(model: ModelInfo) {
  return model.files.reduce((total, file) => total + file.size, 0);
}

/** Where models are fetched from; tests point it at local copies. */
let base = 'https://huggingface.co';
export function setModelBase(url: string | null) {
  base = (url ?? 'https://huggingface.co').replace(/\/$/, '');
}
const fileUrl = (model: ModelInfo, file: ModelFile) =>
  base === 'https://huggingface.co'
    ? `${base}/${model.repo}/resolve/${model.revision}/${file.path}`
    : `${base}/${model.id}/${file.path}`;

async function folder(model: ModelInfo, path: string[], create: boolean) {
  let directory = await navigator.storage.getDirectory();
  for (const part of ['models', model.id, ...path])
    directory = await directory.getDirectoryHandle(part, { create });
  return directory;
}

async function fileHandle(model: ModelInfo, path: string, create: boolean) {
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new Error(`Invalid model file path ${path}`);
  const name = parts.pop()!;
  return (await folder(model, parts, create)).getFileHandle(name, { create });
}

/** The note written once every file of a model has checked out. */
function readyNote(model: ModelInfo) {
  return JSON.stringify({
    revision: model.revision,
    files: model.files.map(({ path, sha256 }) => ({ path, sha256 })),
  });
}

export async function isInstalled(model: ModelInfo): Promise<boolean> {
  try {
    const note = await (await fileHandle(model, 'ready.json', false)).getFile();
    return (await note.text()) === readyNote(model);
  } catch {
    return false;
  }
}

type SyncHandle = {
  write(data: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
};

/** Downloads one file into place, checking its size and hash. */
async function download(
  model: ModelInfo,
  file: ModelFile,
  onBytes: (bytes: number) => void,
  check: () => void,
) {
  const response = await fetch(fileUrl(model, file), { mode: 'cors' });
  if (!response.ok || !response.body)
    throw new Error(`Could not download ${model.name} (${response.status}).`);
  const handle = await fileHandle(model, file.path, true);
  const access = await (
    handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> }
  ).createSyncAccessHandle();
  const hasher = new Hasher();
  const reader = response.body.getReader();
  let written = 0;
  try {
    access.truncate(0);
    while (true) {
      check();
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      written += access.write(value, { at: written });
      onBytes(value.byteLength);
    }
    access.flush();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    access.close();
  }
  const hash = hasher.hex();
  hasher.free();
  if (written !== file.size || hash !== file.sha256) {
    // Gone, so the next try downloads it again rather than trusting its size.
    const parts = file.path.split('/');
    const name = parts.pop()!;
    await (await folder(model, parts, false)).removeEntry(name).catch(() => {});
    throw new Error(`${model.name} did not download intact. Try again.`);
  }
}

/**
 * Downloads whatever of a model is missing, reporting progress from 0 to 1.
 * `check` throws to stop it (a cancelled job).
 */
export async function install(
  model: ModelInfo,
  onProgress: (fraction: number) => void,
  check: () => void,
) {
  if (await isInstalled(model)) return onProgress(1);
  const total = modelSize(model);
  let done = 0;
  for (const file of model.files) {
    // A file already there with the right size was hashed when it came in;
    // only an interrupted download leaves a short one.
    const existing = await fileHandle(model, file.path, false)
      .then((handle) => handle.getFile())
      .catch(() => null);
    if (existing?.size === file.size) {
      done += file.size;
      onProgress(done / total);
      continue;
    }
    await download(
      model,
      file,
      (bytes) => {
        done += bytes;
        onProgress(done / total);
      },
      check,
    );
  }
  const note = await fileHandle(model, 'ready.json', true);
  const writable = await note.createWritable();
  await writable.write(readyNote(model));
  await writable.close();
  onProgress(1);
}

/** The bytes of an installed model's file with `role`. */
export async function readModelFile(model: ModelInfo, role: string): Promise<Uint8Array> {
  const file = model.files.find((entry) => entry.role === role);
  if (!file) throw new Error(`${model.name} has no ${role}`);
  const blob = await (await fileHandle(model, file.path, false)).getFile();
  return new Uint8Array(await blob.arrayBuffer());
}

export async function readModelJson<T>(model: ModelInfo, role: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await readModelFile(model, role))) as T;
}

/** Deletes a downloaded model. */
export async function removeModel(model: ModelInfo) {
  const root = await navigator.storage.getDirectory();
  try {
    const all = await root.getDirectoryHandle('models');
    await all.removeEntry(model.id, { recursive: true });
  } catch {
    // Not downloaded.
  }
}

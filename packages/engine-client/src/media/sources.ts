import { ALL_FORMATS, BlobSource, Input, UrlSource } from 'mediabunny';
import type { MediaSourceKind, MediaSourceRef } from './types';

const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export function sourceName(ref: MediaSourceRef): string {
  switch (ref.kind) {
    case 'handle':
      return ref.handle.name;
    case 'file':
      return ref.file.name;
    case 'opfs':
      return ref.path.split('/').pop() ?? ref.path;
    case 'url':
      return ref.name;
  }
}

/** The image MIME type for a still-image file name, or null for audio and video. */
export function imageType(name: string): string | null {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return imageTypes[extension] ?? null;
}

/** What the library records about where an item lives. */
export function sourceKind(ref: MediaSourceRef): MediaSourceKind {
  switch (ref.kind) {
    case 'handle':
      return { kind: 'handle' };
    case 'opfs':
      return { kind: 'opfs', path: ref.path };
    case 'url':
      return { kind: 'path', path: ref.path };
    case 'file':
      throw new Error('Plain files are copied into OPFS before they are opened');
  }
}

async function opfsDirectory(path: string[], create: boolean) {
  let directory = await navigator.storage.getDirectory();
  for (const part of path) directory = await directory.getDirectoryHandle(part, { create });
  return directory;
}

/** Reads a file from the origin-private file system. */
export async function opfsFile(path: string): Promise<File> {
  const parts = path.split('/');
  const name = parts.pop()!;
  const directory = await opfsDirectory(parts, false);
  return (await directory.getFileHandle(name)).getFile();
}

/**
 * Copies a plain File into OPFS at `media/<id>/<name>`, for browsers without
 * File System Access handles. Uses a sync access handle (workers only).
 */
export async function copyToOpfs(id: string, file: File): Promise<string> {
  const name = file.name.replace(/[\\/:*?"<>|]/g, '_') || 'media';
  const directory = await opfsDirectory(['media', id], true);
  const handle = await directory.getFileHandle(name, { create: true });
  const access = await (
    handle as FileSystemFileHandle & {
      createSyncAccessHandle(): Promise<{
        write(data: Uint8Array, options: { at: number }): number;
        truncate(size: number): void;
        flush(): void;
        close(): void;
      }>;
    }
  ).createSyncAccessHandle();
  try {
    access.truncate(0);
    let offset = 0;
    const reader = file.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      offset += access.write(value, { at: offset });
    }
    access.flush();
  } finally {
    access.close();
  }
  return `media/${id}/${name}`;
}

/** The bytes of a local source as a Blob; desktop URLs have none. */
export async function sourceBlob(ref: MediaSourceRef): Promise<Blob | null> {
  switch (ref.kind) {
    case 'handle':
      return ref.handle.getFile();
    case 'file':
      return ref.file;
    case 'opfs':
      return opfsFile(ref.path);
    case 'url':
      return null;
  }
}

export async function sourceSize(ref: MediaSourceRef): Promise<number> {
  if (ref.kind === 'url') return ref.size;
  return (await sourceBlob(ref))!.size;
}

/** A Mediabunny input reading the source in place (no copy into memory). */
export async function openInput(ref: MediaSourceRef): Promise<Input> {
  const blob = await sourceBlob(ref);
  const source =
    blob !== null
      ? new BlobSource(blob)
      : new UrlSource((ref as Extract<MediaSourceRef, { kind: 'url' }>).url);
  return new Input({ source, formats: ALL_FORMATS });
}

/** The whole file, for image decoding. */
export async function readAll(ref: MediaSourceRef): Promise<ArrayBuffer> {
  const blob = await sourceBlob(ref);
  if (blob) return blob.arrayBuffer();
  const response = await fetch((ref as Extract<MediaSourceRef, { kind: 'url' }>).url);
  if (!response.ok) throw new Error(`Could not read ${sourceName(ref)}: ${response.status}`);
  return response.arrayBuffer();
}

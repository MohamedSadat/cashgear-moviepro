// Files of the app's own pack (stickers, sounds) as media sources.
import type { MediaSourceRef } from '@cgv/engine-client';
import { soundRequest, sounds } from '../sounds/catalog';
import { stickerRequest, stickers } from '../stickers/catalog';

/** Where the engine reads pack file `path` (under assets) in this build, or null. */
export function packSource(path: string): Extract<MediaSourceRef, { kind: 'pack' }> | null {
  const sticker = stickers.find((s) => s.file === path);
  const sound = sounds.find((s) => s.file === path);
  const request = sticker ? stickerRequest(sticker) : sound ? soundRequest(sound) : null;
  return request?.source.kind === 'pack' ? request.source : null;
}

// The built-in stickers: animated WebP files in assets/stickers, listed in its
// stickers.json (scripts/make-stickers.mjs writes both). A sticker in a project is
// media of the app's pack, found again by its path wherever the project opens.
import { FLICKS_PER_SECOND, type ImportRequest, type MediaSourceRef } from '@cgv/engine-client';

interface ManifestSticker {
  id: string;
  name: string;
  category: string;
  /** Its path under assets. */
  file: string;
  bytes: number;
  seconds: number;
}

export interface Sticker extends ManifestSticker {
  /** Where this build serves it. */
  url: string;
}

const assets = '../../../../assets/';
const manifests = import.meta.glob<{ stickers: ManifestSticker[] }>(
  '../../../../assets/stickers/stickers.json',
  { eager: true, import: 'default' },
);
const urls = import.meta.glob<string>('../../../../assets/stickers/*.webp', {
  query: '?url',
  import: 'default',
  eager: true,
});

export const stickers: Sticker[] = (manifests[assets + 'stickers/stickers.json']?.stickers ?? [])
  .map((sticker) => ({ ...sticker, url: urls[assets + sticker.file] }))
  .filter((sticker) => !!sticker.url);

/** A new sticker clip lasts this long; its loop repeats. */
export const stickerDuration = 5 * FLICKS_PER_SECOND;
/** A new sticker's scale: about a third of the frame's height. */
export const stickerScale = 0.35;

/** The project media id of a sticker: the same each time it is added. */
export const stickerMediaId = (sticker: Sticker) => `sticker-${sticker.id}`;

/** Where the engine reads pack file `path` (under assets) in this build, or null. */
export function packSource(path: string): Extract<MediaSourceRef, { kind: 'pack' }> | null {
  const sticker = stickers.find((s) => s.file === path);
  if (!sticker) return null;
  return {
    kind: 'pack',
    path: sticker.file,
    url: sticker.url,
    name: `${sticker.id}.webp`,
    size: sticker.bytes,
  };
}

/** The import of `sticker` into the project's media. */
export function stickerRequest(sticker: Sticker): ImportRequest {
  return { id: stickerMediaId(sticker), source: packSource(sticker.file)! };
}

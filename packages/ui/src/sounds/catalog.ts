// The built-in sound library: music beds and sound effects as Opus files in
// assets/sounds, listed in its sounds.json (scripts/make-sounds.mjs writes both).
// A sound in a project is media of the app's pack, found again by its path
// wherever the project opens.
import type { ImportRequest } from '@cgv/engine-client';

interface ManifestSound {
  id: string;
  name: string;
  kind: 'music' | 'effect';
  category: string;
  /** Its path under assets. */
  file: string;
  bytes: number;
  seconds: number;
  bpm?: number;
}

export interface Sound extends ManifestSound {
  /** Where this build serves it. */
  url: string;
}

const assets = '../../../../assets/';
const manifests = import.meta.glob<{ sounds: ManifestSound[] }>(
  '../../../../assets/sounds/sounds.json',
  { eager: true, import: 'default' },
);
const urls = import.meta.glob<string>('../../../../assets/sounds/*.webm', {
  query: '?url',
  import: 'default',
  eager: true,
});

export const sounds: Sound[] = (manifests[assets + 'sounds/sounds.json']?.sounds ?? [])
  .map((sound) => ({ ...sound, url: urls[assets + sound.file] }))
  .filter((sound) => !!sound.url);

/** The project media id of a sound: the same each time it is added. */
export const soundMediaId = (sound: Sound) => `sound-${sound.id}`;

/** The import of `sound` into the project's media. */
export function soundRequest(sound: Sound): ImportRequest {
  return {
    id: soundMediaId(sound),
    source: {
      kind: 'pack',
      path: sound.file,
      url: sound.url,
      name: `${sound.id}.webm`,
      size: sound.bytes,
    },
  };
}

/** "1:05", "0:02" */
export function soundLength(seconds: number) {
  const whole = Math.max(1, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

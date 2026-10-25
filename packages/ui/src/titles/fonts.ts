// Fonts beyond the bundled ones: files the user imports (kept in the browser's
// private storage) and, on the desktop, the fonts installed on the computer.
// Each joins the page's font catalogue, which the engine's workers follow.
import { useSyncExternalStore } from 'react';
import {
  fontCatalog,
  importFont,
  importedFonts,
  type FontFamilyEntry,
  type FontFamilyInfo,
  type Title,
} from '@cgv/engine-client';
import type { MediaPlatform } from '../platform';

/** Adds the imported and installed families to the catalogue. */
export async function loadExtraFonts(platform: MediaPlatform): Promise<void> {
  const sources: [string, Promise<FontFamilyEntry[]>][] = [
    ['Imported fonts', importedFonts()],
    ['Installed fonts', platform.installedFonts?.() ?? Promise.resolve([])],
  ];
  for (const [name, entries] of sources) {
    try {
      fontCatalog().addEntries(await entries);
    } catch (error) {
      console.warn(`${name} could not be listed: ${String(error)}`);
    }
  }
}

/** Keeps a font file the user picked and adds it; resolves to its family. */
export async function importFontFile(file: File): Promise<string> {
  const entry = await importFont(file);
  fontCatalog().addEntries([entry]);
  return entry.family;
}

let listed: FontFamilyInfo[] | null = null;
const subscribe = (listener: () => void) =>
  fontCatalog().subscribe(() => {
    listed = null;
    listener();
  });
const snapshot = () => (listed ??= fontCatalog().list());

/** Every family titles can use, kept current as fonts are added. */
export function useFontFamilies(): FontFamilyInfo[] {
  return useSyncExternalStore(subscribe, snapshot);
}

/** The picker's groups: bundled families by script, then imported, then installed. */
export function fontGroups(families: FontFamilyInfo[]): { name: string; families: string[] }[] {
  const groups: [string, (family: FontFamilyInfo) => boolean][] = [
    ['Latin', (f) => f.origin === 'bundled' && f.script === 'latin'],
    ['Arabic', (f) => f.origin === 'bundled' && f.script === 'arabic'],
    ['Emoji', (f) => f.origin === 'bundled' && f.script === 'emoji'],
    ['Other', (f) => f.origin === 'bundled' && f.script === 'other'],
    ['Imported', (f) => f.origin === 'imported'],
    ['Installed', (f) => f.origin === 'system'],
  ];
  return groups
    .map(([name, belongs]) => ({
      name,
      families: families.filter(belongs).map((f) => f.family),
    }))
    .filter((group) => group.families.length > 0);
}

/** The families the project's titles name that `families` lacks (names match in any case). */
export function missingFonts(
  project: { tracks: { clips: { title?: Title | null }[] }[] },
  families: FontFamilyInfo[],
): string[] {
  const known = new Set(families.map((f) => f.family.toLowerCase()));
  const missing = new Map<string, string>();
  for (const track of project.tracks)
    for (const clip of track.clips)
      for (const element of clip.title?.elements ?? []) {
        if (element.type !== 'text') continue;
        const key = element.font.family.toLowerCase();
        if (!known.has(key) && !missing.has(key)) missing.set(key, element.font.family);
      }
  return [...missing.values()].sort((a, b) => a.localeCompare(b));
}

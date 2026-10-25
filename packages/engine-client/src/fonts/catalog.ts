// The fonts titles can use: the bundled families (assets/fonts, listed in its
// fonts.json), and fonts added later (imported files, installed desktop fonts).
// Each file is fetched the first time a title needs its family.

interface ManifestFamily {
  family: string;
  script: string;
  files: { from: string; file?: string }[];
}

const assets = '../../../../assets/fonts/';
const manifests = import.meta.glob<{ families: ManifestFamily[] }>(
  '../../../../assets/fonts/fonts.json',
  { eager: true, import: 'default' },
);
const urls = import.meta.glob<string>('../../../../assets/fonts/**/*.ttf', {
  query: '?url',
  import: 'default',
  eager: true,
});

export type FontScript = 'arabic' | 'latin' | 'emoji' | 'other';
export type FontOrigin = 'bundled' | 'imported' | 'system';

/** A family as the font picker lists it. */
export interface FontFamilyInfo {
  family: string;
  script: FontScript;
  origin: FontOrigin;
}

/** One font file: `source` names it to the engine, once. */
export interface FontFile {
  source: string;
  load(): Promise<Uint8Array>;
}

/**
 * A family that is not bundled, as threads pass it to each other: its files are
 * fetched from `url` (an installed font, through the desktop's media protocol)
 * or read from the origin-private file system at `opfs` (an imported one).
 */
export interface FontFamilyEntry extends FontFamilyInfo {
  files: { source: string; url?: string; opfs?: string }[];
}

/** The folder `pnpm fetch-fonts` keeps a family in. */
function folder(family: string) {
  return family.toLowerCase().replaceAll(' ', '-');
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The font ${url} could not be loaded (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function opfsBytes(path: string): Promise<Uint8Array> {
  const parts = path.split('/');
  const name = parts.pop()!;
  let directory = await navigator.storage.getDirectory();
  for (const part of parts) directory = await directory.getDirectoryHandle(part);
  const file = await (await directory.getFileHandle(name)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

function entryFiles(entry: FontFamilyEntry): FontFile[] {
  return entry.files.map(({ source, url, opfs }) => ({
    source,
    load: () =>
      url
        ? fetchBytes(url)
        : opfs
          ? opfsBytes(opfs)
          : Promise.reject(new Error(`${source} has no file`)),
  }));
}

export class FontCatalog {
  private families = new Map<string, { info: FontFamilyInfo; files: FontFile[] }>();
  /** Families added from elsewhere (imported, installed), to pass on to other workers. */
  private entries = new Map<string, FontFamilyEntry>();
  private listeners = new Set<() => void>();

  /** The bundled families, ready to fetch. */
  static bundled(): FontCatalog {
    const catalog = new FontCatalog();
    const manifest = manifests[assets + 'fonts.json'];
    for (const entry of manifest?.families ?? []) {
      const files = entry.files.map(({ from, file }) => {
        const name = file ?? from;
        const url = urls[`${assets}${folder(entry.family)}/${name}`];
        if (!url) throw new Error(`The font ${name} is missing from the build`);
        return { source: `bundled:${name}`, load: () => fetchBytes(url) };
      });
      const script = (
        ['arabic', 'latin', 'emoji'].includes(entry.script) ? entry.script : 'other'
      ) as FontScript;
      catalog.add({ family: entry.family, script, origin: 'bundled' }, files);
    }
    return catalog;
  }

  /** Adds a family, or more files of one (a bold face, say). */
  add(info: FontFamilyInfo, files: FontFile[]) {
    const key = info.family.toLowerCase();
    const known = this.families.get(key);
    if (known)
      known.files.push(...files.filter((f) => !known.files.some((k) => k.source === f.source)));
    else this.families.set(key, { info, files: [...files] });
  }

  /** Adds families that are not bundled (or more files of them). */
  addEntries(entries: FontFamilyEntry[]) {
    for (const entry of entries) {
      const key = entry.family.toLowerCase();
      if (this.families.get(key)?.info.origin === 'bundled') continue;
      const known = this.entries.get(key);
      const files = [
        ...(known?.files ?? []),
        ...entry.files.filter((f) => !known?.files.some((k) => k.source === f.source)),
      ];
      const merged = { ...(known ?? entry), files };
      this.entries.set(key, merged);
      const { family, script, origin } = merged;
      this.add({ family, script, origin }, entryFiles(merged));
    }
    for (const listener of this.listeners) listener();
  }

  /** The families added from elsewhere, for another worker's catalogue. */
  extras(): FontFamilyEntry[] {
    return [...this.entries.values()];
  }

  /** Calls `listener` whenever families are added; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  has(family: string): boolean {
    return this.families.has(family.toLowerCase());
  }

  files(family: string): FontFile[] {
    return this.families.get(family.toLowerCase())?.files ?? [];
  }

  /** Every family, bundled first, each group by name. */
  list(): FontFamilyInfo[] {
    const order: FontOrigin[] = ['bundled', 'imported', 'system'];
    return [...this.families.values()]
      .map(({ info }) => info)
      .sort(
        (a, b) =>
          order.indexOf(a.origin) - order.indexOf(b.origin) || a.family.localeCompare(b.family),
      );
  }
}

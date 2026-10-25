// Fonts the user imports (the web app): kept in the origin-private file system,
// under fonts/, with fonts/index.json listing each file's family.
import type { FontFamilyEntry } from './catalog';
import { fontFamily } from './names';

const folder = 'fonts';
const indexName = 'index.json';

interface IndexEntry {
  family: string;
  file: string;
}

async function directory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(folder, { create: true });
}

async function readIndex(): Promise<IndexEntry[]> {
  try {
    const handle = await (await directory()).getFileHandle(indexName);
    return JSON.parse(await (await handle.getFile()).text()) as IndexEntry[];
  } catch {
    return [];
  }
}

function entries(index: IndexEntry[]): FontFamilyEntry[] {
  const byFamily = new Map<string, FontFamilyEntry>();
  for (const { family, file } of index) {
    const entry = byFamily.get(family) ?? {
      family,
      script: 'other' as const,
      origin: 'imported' as const,
      files: [],
    };
    entry.files.push({ source: `imported:${file}`, opfs: `${folder}/${file}` });
    byFamily.set(family, entry);
  }
  return [...byFamily.values()];
}

/** The imported families. */
export async function importedFonts(): Promise<FontFamilyEntry[]> {
  return entries(await readIndex());
}

/** Keeps a font file the user picked; resolves to its family as the catalogue lists it. */
export async function importFont(file: File): Promise<FontFamilyEntry> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const family = fontFamily(bytes);
  if (!family) throw new Error(`${file.name} is not a TrueType or OpenType font`);
  const name = `${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, '_')}`;
  const dir = await directory();
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(bytes);
  await writable.close();
  const index = [...(await readIndex()), { family, file: name }];
  const indexFile = await (await dir.getFileHandle(indexName, { create: true })).createWritable();
  await indexFile.write(JSON.stringify(index));
  await indexFile.close();
  return entries(index).find((entry) => entry.family === family)!;
}

import { describe, expect, it } from 'vitest';
import { FontCatalog } from './catalog';
import { fontFamily } from './names';

interface Name {
  id: number;
  text: string;
  /** Windows (3) by default; Mac (1) holds Roman bytes. */
  platform?: number;
  language?: number;
}

/** A TrueType file holding only a `name` table, or a collection whose first face it is. */
function font(names: Name[], { collection = false, tag = 0x00010000 } = {}): Uint8Array {
  const strings: number[] = [];
  const records = names.map(({ id, text, platform = 3, language = 0x409 }) => {
    const start = strings.length;
    for (const char of text) {
      if (platform === 1) strings.push(char.charCodeAt(0));
      else strings.push(char.charCodeAt(0) >> 8, char.charCodeAt(0) & 0xff);
    }
    return {
      platform,
      encoding: platform === 1 ? 0 : 1,
      language,
      id,
      start,
      length: strings.length - start,
    };
  });
  const head = collection ? 16 : 0;
  const nameAt = head + 12 + 16;
  const table = 6 + records.length * 12;
  const bytes = new Uint8Array(nameAt + table + strings.length);
  const view = new DataView(bytes.buffer);
  if (collection) {
    view.setUint32(0, 0x74746366); // 'ttcf'
    view.setUint32(4, 0x00010000);
    view.setUint32(8, 1);
    view.setUint32(12, head);
  }
  view.setUint32(head, tag);
  view.setUint16(head + 4, 1);
  view.setUint32(head + 12, 0x6e616d65); // 'name'
  view.setUint32(head + 12 + 8, nameAt);
  view.setUint32(head + 12 + 12, table + strings.length);
  view.setUint16(nameAt + 2, records.length);
  view.setUint16(nameAt + 4, table);
  records.forEach((record, i) => {
    const at = nameAt + 6 + i * 12;
    view.setUint16(at, record.platform);
    view.setUint16(at + 2, record.encoding);
    view.setUint16(at + 4, record.language);
    view.setUint16(at + 6, record.id);
    view.setUint16(at + 8, record.length);
    view.setUint16(at + 10, record.start);
  });
  bytes.set(strings, nameAt + table);
  return bytes;
}

describe('fontFamily', () => {
  it('reads the family a picker groups a font under', () => {
    expect(fontFamily(font([{ id: 1, text: 'Inter' }]))).toBe('Inter');
    // Static weights share their typographic family.
    expect(
      fontFamily(
        font([
          { id: 1, text: 'Tajawal ExtraLight' },
          { id: 16, text: 'Tajawal' },
        ]),
      ),
    ).toBe('Tajawal');
    // English wins over other languages, and Mac Roman names count as English.
    expect(
      fontFamily(
        font([
          { id: 1, text: 'Schrift', language: 0x407 },
          { id: 1, text: 'Script', language: 0x409 },
        ]),
      ),
    ).toBe('Script');
    expect(fontFamily(font([{ id: 1, text: 'Old Style', platform: 1 }]))).toBe('Old Style');
  });

  it('reads OpenType files and the first face of a collection', () => {
    expect(fontFamily(font([{ id: 1, text: 'Outline' }], { tag: 0x4f54544f }))).toBe('Outline');
    expect(fontFamily(font([{ id: 1, text: 'Pair' }], { collection: true }))).toBe('Pair');
  });

  it('refuses what is not a font', () => {
    expect(fontFamily(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(fontFamily(new TextEncoder().encode('not a font, just some text here'))).toBeNull();
    expect(fontFamily(font([{ id: 4, text: 'Full name only' }]))).toBeNull();
  });
});

describe('FontCatalog.addEntries', () => {
  const bundled = () => {
    const catalog = new FontCatalog();
    const load = () => Promise.resolve(new Uint8Array());
    catalog.add({ family: 'Inter', script: 'latin', origin: 'bundled' }, [
      { source: 'bundled:Inter.ttf', load },
    ]);
    return catalog;
  };

  it('adds imported and installed families after the bundled ones, once each', () => {
    const catalog = bundled();
    let changes = 0;
    catalog.subscribe(() => changes++);
    const regular = { source: 'system:font-1', url: 'cgv-media://localhost/font-1' };
    const bold = { source: 'system:font-2', url: 'cgv-media://localhost/font-2' };
    catalog.addEntries([{ family: 'Arial', script: 'other', origin: 'system', files: [regular] }]);
    catalog.addEntries([
      { family: 'Arial', script: 'other', origin: 'system', files: [regular, bold] },
      {
        family: 'Mine',
        script: 'other',
        origin: 'imported',
        files: [{ source: 'imported:a', opfs: 'fonts/a' }],
      },
    ]);
    expect(changes).toBe(2);
    expect(catalog.list().map((f) => f.family)).toEqual(['Inter', 'Mine', 'Arial']);
    expect(catalog.files('arial').map((f) => f.source)).toEqual(['system:font-1', 'system:font-2']);
    // Another worker's catalogue gets the same families from `extras`.
    const other = bundled();
    other.addEntries(catalog.extras());
    expect(other.list()).toEqual(catalog.list());
    expect(other.files('Arial')).toHaveLength(2);
  });

  it('keeps a bundled family bundled', () => {
    const catalog = bundled();
    catalog.addEntries([
      {
        family: 'inter',
        script: 'other',
        origin: 'system',
        files: [{ source: 'system:x', url: 'u' }],
      },
    ]);
    expect(catalog.list()).toEqual([{ family: 'Inter', script: 'latin', origin: 'bundled' }]);
    expect(catalog.files('Inter').map((f) => f.source)).toEqual(['bundled:Inter.ttf']);
    expect(catalog.extras()).toEqual([]);
  });
});

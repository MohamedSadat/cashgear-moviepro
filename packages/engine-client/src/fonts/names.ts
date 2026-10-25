// Reads a font file's family name from its `name` table, for listing an imported
// font before any engine has it: the typographic family (name 16) where the font
// has one, else its family (name 1), in English where it says.

/** The family of the first face of a TrueType or OpenType file (or collection), or null. */
export function fontFamily(bytes: Uint8Array): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) return null;
  let offset = 0;
  // A collection: the first face's table directory.
  if (view.getUint32(0) === 0x74746366) offset = view.getUint32(12);
  const tag = view.getUint32(offset);
  const known = [0x00010000, 0x4f54544f, 0x74727565]; // TrueType, 'OTTO', 'true'
  if (!known.includes(tag)) return null;
  const tables = view.getUint16(offset + 4);
  let name = -1;
  for (let i = 0; i < tables; i++) {
    const record = offset + 12 + i * 16;
    if (record + 16 > bytes.byteLength) return null;
    if (view.getUint32(record) === 0x6e616d65) name = view.getUint32(record + 8);
  }
  if (name < 0 || name + 6 > bytes.byteLength) return null;
  const count = view.getUint16(name + 2);
  const strings = name + view.getUint16(name + 4);
  const found = new Map<number, { score: number; text: string }>();
  for (let i = 0; i < count; i++) {
    const record = name + 6 + i * 12;
    if (record + 12 > bytes.byteLength) break;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const language = view.getUint16(record + 4);
    const id = view.getUint16(record + 6);
    if (id !== 1 && id !== 16) continue;
    const length = view.getUint16(record + 8);
    const start = strings + view.getUint16(record + 10);
    if (start + length > bytes.byteLength) continue;
    // Windows Unicode and Unicode platforms hold UTF-16BE; Mac Roman holds bytes.
    let text = '';
    if (platform === 3 || platform === 0) {
      for (let at = start; at + 1 < start + length; at += 2)
        text += String.fromCharCode(view.getUint16(at));
    } else if (platform === 1 && encoding === 0) {
      for (let at = start; at < start + length; at++) text += String.fromCharCode(bytes[at]);
    } else continue;
    // English (Windows US English, or any Mac Roman) wins.
    const score = (platform === 3 && language === 0x409) || platform === 1 ? 2 : 1;
    const best = found.get(id);
    if (text.trim() && (!best || score > best.score)) found.set(id, { score, text: text.trim() });
  }
  return found.get(16)?.text ?? found.get(1)?.text ?? null;
}

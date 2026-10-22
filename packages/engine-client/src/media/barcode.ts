// The test clips carry their frame number as 16 blocks across the top eighth
// of the picture: bit 0 on the left, white = 1 (see scripts/make-test-media.mjs).

export const barcodeBits = 16;

/** Decodes the barcode from one row of luma (limited range), or -1 if unreadable. */
export function readBarcode(luma: Uint8Array, width: number): number {
  let value = 0;
  for (let bit = 0; bit < barcodeBits; bit++) {
    const level = luma[Math.floor(((bit + 0.5) * width) / barcodeBits)];
    // Blocks are coded near 16 or 235; anything far in between is noise or not a barcode.
    if (level > 180) value |= 1 << bit;
    else if (level > 70) return -1;
  }
  return value;
}

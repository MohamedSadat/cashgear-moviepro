// The scopes' graticule, from BT.709's weights as the engine counts with them
// (crates/cgv-render/src/scopes.rs). Pure, so the tests check it.

const kr = 0.2126;
const kb = 0.0722;
const kg = 1 - kr - kb;

/** Cb and Cr (−0.5 to 0.5) of R'G'B' from 0 to 1. */
export function colourDifference(r: number, g: number, b: number): { cb: number; cr: number } {
  const y = kr * r + kg * g + kb * b;
  return { cb: (b - y) / (2 * (1 - kb)), cr: (r - y) / (2 * (1 - kr)) };
}

/** The 75% colour bars' vectorscope targets. */
export const vectorTargets: { name: string; cb: number; cr: number }[] = (
  [
    ['R', 1, 0, 0],
    ['Mg', 1, 0, 1],
    ['B', 0, 0, 1],
    ['Cy', 0, 1, 1],
    ['G', 0, 1, 0],
    ['Yl', 1, 1, 0],
  ] as const
).map(([name, r, g, b]) => ({ name, ...colourDifference(0.75 * r, 0.75 * g, 0.75 * b) }));

/** The skin-tone line, in degrees anticlockwise from +Cb. */
export const skinToneDegrees = 123;

/** How bright a scope cell with `count` pixels draws, from 0 to 1, against the busiest `peak`. */
export function traceLevel(count: number, peak: number): number {
  if (count <= 0 || peak <= 0) return 0;
  // A square root keeps sparse detail visible beside flat areas.
  return Math.min(1, 0.15 + 0.85 * Math.sqrt(count / peak));
}

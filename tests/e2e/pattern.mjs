// Reads the Phase 0 test pattern back from a PNG screenshot of the program monitor.
// Keep in sync with crates/cgv-render/src/pattern.rs. Shared by the Playwright
// specs and scripts/desktop-smoke.mjs.

/** Left to right: white, yellow, cyan, green, magenta, red, blue, black. */
export const BAR_COLORS = [
  [255, 255, 255],
  [255, 255, 0],
  [0, 255, 255],
  [0, 255, 0],
  [255, 0, 255],
  [255, 0, 0],
  [0, 0, 255],
  [0, 0, 0],
];
const BARS_HEIGHT = 0.7;
const SWEEP_WIDTH = 1 / 16;

/** @param {{ width: number, height: number, data: Uint8Array }} png */
function pixel(png, x, y) {
  const index = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  return [png.data[index], png.data[index + 1], png.data[index + 2]];
}

/** Returns one message per bar whose center is not its expected color (±1). */
export function barMismatches(png) {
  const y = png.height * BARS_HEIGHT * 0.5;
  return BAR_COLORS.flatMap((expected, bar) => {
    const actual = pixel(png, ((bar + 0.5) / 8) * png.width, y);
    return actual.every((value, channel) => Math.abs(value - expected[channel]) <= 1)
      ? []
      : ['bar ' + bar + ': expected ' + expected + ', got ' + actual];
  });
}

/**
 * Finds the white sweep band in the strip below the bars. Returns its center as
 * a fraction of the width, its width in pixels and the width it should have.
 */
export function sweepBand(png) {
  const y = png.height * (BARS_HEIGHT + 1) * 0.5;
  const white = [];
  for (let x = 0; x < png.width; x++) {
    if (pixel(png, x, y).every((value) => value >= 254)) white.push(x);
  }
  if (!white.length) return { center: undefined, width: 0, expectedWidth: png.width * SWEEP_WIDTH };
  // A band that wraps around the right edge splits into two runs; unwrap it.
  const gap = white.findIndex((x, i) => i > 0 && x - white[i - 1] > 1);
  const unwrapped =
    gap < 0 ? white : [...white.slice(gap), ...white.slice(0, gap).map((x) => x + png.width)];
  const center = ((unwrapped[0] + unwrapped.at(-1)) / 2 / png.width) % 1;
  return { center, width: white.length, expectedWidth: png.width * SWEEP_WIDTH };
}

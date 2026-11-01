//! Scopes of a composed frame: the waveform (luma, or R', G' and B' side by
//! side), the vectorscope and the histogram. They are counted from a small
//! readback of the frame in sRGB-encoded R'G'B', as exports encode it, with
//! BT.709's luma and colour-difference weights, as the export's Y'CbCr has them.
//! The monitor reads one back a few times a second, so they follow playback.

/// Rows of the waveform and bins of the histogram: one per 8-bit level.
pub const LEVELS: usize = 256;
/// Sides of the vectorscope's square: Cb across, Cr up.
pub const VECTOR_SIZE: usize = 256;
/// The skin-tone line, in degrees anticlockwise from +Cb (the I axis of NTSC).
pub const SKIN_TONE_DEGREES: f64 = 123.0;

const KR: f64 = 0.2126;
const KB: f64 = 0.0722;
const KG: f64 = 1.0 - KR - KB;

/// Counts, bottom row (level 0) first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scopes {
    /// Waveform columns, each a sample of the frame's width.
    pub columns: usize,
    /// `LEVELS` rows of `columns` counts each: how many pixels of each column
    /// have each luma level.
    pub luma: Vec<u32>,
    /// The parade: the same for R', G' and B'.
    pub parade: [Vec<u32>; 3],
    /// `VECTOR_SIZE` rows of `VECTOR_SIZE`: Cb from left to right, Cr from bottom to top.
    pub vector: Vec<u32>,
    /// Pixels at each level of R', G', B' and luma.
    pub histogram: [Vec<u32>; 4],
}

/// Y', Cb and Cr of 8-bit R'G'B' levels, Y' from 0 to 255, Cb and Cr from −0.5 to 0.5.
pub fn ycbcr(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let y = KR * r + KG * g + KB * b;
    let cb = (b - y) / (2.0 * (1.0 - KB)) / 255.0;
    let cr = (r - y) / (2.0 * (1.0 - KR)) / 255.0;
    (y, cb, cr)
}

/// The vectorscope cell of a colour difference: `cb` and `cr` from −0.5 to 0.5.
pub fn vector_cell(cb: f64, cr: f64) -> (usize, usize) {
    let cell = |value: f64| {
        ((value + 0.5) * VECTOR_SIZE as f64)
            .floor()
            .clamp(0.0, (VECTOR_SIZE - 1) as f64) as usize
    };
    (cell(cb), cell(cr))
}

/// The six 75% colour bars' targets on the vectorscope, as (name, Cb, Cr):
/// red, magenta, blue, cyan, green and yellow at 75% of full amplitude.
pub fn targets() -> [(&'static str, f64, f64); 6] {
    let at = |r: f64, g: f64, b: f64| {
        let (_, cb, cr) = ycbcr(r * 191.25, g * 191.25, b * 191.25);
        (cb, cr)
    };
    let named = |name, (cb, cr): (f64, f64)| (name, cb, cr);
    [
        named("R", at(1.0, 0.0, 0.0)),
        named("Mg", at(1.0, 0.0, 1.0)),
        named("B", at(0.0, 0.0, 1.0)),
        named("Cy", at(0.0, 1.0, 1.0)),
        named("G", at(0.0, 1.0, 0.0)),
        named("Yl", at(1.0, 1.0, 0.0)),
    ]
}

/// Counts the scopes of `width` × `height` RGBA pixels (sRGB-encoded, alpha
/// ignored), with `columns` waveform columns.
pub fn measure(pixels: &[u8], width: usize, height: usize, columns: usize) -> Scopes {
    let columns = columns.clamp(1, width.max(1));
    let mut scopes = Scopes {
        columns,
        luma: vec![0; LEVELS * columns],
        parade: std::array::from_fn(|_| vec![0; LEVELS * columns]),
        vector: vec![0; VECTOR_SIZE * VECTOR_SIZE],
        histogram: std::array::from_fn(|_| vec![0; LEVELS]),
    };
    if width == 0 || pixels.len() < width * height * 4 {
        return scopes;
    }
    for row in 0..height {
        for x in 0..width {
            let at = (row * width + x) * 4;
            let [r, g, b] = [pixels[at], pixels[at + 1], pixels[at + 2]];
            let (y, cb, cr) = ycbcr(f64::from(r), f64::from(g), f64::from(b));
            let level = (y.round() as usize).min(LEVELS - 1);
            let column = x * columns / width;
            scopes.luma[level * columns + column] += 1;
            for (channel, value) in [r, g, b].into_iter().enumerate() {
                scopes.parade[channel][usize::from(value) * columns + column] += 1;
                scopes.histogram[channel][usize::from(value)] += 1;
            }
            scopes.histogram[3][level] += 1;
            let (u, v) = vector_cell(cb, cr);
            scopes.vector[v * VECTOR_SIZE + u] += 1;
        }
    }
    scopes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SMPTE-style 75% bars: white at 75%, then yellow, cyan, green, magenta,
    /// red and blue, each `bar` pixels wide and `height` high.
    fn bars(bar: usize, height: usize) -> (Vec<u8>, usize) {
        let level = 191u8;
        let colours = [
            [level, level, level],
            [level, level, 0],
            [0, level, level],
            [0, level, 0],
            [level, 0, level],
            [level, 0, 0],
            [0, 0, level],
        ];
        let width = bar * colours.len();
        let mut pixels = Vec::with_capacity(width * height * 4);
        for _ in 0..height {
            for colour in colours {
                for _ in 0..bar {
                    pixels.extend_from_slice(&[colour[0], colour[1], colour[2], 255]);
                }
            }
        }
        (pixels, width)
    }

    #[test]
    fn bars_land_in_their_vectorscope_targets() {
        let (pixels, width) = bars(20, 10);
        let scopes = measure(&pixels, width, 10, 70);
        for (name, cb, cr) in targets() {
            let (u, v) = vector_cell(cb, cr);
            // Each bar's 200 pixels in its target's cell, within a cell either way.
            let around: u32 = (v.saturating_sub(1)..=(v + 1).min(VECTOR_SIZE - 1))
                .flat_map(|row| {
                    let vector = &scopes.vector;
                    (u.saturating_sub(1)..=(u + 1).min(VECTOR_SIZE - 1))
                        .map(move |col| vector[row * VECTOR_SIZE + col])
                })
                .sum();
            assert_eq!(around, 200, "{name} is not on its target");
        }
        // White sits in the middle.
        let (u, v) = vector_cell(0.0, 0.0);
        assert_eq!(scopes.vector[v * VECTOR_SIZE + u], 200);
    }

    #[test]
    fn the_waveform_shows_each_bars_luma() {
        let (pixels, width) = bars(20, 10);
        let scopes = measure(&pixels, width, 10, 7);
        // Each column is one bar: its luma within 1% of BT.709's weights.
        let weights = [1.0, KR + KG, KG + KB, KG, KR + KB, KR, KB];
        for (column, weight) in weights.iter().enumerate() {
            let expected = 191.0 * weight;
            let level = (0..LEVELS)
                .find(|&level| scopes.luma[level * 7 + column] > 0)
                .unwrap();
            assert!(
                (level as f64 - expected).abs() <= 2.56,
                "column {column}: {level} against {expected}"
            );
            assert_eq!(scopes.luma[level * 7 + column], 200);
        }
        // The parade's red: 191 where the bar has red, 0 elsewhere.
        assert_eq!(scopes.parade[0][191 * 7 + 1], 200);
        assert_eq!(scopes.parade[0][2], 200);
        assert_eq!(scopes.histogram[3].iter().sum::<u32>(), 1400);
    }

    #[test]
    fn targets_are_where_the_standard_puts_them() {
        // 75% red under BT.709: Cb −0.0859 and Cr 0.375, at 102.9°.
        let (_, cb, cr) = targets()[0];
        let degrees = cr.atan2(cb).to_degrees();
        assert!((degrees - 102.9).abs() < 0.1, "{degrees}");
        assert!(((cb * cb + cr * cr).sqrt() - 0.3847).abs() < 0.001);
    }
}

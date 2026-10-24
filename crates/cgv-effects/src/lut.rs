//! LUTs as GPU data: every LUT becomes a cube of RGBA8 texels that shaders read
//! with `apply_lut`.
use cgv_model::LutShape;

/// Points per side of the cube a 1D LUT becomes.
pub const CUBE_FROM_1D: u32 = 33;

fn byte(value: f64) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// The LUT's RGB outputs (16-bit, red fastest, as the project stores them) as
/// cube texels, red fastest, then green, then blue; and the points per side. A 1D
/// LUT becomes a 33-point cube that applies each channel's curve on its own.
/// None when `values` does not match the size.
pub fn lut_texels(shape: LutShape, size: u32, values: &[u16]) -> Option<(u32, Vec<u8>)> {
    let unit = |v: u16| v as f64 / 65535.0;
    match shape {
        LutShape::ThreeD => {
            let entries = (size as usize).pow(3);
            if values.len() != entries * 3 {
                return None;
            }
            let mut texels = Vec::with_capacity(entries * 4);
            for rgb in values.as_chunks::<3>().0 {
                texels.extend_from_slice(&[
                    byte(unit(rgb[0])),
                    byte(unit(rgb[1])),
                    byte(unit(rgb[2])),
                    255,
                ]);
            }
            Some((size, texels))
        }
        LutShape::OneD => {
            if size < 2 || values.len() != size as usize * 3 {
                return None;
            }
            // Channel `channel`'s curve at input x (0 to 1), between its points.
            let curve = |channel: usize, x: f64| {
                let at = x * (size - 1) as f64;
                let low = (at.floor() as usize).min(size as usize - 2);
                let t = at - low as f64;
                let a = unit(values[low * 3 + channel]);
                let b = unit(values[(low + 1) * 3 + channel]);
                a + (b - a) * t
            };
            let n = CUBE_FROM_1D;
            let step = |i: u32| i as f64 / (n - 1) as f64;
            let mut texels = Vec::with_capacity((n as usize).pow(3) * 4);
            for b in 0..n {
                for g in 0..n {
                    for r in 0..n {
                        texels.extend_from_slice(&[
                            byte(curve(0, step(r))),
                            byte(curve(1, step(g))),
                            byte(curve(2, step(b))),
                            255,
                        ]);
                    }
                }
            }
            Some((n, texels))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cubes_keep_their_points_as_bytes() {
        let values: Vec<u16> = (0..24).map(|i| (i * 2849) as u16).collect();
        let (n, texels) = lut_texels(LutShape::ThreeD, 2, &values).unwrap();
        assert_eq!((n, texels.len()), (2, 32));
        assert_eq!(&texels[..4], &[0, 11, 22, 255]);
        assert!(lut_texels(LutShape::ThreeD, 3, &values).is_none());
    }

    #[test]
    fn one_dimensional_luts_become_cubes_of_per_channel_curves() {
        // Red inverted, green squared at three points, blue unchanged.
        let values = [65535, 0, 0, 32768, 16384, 32768, 0, 65535, 65535];
        let (n, texels) = lut_texels(LutShape::OneD, 3, &values).unwrap();
        assert_eq!(n, CUBE_FROM_1D);
        let at = |r: u32, g: u32, b: u32| {
            let i = (((b * n + g) * n + r) * 4) as usize;
            [texels[i], texels[i + 1], texels[i + 2]]
        };
        assert_eq!(at(0, 0, 0), [255, 0, 0]);
        assert_eq!(at(32, 32, 32), [0, 255, 255]);
        assert_eq!(at(16, 16, 16), [128, 64, 128]);
    }
}

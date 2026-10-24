//! Colour conversion for the compositor. The scope is Rec.709 SDR: video values
//! (R'G'B') are treated as sRGB-encoded, as browsers display them, so an untouched
//! clip keeps its values. Compositing happens in linear light.

/// The Y'CbCr matrix a frame was encoded with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Matrix {
    Bt709,
    Bt601,
    Bt2020,
    /// Already R'G'B'.
    Rgb,
}

/// How a frame's values map to light.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transfer {
    /// SDR video (BT.709, BT.601, sRGB): decoded with the sRGB curve.
    Sdr,
    /// HDR PQ (SMPTE ST 2084), tone mapped to SDR.
    Pq,
    /// HDR HLG (ARIB STD-B67), tone mapped to SDR.
    Hlg,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameColor {
    pub matrix: Matrix,
    pub full_range: bool,
    pub transfer: Transfer,
}

impl FrameColor {
    /// Reads WebCodecs `VideoColorSpace` names. Missing values follow the usual
    /// defaults: BT.709 for HD, BT.601 for SD, limited range, SDR.
    pub fn from_names(
        matrix: Option<&str>,
        full_range: Option<bool>,
        transfer: Option<&str>,
        height: u32,
    ) -> FrameColor {
        let matrix = match matrix {
            Some("bt709") => Matrix::Bt709,
            Some("bt470bg" | "smpte170m") => Matrix::Bt601,
            Some("bt2020-ncl") => Matrix::Bt2020,
            Some("rgb") => Matrix::Rgb,
            _ if height >= 720 => Matrix::Bt709,
            _ => Matrix::Bt601,
        };
        let transfer = match transfer {
            Some("pq") => Transfer::Pq,
            Some("hlg") => Transfer::Hlg,
            _ => Transfer::Sdr,
        };
        FrameColor {
            matrix,
            full_range: full_range.unwrap_or(matrix == Matrix::Rgb),
            transfer,
        }
    }
}

/// Rows of the 3×4 matrix that takes `(Y, Cb, Cr, 1)` samples (0 to 1) to R'G'B'.
pub fn yuv_to_rgb(matrix: Matrix, full_range: bool) -> [[f32; 4]; 3] {
    let (kr, kb) = match matrix {
        Matrix::Bt709 => (0.2126, 0.0722),
        Matrix::Bt601 => (0.299, 0.114),
        Matrix::Bt2020 => (0.2627, 0.0593),
        Matrix::Rgb => {
            return [
                [0.0, 0.0, 1.0, 0.0],
                [1.0, 0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0, 0.0],
            ]
        }
    };
    let kg = 1.0 - kr - kb;
    // Y' = y_scale·Y + y_offset, C' = c_scale·C + c_offset (8-bit code ranges).
    let (y_scale, y_offset, c_scale, c_offset): (f64, f64, f64, f64) = if full_range {
        (1.0, 0.0, 1.0, -128.0 / 255.0)
    } else {
        (255.0 / 219.0, -16.0 / 219.0, 255.0 / 224.0, -128.0 / 224.0)
    };
    let cr_r = 2.0 * (1.0 - kr);
    let cb_g = -2.0 * kb * (1.0 - kb) / kg;
    let cr_g = -2.0 * kr * (1.0 - kr) / kg;
    let cb_b = 2.0 * (1.0 - kb);
    let row = |cb: f64, cr: f64| {
        [
            y_scale as f32,
            (cb * c_scale) as f32,
            (cr * c_scale) as f32,
            (y_offset + (cb + cr) * c_offset) as f32,
        ]
    };
    [row(0.0, cr_r), row(cb_g, cr_g), row(cb_b, 0.0)]
}

/// Rows of the 3×4 matrix that takes `(R', G', B', 1)` (0 to 1) to Y, Cb and Cr
/// code values (0 to 1): the inverse of `yuv_to_rgb`. Exports use BT.709 limited range.
pub fn rgb_to_yuv(matrix: Matrix, full_range: bool) -> [[f32; 4]; 3] {
    let (kr, kb) = match matrix {
        Matrix::Bt709 => (0.2126, 0.0722),
        Matrix::Bt601 => (0.299, 0.114),
        Matrix::Bt2020 => (0.2627, 0.0593),
        Matrix::Rgb => {
            return [
                [0.0, 1.0, 0.0, 0.0],
                [0.0, 0.0, 1.0, 0.0],
                [1.0, 0.0, 0.0, 0.0],
            ]
        }
    };
    let kg: f64 = 1.0 - kr - kb;
    let (y_scale, y_offset, c_scale, c_offset): (f64, f64, f64, f64) = if full_range {
        (1.0, 0.0, 1.0, 128.0 / 255.0)
    } else {
        (219.0 / 255.0, 16.0 / 255.0, 224.0 / 255.0, 128.0 / 255.0)
    };
    let cb = 0.5 / (1.0 - kb);
    let cr = 0.5 / (1.0 - kr);
    let row = |values: [f64; 3], scale: f64, offset: f64| {
        [
            (values[0] * scale) as f32,
            (values[1] * scale) as f32,
            (values[2] * scale) as f32,
            offset as f32,
        ]
    };
    [
        row([kr, kg, kb], y_scale, y_offset),
        row([-kr * cb, -kg * cb, (1.0 - kb) * cb], c_scale, c_offset),
        row([(1.0 - kr) * cr, -kg * cr, -kb * cr], c_scale, c_offset),
    ]
}

/// The sRGB decoding curve (EOTF), 0 to 1.
pub fn srgb_to_linear(value: f64) -> f64 {
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

/// The sRGB encoding curve, 0 to 1.
pub fn linear_to_srgb(value: f64) -> f64 {
    let value = value.clamp(0.0, 1.0);
    if value <= 0.003_130_8 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    }
}

/// HDR reference white (BT.2408) shown as SDR white.
pub const REFERENCE_WHITE_NITS: f64 = 203.0;

/// PQ code value (0 to 1) to absolute luminance in nits.
pub fn pq_to_nits(value: f64) -> f64 {
    let (m1, m2) = (2610.0 / 16384.0, 2523.0 / 4096.0 * 128.0);
    let (c1, c2, c3) = (
        3424.0 / 4096.0,
        2413.0 / 4096.0 * 32.0,
        2392.0 / 4096.0 * 32.0,
    );
    let p = value.clamp(0.0, 1.0).powf(1.0 / m2);
    10000.0 * ((p - c1).max(0.0) / (c2 - c3 * p)).powf(1.0 / m1)
}

/// HLG signal (0 to 1) to scene light (0 to 1), before the system gamma.
pub fn hlg_to_scene(value: f64) -> f64 {
    let (a, b, c) = (0.178_832_77, 0.284_668_92, 0.559_910_73);
    let value = value.clamp(0.0, 1.0);
    if value <= 0.5 {
        value * value / 3.0
    } else {
        (((value - c) / a).exp() + b) / 12.0
    }
}

/// A simple SDR tone map for HDR light relative to reference white: a smooth
/// shoulder that keeps values below about half of white and rolls off highlights.
pub fn tone_map(relative: f64) -> f64 {
    let x = relative.max(0.0);
    if x <= 0.5 {
        x
    } else {
        // Reinhard on the part above 0.5, scaled so the curve meets 1 at infinity.
        0.5 + 0.5 * (x - 0.5) / ((x - 0.5) + 0.5)
    }
}

/// Linear BT.2020 primaries to linear BT.709 primaries (rows).
pub const BT2020_TO_BT709: [[f64; 3]; 3] = [
    [1.660_491, -0.587_641, -0.072_850],
    [-0.124_550, 1.132_900, -0.008_349],
    [-0.018_151, -0.100_579, 1.118_730],
];

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(m: [[f32; 4]; 3], y: f64, cb: f64, cr: f64) -> [f64; 3] {
        m.map(|row| {
            row[0] as f64 * y / 255.0
                + row[1] as f64 * cb / 255.0
                + row[2] as f64 * cr / 255.0
                + row[3] as f64
        })
    }

    fn within(actual: [f64; 3], expected: [f64; 3], tolerance: f64) {
        for (a, e) in actual.iter().zip(expected) {
            assert!((a - e).abs() < tolerance, "{actual:?} != {expected:?}");
        }
    }

    fn near(actual: [f64; 3], expected: [f64; 3]) {
        within(actual, expected, 1e-5);
    }

    #[test]
    fn limited_range_black_and_white() {
        for matrix in [Matrix::Bt709, Matrix::Bt601, Matrix::Bt2020] {
            let m = yuv_to_rgb(matrix, false);
            near(apply(m, 16.0, 128.0, 128.0), [0.0; 3]);
            near(apply(m, 235.0, 128.0, 128.0), [1.0; 3]);
            let full = yuv_to_rgb(matrix, true);
            near(apply(full, 0.0, 128.0, 128.0), [0.0; 3]);
            near(apply(full, 255.0, 128.0, 128.0), [1.0; 3]);
        }
    }

    #[test]
    fn primaries_match_the_standards() {
        // Limited-range 8-bit codes for full red (rounded, so within 1%).
        let m709 = yuv_to_rgb(Matrix::Bt709, false);
        within(apply(m709, 63.0, 102.0, 240.0), [1.0, 0.0, 0.0], 0.01);
        within(apply(m709, 173.0, 42.0, 26.0), [0.0, 1.0, 0.0], 0.01);
        let m601 = yuv_to_rgb(Matrix::Bt601, false);
        within(apply(m601, 81.0, 90.0, 240.0), [1.0, 0.0, 0.0], 0.01);
        // BT.709 codes decoded with the BT.601 matrix go wrong: Chrome's CPU-frame bug.
        let wrong = apply(m601, 63.0, 102.0, 240.0);
        assert!(wrong[1].abs() > 0.05, "{wrong:?}");
    }

    fn encode(m: [[f32; 4]; 3], rgb: [f64; 3]) -> [f64; 3] {
        m.map(|row| {
            (row[0] as f64 * rgb[0]
                + row[1] as f64 * rgb[1]
                + row[2] as f64 * rgb[2]
                + row[3] as f64)
                * 255.0
        })
    }

    #[test]
    fn export_codes_match_the_standards() {
        let m = rgb_to_yuv(Matrix::Bt709, false);
        near(encode(m, [0.0; 3]), [16.0, 128.0, 128.0]);
        near(encode(m, [1.0; 3]), [235.0, 128.0, 128.0]);
        // The same full red and green as above, before rounding.
        within(encode(m, [1.0, 0.0, 0.0]), [63.0, 102.0, 240.0], 0.5);
        within(encode(m, [0.0, 1.0, 0.0]), [173.0, 42.0, 26.0], 0.5);
        near(
            encode(rgb_to_yuv(Matrix::Bt601, true), [1.0; 3]),
            [255.0, 128.0, 128.0],
        );
    }

    #[test]
    fn export_matrices_invert_the_decoding_ones() {
        for matrix in [Matrix::Bt709, Matrix::Bt601, Matrix::Bt2020, Matrix::Rgb] {
            for full_range in [false, true] {
                let (forward, back) = (
                    rgb_to_yuv(matrix, full_range),
                    yuv_to_rgb(matrix, full_range),
                );
                for rgb in [[0.25, 0.5, 0.75], [1.0, 0.0, 0.5], [0.1, 0.9, 0.3]] {
                    let [y, cb, cr] = encode(forward, rgb);
                    near(apply(back, y, cb, cr), rgb);
                }
            }
        }
    }

    #[test]
    fn rgb_frames_pass_through() {
        // Plane order for RGB is G, B, R (as in GBR planar).
        let m = yuv_to_rgb(Matrix::Rgb, true);
        near(apply(m, 51.0, 102.0, 153.0), [0.6, 0.2, 0.4]);
    }

    #[test]
    fn names_and_defaults() {
        let hd = FrameColor::from_names(None, None, None, 1080);
        assert_eq!(
            hd,
            FrameColor {
                matrix: Matrix::Bt709,
                full_range: false,
                transfer: Transfer::Sdr
            }
        );
        assert_eq!(
            FrameColor::from_names(None, None, None, 480).matrix,
            Matrix::Bt601
        );
        let jpeg =
            FrameColor::from_names(Some("smpte170m"), Some(true), Some("iec61966-2-1"), 1080);
        assert_eq!((jpeg.matrix, jpeg.full_range), (Matrix::Bt601, true));
        assert_eq!(
            FrameColor::from_names(Some("bt709"), None, Some("pq"), 2160).transfer,
            Transfer::Pq
        );
        assert_eq!(
            FrameColor::from_names(Some("bt2020-ncl"), Some(false), Some("hlg"), 2160).transfer,
            Transfer::Hlg
        );
        assert!(FrameColor::from_names(Some("rgb"), None, None, 1080).full_range);
    }

    #[test]
    fn srgb_curves_round_trip_every_8_bit_code() {
        for code in 0..=255u32 {
            let value = code as f64 / 255.0;
            let back = (linear_to_srgb(srgb_to_linear(value)) * 255.0).round() as u32;
            assert_eq!(back, code);
        }
        assert!((srgb_to_linear(0.5) - 0.214_041).abs() < 1e-5);
    }

    #[test]
    fn hdr_curves_and_tone_map() {
        assert!(pq_to_nits(0.0) < 1e-9);
        assert!((pq_to_nits(1.0) - 10000.0).abs() < 1e-6);
        // PQ 0.58 is about 203 nits (reference white).
        assert!((pq_to_nits(0.58) / REFERENCE_WHITE_NITS - 1.0).abs() < 0.03);
        assert!((hlg_to_scene(0.5) - 1.0 / 12.0).abs() < 1e-9);
        assert!((hlg_to_scene(1.0) - 1.0).abs() < 1e-6);
        assert_eq!(tone_map(0.25), 0.25);
        assert!(tone_map(1.0) < 1.0 && tone_map(1.0) > 0.7);
        assert!(tone_map(50.0) < 1.0);
        // White stays white when BT.2020 primaries become BT.709.
        for row in BT2020_TO_BT709 {
            assert!((row.iter().sum::<f64>() - 1.0).abs() < 1e-4);
        }
        let mut last = 0.0;
        for step in 0..1000 {
            let value = tone_map(step as f64 / 100.0);
            assert!(value >= last);
            last = value;
        }
    }
}

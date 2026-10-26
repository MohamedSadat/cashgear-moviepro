//! The uniforms of the mask pass, and blend mode numbers, as the compositor
//! shader reads them. Pure math, so it is tested natively.
//!
//! Masks are measured in picture pixels: a mask's box, rotation and points are
//! placed in the upright picture, and feather and expansion are fractions of its
//! shorter side. Drawn paths are flattened here into straight segments.
use cgv_model::{BlendMode, Mask, MaskMode, MaskShape};

/// Masks the shader reads, and the points of all their paths.
pub const MAX_MASKS: usize = 8;
pub const MAX_POINTS: usize = 256;
/// Floats in the `Masks` uniform struct: info, area, 8 masks of 5 vectors and
/// 128 vectors of points.
pub const MASK_FLOATS: usize = 4 + 4 + MAX_MASKS * 20 + MAX_POINTS * 2;

/// The shader's number for a blend mode (0 is normal).
pub fn blend_index(mode: BlendMode) -> u32 {
    match mode {
        BlendMode::Normal => 0,
        BlendMode::Multiply => 1,
        BlendMode::Screen => 2,
        BlendMode::Overlay => 3,
        BlendMode::SoftLight => 4,
        BlendMode::HardLight => 5,
        BlendMode::Add => 6,
        BlendMode::Darken => 7,
        BlendMode::Lighten => 8,
        BlendMode::Difference => 9,
        BlendMode::Exclusion => 10,
        BlendMode::ColorDodge => 11,
        BlendMode::ColorBurn => 12,
    }
}

/// A mask's box in picture pixels: centre, half size and rotation (cos, sin).
fn frame(mask: &Mask, picture: (f64, f64)) -> ((f64, f64), (f64, f64), (f64, f64)) {
    let centre = (mask.x * picture.0, mask.y * picture.1);
    let half = (mask.width * picture.0 / 2.0, mask.height * picture.1 / 2.0);
    let (sin, cos) = mask.rotation.to_radians().sin_cos();
    (centre, half, (cos, sin))
}

/// The closed path through a drawn mask's points, in picture pixels, with each
/// curved side cut into `steps` straight ones.
pub fn flatten(mask: &Mask, picture: (f64, f64), steps: usize) -> Vec<(f64, f64)> {
    let (centre, half, (cos, sin)) = frame(mask, picture);
    // Box units (-0.5 to 0.5) to picture pixels: scale, turn clockwise, place.
    let place = |x: f64, y: f64| {
        let (lx, ly) = (x * 2.0 * half.0, y * 2.0 * half.1);
        (
            centre.0 + cos * lx - sin * ly,
            centre.1 + sin * lx + cos * ly,
        )
    };
    let points = &mask.points;
    let mut out = Vec::new();
    for (index, a) in points.iter().enumerate() {
        let b = &points[(index + 1) % points.len()];
        out.push(place(a.x, a.y));
        let straight = a.out_x == 0.0 && a.out_y == 0.0 && b.in_x == 0.0 && b.in_y == 0.0;
        if straight {
            continue;
        }
        let p1 = (a.x + a.out_x, a.y + a.out_y);
        let p2 = (b.x + b.in_x, b.y + b.in_y);
        for step in 1..steps {
            let t = step as f64 / steps as f64;
            let u = 1.0 - t;
            let along = |p0: f64, c1: f64, c2: f64, p3: f64| {
                u * u * u * p0 + 3.0 * u * u * t * c1 + 3.0 * u * t * t * c2 + t * t * t * p3
            };
            out.push(place(
                along(a.x, p1.0, p2.0, b.x),
                along(a.y, p1.1, p2.1, b.y),
            ));
        }
    }
    out
}

/// The `Masks` uniform struct for `masks` (at most [`MAX_MASKS`] are read) on a
/// picture of `picture` pixels, drawn into a texture covering `area` (x, y,
/// width, height in picture pixels) with texels `texel` picture pixels wide.
pub fn mask_uniforms(masks: &[Mask], picture: (f64, f64), area: [f64; 4], texel: f64) -> Vec<f32> {
    let masks = &masks[..masks.len().min(MAX_MASKS)];
    let shorter = picture.0.min(picture.1);
    // Curves get as many steps as fit the points every path can share.
    let corners: usize = masks
        .iter()
        .filter(|m| m.shape == MaskShape::Path)
        .map(|m| m.points.len())
        .sum();
    let steps = [12, 8, 4, 2, 1]
        .into_iter()
        .find(|&steps| corners * steps <= MAX_POINTS)
        .unwrap_or(1);
    let mut values = vec![0.0f32; MASK_FLOATS];
    values[0] = masks.len() as f32;
    values[1] = texel.max(1e-3) as f32;
    values[4..8].copy_from_slice(&area.map(|v| v as f32));
    let mut points: Vec<(f64, f64)> = Vec::new();
    for (index, mask) in masks.iter().enumerate() {
        let (centre, half, (cos, sin)) = frame(mask, picture);
        let feather = mask.feather * shorter;
        let expansion = mask.expansion * shorter;
        let reach = feather + expansion.max(0.0) + 2.0 * texel;
        let mut first = points.len();
        let mut count = 0;
        let bounds = if mask.shape == MaskShape::Path {
            let mut path = flatten(mask, picture, steps);
            path.truncate(MAX_POINTS - points.len());
            if path.len() < 3 {
                first = 0;
            } else {
                count = path.len();
                points.extend(&path);
            }
            let fold = |pick: fn(&(f64, f64)) -> f64, min: bool| {
                path.iter()
                    .map(pick)
                    .fold(if min { f64::MAX } else { f64::MIN }, |a, b| {
                        if min {
                            a.min(b)
                        } else {
                            a.max(b)
                        }
                    })
            };
            [
                fold(|p| p.0, true) - reach,
                fold(|p| p.1, true) - reach,
                fold(|p| p.0, false) + reach,
                fold(|p| p.1, false) + reach,
            ]
        } else {
            let radius = half.0.hypot(half.1) + reach;
            [
                centre.0 - radius,
                centre.1 - radius,
                centre.0 + radius,
                centre.1 + radius,
            ]
        };
        let kind = match mask.shape {
            MaskShape::Rectangle => 0.0,
            MaskShape::Ellipse => 1.0,
            MaskShape::Path => 2.0,
        };
        let mode = match mask.mode {
            MaskMode::Add => 0.0,
            MaskMode::Subtract => 1.0,
            MaskMode::Intersect => 2.0,
        };
        // A path with too few points to fill hides nothing and shows nothing.
        let opacity = if mask.shape == MaskShape::Path && count == 0 {
            0.0
        } else {
            mask.opacity
        };
        let radius = mask.roundness.clamp(0.0, 1.0) * half.0.min(half.1);
        let entry = [
            kind,
            mode,
            if mask.invert { 1.0 } else { 0.0 },
            opacity,
            centre.0,
            centre.1,
            half.0,
            half.1,
            cos,
            sin,
            radius,
            expansion,
            feather,
            first as f64,
            count as f64,
            0.0,
            bounds[0],
            bounds[1],
            bounds[2],
            bounds[3],
        ];
        let at = 8 + index * 20;
        for (slot, value) in values[at..at + 20].iter_mut().zip(entry) {
            *slot = value as f32;
        }
    }
    let at = 8 + MAX_MASKS * 20;
    for (index, (x, y)) in points.iter().enumerate() {
        values[at + index * 2] = *x as f32;
        values[at + index * 2 + 1] = *y as f32;
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use cgv_model::{MaskId, MaskPoint};

    fn mask(shape: MaskShape) -> Mask {
        Mask {
            id: MaskId(1),
            shape,
            mode: MaskMode::Add,
            invert: false,
            x: 0.25,
            y: 0.5,
            width: 0.5,
            height: 0.5,
            rotation: 90.0,
            roundness: 0.5,
            feather: 0.1,
            expansion: 0.0,
            opacity: 1.0,
            points: Vec::new(),
        }
    }

    #[test]
    fn boxes_and_edges_are_in_picture_pixels() {
        let values = mask_uniforms(
            &[mask(MaskShape::Rectangle)],
            (1920.0, 1080.0),
            [0.0, 0.0, 1920.0, 1080.0],
            2.0,
        );
        assert_eq!(values.len(), MASK_FLOATS);
        assert_eq!(MASK_FLOATS * 4, 2720, "the WGSL struct's size");
        assert_eq!((values[0], values[1]), (1.0, 2.0));
        let m = &values[8..28];
        assert_eq!((m[4], m[5]), (480.0, 540.0), "centre");
        assert_eq!((m[6], m[7]), (480.0, 270.0), "half its size");
        assert!(m[8].abs() < 1e-6 && (m[9] - 1.0).abs() < 1e-6, "turned 90°");
        assert_eq!(m[10], 135.0, "corners: half the shorter half side");
        assert_eq!(m[12], 108.0, "feather: a tenth of the shorter side");
        assert!(m[16] < 480.0 - 550.0 && m[18] > 480.0 + 550.0);
        assert_eq!(blend_index(BlendMode::ColorBurn), 12);
    }

    #[test]
    fn paths_flatten_their_curves_within_the_point_budget() {
        let corner = |x: f64, y: f64| MaskPoint {
            x,
            y,
            ..MaskPoint::default()
        };
        let mut square = mask(MaskShape::Path);
        square.rotation = 0.0;
        square.points = vec![
            corner(-0.5, -0.5),
            corner(0.5, -0.5),
            corner(0.5, 0.5),
            corner(-0.5, 0.5),
        ];
        let flat = flatten(&square, (100.0, 100.0), 8);
        assert_eq!(
            flat,
            vec![(0.0, 25.0), (50.0, 25.0), (50.0, 75.0), (0.0, 75.0)]
        );
        let mut round = square.clone();
        round.points[0].out_x = 0.3;
        let curved = flatten(&round, (100.0, 100.0), 8);
        assert_eq!(curved.len(), 4 + 7, "one curved side in eight steps");
        // Eight curvy masks of 32 points still fit the budget, with fewer steps.
        let mut many = round.clone();
        many.points = (0..32)
            .map(|i| {
                let a = i as f64 / 32.0 * std::f64::consts::TAU;
                MaskPoint {
                    x: a.cos() / 2.0,
                    y: a.sin() / 2.0,
                    out_x: 0.05,
                    in_x: -0.05,
                    ..MaskPoint::default()
                }
            })
            .collect();
        let values = mask_uniforms(
            &vec![many; 8],
            (100.0, 100.0),
            [0.0, 0.0, 100.0, 100.0],
            1.0,
        );
        let counts: Vec<f32> = (0..8).map(|i| values[8 + i * 20 + 14]).collect();
        assert!(counts.iter().all(|&c| c >= 3.0), "{counts:?}");
        assert!(counts.iter().sum::<f32>() as usize <= MAX_POINTS);
    }
}

//! Where a layer's picture lands in the frame: fitting, transform, crop and the
//! media's own rotation. Pure math, shared by preview and export.
//!
//! Coordinates: project pixels with the origin at the top left and y down.
//! A picture's upright coordinates `(u, v)` run from 0 to 1 across the picture
//! as it is shown, after the media rotation.

/// A picture as its texture stores it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Picture {
    /// Display size before rotation, with any pixel aspect applied.
    pub width: f64,
    pub height: f64,
    /// Clockwise degrees that show the picture upright: 0, 90, 180 or 270.
    pub rotation: u32,
}

impl Picture {
    /// Width and height as shown, after the rotation.
    pub fn upright(&self) -> (f64, f64) {
        if self.rotation % 180 == 90 {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        }
    }
}

/// A clip's transform. Positions are project pixels from the frame centre; the
/// anchor, a fraction of the picture, is the pivot for scale and rotation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerTransform {
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    /// Degrees, clockwise.
    pub rotation: f64,
    pub anchor_x: f64,
    pub anchor_y: f64,
}

impl Default for LayerTransform {
    fn default() -> Self {
        LayerTransform {
            x: 0.0,
            y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation: 0.0,
            anchor_x: 0.5,
            anchor_y: 0.5,
        }
    }
}

/// Fractions of the upright picture hidden on each side. The rest stays where it was.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CropRect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// A 2D affine map: `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub tx: f64,
    pub ty: f64,
}

impl Affine {
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.tx,
            self.b * x + self.d * y + self.ty,
        )
    }

    pub fn to_f32(self) -> [f32; 6] {
        [self.a, self.b, self.c, self.d, self.tx, self.ty].map(|value| value as f32)
    }
}

/// Everything the layer shader needs to draw one picture.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerGeometry {
    /// Upright `(u, v)` to clip space (x right, y up, -1 to 1).
    pub to_clip: Affine,
    /// Upright `(u, v)` to texture coordinates of the stored picture.
    pub to_texture: Affine,
    /// The visible part of the picture: `u0, v0, u1, v1`.
    pub visible: [f64; 4],
    /// The drawn quad: the visible part grown by about one output pixel, so the
    /// shader can smooth its edges.
    pub quad: [f64; 4],
}

/// Upright `(u, v)` to the stored picture's texture coordinates.
pub fn texture_map(rotation: u32) -> Affine {
    let (a, b, c, d, tx, ty) = match rotation % 360 {
        90 => (0.0, -1.0, 1.0, 0.0, 0.0, 1.0),
        180 => (-1.0, 0.0, 0.0, -1.0, 1.0, 1.0),
        270 => (0.0, 1.0, -1.0, 0.0, 1.0, 0.0),
        _ => (1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
    };
    Affine { a, b, c, d, tx, ty }
}

/// The scale that fits the upright picture inside the project frame, keeping its
/// aspect ratio. Scale 1 in a clip's transform means this size.
pub fn fit_scale(project: (f64, f64), picture: &Picture) -> f64 {
    let (width, height) = picture.upright();
    (project.0 / width).min(project.1 / height)
}

/// Upright `(u, v)` to project pixels.
pub fn to_project(project: (f64, f64), picture: &Picture, transform: &LayerTransform) -> Affine {
    let (width, height) = picture.upright();
    let fit = fit_scale(project, picture);
    let (w, h) = (width * fit, height * fit);
    let LayerTransform {
        x,
        y,
        scale_x,
        scale_y,
        rotation,
        anchor_x,
        anchor_y,
    } = *transform;
    // The pivot sits where the anchor point is when the picture is centred and
    // offset by (x, y), so moving the anchor only moves the pivot.
    let pivot_x = project.0 / 2.0 + x + (anchor_x - 0.5) * w;
    let pivot_y = project.1 / 2.0 + y + (anchor_y - 0.5) * h;
    let (sin, cos) = rotation.to_radians().sin_cos();
    // R·S·diag(w, h), with R clockwise on screen (y down).
    let a = cos * scale_x * w;
    let b = sin * scale_x * w;
    let c = -sin * scale_y * h;
    let d = cos * scale_y * h;
    // Upright (anchor_x, anchor_y) lands on the pivot.
    Affine {
        a,
        b,
        c,
        d,
        tx: pivot_x - (a * anchor_x + c * anchor_y),
        ty: pivot_y - (b * anchor_x + d * anchor_y),
    }
}

/// Places a picture in the frame. `output_scale` is output pixels per project
/// pixel (the preview quality). None when nothing of it would show.
pub fn layer_geometry(
    project: (f64, f64),
    output_scale: f64,
    picture: &Picture,
    transform: &LayerTransform,
    crop: &CropRect,
) -> Option<LayerGeometry> {
    let finite = [
        picture.width,
        picture.height,
        transform.x,
        transform.y,
        transform.scale_x,
        transform.scale_y,
        transform.rotation,
        transform.anchor_x,
        transform.anchor_y,
    ]
    .iter()
    .all(|value| value.is_finite());
    if !finite || picture.width <= 0.0 || picture.height <= 0.0 || project.0 <= 0.0 {
        return None;
    }
    let clamp = |value: f64| value.clamp(0.0, 1.0);
    let visible = [
        clamp(crop.left),
        clamp(crop.top),
        1.0 - clamp(crop.right),
        1.0 - clamp(crop.bottom),
    ];
    if visible[2] <= visible[0] || visible[3] <= visible[1] {
        return None;
    }
    let pixels = to_project(project, picture, transform);
    // Output pixels per unit of u and v (scale and rotation keep lengths).
    let per_u = pixels.a.hypot(pixels.b) * output_scale;
    let per_v = pixels.c.hypot(pixels.d) * output_scale;
    if per_u < 1e-9 || per_v < 1e-9 {
        return None;
    }
    let (grow_u, grow_v) = (1.0 / per_u, 1.0 / per_v);
    let quad = [
        visible[0] - grow_u,
        visible[1] - grow_v,
        visible[2] + grow_u,
        visible[3] + grow_v,
    ];
    // Project pixels to clip space.
    let (sx, sy) = (2.0 / project.0, -2.0 / project.1);
    let to_clip = Affine {
        a: pixels.a * sx,
        b: pixels.b * sy,
        c: pixels.c * sx,
        d: pixels.d * sy,
        tx: pixels.tx * sx - 1.0,
        ty: pixels.ty * sy + 1.0,
    };
    Some(LayerGeometry {
        to_clip,
        to_texture: texture_map(picture.rotation),
        visible,
        quad,
    })
}

/// The output size for a project at a preview `scale` (1, 0.5, 0.25): even, at least 16.
pub fn output_size(width: u32, height: u32, scale: f64) -> (u32, u32) {
    let side = |value: u32| (((value as f64 * scale) / 2.0).round() as u32 * 2).max(16);
    (side(width), side(height))
}

/// The largest rectangle with the project's aspect ratio that fits the monitor,
/// centred: `x, y, width, height` in monitor pixels.
pub fn letterbox(monitor: (u32, u32), project: (u32, u32)) -> [f32; 4] {
    let (mw, mh) = (monitor.0 as f64, monitor.1 as f64);
    let scale = (mw / project.0 as f64).min(mh / project.1 as f64);
    let (w, h) = (
        (project.0 as f64 * scale).round().min(mw),
        (project.1 as f64 * scale).round().min(mh),
    );
    let (x, y) = (((mw - w) / 2.0).floor(), ((mh - h) / 2.0).floor());
    [x as f32, y as f32, w as f32, h as f32]
}

#[cfg(test)]
mod tests {
    use super::*;

    const HD: (f64, f64) = (1920.0, 1080.0);

    fn close(actual: (f64, f64), expected: (f64, f64)) {
        let ok = (actual.0 - expected.0).abs() < 1e-9 && (actual.1 - expected.1).abs() < 1e-9;
        assert!(ok, "{actual:?} != {expected:?}");
    }

    fn picture(width: f64, height: f64, rotation: u32) -> Picture {
        Picture {
            width,
            height,
            rotation,
        }
    }

    #[test]
    fn a_full_frame_picture_fills_the_frame() {
        let map = to_project(HD, &picture(1920.0, 1080.0, 0), &LayerTransform::default());
        close(map.apply(0.0, 0.0), (0.0, 0.0));
        close(map.apply(1.0, 1.0), (1920.0, 1080.0));
        let geometry = layer_geometry(
            HD,
            1.0,
            &picture(1920.0, 1080.0, 0),
            &Default::default(),
            &Default::default(),
        )
        .unwrap();
        close(geometry.to_clip.apply(0.0, 0.0), (-1.0, 1.0));
        close(geometry.to_clip.apply(1.0, 1.0), (1.0, -1.0));
        assert_eq!(geometry.visible, [0.0, 0.0, 1.0, 1.0]);
        // Grown by one output pixel on each side.
        assert!((geometry.quad[0] + 1.0 / 1920.0).abs() < 1e-12);
        assert!((geometry.quad[3] - (1.0 + 1.0 / 1080.0)).abs() < 1e-12);
    }

    #[test]
    fn smaller_and_other_shapes_fit_inside_the_frame() {
        // 720p scales up to fill 1080p.
        let map = to_project(HD, &picture(1280.0, 720.0, 0), &Default::default());
        close(map.apply(1.0, 1.0), (1920.0, 1080.0));
        // 4:3 is pillarboxed.
        let map = to_project(HD, &picture(640.0, 480.0, 0), &Default::default());
        close(map.apply(0.0, 0.0), (240.0, 0.0));
        close(map.apply(1.0, 1.0), (1680.0, 1080.0));
        // A portrait picture in a landscape frame.
        let map = to_project(HD, &picture(1080.0, 1920.0, 0), &Default::default());
        close(map.apply(0.0, 0.0), (960.0 - 303.75, 0.0));
        close(map.apply(1.0, 1.0), (960.0 + 303.75, 1080.0));
    }

    #[test]
    fn media_rotation_shows_the_picture_upright() {
        // A 1920×1080 frame stored sideways, shown rotated 90° clockwise: portrait.
        let rotated = picture(1920.0, 1080.0, 90);
        assert_eq!(rotated.upright(), (1080.0, 1920.0));
        let map = to_project((1080.0, 1920.0), &rotated, &Default::default());
        close(map.apply(1.0, 1.0), (1080.0, 1920.0));
        // Upright top-left comes from the stored bottom-left, and so on.
        let texture = texture_map(90);
        close(texture.apply(0.0, 0.0), (0.0, 1.0));
        close(texture.apply(1.0, 0.0), (0.0, 0.0));
        close(texture.apply(1.0, 1.0), (1.0, 0.0));
        let texture = texture_map(180);
        close(texture.apply(0.0, 0.0), (1.0, 1.0));
        let texture = texture_map(270);
        close(texture.apply(0.0, 0.0), (1.0, 0.0));
        close(texture.apply(0.0, 1.0), (0.0, 0.0));
        close(texture_map(0).apply(0.3, 0.7), (0.3, 0.7));
    }

    #[test]
    fn position_scale_and_rotation_turn_about_the_anchor() {
        let pic = picture(1920.0, 1080.0, 0);
        let moved = LayerTransform {
            x: 100.0,
            y: -50.0,
            ..Default::default()
        };
        close(
            to_project(HD, &pic, &moved).apply(0.5, 0.5),
            (1060.0, 490.0),
        );
        let half = LayerTransform {
            scale_x: 0.5,
            scale_y: 0.5,
            ..Default::default()
        };
        let map = to_project(HD, &pic, &half);
        close(map.apply(0.0, 0.0), (480.0, 270.0));
        close(map.apply(1.0, 1.0), (1440.0, 810.0));
        // 90° clockwise about the centre: the top-left corner goes to the top-right.
        let turned = LayerTransform {
            rotation: 90.0,
            ..Default::default()
        };
        let map = to_project(HD, &pic, &turned);
        close(map.apply(0.0, 0.0), (960.0 + 540.0, 540.0 - 960.0));
        close(map.apply(0.5, 0.5), (960.0, 540.0));
        // Anchored at the top-left, the picture stays put and turns about that corner.
        let corner = LayerTransform {
            rotation: 90.0,
            anchor_x: 0.0,
            anchor_y: 0.0,
            ..Default::default()
        };
        let map = to_project(HD, &pic, &corner);
        close(map.apply(0.0, 0.0), (0.0, 0.0));
        close(map.apply(1.0, 0.0), (0.0, 1920.0));
        let unturned = LayerTransform {
            anchor_x: 0.0,
            anchor_y: 0.0,
            ..Default::default()
        };
        close(
            to_project(HD, &pic, &unturned).apply(1.0, 1.0),
            (1920.0, 1080.0),
        );
        // Flipping with a negative scale mirrors about the anchor.
        let flipped = LayerTransform {
            scale_x: -1.0,
            ..Default::default()
        };
        close(
            to_project(HD, &pic, &flipped).apply(0.0, 0.0),
            (1920.0, 0.0),
        );
    }

    #[test]
    fn crop_hides_edges_without_moving_the_rest() {
        let crop = CropRect {
            left: 0.25,
            top: 0.1,
            right: 0.5,
            bottom: 0.0,
        };
        let geometry = layer_geometry(
            HD,
            0.5,
            &picture(1920.0, 1080.0, 0),
            &Default::default(),
            &crop,
        )
        .unwrap();
        assert_eq!(geometry.visible, [0.25, 0.1, 0.5, 1.0]);
        // At half resolution one output pixel is 2 project pixels.
        assert!((geometry.quad[0] - (0.25 - 2.0 / 1920.0)).abs() < 1e-12);
        close(geometry.to_clip.apply(0.25, 0.5), (-0.5, 0.0));
        let everything = CropRect {
            left: 0.6,
            right: 0.4,
            ..Default::default()
        };
        assert!(layer_geometry(
            HD,
            1.0,
            &picture(1920.0, 1080.0, 0),
            &Default::default(),
            &everything
        )
        .is_none());
    }

    #[test]
    fn degenerate_layers_draw_nothing() {
        let pic = picture(1920.0, 1080.0, 0);
        let none = Default::default();
        let zero = LayerTransform {
            scale_x: 0.0,
            ..Default::default()
        };
        assert!(layer_geometry(HD, 1.0, &pic, &zero, &none).is_none());
        let nan = LayerTransform {
            x: f64::NAN,
            ..Default::default()
        };
        assert!(layer_geometry(HD, 1.0, &pic, &nan, &none).is_none());
        assert!(
            layer_geometry(HD, 1.0, &picture(0.0, 10.0, 0), &Default::default(), &none).is_none()
        );
    }

    #[test]
    fn output_sizes_and_letterboxing() {
        assert_eq!(output_size(1920, 1080, 1.0), (1920, 1080));
        assert_eq!(output_size(1920, 1080, 0.5), (960, 540));
        assert_eq!(output_size(1920, 1080, 0.25), (480, 270));
        assert_eq!(output_size(1080, 1080, 0.25), (270, 270));
        assert_eq!(output_size(30, 30, 0.25), (16, 16));
        assert_eq!(
            letterbox((1000, 1000), (1920, 1080)),
            [0.0, 218.0, 1000.0, 563.0]
        );
        assert_eq!(
            letterbox((1920, 1080), (1920, 1080)),
            [0.0, 0.0, 1920.0, 1080.0]
        );
        assert_eq!(
            letterbox((800, 400), (1080, 1920)),
            [287.0, 0.0, 225.0, 400.0]
        );
    }
}

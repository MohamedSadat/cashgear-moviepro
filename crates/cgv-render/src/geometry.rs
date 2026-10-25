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
    /// Output pixels per unit of u and of v.
    pub per_u: f64,
    pub per_v: f64,
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
        per_u,
        per_v,
    })
}

/// The size in pixels to run a layer's effects at: its visible part as it is
/// drawn, but never more than the picture's own pixels, nor `limit`. A `moving`
/// layer's drawn size is rounded up by [`size_step`], so a frame-by-frame zoom
/// reuses a few texture sizes instead of making new ones every frame.
pub fn effect_size(
    geometry: &LayerGeometry,
    picture: &Picture,
    limit: u32,
    moving: bool,
) -> (u32, u32) {
    let [u0, v0, u1, v1] = geometry.visible;
    let (width, height) = picture.upright();
    let side = |drawn: f64, own: f64| {
        let drawn = if moving { size_step(drawn) } else { drawn };
        (drawn.min(own).ceil().max(1.0) as u32).min(limit.max(1))
    };
    (
        side(geometry.per_u * (u1 - u0), width * (u1 - u0)),
        side(geometry.per_v * (v1 - v0), height * (v1 - v0)),
    )
}

/// `side` rounded up to a sixteenth of its power of two (multiples of 64 from 1024
/// to 2048, say): at most 1/16 more pixels, and 16 sizes an octave.
pub fn size_step(side: f64) -> f64 {
    if side <= 16.0 {
        return side.ceil();
    }
    let step = 2f64.powi(side.log2().floor() as i32 - 4);
    (side / step).ceil() * step
}

/// The part of a picture a title draws, and the pixels it is drawn in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DrawnPart {
    /// Upright `u0, v0, u1, v1`.
    pub visible: [f64; 4],
    pub size: (u32, u32),
}

/// The part of a generated picture (a title's frame-sized canvas) worth drawing:
/// what is visible after the crop, on screen, and inside `content` (canvas
/// pixels `left, top, right, bottom`) when given, grown by an output pixel. It is
/// drawn at the size it shows, so text stays sharp however far it is scaled up;
/// a `moving` one's size is rounded up as [`effect_size`] does.
pub fn drawn_part(
    project: (f64, f64),
    output_scale: f64,
    transform: &LayerTransform,
    crop: &CropRect,
    content: Option<[f64; 4]>,
    moving: bool,
    limit: u32,
) -> Option<DrawnPart> {
    let picture = Picture {
        width: project.0,
        height: project.1,
        rotation: 0,
    };
    let geometry = layer_geometry(project, output_scale, &picture, transform, crop)?;
    let map = to_project(project, &picture, transform);
    let det = map.a * map.d - map.b * map.c;
    if det.abs() < 1e-12 {
        return None;
    }
    // The frame's corners in upright (u, v).
    let inverse = |x: f64, y: f64| {
        let (x, y) = (x - map.tx, y - map.ty);
        (
            (map.d * x - map.c * y) / det,
            (-map.b * x + map.a * y) / det,
        )
    };
    let corners = [
        inverse(0.0, 0.0),
        inverse(project.0, 0.0),
        inverse(0.0, project.1),
        inverse(project.0, project.1),
    ];
    let fold = |pick: fn(&(f64, f64)) -> f64, min: bool| {
        corners
            .iter()
            .map(pick)
            .fold(if min { f64::MAX } else { f64::MIN }, |a, b| {
                if min {
                    a.min(b)
                } else {
                    a.max(b)
                }
            })
    };
    let (grow_u, grow_v) = (1.0 / geometry.per_u, 1.0 / geometry.per_v);
    let mut part = [
        fold(|c| c.0, true).max(geometry.visible[0]),
        fold(|c| c.1, true).max(geometry.visible[1]),
        fold(|c| c.0, false).min(geometry.visible[2]),
        fold(|c| c.1, false).min(geometry.visible[3]),
    ];
    if let Some([left, top, right, bottom]) = content {
        part = [
            part[0].max(left / project.0 - grow_u),
            part[1].max(top / project.1 - grow_v),
            part[2].min(right / project.0 + grow_u),
            part[3].min(bottom / project.1 + grow_v),
        ];
    }
    if part[2] <= part[0] || part[3] <= part[1] {
        return None;
    }
    let side = |drawn: f64| {
        let drawn = if moving { size_step(drawn) } else { drawn };
        // Rounding noise must not add a pixel.
        ((drawn - 1e-6).ceil().max(1.0) as u32).min(limit.max(1))
    };
    Some(DrawnPart {
        visible: part,
        size: (
            side(geometry.per_u * (part[2] - part[0])),
            side(geometry.per_v * (part[3] - part[1])),
        ),
    })
}

/// Upright `(u, v)` inside the visible part to coordinates of a texture that holds
/// just that part: what a layer's effects leave.
pub fn visible_map(visible: [f64; 4]) -> Affine {
    let [u0, v0, u1, v1] = visible;
    let (a, d) = (1.0 / (u1 - u0), 1.0 / (v1 - v0));
    Affine {
        a,
        b: 0.0,
        c: 0.0,
        d,
        tx: -u0 * a,
        ty: -v0 * d,
    }
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

/// The scale that fits a project into an export frame, keeping its aspect ratio.
pub fn export_scale(frame: (u32, u32), project: (u32, u32)) -> f64 {
    (frame.0 as f64 / project.0 as f64).min(frame.1 as f64 / project.1 as f64)
}

/// Where a composition of `picture` pixels sits in an export frame: centred on
/// whole pixels (`x, y, width, height`), so each frame pixel samples one texel.
pub fn export_picture(frame: (u32, u32), picture: (u32, u32)) -> [u32; 4] {
    let (width, height) = (picture.0.min(frame.0), picture.1.min(frame.1));
    [(frame.0 - width) / 2, (frame.1 - height) / 2, width, height]
}

/// The size of the packed NV12 readback of a frame: four bytes a texel, the luma
/// rows and then the interleaved chroma rows (a frame's height must be even).
pub fn nv12_texels(frame: (u32, u32)) -> (u32, u32) {
    (frame.0.div_ceil(4), frame.1 + frame.1 / 2)
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
    fn effects_run_at_the_drawn_size_of_the_visible_part_up_to_the_picture_size() {
        let crop = CropRect {
            left: 0.25,
            ..Default::default()
        };
        let pic = picture(3840.0, 2160.0, 0);
        // A 4K picture at quarter preview of a 1080p project: drawn 480 × 270.
        let quarter = layer_geometry(HD, 0.25, &pic, &Default::default(), &crop).unwrap();
        assert_eq!(effect_size(&quarter, &pic, 8192, false), (360, 270));
        // Keyframed, its size goes up in steps.
        assert_eq!(effect_size(&quarter, &pic, 8192, true), (368, 272));
        // Scaled up 4×, it is drawn larger than it is: its own pixels are the limit.
        let big = LayerTransform {
            scale_x: 4.0,
            scale_y: 4.0,
            ..Default::default()
        };
        let zoomed = layer_geometry(HD, 1.0, &pic, &big, &crop).unwrap();
        assert_eq!(effect_size(&zoomed, &pic, 8192, false), (2880, 2160));
        assert_eq!(effect_size(&zoomed, &pic, 8192, true), (2880, 2160));
        assert_eq!(effect_size(&zoomed, &pic, 2048, false), (2048, 2048));
        // A rotated phone clip runs upright.
        let portrait = picture(1920.0, 1080.0, 90);
        let full =
            layer_geometry(HD, 1.0, &portrait, &Default::default(), &Default::default()).unwrap();
        assert_eq!(effect_size(&full, &portrait, 8192, false), (608, 1080));
        let map = visible_map(quarter.visible);
        close(map.apply(0.25, 0.0), (0.0, 0.0));
        close(map.apply(1.0, 1.0), (1.0, 1.0));
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

    #[test]
    fn export_frames_fit_the_project() {
        // Same shape: the composition fills the frame.
        let scale = export_scale((1280, 720), (1920, 1080));
        assert_eq!(output_size(1920, 1080, scale), (1280, 720));
        assert_eq!(export_picture((1280, 720), (1280, 720)), [0, 0, 1280, 720]);
        let scale = export_scale((3840, 2160), (1920, 1080));
        assert_eq!(output_size(1920, 1080, scale), (3840, 2160));
        // 16:9 into 9:16 and 1:1: black bars above and below.
        let scale = export_scale((1080, 1920), (1920, 1080));
        let picture = output_size(1920, 1080, scale);
        assert_eq!(picture, (1080, 608));
        assert_eq!(export_picture((1080, 1920), picture), [0, 656, 1080, 608]);
        let picture = output_size(1920, 1080, export_scale((1080, 1080), (1920, 1080)));
        assert_eq!(export_picture((1080, 1080), picture), [0, 236, 1080, 608]);
        // 9:16 into 16:9: bars at the sides.
        let picture = output_size(1080, 1920, export_scale((1920, 1080), (1080, 1920)));
        assert_eq!(export_picture((1920, 1080), picture), [656, 0, 608, 1080]);
        // A picture larger than the frame is cut to it.
        assert_eq!(export_picture((20, 16), (16, 30)), [2, 0, 16, 16]);
    }

    #[test]
    fn nv12_readbacks_pack_four_bytes_a_texel() {
        assert_eq!(nv12_texels((1920, 1080)), (480, 1620));
        assert_eq!(nv12_texels((1080, 1920)), (270, 2880));
        // Widths that are not a multiple of four leave padding in the last texel.
        assert_eq!(nv12_texels((1282, 720)), (321, 1080));
    }

    #[test]
    fn titles_draw_only_what_shows_at_the_size_it_shows() {
        let still = LayerTransform::default();
        let none = CropRect::default();
        // A lower third: its content only, grown by an output pixel.
        let content = Some([560.0, 840.0, 1360.0, 960.0]);
        let part = drawn_part(HD, 1.0, &still, &none, content, false, 8192).unwrap();
        assert!((part.visible[0] - (560.0 / 1920.0 - 1.0 / 1920.0)).abs() < 1e-12);
        assert_eq!(part.size, (802, 122));
        // At half preview, half the pixels.
        let half = drawn_part(HD, 0.5, &still, &none, content, false, 8192).unwrap();
        assert_eq!(half.size, (402, 62));
        // Scaled up 4×, only the part on screen is drawn, at 4× the density.
        let zoomed = LayerTransform {
            scale_x: 4.0,
            scale_y: 4.0,
            ..Default::default()
        };
        let part = drawn_part(HD, 1.0, &zoomed, &none, None, false, 8192).unwrap();
        assert!((part.visible[0] - 0.375).abs() < 1e-9 && (part.visible[2] - 0.625).abs() < 1e-9);
        assert_eq!(part.size, (1920, 1080));
        // Off screen: nothing.
        let away = LayerTransform {
            x: 4000.0,
            ..Default::default()
        };
        assert_eq!(drawn_part(HD, 1.0, &away, &none, None, false, 8192), None);
        // Turned a quarter: the screen's corners bound the part.
        let turned = LayerTransform {
            rotation: 90.0,
            ..Default::default()
        };
        let part = drawn_part(HD, 1.0, &turned, &none, None, false, 8192).unwrap();
        assert!(
            (part.visible[0] - (960.0 - 540.0) / 1920.0).abs() < 1e-9,
            "{part:?}"
        );
        assert!(part.visible[1].abs() < 1e-9 && (part.visible[3] - 1.0).abs() < 1e-9);
        // Moving layers round their size up; the GPU's limit caps it.
        let moving = drawn_part(HD, 1.0, &still, &none, content, true, 8192).unwrap();
        assert_eq!(moving.size, (832, 124));
        assert_eq!(
            drawn_part(HD, 1.0, &zoomed, &none, None, false, 1024)
                .unwrap()
                .size,
            (1024, 1024)
        );
    }
}

//! Drawing titles: each element's outlines are rasterised at the size the view
//! shows them, then composited in linear light, back to front, a band of rows at
//! a time so no buffer grows with the frame.
//!
//! Each element draws its background box, then its shadow (its fill and outline,
//! offset and blurred), then its outline, then its fill. The output is
//! premultiplied linear colour, sRGB-encoded in 8 bits, as `rgba8unorm-srgb`
//! textures store it.
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use cgv_model::title::{Content, Element, ShapeKind, Text, Title};
use cgv_model::Color;
use rustybuzz::ttf_parser::{GlyphId, OutlineBuilder};
use zeno::{Cap, Command, Fill, Join, Mask, Point, Scratch, Stroke, Style, Vector};

use crate::fonts::Fonts;
use crate::layout::{layout, Rect, TextLayout};

/// Rows drawn at a time.
pub const BAND_ROWS: u32 = 128;
/// Layouts kept between frames, for titles whose text does not change.
const LAYOUTS_KEPT: usize = 256;

/// Where the raster sits on the title's canvas.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    /// The canvas point at the raster's top left, in project pixels from the
    /// canvas's top left.
    pub left: f64,
    pub top: f64,
    /// Raster pixels per project pixel.
    pub scale_x: f64,
    pub scale_y: f64,
    pub width: u32,
    pub height: u32,
}

fn srgb_to_linear(c: f64) -> f32 {
    let c = c.clamp(0.0, 1.0);
    (if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }) as f32
}

/// A colour as premultiplied linear light, faded by `alpha`.
fn linear(color: &Color, alpha: f32) -> [f32; 4] {
    let a = color.a.clamp(0.0, 1.0) as f32 * alpha;
    [
        srgb_to_linear(color.r) * a,
        srgb_to_linear(color.g) * a,
        srgb_to_linear(color.b) * a,
        a,
    ]
}

/// 12-bit linear light to 8-bit sRGB.
fn encode_table() -> Vec<u8> {
    (0..4096)
        .map(|i| {
            let c = i as f64 / 4095.0;
            let s = if c <= 0.003_130_8 {
                c * 12.92
            } else {
                1.055 * c.powf(1.0 / 2.4) - 0.055
            };
            (s * 255.0).round().clamp(0.0, 255.0) as u8
        })
        .collect()
}

/// An element's placement: its local coordinates (pixels from its centre,
/// before scale and rotation) to raster pixels.
#[derive(Clone, Copy)]
struct Placement {
    cx: f64,
    cy: f64,
    scale: f64,
    cos: f64,
    sin: f64,
    view: View,
}

impl Placement {
    fn new(element: &Element, canvas: (f64, f64), view: View) -> Placement {
        let (sin, cos) = element.rotation.to_radians().sin_cos();
        Placement {
            cx: canvas.0 / 2.0 + element.x,
            cy: canvas.1 / 2.0 + element.y,
            scale: element.scale,
            cos,
            sin,
            view,
        }
    }

    /// Local to canvas pixels.
    fn canvas(&self, x: f64, y: f64) -> (f64, f64) {
        let (x, y) = (x * self.scale, y * self.scale);
        (
            self.cx + x * self.cos - y * self.sin,
            self.cy + x * self.sin + y * self.cos,
        )
    }

    fn raster(&self, x: f64, y: f64) -> Point {
        let (x, y) = self.canvas(x, y);
        Point::new(
            ((x - self.view.left) * self.view.scale_x) as f32,
            ((y - self.view.top) * self.view.scale_y) as f32,
        )
    }

    /// Raster pixels per local pixel.
    fn pixels(&self) -> f64 {
        self.scale * (self.view.scale_x * self.view.scale_y).sqrt()
    }
}

/// Builds raster-space paths from local points.
struct PathMaker<'p> {
    place: &'p Placement,
    out: Vec<Command>,
}

impl PathMaker<'_> {
    fn move_to(&mut self, x: f64, y: f64) {
        self.out.push(Command::MoveTo(self.place.raster(x, y)));
    }
    fn line_to(&mut self, x: f64, y: f64) {
        self.out.push(Command::LineTo(self.place.raster(x, y)));
    }
    fn curve_to(&mut self, a: (f64, f64), b: (f64, f64), to: (f64, f64)) {
        self.out.push(Command::CurveTo(
            self.place.raster(a.0, a.1),
            self.place.raster(b.0, b.1),
            self.place.raster(to.0, to.1),
        ));
    }
    fn close(&mut self) {
        self.out.push(Command::Close);
    }

    fn polygon(&mut self, points: &[(f64, f64)]) {
        for (i, &(x, y)) in points.iter().enumerate() {
            if i == 0 {
                self.move_to(x, y);
            } else {
                self.line_to(x, y);
            }
        }
        self.close();
    }

    /// A rectangle from (x, y), with corners rounded by `r`.
    fn rounded_rect(&mut self, x: f64, y: f64, w: f64, h: f64, r: f64) {
        let r = r.clamp(0.0, w.min(h) / 2.0);
        if r <= 0.0 {
            self.polygon(&[(x, y), (x + w, y), (x + w, y + h), (x, y + h)]);
            return;
        }
        let k = r * (1.0 - 0.552_284_75);
        let (right, bottom) = (x + w, y + h);
        self.move_to(x + r, y);
        self.line_to(right - r, y);
        self.curve_to((right - k, y), (right, y + k), (right, y + r));
        self.line_to(right, bottom - r);
        self.curve_to(
            (right, bottom - k),
            (right - k, bottom),
            (right - r, bottom),
        );
        self.line_to(x + r, bottom);
        self.curve_to((x + k, bottom), (x, bottom - k), (x, bottom - r));
        self.line_to(x, y + r);
        self.curve_to((x, y + k), (x + k, y), (x + r, y));
        self.close();
    }

    fn ellipse(&mut self, rx: f64, ry: f64) {
        let (kx, ky) = (rx * 0.552_284_75, ry * 0.552_284_75);
        self.move_to(rx, 0.0);
        self.curve_to((rx, ky), (kx, ry), (0.0, ry));
        self.curve_to((-kx, ry), (-rx, ky), (-rx, 0.0));
        self.curve_to((-rx, -ky), (-kx, -ry), (0.0, -ry));
        self.curve_to((kx, -ry), (rx, -ky), (rx, 0.0));
        self.close();
    }
}

/// Glyph outlines into a path: font units at a pen position, y up.
struct GlyphSink<'m, 'p> {
    maker: &'m mut PathMaker<'p>,
    x: f64,
    y: f64,
    scale: f64,
    skew: f64,
}

impl GlyphSink<'_, '_> {
    fn local(&self, x: f32, y: f32) -> (f64, f64) {
        let (x, y) = (x as f64, y as f64);
        (
            self.x + (x + self.skew * y) * self.scale,
            self.y - y * self.scale,
        )
    }
}

impl OutlineBuilder for GlyphSink<'_, '_> {
    fn move_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.local(x, y);
        self.maker.move_to(x, y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.local(x, y);
        self.maker.line_to(x, y);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let a = self.maker.place.raster_point(self.local(x1, y1));
        let to = self.maker.place.raster_point(self.local(x, y));
        self.maker.out.push(Command::QuadTo(a, to));
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (a, b, to) = (self.local(x1, y1), self.local(x2, y2), self.local(x, y));
        self.maker.curve_to(a, b, to);
    }
    fn close(&mut self) {
        self.maker.close();
    }
}

impl Placement {
    fn raster_point(&self, (x, y): (f64, f64)) -> Point {
        self.raster(x, y)
    }
}

/// One thing to paint: a path, how to fill it and its colour.
struct Layer {
    path: Vec<Command>,
    color: [f32; 4],
}

/// An element ready to paint, in raster pixels.
struct Prepared {
    background: Vec<Layer>,
    /// The paths of the fill, each with how much it shows (a reveal fades units in).
    fills: Vec<(Vec<Command>, f32)>,
    fill: [f32; 4],
    stroke: Option<(f32, [f32; 4])>,
    /// Offset, Gaussian sigma (raster pixels) and colour.
    shadow: Option<(f32, f32, f32, [f32; 4])>,
    /// Raster bounds, shadow included.
    bounds: Rect,
}

/// Draws titles. It keeps the fonts, recent layouts and the rasteriser's scratch
/// space between frames.
pub struct Painter {
    pub fonts: Fonts,
    layouts: HashMap<u64, (u64, Rc<TextLayout>)>,
    scratch: Scratch,
    encode: Vec<u8>,
}

impl Default for Painter {
    fn default() -> Self {
        Painter::new(Fonts::new())
    }
}

fn layout_key(text: &Text) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.text.hash(&mut hasher);
    text.font.hash(&mut hasher);
    for value in [
        text.size,
        text.line_spacing,
        text.letter_spacing,
        text.wrap.unwrap_or(-1.0),
    ] {
        value.to_bits().hash(&mut hasher);
    }
    text.align.hash(&mut hasher);
    text.direction.hash(&mut hasher);
    hasher.finish()
}

/// How much of unit `index` shows when `reveal` of `count` units show.
fn revealed(reveal: f64, count: u32, index: u32) -> f32 {
    if reveal >= 1.0 {
        return 1.0;
    }
    (reveal * count as f64 - index as f64).clamp(0.0, 1.0) as f32
}

impl Painter {
    pub fn new(fonts: Fonts) -> Painter {
        Painter {
            fonts,
            layouts: HashMap::new(),
            scratch: Scratch::new(),
            encode: encode_table(),
        }
    }

    /// The layout of `text`, from the cache when its words and style are unchanged.
    pub fn layout(&mut self, text: &Text) -> Rc<TextLayout> {
        let key = layout_key(text);
        let generation = self.fonts.generation();
        if let Some((made, layout)) = self.layouts.get(&key) {
            if *made == generation {
                return layout.clone();
            }
        }
        if self.layouts.len() >= LAYOUTS_KEPT {
            self.layouts.clear();
        }
        let made = Rc::new(layout(&mut self.fonts, text));
        self.layouts.insert(key, (generation, made.clone()));
        made
    }

    /// Families `title` needs that are not loaded.
    pub fn missing(&mut self, title: &Title) -> Vec<String> {
        let mut missing: Vec<String> = Vec::new();
        for element in &title.elements {
            if let Content::Text(text) = &element.content {
                for family in &self.layout(text).missing {
                    if !missing.contains(family) {
                        missing.push(family.clone());
                    }
                }
            }
        }
        missing
    }

    /// The element's extent in its local pixels: its box, background and ink.
    fn local_bounds(&mut self, element: &Element) -> Option<Rect> {
        let rect = match &element.content {
            Content::Text(text) => {
                let layout = self.layout(text);
                let (w, h) = (layout.width, layout.height);
                let mut rect = layout.ink.map(|ink| Rect {
                    left: ink.left - w / 2.0,
                    top: ink.top - h / 2.0,
                    right: ink.right - w / 2.0,
                    bottom: ink.bottom - h / 2.0,
                });
                if let Some(background) = &text.background {
                    let pad = background.padding as f32;
                    let boxed = Rect {
                        left: -w / 2.0 - pad,
                        top: -h / 2.0 - pad,
                        right: w / 2.0 + pad,
                        bottom: h / 2.0 + pad,
                    };
                    rect = Some(rect.map_or(boxed, |r| r.union(boxed)));
                }
                rect?
            }
            Content::Shape(shape) => {
                let (w, h) = (shape.width as f32, shape.height as f32);
                Rect {
                    left: -w / 2.0,
                    top: -h / 2.0,
                    right: w / 2.0,
                    bottom: h / 2.0,
                }
            }
        };
        let stroke = element.stroke.map_or(0.0, |s| s.width as f32 / 2.0);
        Some(rect.grow(stroke + 1.0))
    }

    /// The title's extent on its canvas (project pixels from the canvas's top
    /// left), shadows included; None when it draws nothing.
    pub fn bounds(&mut self, title: &Title, canvas: (f64, f64)) -> Option<Rect> {
        let view = View {
            left: 0.0,
            top: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            width: 1,
            height: 1,
        };
        let mut total: Option<Rect> = None;
        for element in &title.elements {
            if element.opacity <= 0.0 {
                continue;
            }
            let Some(local) = self.local_bounds(element) else {
                continue;
            };
            let place = Placement::new(element, canvas, view);
            let mut rect: Option<Rect> = None;
            for (x, y) in [
                (local.left, local.top),
                (local.right, local.top),
                (local.left, local.bottom),
                (local.right, local.bottom),
            ] {
                let (x, y) = place.canvas(x as f64, y as f64);
                let point = Rect {
                    left: x as f32,
                    top: y as f32,
                    right: x as f32,
                    bottom: y as f32,
                };
                rect = Some(rect.map_or(point, |r| r.union(point)));
            }
            let mut rect = rect?;
            if let Some(shadow) = &element.shadow {
                let scale = element.scale as f32;
                let spread = 1.5 * shadow.blur as f32 * scale;
                let moved = Rect {
                    left: rect.left + shadow.x as f32 * scale,
                    top: rect.top + shadow.y as f32 * scale,
                    right: rect.right + shadow.x as f32 * scale,
                    bottom: rect.bottom + shadow.y as f32 * scale,
                }
                .grow(spread);
                rect = rect.union(moved);
            }
            total = Some(total.map_or(rect, |t| t.union(rect)));
        }
        total
    }

    fn prepare(&mut self, element: &Element, canvas: (f64, f64), view: View) -> Option<Prepared> {
        let opacity = element.opacity.clamp(0.0, 1.0) as f32;
        if opacity <= 0.0 {
            return None;
        }
        let place = Placement::new(element, canvas, view);
        let pixels = place.pixels() as f32;
        let mut background = Vec::new();
        let mut fills = Vec::new();
        match &element.content {
            Content::Text(text) => {
                let layout = self.layout(text);
                let (w, h) = (layout.width as f64, layout.height as f64);
                if let Some(back) = &text.background {
                    let pad = back.padding;
                    let mut maker = PathMaker {
                        place: &place,
                        out: Vec::new(),
                    };
                    if back.per_line {
                        for line in &layout.lines {
                            if line.width > 0.0 {
                                maker.rounded_rect(
                                    line.left as f64 - w / 2.0 - pad,
                                    line.top as f64 - h / 2.0 - pad,
                                    line.width as f64 + 2.0 * pad,
                                    line.height as f64 + 2.0 * pad,
                                    back.radius,
                                );
                            }
                        }
                    } else {
                        maker.rounded_rect(
                            -w / 2.0 - pad,
                            -h / 2.0 - pad,
                            w + 2.0 * pad,
                            h + 2.0 * pad,
                            back.radius,
                        );
                    }
                    if !maker.out.is_empty() {
                        background.push(Layer {
                            path: maker.out,
                            color: linear(&back.color, opacity),
                        });
                    }
                }
                // Glyphs grouped by how much of them a reveal shows.
                let count = match text.reveal_by {
                    cgv_model::title::RevealUnit::Letter => layout.letters,
                    cgv_model::title::RevealUnit::Word => layout.words,
                    cgv_model::title::RevealUnit::Line => layout.lines.len() as u32,
                };
                let mut groups: Vec<(u8, PathMaker)> = Vec::new();
                for glyph in &layout.glyphs {
                    let unit = match text.reveal_by {
                        cgv_model::title::RevealUnit::Letter => glyph.letter,
                        cgv_model::title::RevealUnit::Word => glyph.word,
                        cgv_model::title::RevealUnit::Line => glyph.line,
                    };
                    let shown = (revealed(text.reveal, count, unit) * 255.0).round() as u8;
                    if shown == 0 {
                        continue;
                    }
                    let index = match groups.iter().position(|(alpha, _)| *alpha == shown) {
                        Some(index) => index,
                        None => {
                            groups.push((
                                shown,
                                PathMaker {
                                    place: &place,
                                    out: Vec::new(),
                                },
                            ));
                            groups.len() - 1
                        }
                    };
                    let face = self.fonts.face(glyph.face);
                    let mut sink = GlyphSink {
                        maker: &mut groups[index].1,
                        x: glyph.x as f64 - w / 2.0,
                        y: glyph.y as f64 - h / 2.0,
                        scale: glyph.scale as f64,
                        skew: glyph.skew as f64,
                    };
                    face.outline_glyph(GlyphId(glyph.id), &mut sink);
                }
                for (alpha, maker) in groups {
                    if !maker.out.is_empty() {
                        fills.push((maker.out, alpha as f32 / 255.0));
                    }
                }
            }
            Content::Shape(shape) => {
                let mut maker = PathMaker {
                    place: &place,
                    out: Vec::new(),
                };
                let (w, h) = (shape.width, shape.height);
                match shape.kind {
                    ShapeKind::Rectangle => {
                        maker.rounded_rect(-w / 2.0, -h / 2.0, w, h, shape.radius)
                    }
                    ShapeKind::Ellipse => maker.ellipse(w / 2.0, h / 2.0),
                    ShapeKind::Line => maker.rounded_rect(-w / 2.0, -h / 2.0, w, h, h / 2.0),
                    ShapeKind::Arrow => {
                        // It fills its box: the head is as tall as the box, the shaft a third.
                        let t = h / 3.0;
                        let head = h.min(w / 2.0);
                        let half = h / 2.0;
                        let neck = w / 2.0 - head;
                        maker.polygon(&[
                            (-w / 2.0, -t / 2.0),
                            (neck, -t / 2.0),
                            (neck, -half),
                            (w / 2.0, 0.0),
                            (neck, half),
                            (neck, t / 2.0),
                            (-w / 2.0, t / 2.0),
                        ]);
                    }
                    ShapeKind::Polygon | ShapeKind::Star => {
                        let star = shape.kind == ShapeKind::Star;
                        let corners = shape.sides.clamp(3, 64) as usize * if star { 2 } else { 1 };
                        let points: Vec<(f64, f64)> = (0..corners)
                            .map(|i| {
                                let angle = -std::f64::consts::FRAC_PI_2
                                    + i as f64 * std::f64::consts::TAU / corners as f64;
                                let r = if star && i % 2 == 1 { shape.inner } else { 1.0 };
                                (angle.cos() * w / 2.0 * r, angle.sin() * h / 2.0 * r)
                            })
                            .collect();
                        maker.polygon(&points);
                    }
                }
                if !maker.out.is_empty() {
                    fills.push((maker.out, 1.0));
                }
            }
        }
        if fills.is_empty() && background.is_empty() {
            return None;
        }
        let stroke = element
            .stroke
            .filter(|stroke| stroke.width > 0.0 && stroke.color.a > 0.0)
            .map(|stroke| (stroke.width as f32 * pixels, linear(&stroke.color, opacity)));
        let shadow = element
            .shadow
            .filter(|shadow| shadow.color.a > 0.0)
            .map(|shadow| {
                let scale = element.scale as f32;
                (
                    shadow.x as f32 * scale * view.scale_x as f32,
                    shadow.y as f32 * scale * view.scale_y as f32,
                    (shadow.blur as f32 / 2.0)
                        * scale
                        * (view.scale_x * view.scale_y).sqrt() as f32,
                    linear(&shadow.color, opacity),
                )
            });
        // Raster bounds from the paths themselves.
        let mut bounds: Option<Rect> = None;
        let mut include = |path: &[Command]| {
            let b = zeno::bounds(path, Fill::NonZero, None);
            if b.is_empty() {
                return;
            }
            let r = Rect {
                left: b.min.x,
                top: b.min.y,
                right: b.max.x,
                bottom: b.max.y,
            };
            bounds = Some(bounds.map_or(r, |old| old.union(r)));
        };
        for layer in &background {
            include(&layer.path);
        }
        for (path, _) in &fills {
            include(path);
        }
        let mut bounds = bounds?.grow(stroke.map_or(0.0, |(w, _)| w / 2.0) + 2.0);
        if let Some((dx, dy, sigma, _)) = shadow {
            let spread = 3.0 * sigma + 2.0;
            let moved = Rect {
                left: bounds.left + dx,
                top: bounds.top + dy,
                right: bounds.right + dx,
                bottom: bounds.bottom + dy,
            }
            .grow(spread);
            bounds = bounds.union(moved);
        }
        Some(Prepared {
            background,
            fills,
            fill: linear(&element.fill, opacity),
            stroke,
            shadow,
            bounds,
        })
    }

    /// Draws `title` (on a canvas of `canvas` project pixels) as `view` shows it,
    /// handing each band of rows to `emit`: its first row, its row count and its
    /// RGBA bytes.
    pub fn draw(
        &mut self,
        title: &Title,
        canvas: (f64, f64),
        view: View,
        mut emit: impl FnMut(u32, u32, &[u8]),
    ) {
        let prepared: Vec<Prepared> = title
            .elements
            .iter()
            .filter_map(|element| self.prepare(element, canvas, view))
            .collect();
        let width = view.width as usize;
        let mut acc = vec![[0f32; 4]; width * BAND_ROWS as usize];
        let mut bytes = vec![0u8; width * BAND_ROWS as usize * 4];
        let mut top = 0u32;
        while top < view.height {
            let rows = BAND_ROWS.min(view.height - top);
            let band = Rect {
                left: 0.0,
                top: top as f32,
                right: view.width as f32,
                bottom: (top + rows) as f32,
            };
            let acc = &mut acc[..width * rows as usize];
            acc.fill([0.0; 4]);
            for element in &prepared {
                if !overlaps(&element.bounds, &band) {
                    continue;
                }
                self.paint(element, band, acc, width);
            }
            let out = &mut bytes[..width * rows as usize * 4];
            for (pixel, rgba) in acc.iter().zip(out.as_chunks_mut::<4>().0) {
                for c in 0..3 {
                    let index = (pixel[c].clamp(0.0, 1.0) * 4095.0 + 0.5) as usize;
                    rgba[c] = self.encode[index];
                }
                rgba[3] = (pixel[3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
            emit(top, rows, out);
            top += rows;
        }
    }

    fn paint(&mut self, element: &Prepared, band: Rect, acc: &mut [[f32; 4]], width: usize) {
        // The part of the band the element covers, in whole pixels.
        let window = Window::new(&element.bounds, &band, width);
        if window.w == 0 || window.h == 0 {
            return;
        }
        let fill = Style::Fill(Fill::NonZero);
        for layer in &element.background {
            self.layer(&layer.path, fill, layer.color, window, acc, width);
        }
        if let Some((dx, dy, sigma, color)) = element.shadow {
            self.shadow(element, dx, dy, sigma, color, window, acc, width);
        }
        if let Some((stroke_width, color)) = element.stroke {
            for (path, alpha) in &element.fills {
                let style = stroke_style(stroke_width);
                self.layer(path, style, scaled(color, *alpha), window, acc, width);
            }
        }
        for (path, alpha) in &element.fills {
            self.layer(path, fill, scaled(element.fill, *alpha), window, acc, width);
        }
    }

    /// Coverage of `path`, moved by `shift`, in a `w` by `h` mask.
    fn coverage(
        &mut self,
        path: &[Command],
        style: Style,
        shift: Vector,
        w: u32,
        h: u32,
    ) -> Vec<u8> {
        let mut mask = vec![0u8; (w * h) as usize];
        Mask::with_scratch(path, &mut self.scratch)
            .style(style)
            .size(w, h)
            .offset(shift)
            .render_into(&mut mask, None);
        mask
    }

    fn layer(
        &mut self,
        path: &[Command],
        style: Style,
        color: [f32; 4],
        window: Window,
        acc: &mut [[f32; 4]],
        width: usize,
    ) {
        if color[3] <= 0.0 {
            return;
        }
        let shift = Vector::new(-(window.x as f32), -(window.y as f32));
        let mask = self.coverage(path, style, shift, window.w, window.h);
        for row in 0..window.h as usize {
            let start = (window.y as usize - window.band_top + row) * width + window.x as usize;
            let line = &mut acc[start..start + window.w as usize];
            let cover = &mask[row * window.w as usize..(row + 1) * window.w as usize];
            for (pixel, &c) in line.iter_mut().zip(cover) {
                if c != 0 {
                    over(pixel, color, c as f32 / 255.0);
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn shadow(
        &mut self,
        element: &Prepared,
        dx: f32,
        dy: f32,
        sigma: f32,
        color: [f32; 4],
        window: Window,
        acc: &mut [[f32; 4]],
        width: usize,
    ) {
        // The window grown by the blur's reach; the fill and outline are drawn moved
        // by the offset, so the rasteriser places fractional offsets exactly.
        let margin = (3.0 * sigma).ceil() as u32 + 1;
        let (x0, y0) = (window.x - margin as i32, window.y - margin as i32);
        let (w, h) = (window.w + 2 * margin, window.h + 2 * margin);
        let shift = Vector::new(dx - x0 as f32, dy - y0 as f32);
        let mut alpha = vec![0f32; (w * h) as usize];
        for (path, shown) in &element.fills {
            let mut cover = self.coverage(path, Style::Fill(Fill::NonZero), shift, w, h);
            if let Some((stroke_width, _)) = element.stroke {
                let outline = self.coverage(path, stroke_style(stroke_width), shift, w, h);
                for (c, o) in cover.iter_mut().zip(outline) {
                    *c = (*c).max(o);
                }
            }
            for (a, c) in alpha.iter_mut().zip(cover) {
                *a = (*a + c as f32 / 255.0 * shown).min(1.0);
            }
        }
        blur(&mut alpha, w as usize, h as usize, sigma);
        for row in 0..window.h as usize {
            let start = (window.y as usize - window.band_top + row) * width + window.x as usize;
            let line = &mut acc[start..start + window.w as usize];
            let from = (row + margin as usize) * w as usize + margin as usize;
            for (pixel, &a) in line.iter_mut().zip(&alpha[from..from + window.w as usize]) {
                if a > 0.0 {
                    over(pixel, color, a);
                }
            }
        }
    }
}

/// Whole pixels of a band an element covers.
#[derive(Clone, Copy, Debug)]
struct Window {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    band_top: usize,
}

impl Window {
    fn new(bounds: &Rect, band: &Rect, width: usize) -> Window {
        let left = bounds.left.floor().max(0.0) as i32;
        let right = (bounds.right.ceil() as i32).min(width as i32);
        let top = bounds.top.floor().max(band.top) as i32;
        let bottom = (bounds.bottom.ceil()).min(band.bottom) as i32;
        Window {
            x: left,
            y: top,
            w: (right - left).max(0) as u32,
            h: (bottom - top).max(0) as u32,
            band_top: band.top as usize,
        }
    }
}

fn stroke_style(width: f32) -> Style<'static> {
    let mut stroke = Stroke::new(width);
    stroke.join(Join::Round).cap(Cap::Round);
    Style::Stroke(stroke)
}

fn scaled(color: [f32; 4], by: f32) -> [f32; 4] {
    color.map(|c| c * by)
}

fn overlaps(a: &Rect, b: &Rect) -> bool {
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/// Source-over in premultiplied linear light, `color` at `coverage`.
fn over(pixel: &mut [f32; 4], color: [f32; 4], coverage: f32) {
    let keep = 1.0 - color[3] * coverage;
    for c in 0..4 {
        pixel[c] = color[c] * coverage + pixel[c] * keep;
    }
}

/// The widths of three box blurs that together approach a Gaussian of `sigma`.
fn boxes(sigma: f32) -> [usize; 3] {
    let ideal = (12.0 * sigma * sigma / 3.0 + 1.0).sqrt();
    let mut lower = ideal.floor() as usize;
    if lower.is_multiple_of(2) {
        lower = lower.saturating_sub(1);
    }
    let lower = lower.max(1);
    let upper = lower + 2;
    let m = ((12.0 * sigma * sigma - 3.0 * (lower * lower) as f32 - 12.0 * lower as f32 - 9.0)
        / (-4.0 * lower as f32 - 4.0))
        .round()
        .clamp(0.0, 3.0) as usize;
    [0, 1, 2].map(|i| if i < m { lower } else { upper })
}

/// Blurs `data` (w by h) in place, transparent beyond its edges.
fn blur(data: &mut [f32], w: usize, h: usize, sigma: f32) {
    if sigma < 0.25 {
        return;
    }
    let mut scratch = vec![0f32; w.max(h)];
    for size in boxes(sigma) {
        let radius = size / 2;
        for row in 0..h {
            box_line(&mut data[row * w..row * w + w], 1, w, radius, &mut scratch);
        }
        for col in 0..w {
            box_column(data, col, w, h, radius, &mut scratch);
        }
    }
}

fn box_line(line: &mut [f32], _stride: usize, len: usize, radius: usize, scratch: &mut [f32]) {
    let scale = 1.0 / (2 * radius + 1) as f32;
    let mut sum = 0.0;
    for &value in line.iter().take(radius.min(len)) {
        sum += value;
    }
    for i in 0..len {
        if i + radius < len {
            sum += line[i + radius];
        }
        scratch[i] = sum * scale;
        if i >= radius {
            sum -= line[i - radius];
        }
    }
    line.copy_from_slice(&scratch[..len]);
}

fn box_column(
    data: &mut [f32],
    col: usize,
    w: usize,
    h: usize,
    radius: usize,
    scratch: &mut [f32],
) {
    let scale = 1.0 / (2 * radius + 1) as f32;
    let mut sum = 0.0;
    for row in 0..radius.min(h) {
        sum += data[row * w + col];
    }
    for i in 0..h {
        if i + radius < h {
            sum += data[(i + radius) * w + col];
        }
        scratch[i] = sum * scale;
        if i >= radius {
            sum -= data[(i - radius) * w + col];
        }
    }
    for i in 0..h {
        data[i * w + col] = scratch[i];
    }
}

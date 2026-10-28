//! Titles: the text blocks and shapes a title clip draws, back to front.
//!
//! A title clip's picture is a transparent canvas the size of the project frame,
//! so its own transform works as a video's does. Each element sits on that canvas
//! with a position, scale, rotation and opacity of its own, which keyframes named
//! `title.<element id>.<setting>` animate. The engine lays text out and draws it.
use serde::{Deserialize, Serialize};

use cgv_time::Flicks;

use crate::animation::{value_at, KeyValue, Keyframes};
use crate::effects::Color;
use crate::project::ElementId;

/// Longest text an element holds, in bytes.
pub const MAX_TEXT: usize = 10_000;
/// Most elements a title holds.
pub const MAX_ELEMENTS: usize = 64;
/// Largest font size and shape side, in project pixels.
pub const MAX_SIZE: f64 = 10_000.0;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Title {
    /// Back to front.
    pub elements: Vec<Element>,
}

/// A text block or shape on the title's canvas.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: ElementId,
    /// Centre of the element in project pixels from the frame centre, y down.
    pub x: f64,
    pub y: f64,
    /// 1 draws it at its own size.
    #[serde(default = "one")]
    pub scale: f64,
    /// Degrees, clockwise, about its centre.
    #[serde(default)]
    pub rotation: f64,
    #[serde(default = "one")]
    pub opacity: f64,
    /// The text's colour or the shape's; transparent for none.
    pub fill: Color,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<Stroke>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<Shadow>,
    #[serde(flatten)]
    pub content: Content,
}

fn one() -> f64 {
    1.0
}

/// An outline around the text's letters or the shape, drawn beneath the fill, so
/// half its width shows outside.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stroke {
    pub color: Color,
    /// Project pixels.
    pub width: f64,
}

/// A blurred copy of the element's fill and stroke beneath it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Shadow {
    pub color: Color,
    /// Offset in project pixels, scaled with the element but not turned with it.
    pub x: f64,
    pub y: f64,
    /// Blur radius in project pixels.
    pub blur: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Content {
    Text(Text),
    Shape(Shape),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Font {
    pub family: String,
    /// 100 (thin) to 900 (black); 400 is regular.
    #[serde(default = "regular")]
    pub weight: u16,
    #[serde(default)]
    pub italic: bool,
}

fn regular() -> u16 {
    400
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    Left,
    #[default]
    Center,
    Right,
}

/// The order letters run in. Auto takes each paragraph's from its first letter
/// with a direction, so Arabic runs right to left.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    #[default]
    Auto,
    Ltr,
    Rtl,
}

/// What a partial `reveal` counts in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RevealUnit {
    /// Shaped letters (with their marks): typewriter.
    #[default]
    Letter,
    Word,
    Line,
}

/// A box behind the text.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Background {
    pub color: Color,
    /// Space around the text, in project pixels.
    pub padding: f64,
    /// Corner radius, in project pixels.
    #[serde(default)]
    pub radius: f64,
    /// One box per line, as captions have, instead of one around the block.
    #[serde(default)]
    pub per_line: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Text {
    pub text: String,
    pub font: Font,
    /// Font size in project pixels.
    pub size: f64,
    #[serde(default)]
    pub align: Align,
    #[serde(default)]
    pub direction: Direction,
    /// A multiple of the font's own line height.
    #[serde(default = "one")]
    pub line_spacing: f64,
    /// Extra space after each letter, in project pixels.
    #[serde(default)]
    pub letter_spacing: f64,
    /// Lines wrap at this width in project pixels; without it, each paragraph is one line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<Background>,
    /// How much of the text shows, 0 to 1, counted in `reveal_by` units in reading order.
    #[serde(default = "one")]
    pub reveal: f64,
    #[serde(default)]
    pub reveal_by: RevealUnit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShapeKind {
    Rectangle,
    Ellipse,
    /// A bar `width` long and `height` thick, with round ends.
    Line,
    /// An arrow pointing right that fills its box: its head is as tall as the box,
    /// its shaft a third as thick.
    Arrow,
    /// A regular polygon of `sides` sides in the `width` by `height` box, pointing up.
    Polygon,
    /// A star of `sides` points; `inner` is the inner radius as a fraction of the outer.
    Star,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Shape {
    pub kind: ShapeKind,
    /// Project pixels.
    pub width: f64,
    pub height: f64,
    /// Rounded corners of rectangles, in project pixels.
    #[serde(default)]
    pub radius: f64,
    #[serde(default = "five")]
    pub sides: u32,
    #[serde(default = "half")]
    pub inner: f64,
}

fn five() -> u32 {
    5
}

fn half() -> f64 {
    0.5
}

/// The element settings keyframes can animate.
pub const ELEMENT_SETTINGS: [&str; 7] =
    ["x", "y", "scale", "rotation", "opacity", "reveal", "fill"];

/// The keyframe property name of setting `name` of element `id`.
/// Most words a caption keeps times for.
pub const MAX_CAPTION_WORDS: usize = 2_000;

/// What makes a title clip a caption: the speech its text shows, for subtitle
/// files and for showing words as they are said. Its text is the title's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Caption {
    /// The speech's language code, such as `en` or `ar`.
    pub language: String,
    /// When each word of the text is said, from the clip's start, in order.
    /// Splits and trims keep them where they were said.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<Flicks>,
}

impl Caption {
    pub fn check(&self) -> Result<(), String> {
        let code = &self.language;
        let language_ok = (2..=12).contains(&code.len())
            && code.chars().all(|c| c.is_ascii_lowercase() || c == '-');
        if !language_ok {
            return Err(format!("{code:?} is not a language code"));
        }
        if self.words.len() > MAX_CAPTION_WORDS
            || !self.words.windows(2).all(|pair| pair[0] <= pair[1])
        {
            return Err("A caption's word times are out of order".into());
        }
        Ok(())
    }
}

pub fn element_property(id: ElementId, name: &str) -> String {
    format!("title.{id}.{name}")
}

/// Whether `value` suits element setting `name` (a number; `fill` takes colours).
pub(crate) fn element_value_ok(name: &str, value: f64) -> bool {
    match name {
        "x" | "y" => value.is_finite() && value.abs() <= 1e6,
        "scale" => value > 0.0 && value <= 100.0,
        "rotation" => value.is_finite() && value.abs() <= 36_000.0,
        "opacity" | "reveal" => (0.0..=1.0).contains(&value),
        _ => false,
    }
}

fn check_color(color: &Color, what: &str) -> Result<(), String> {
    color
        .check()
        .map_err(|_| format!("The {what} colour is out of range"))
}

fn check_length(value: f64, what: &str, min: f64) -> Result<(), String> {
    if value.is_finite() && (min..=MAX_SIZE).contains(&value) {
        Ok(())
    } else {
        Err(format!(
            "The {what} must be from {min} to {MAX_SIZE} pixels"
        ))
    }
}

impl Element {
    pub fn text(&self) -> Option<&Text> {
        match &self.content {
            Content::Text(text) => Some(text),
            Content::Shape(_) => None,
        }
    }

    fn check(&self) -> Result<(), String> {
        let position = [self.x, self.y]
            .iter()
            .all(|v| v.is_finite() && v.abs() <= 1e6);
        if !position {
            return Err("A title element is placed too far away".into());
        }
        if !(element_value_ok("scale", self.scale)
            && element_value_ok("rotation", self.rotation)
            && element_value_ok("opacity", self.opacity))
        {
            return Err("A title element's scale, rotation or opacity is out of range".into());
        }
        check_color(&self.fill, "fill")?;
        if let Some(stroke) = &self.stroke {
            check_color(&stroke.color, "outline")?;
            check_length(stroke.width, "outline width", 0.0)?;
        }
        if let Some(shadow) = &self.shadow {
            check_color(&shadow.color, "shadow")?;
            let offset = [shadow.x, shadow.y]
                .iter()
                .all(|v| v.is_finite() && v.abs() <= MAX_SIZE);
            if !offset {
                return Err("The shadow is too far from its element".into());
            }
            check_length(shadow.blur, "shadow blur", 0.0)?;
        }
        match &self.content {
            Content::Text(text) => text.check(),
            Content::Shape(shape) => shape.check(),
        }
    }
}

impl Text {
    fn check(&self) -> Result<(), String> {
        if self.text.len() > MAX_TEXT {
            return Err(format!("A text block holds at most {MAX_TEXT} bytes"));
        }
        let family = self.font.family.trim();
        if family.is_empty() || family.len() > 200 {
            return Err("A text block needs a font".into());
        }
        if !(1..=1000).contains(&self.font.weight) {
            return Err("Font weights are from 1 to 1000".into());
        }
        check_length(self.size, "font size", 1.0)?;
        if !(self.line_spacing.is_finite() && (0.1..=10.0).contains(&self.line_spacing)) {
            return Err("Line spacing is from 0.1 to 10".into());
        }
        if !(self.letter_spacing.is_finite() && self.letter_spacing.abs() <= MAX_SIZE) {
            return Err("The letter spacing is out of range".into());
        }
        if let Some(wrap) = self.wrap {
            check_length(wrap, "wrapping width", 1.0)?;
        }
        if let Some(background) = &self.background {
            check_color(&background.color, "background")?;
            check_length(background.padding, "background padding", 0.0)?;
            check_length(background.radius, "background corner radius", 0.0)?;
        }
        if !element_value_ok("reveal", self.reveal) {
            return Err("Reveal is from 0 to 1".into());
        }
        Ok(())
    }
}

impl Shape {
    fn check(&self) -> Result<(), String> {
        check_length(self.width, "shape width", 0.0)?;
        check_length(self.height, "shape height", 0.0)?;
        check_length(self.radius, "corner radius", 0.0)?;
        if !(3..=64).contains(&self.sides) {
            return Err("Polygons and stars have 3 to 64 corners".into());
        }
        if !(self.inner.is_finite() && (0.01..=1.0).contains(&self.inner)) {
            return Err("A star's inner radius is from 0.01 to 1".into());
        }
        Ok(())
    }
}

impl Title {
    /// The title's rules: a bounded number of valid elements with distinct ids.
    pub fn check(&self) -> Result<(), String> {
        if self.elements.len() > MAX_ELEMENTS {
            return Err(format!("A title holds at most {MAX_ELEMENTS} elements"));
        }
        let mut ids = std::collections::BTreeSet::new();
        for element in &self.elements {
            if !ids.insert(element.id) {
                return Err(format!("Two title elements share the id {}", element.id));
            }
            element.check()?;
        }
        Ok(())
    }

    pub fn element(&self, id: ElementId) -> Option<&Element> {
        self.elements.iter().find(|element| element.id == id)
    }

    /// The fonts the title's text asks for.
    pub fn fonts(&self) -> impl Iterator<Item = &Font> {
        self.elements
            .iter()
            .filter_map(|element| element.text().map(|text| &text.font))
    }

    /// The title at `offset` from its clip's start, with `keyframes` (the clip's)
    /// applied to its elements and kept within range.
    pub fn at(&self, keyframes: &Keyframes, offset: cgv_time::Flicks) -> Title {
        let mut title = self.clone();
        for element in &mut title.elements {
            let prefix = format!("title.{}.", element.id);
            for (name, keys) in keyframes.range(prefix.clone()..) {
                let Some(setting) = name.strip_prefix(&prefix) else {
                    break;
                };
                match (setting, value_at(keys, offset)) {
                    ("fill", Some(KeyValue::Color(color))) => element.fill = color,
                    (setting, Some(KeyValue::Number(value))) => {
                        let value = match setting {
                            "x" | "y" => value.clamp(-1e6, 1e6),
                            "scale" => value.clamp(1e-6, 100.0),
                            "rotation" => value.clamp(-36_000.0, 36_000.0),
                            _ => value.clamp(0.0, 1.0),
                        };
                        match setting {
                            "x" => element.x = value,
                            "y" => element.y = value,
                            "scale" => element.scale = value,
                            "rotation" => element.rotation = value,
                            "opacity" => element.opacity = value,
                            "reveal" => {
                                if let Content::Text(text) = &mut element.content {
                                    text.reveal = value;
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
        }
        title
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation::{Interpolation, Keyframe};
    use cgv_time::Flicks;

    pub(crate) fn heading() -> Title {
        Title {
            elements: vec![Element {
                id: ElementId(7),
                x: 0.0,
                y: 300.0,
                scale: 1.0,
                rotation: 0.0,
                opacity: 1.0,
                fill: Color {
                    r: 1.0,
                    g: 1.0,
                    b: 1.0,
                    a: 1.0,
                },
                stroke: None,
                shadow: None,
                content: Content::Text(Text {
                    text: "مرحبا Hello".into(),
                    font: Font {
                        family: "Cairo".into(),
                        weight: 700,
                        italic: false,
                    },
                    size: 96.0,
                    align: Align::Center,
                    direction: Direction::Auto,
                    line_spacing: 1.0,
                    letter_spacing: 0.0,
                    wrap: None,
                    background: None,
                    reveal: 1.0,
                    reveal_by: RevealUnit::Letter,
                }),
            }],
        }
    }

    #[test]
    fn titles_round_trip_through_json_with_defaults() {
        let title = heading();
        let json = serde_json::to_string(&title).unwrap();
        assert!(json.contains(r#""type":"text""#), "{json}");
        assert_eq!(serde_json::from_str::<Title>(&json).unwrap(), title);
        let shape: Element = serde_json::from_str(
            r#"{"id":3,"x":0,"y":0,"fill":{"r":1,"g":0,"b":0},
                "type":"shape","kind":"star","width":200,"height":200}"#,
        )
        .unwrap();
        assert_eq!(shape.scale, 1.0);
        let Content::Shape(star) = shape.content else {
            panic!("a shape")
        };
        assert_eq!((star.sides, star.inner), (5, 0.5));
        assert!(title.check().is_ok());
    }

    #[test]
    fn checks_refuse_bad_elements() {
        let mut twice = heading();
        twice.elements.push(twice.elements[0].clone());
        assert!(twice.check().is_err());
        let mut tiny = heading();
        let Content::Text(text) = &mut tiny.elements[0].content else {
            unreachable!()
        };
        text.size = 0.5;
        assert!(tiny.check().is_err());
        let mut faded = heading();
        faded.elements[0].opacity = 1.5;
        assert!(faded.check().is_err());
    }

    #[test]
    fn keyframes_animate_element_settings() {
        let key = |time: i64, value: KeyValue| Keyframe {
            time: Flicks(time),
            value,
            interpolation: Interpolation::Linear,
        };
        let mut keyframes = Keyframes::new();
        keyframes.insert(
            "title.7.reveal".into(),
            vec![
                key(0, KeyValue::Number(0.0)),
                key(100, KeyValue::Number(1.0)),
            ],
        );
        keyframes.insert(
            "title.7.y".into(),
            vec![
                key(0, KeyValue::Number(500.0)),
                key(100, KeyValue::Number(300.0)),
            ],
        );
        keyframes.insert("title.9.x".into(), vec![key(0, KeyValue::Number(1.0))]);
        let at = heading().at(&keyframes, Flicks(25));
        let element = &at.elements[0];
        assert_eq!(element.y, 450.0);
        assert_eq!(element.text().unwrap().reveal, 0.25);
        assert_eq!(element.x, 0.0);
        assert_eq!(element_property(ElementId(7), "fill"), "title.7.fill");
    }
}

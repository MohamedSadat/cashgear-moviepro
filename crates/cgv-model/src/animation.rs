//! Keyframes: animated clip properties and their values at any time.
//!
//! A property is animated when it has keyframes; its static value is then unused.
//! Keyframe times count from the clip's start. A keyframe's interpolation shapes
//! the stretch from it to the next one; before the first keyframe and after the
//! last, the value holds.
use std::collections::BTreeMap;

use cgv_time::Flicks;
use serde::{Deserialize, Serialize};

use crate::effects::{Color, ParamValue, Params};
use crate::project::EffectId;
use crate::project::{Clip, Crop, Transform};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Interpolation {
    #[default]
    Linear,
    /// The value jumps at the next keyframe.
    Hold,
    /// Starts slowly and speeds up: CSS `ease-in`.
    EaseIn,
    /// Starts quickly and slows down: CSS `ease-out`.
    EaseOut,
    /// Slow at both ends: CSS `ease-in-out`.
    EaseInOut,
    /// A cubic Bézier from (0, 0) to (1, 1) through (x1, y1) and (x2, y2), as in CSS.
    /// x stays within 0 to 1; y may overshoot.
    Bezier { x1: f64, y1: f64, x2: f64, y2: f64 },
}

impl Interpolation {
    /// The Bézier control points this interpolation follows, if it is a curve.
    pub fn curve(&self) -> Option<[f64; 4]> {
        match *self {
            Interpolation::Linear | Interpolation::Hold => None,
            Interpolation::EaseIn => Some([0.42, 0.0, 1.0, 1.0]),
            Interpolation::EaseOut => Some([0.0, 0.0, 0.58, 1.0]),
            Interpolation::EaseInOut => Some([0.42, 0.0, 0.58, 1.0]),
            Interpolation::Bezier { x1, y1, x2, y2 } => Some([x1, y1, x2, y2]),
        }
    }

    /// How far along the stretch the value is at fraction `t` (0 to 1) of its time.
    pub fn progress(&self, t: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Interpolation::Linear => t,
            Interpolation::Hold => 0.0,
            _ => {
                let [x1, y1, x2, y2] = self.curve().expect("curve");
                bezier_at(x1, y1, x2, y2, t)
            }
        }
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        if let Interpolation::Bezier { x1, y1, x2, y2 } = *self {
            let ok = [x1, x2].iter().all(|x| (0.0..=1.0).contains(x))
                && [y1, y2]
                    .iter()
                    .all(|y| y.is_finite() && (-2.0..=3.0).contains(y));
            if !ok {
                return Err("Curve handles must stay within the stretch's time".into());
            }
        }
        Ok(())
    }
}

/// y of a CSS cubic Bézier at x.
fn bezier_at(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
    let along = |a: f64, b: f64, s: f64| {
        let u = 1.0 - s;
        3.0 * u * u * s * a + 3.0 * u * s * s * b + s * s * s
    };
    let slope = |a: f64, b: f64, s: f64| {
        let u = 1.0 - s;
        3.0 * u * u * a + 6.0 * u * s * (b - a) + 3.0 * s * s * (1.0 - b)
    };
    // Newton's method, then bisection where the curve is too flat for it.
    let mut s = x;
    for _ in 0..8 {
        let error = along(x1, x2, s) - x;
        if error.abs() < 1e-9 {
            return along(y1, y2, s);
        }
        let d = slope(x1, x2, s);
        if d.abs() < 1e-6 {
            break;
        }
        s = (s - error / d).clamp(0.0, 1.0);
    }
    let (mut low, mut high) = (0.0, 1.0);
    s = x;
    for _ in 0..60 {
        let value = along(x1, x2, s);
        if (value - x).abs() < 1e-9 {
            break;
        }
        if value < x {
            low = s;
        } else {
            high = s;
        }
        s = (low + high) / 2.0;
    }
    along(y1, y2, s)
}

/// A keyframe's value: a number, or a colour (blended in linear light).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum KeyValue {
    Number(f64),
    Color(Color),
}

impl KeyValue {
    pub fn as_number(&self) -> Option<f64> {
        match self {
            KeyValue::Number(value) => Some(*value),
            KeyValue::Color(_) => None,
        }
    }

    pub fn param(&self) -> ParamValue {
        match self {
            KeyValue::Number(value) => ParamValue::Number(*value),
            KeyValue::Color(color) => ParamValue::Color(*color),
        }
    }

    fn mix(&self, other: &KeyValue, t: f64) -> KeyValue {
        match (self, other) {
            (KeyValue::Number(a), KeyValue::Number(b)) => KeyValue::Number(a + (b - a) * t),
            (KeyValue::Color(a), KeyValue::Color(b)) => {
                let channel = |a: f64, b: f64| {
                    let (a, b) = (srgb_to_linear(a), srgb_to_linear(b));
                    linear_to_srgb(a + (b - a) * t)
                };
                KeyValue::Color(Color {
                    r: channel(a.r, b.r),
                    g: channel(a.g, b.g),
                    b: channel(a.b, b.b),
                    a: (a.a + (b.a - a.a) * t).clamp(0.0, 1.0),
                })
            }
            // Mixed kinds never validate; hold the first.
            _ => *self,
        }
    }
}

fn srgb_to_linear(c: f64) -> f64 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(c: f64) -> f64 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// A property value at a time measured from the clip's start.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub time: Flicks,
    pub value: KeyValue,
    #[serde(default)]
    pub interpolation: Interpolation,
}

/// The value of keyframes `keys` (sorted by time) at `time`.
pub fn value_at(keys: &[Keyframe], time: Flicks) -> Option<KeyValue> {
    let first = keys.first()?;
    if time <= first.time {
        return Some(first.value);
    }
    let next = keys.partition_point(|key| key.time <= time);
    let Some(after) = keys.get(next) else {
        return keys.last().map(|key| key.value);
    };
    let before = &keys[next - 1];
    let span = (after.time.0 - before.time.0) as f64;
    let t = (time.0 - before.time.0) as f64 / span;
    Some(
        before
            .value
            .mix(&after.value, before.interpolation.progress(t)),
    )
}

/// A clip property that can be animated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Property {
    X,
    Y,
    ScaleX,
    ScaleY,
    Rotation,
    AnchorX,
    AnchorY,
    Opacity,
    CropLeft,
    CropTop,
    CropRight,
    CropBottom,
    VolumeDb,
    /// A setting of one of the clip's effects.
    Effect(EffectId),
}

const NAMED: [(&str, Property); 13] = [
    ("transform.x", Property::X),
    ("transform.y", Property::Y),
    ("transform.scaleX", Property::ScaleX),
    ("transform.scaleY", Property::ScaleY),
    ("transform.rotation", Property::Rotation),
    ("transform.anchorX", Property::AnchorX),
    ("transform.anchorY", Property::AnchorY),
    ("opacity", Property::Opacity),
    ("crop.left", Property::CropLeft),
    ("crop.top", Property::CropTop),
    ("crop.right", Property::CropRight),
    ("crop.bottom", Property::CropBottom),
    ("volumeDb", Property::VolumeDb),
];

impl Property {
    /// Reads a keyframe property name: one of the names above, or
    /// `effects.<effect id>.<setting>`.
    pub fn parse(name: &str) -> Option<(Property, Option<&str>)> {
        if let Some((_, property)) = NAMED.iter().find(|(n, _)| *n == name) {
            return Some((*property, None));
        }
        let rest = name.strip_prefix("effects.")?;
        let (id, param) = rest.split_once('.')?;
        let id = id.parse().ok()?;
        crate::effects::valid_param_name(param)
            .then_some((Property::Effect(EffectId(id)), Some(param)))
    }

    /// Whether the property belongs to the picture (rather than the sound).
    pub fn visual(&self) -> bool {
        *self != Property::VolumeDb
    }
}

/// The keyframe property name of setting `param` of effect `id`.
pub fn effect_property(id: EffectId, param: &str) -> String {
    format!("effects.{id}.{param}")
}

/// The effect a keyframe property name belongs to, if any.
pub fn property_effect(name: &str) -> Option<EffectId> {
    match Property::parse(name) {
        Some((Property::Effect(id), _)) => Some(id),
        _ => None,
    }
}

/// Every animated property and its keyframes.
pub type Keyframes = BTreeMap<String, Vec<Keyframe>>;

impl Clip {
    fn number_at(&self, name: &str, offset: Flicks, value: f64) -> f64 {
        self.keyframes
            .get(name)
            .and_then(|keys| value_at(keys, offset))
            .and_then(|value| value.as_number())
            .unwrap_or(value)
    }

    /// The transform at `offset` from the clip's start, kept within range.
    pub fn transform_at(&self, offset: Flicks) -> Transform {
        let t = self.transform;
        if !self
            .keyframes
            .keys()
            .any(|name| name.starts_with("transform."))
        {
            return t;
        }
        Transform {
            x: self.number_at("transform.x", offset, t.x).clamp(-1e6, 1e6),
            y: self.number_at("transform.y", offset, t.y).clamp(-1e6, 1e6),
            scale_x: self
                .number_at("transform.scaleX", offset, t.scale_x)
                .clamp(1e-6, 100.0),
            scale_y: self
                .number_at("transform.scaleY", offset, t.scale_y)
                .clamp(1e-6, 100.0),
            rotation: self
                .number_at("transform.rotation", offset, t.rotation)
                .clamp(-36_000.0, 36_000.0),
            anchor_x: self
                .number_at("transform.anchorX", offset, t.anchor_x)
                .clamp(-100.0, 100.0),
            anchor_y: self
                .number_at("transform.anchorY", offset, t.anchor_y)
                .clamp(-100.0, 100.0),
        }
    }

    pub fn opacity_at(&self, offset: Flicks) -> f64 {
        self.number_at("opacity", offset, self.opacity)
            .clamp(0.0, 1.0)
    }

    /// The crop at `offset`; sides that would leave nothing shrink together.
    pub fn crop_at(&self, offset: Flicks) -> Crop {
        let c = self.crop;
        if !self.keyframes.keys().any(|name| name.starts_with("crop.")) {
            return c;
        }
        let side = |name: &str, value: f64| self.number_at(name, offset, value).clamp(0.0, 0.99);
        let mut crop = Crop {
            left: side("crop.left", c.left),
            top: side("crop.top", c.top),
            right: side("crop.right", c.right),
            bottom: side("crop.bottom", c.bottom),
        };
        for (a, b) in [
            (&mut crop.left, &mut crop.right),
            (&mut crop.top, &mut crop.bottom),
        ] {
            let total = *a + *b;
            if total > 0.99 {
                *a *= 0.99 / total;
                *b *= 0.99 / total;
            }
        }
        crop
    }

    pub fn volume_db_at(&self, offset: Flicks) -> f64 {
        self.number_at("volumeDb", offset, self.volume_db)
            .clamp(-96.0, 24.0)
    }

    pub fn has_volume_keyframes(&self) -> bool {
        self.keyframes.contains_key("volumeDb")
    }

    /// True when the clip's size or framing is keyframed.
    pub fn has_moving_keyframes(&self) -> bool {
        self.keyframes
            .keys()
            .any(|name| name.starts_with("transform.") || name.starts_with("crop."))
    }

    /// The settings of effect `index` at `offset`, with animated ones evaluated.
    pub fn effect_params_at(&self, index: usize, offset: Flicks) -> Params {
        let effect = &self.effects[index];
        let mut params = effect.params.clone();
        let prefix = format!("effects.{}.", effect.id);
        for (name, keys) in self.keyframes.range(prefix.clone()..) {
            let Some(param) = name.strip_prefix(&prefix) else {
                break;
            };
            if let Some(value) = value_at(keys, offset) {
                params.insert(param.to_string(), value.param());
            }
        }
        params
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(frames: i64, value: f64, interpolation: Interpolation) -> Keyframe {
        Keyframe {
            time: Flicks(frames * 10),
            value: KeyValue::Number(value),
            interpolation,
        }
    }

    fn at(keys: &[Keyframe], time: i64) -> f64 {
        value_at(keys, Flicks(time)).unwrap().as_number().unwrap()
    }

    #[test]
    fn values_hold_outside_the_keyframes_and_follow_each_stretch() {
        let keys = [
            key(1, 0.0, Interpolation::Linear),
            key(3, 10.0, Interpolation::Hold),
            key(5, 20.0, Interpolation::EaseIn),
            key(7, 40.0, Interpolation::Linear),
        ];
        assert_eq!(value_at(&[], Flicks::ZERO), None);
        assert_eq!(at(&keys, 0), 0.0);
        assert_eq!(at(&keys, 20), 5.0);
        assert_eq!(at(&keys, 30), 10.0);
        assert_eq!(
            at(&keys, 49),
            10.0,
            "hold keeps the value until the next key"
        );
        assert_eq!(at(&keys, 50), 20.0);
        assert!(at(&keys, 60) < 30.0, "ease-in starts slowly");
        assert_eq!(at(&keys, 70), 40.0);
        assert_eq!(at(&keys, 1000), 40.0);
    }

    #[test]
    fn eases_match_css_curves() {
        let ease_in = Interpolation::EaseIn;
        let ease_out = Interpolation::EaseOut;
        assert!((ease_in.progress(0.5) - 0.315_356).abs() < 1e-5);
        assert!((ease_out.progress(0.5) - 0.684_644).abs() < 1e-5);
        assert!((Interpolation::EaseInOut.progress(0.5) - 0.5).abs() < 1e-9);
        for t in [0.0, 0.1, 0.37, 0.9, 1.0] {
            let sum = ease_in.progress(t) + ease_out.progress(1.0 - t);
            assert!((sum - 1.0).abs() < 1e-6, "ease-out mirrors ease-in at {t}");
        }
        let linear = Interpolation::Bezier {
            x1: 0.25,
            y1: 0.25,
            x2: 0.75,
            y2: 0.75,
        };
        assert!((linear.progress(0.3) - 0.3).abs() < 1e-6);
        let overshoot = Interpolation::Bezier {
            x1: 0.3,
            y1: 1.8,
            x2: 0.7,
            y2: 1.0,
        };
        assert!(overshoot.progress(0.5) > 1.0);
        assert!(overshoot.check().is_ok());
        let backwards = Interpolation::Bezier {
            x1: 1.5,
            y1: 0.0,
            x2: 0.5,
            y2: 1.0,
        };
        assert!(backwards.check().is_err());
    }

    #[test]
    fn colours_blend_in_linear_light() {
        let black = Color {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 1.0,
        };
        let white = Color {
            r: 1.0,
            g: 1.0,
            b: 1.0,
            a: 0.0,
        };
        let keys = [
            Keyframe {
                time: Flicks(0),
                value: KeyValue::Color(black),
                interpolation: Interpolation::Linear,
            },
            Keyframe {
                time: Flicks(100),
                value: KeyValue::Color(white),
                interpolation: Interpolation::Linear,
            },
        ];
        let KeyValue::Color(mid) = value_at(&keys, Flicks(50)).unwrap() else {
            panic!("a colour")
        };
        // Half of linear light is 0.735 encoded, not 0.5.
        assert!((mid.r - 0.735_357).abs() < 1e-5, "{}", mid.r);
        assert!((mid.a - 0.5).abs() < 1e-9);
    }

    #[test]
    fn property_names_parse() {
        assert_eq!(Property::parse("opacity"), Some((Property::Opacity, None)));
        assert_eq!(
            Property::parse("effects.12.radius"),
            Some((Property::Effect(EffectId(12)), Some("radius")))
        );
        assert_eq!(Property::parse("effects.x.radius"), None);
        assert_eq!(Property::parse("effects.3.9"), None);
        assert_eq!(Property::parse("transform.scale"), None);
        assert_eq!(effect_property(EffectId(4), "amount"), "effects.4.amount");
        assert_eq!(property_effect("effects.4.amount"), Some(EffectId(4)));
        assert!(!Property::VolumeDb.visual());
    }
}

//! Masks, which cut shapes out of a clip's picture, and blend modes, which mix
//! a picture with what is below it.
//!
//! A mask lives in its clip's picture, before the clip's transform, so it moves,
//! turns and scales with the clip. Positions and sizes are fractions of the
//! picture's width and height; feather and expansion are fractions of its
//! shorter side, so a mask looks the same at any preview or export size.
use cgv_time::Flicks;
use serde::{Deserialize, Serialize};

use crate::animation::value_at;
use crate::project::{Clip, MaskId};

/// Masks one clip can have.
pub const MAX_MASKS: usize = 8;
/// Points one drawn mask can have.
pub const MAX_MASK_POINTS: usize = 32;

/// How a picture mixes with what is below it. Modes other than normal work on
/// sRGB-encoded values, as image editors compute them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    SoftLight,
    HardLight,
    Add,
    Darken,
    Lighten,
    Difference,
    Exclusion,
    ColorDodge,
    ColorBurn,
}

impl BlendMode {
    pub fn is_normal(&self) -> bool {
        *self == BlendMode::Normal
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaskShape {
    /// A box with optionally rounded corners.
    #[default]
    Rectangle,
    Ellipse,
    /// A closed path through `points`: straight sides (a polygon) or Bézier curves.
    Path,
}

/// How a mask combines with the masks before it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaskMode {
    /// Shows what this mask or the ones before show.
    #[default]
    Add,
    /// Hides what this mask covers.
    Subtract,
    /// Shows only what this mask and the ones before both show.
    Intersect,
}

/// A point of a drawn mask, in its box: -0.5 to 0.5 across and down from its
/// centre. The handles are offsets from the point; zero handles make a corner.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaskPoint {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "crate::project::is_zero")]
    pub in_x: f64,
    #[serde(default, skip_serializing_if = "crate::project::is_zero")]
    pub in_y: f64,
    #[serde(default, skip_serializing_if = "crate::project::is_zero")]
    pub out_x: f64,
    #[serde(default, skip_serializing_if = "crate::project::is_zero")]
    pub out_y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mask {
    pub id: MaskId,
    pub shape: MaskShape,
    #[serde(default)]
    pub mode: MaskMode,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub invert: bool,
    /// The centre, as fractions of the picture from its top left.
    pub x: f64,
    pub y: f64,
    /// The box, as fractions of the picture's width and height.
    pub width: f64,
    pub height: f64,
    /// Degrees, clockwise.
    #[serde(default, skip_serializing_if = "crate::project::is_zero")]
    pub rotation: f64,
    /// A rectangle's corners: 0 (square) to 1 (half its shorter side).
    #[serde(default, skip_serializing_if = "crate::project::is_zero")]
    pub roundness: f64,
    /// The width of the soft edge, as a fraction of the picture's shorter side.
    #[serde(default, skip_serializing_if = "crate::project::is_zero")]
    pub feather: f64,
    /// Grows (positive) or shrinks the shape, as a fraction of the shorter side.
    #[serde(default, skip_serializing_if = "crate::project::is_zero")]
    pub expansion: f64,
    pub opacity: f64,
    /// A drawn mask's points, in order around it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<MaskPoint>,
}

/// The settings of a mask that can be animated, besides its points' positions
/// (`point<N>.x` and `point<N>.y`).
pub const MASK_SETTINGS: [&str; 9] = [
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "roundness",
    "feather",
    "expansion",
    "opacity",
];

/// The keyframe property name of setting `setting` of mask `id`.
pub fn mask_property(id: MaskId, setting: &str) -> String {
    format!("masks.{id}.{setting}")
}

/// The point a mask setting name moves, and which coordinate.
pub fn point_setting(setting: &str) -> Option<(usize, bool)> {
    let rest = setting.strip_prefix("point")?;
    let (index, axis) = rest.split_once('.')?;
    if index.is_empty() || !index.chars().all(|c| c.is_ascii_digit()) || index.len() > 3 {
        return None;
    }
    let index: usize = index.parse().ok()?;
    match axis {
        "x" => Some((index, true)),
        "y" => Some((index, false)),
        _ => None,
    }
}

/// Whether `setting` names something of a mask that can be animated.
pub(crate) fn valid_mask_setting(setting: &str) -> bool {
    MASK_SETTINGS.contains(&setting) || point_setting(setting).is_some()
}

/// Whether `value` is in range for mask setting `setting`.
pub(crate) fn mask_value_ok(setting: &str, value: f64) -> bool {
    if !value.is_finite() {
        return false;
    }
    if point_setting(setting).is_some() {
        return value.abs() <= 2.0;
    }
    match setting {
        "x" | "y" => (-1.0..=2.0).contains(&value),
        "width" | "height" => value > 0.0 && value <= 4.0,
        "rotation" => value.abs() <= 36_000.0,
        "roundness" | "opacity" => (0.0..=1.0).contains(&value),
        "feather" => (0.0..=0.5).contains(&value),
        "expansion" => (-0.5..=0.5).contains(&value),
        _ => false,
    }
}

impl Mask {
    /// A setting's static value.
    fn setting(&self, setting: &str) -> Option<f64> {
        if let Some((index, x)) = point_setting(setting) {
            let point = self.points.get(index)?;
            return Some(if x { point.x } else { point.y });
        }
        Some(match setting {
            "x" => self.x,
            "y" => self.y,
            "width" => self.width,
            "height" => self.height,
            "rotation" => self.rotation,
            "roundness" => self.roundness,
            "feather" => self.feather,
            "expansion" => self.expansion,
            "opacity" => self.opacity,
            _ => return None,
        })
    }

    pub(crate) fn set(&mut self, setting: &str, value: f64) {
        if let Some((index, x)) = point_setting(setting) {
            if let Some(point) = self.points.get_mut(index) {
                if x {
                    point.x = value;
                } else {
                    point.y = value;
                }
            }
            return;
        }
        match setting {
            "x" => self.x = value,
            "y" => self.y = value,
            "width" => self.width = value,
            "height" => self.height = value,
            "rotation" => self.rotation = value,
            "roundness" => self.roundness = value,
            "feather" => self.feather = value,
            "expansion" => self.expansion = value,
            "opacity" => self.opacity = value,
            _ => {}
        }
    }

    /// Whether the mask names point `index`.
    pub(crate) fn has_setting(&self, setting: &str) -> bool {
        self.setting(setting).is_some()
    }

    pub fn check(&self) -> Result<(), String> {
        for setting in MASK_SETTINGS {
            let value = self.setting(setting).expect("a setting");
            if !mask_value_ok(setting, value) {
                return Err(format!("Mask {} has its {setting} out of range", self.id));
            }
        }
        match self.shape {
            MaskShape::Path if !(3..=MAX_MASK_POINTS).contains(&self.points.len()) => {
                return Err(format!("A drawn mask has 3 to {MAX_MASK_POINTS} points"));
            }
            MaskShape::Rectangle | MaskShape::Ellipse if !self.points.is_empty() => {
                return Err("Only drawn masks have points".into());
            }
            _ => {}
        }
        let coordinates = self
            .points
            .iter()
            .flat_map(|p| [p.x, p.y, p.in_x, p.in_y, p.out_x, p.out_y]);
        for value in coordinates {
            if !value.is_finite() || value.abs() > 2.0 {
                return Err(format!("Mask {} has a point out of range", self.id));
            }
        }
        Ok(())
    }

    /// The mask with its keyframes evaluated `offset` from the clip's start.
    pub fn at(&self, clip: &Clip, offset: Flicks) -> Mask {
        let mut mask = self.clone();
        let prefix = format!("masks.{}.", self.id);
        for (name, keys) in clip.keyframes.range(prefix.clone()..) {
            let Some(setting) = name.strip_prefix(&prefix) else {
                break;
            };
            if let Some(value) = value_at(keys, offset).and_then(|v| v.as_number()) {
                let value = clamp(setting, value);
                mask.set(setting, value);
            }
        }
        mask
    }
}

/// Keeps an animated value in its setting's range.
fn clamp(setting: &str, value: f64) -> f64 {
    if point_setting(setting).is_some() {
        return value.clamp(-2.0, 2.0);
    }
    match setting {
        "x" | "y" => value.clamp(-1.0, 2.0),
        "width" | "height" => value.clamp(1e-6, 4.0),
        "rotation" => value.clamp(-36_000.0, 36_000.0),
        "roundness" | "opacity" => value.clamp(0.0, 1.0),
        "feather" => value.clamp(0.0, 0.5),
        "expansion" => value.clamp(-0.5, 0.5),
        _ => value,
    }
}

impl Clip {
    /// The masks `offset` from the clip's start, keyframes applied.
    pub fn masks_at(&self, offset: Flicks) -> Vec<Mask> {
        self.masks
            .iter()
            .map(|mask| mask.at(self, offset))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn point_settings_parse() {
        assert_eq!(point_setting("point3.x"), Some((3, true)));
        assert_eq!(point_setting("point12.y"), Some((12, false)));
        assert_eq!(point_setting("point.x"), None);
        assert_eq!(point_setting("point3.z"), None);
        assert_eq!(point_setting("point-1.x"), None);
        assert!(valid_mask_setting("feather"));
        assert!(!valid_mask_setting("colour"));
        assert!(mask_value_ok("feather", 0.1));
        assert!(!mask_value_ok("feather", 0.6));
        assert!(!mask_value_ok("width", 0.0));
    }
}

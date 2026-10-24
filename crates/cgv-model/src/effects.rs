//! Effects, transitions and LUTs as the project stores them. The model knows
//! their structure, not their meaning: definitions (settings, shaders) live in
//! effect packs, so a project can name an effect this build does not have.
use std::collections::BTreeMap;

use cgv_time::Flicks;
use serde::{Deserialize, Serialize};

use crate::project::{ClipId, EffectId, LutId, TransitionId, MAX_TIME};

/// The pack of the effects and transitions that ship with the app.
pub const BUILTIN_PACK: &str = "builtin";
/// Effects one clip can hold.
pub const MAX_EFFECTS: usize = 32;
const MAX_PARAMS: usize = 64;
const MAX_TEXT: usize = 200;

/// A colour as a colour picker shows it: sRGB-encoded, straight alpha, 0 to 1.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Color {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    #[serde(default = "opaque")]
    pub a: f64,
}

fn opaque() -> f64 {
    1.0
}

impl Color {
    pub fn components(&self) -> [f64; 4] {
        [self.r, self.g, self.b, self.a]
    }

    pub fn check(&self) -> Result<(), String> {
        if self
            .components()
            .iter()
            .all(|c| c.is_finite() && (0.0..=1.0).contains(c))
        {
            Ok(())
        } else {
            Err("Colour components are from 0 to 1".into())
        }
    }
}

/// One setting of an effect or transition.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ParamValue {
    Number(f64),
    Bool(bool),
    Color(Color),
    /// A choice, or a reference such as a LUT id.
    Text(String),
}

impl ParamValue {
    fn check(&self) -> Result<(), String> {
        match self {
            ParamValue::Number(value) if !value.is_finite() || value.abs() > 1e9 => {
                Err("Effect settings must be finite numbers".into())
            }
            ParamValue::Color(color) => color.check(),
            ParamValue::Text(text) if text.chars().count() > MAX_TEXT => {
                Err(format!("Effect settings are at most {MAX_TEXT} characters"))
            }
            _ => Ok(()),
        }
    }
}

pub type Params = BTreeMap<String, ParamValue>;

/// A plain name: lower-case letters, digits and dashes, as pack and effect ids are.
pub(crate) fn valid_slug(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Setting names are identifiers, so shaders can use them as field names.
pub(crate) fn valid_param_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub(crate) fn check_params(params: &Params) -> Result<(), String> {
    if params.len() > MAX_PARAMS {
        return Err(format!("An effect has at most {MAX_PARAMS} settings"));
    }
    for (name, value) in params {
        if !valid_param_name(name) {
            return Err(format!("{name:?} is not a setting name"));
        }
        value.check()?;
    }
    Ok(())
}

fn check_kind(kind: &str, pack: &str, version: u32) -> Result<(), String> {
    if !valid_slug(kind) || !valid_slug(pack) {
        return Err(format!("{pack}/{kind} is not an effect name"));
    }
    if version == 0 {
        return Err("Effect versions start at 1".into());
    }
    Ok(())
}

/// A video effect on a clip. Effects run in list order on the clip's picture.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub id: EffectId,
    /// The effect's id in its pack, such as `gaussian-blur`.
    pub kind: String,
    pub pack: String,
    /// The definition version the settings were saved with.
    pub version: u32,
    pub enabled: bool,
    /// Settings by name. Missing ones take the definition's defaults.
    #[serde(default)]
    pub params: Params,
}

impl Effect {
    pub(crate) fn check(&self) -> Result<(), String> {
        check_kind(&self.kind, &self.pack, self.version)?;
        check_params(&self.params)
    }
}

/// An effect to add. `id` is the effect's id where it was copied from, so that
/// the copy's keyframes follow it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectSpec {
    #[serde(default)]
    pub id: Option<EffectId>,
    pub kind: String,
    #[serde(default = "builtin")]
    pub pack: String,
    #[serde(default = "first_version")]
    pub version: u32,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub params: Params,
}

fn builtin() -> String {
    BUILTIN_PACK.into()
}

fn first_version() -> u32 {
    1
}

fn enabled() -> bool {
    true
}

impl EffectSpec {
    pub(crate) fn build(&self, id: EffectId) -> Result<Effect, String> {
        let effect = Effect {
            id,
            kind: self.kind.clone(),
            pack: self.pack.clone(),
            version: self.version,
            enabled: self.enabled,
            params: self.params.clone(),
        };
        effect.check()?;
        Ok(effect)
    }
}

impl From<&Effect> for EffectSpec {
    fn from(effect: &Effect) -> Self {
        EffectSpec {
            id: Some(effect.id),
            kind: effect.kind.clone(),
            pack: effect.pack.clone(),
            version: effect.version,
            enabled: effect.enabled,
            params: effect.params.clone(),
        }
    }
}

/// Where a transition sits against its cut.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Alignment {
    /// It begins at the cut, inside the clip after it.
    Start,
    /// Half before the cut and half after, using the media beyond each clip's edge.
    #[default]
    Center,
    /// It ends at the cut, inside the clip before it.
    End,
}

/// A transition on a track: between two clips that touch (`from`, then `to`), or
/// at a clip's free edge, from or to transparent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub id: TransitionId,
    pub kind: String,
    pub pack: String,
    pub version: u32,
    /// The clip before the cut; none for a transition from transparent.
    #[serde(default)]
    pub from: Option<ClipId>,
    /// The clip after the cut; none for a transition to transparent.
    #[serde(default)]
    pub to: Option<ClipId>,
    pub duration: Flicks,
    #[serde(default)]
    pub alignment: Alignment,
    #[serde(default)]
    pub params: Params,
}

impl Transition {
    /// The timeline span the transition covers when its cut is at `cut`. A centred
    /// one puts the whole frames of the first half before the cut.
    pub fn window(&self, cut: Flicks, frame: Flicks) -> (Flicks, Flicks) {
        match self.alignment {
            Alignment::Start => (cut, cut + self.duration),
            Alignment::End => (cut - self.duration, cut),
            Alignment::Center => {
                let half = self.duration.0 / 2;
                let before = if frame.0 > 0 {
                    half / frame.0 * frame.0
                } else {
                    half
                };
                (cut - Flicks(before), cut - Flicks(before) + self.duration)
            }
        }
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        check_kind(&self.kind, &self.pack, self.version)?;
        check_params(&self.params)?;
        if self.from.is_none() && self.to.is_none() {
            return Err(format!("Transition {} has no clip", self.id));
        }
        if self.duration <= Flicks::ZERO || self.duration > MAX_TIME {
            return Err(format!("Transition {} has an invalid duration", self.id));
        }
        // A transition at a free edge stays inside its clip.
        let alignment_ok = match (self.from, self.to) {
            (None, Some(_)) => self.alignment == Alignment::Start,
            (Some(_), None) => self.alignment == Alignment::End,
            _ => true,
        };
        if !alignment_ok {
            return Err(format!(
                "Transition {} at a clip's free edge must stay inside the clip",
                self.id
            ));
        }
        Ok(())
    }
}

/// A transition to add.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionSpec {
    pub kind: String,
    #[serde(default = "builtin")]
    pub pack: String,
    #[serde(default = "first_version")]
    pub version: u32,
    pub duration: Flicks,
    /// Defaults to centred on a cut; a transition at a free edge stays inside its clip.
    #[serde(default)]
    pub alignment: Option<Alignment>,
    #[serde(default)]
    pub params: Params,
}

/// Whether a LUT maps each channel on its own (1D) or colours as a whole (3D).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LutShape {
    #[serde(rename = "1d")]
    OneD,
    #[serde(rename = "3d")]
    ThreeD,
}

/// Points per side of the largest 3D LUT, and the most points of a 1D LUT.
pub const MAX_LUT_3D: u32 = 65;
pub const MAX_LUT_1D: u32 = 65_536;

/// A colour lookup table, kept inside the project so it travels with it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lut {
    pub id: LutId,
    pub name: String,
    pub shape: LutShape,
    /// Points per side (3D) or in all (1D).
    pub size: u32,
    /// The input range: inputs outside it are clamped.
    pub domain_min: [f64; 3],
    pub domain_max: [f64; 3],
    /// RGB outputs as little-endian 16-bit values (0 to 65535 for 0 to 1), red
    /// varying fastest, in base64.
    pub data: String,
}

/// A LUT to add, as [`crate::lut::parse_cube`] makes it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LutSpec {
    pub name: String,
    pub shape: LutShape,
    pub size: u32,
    pub domain_min: [f64; 3],
    pub domain_max: [f64; 3],
    pub data: String,
}

fn entries(shape: LutShape, size: u32) -> u64 {
    match shape {
        LutShape::OneD => size as u64,
        LutShape::ThreeD => (size as u64).pow(3),
    }
}

/// A LUT's name, size and range are valid, and its data is as long as its size needs.
fn check_lut(
    name: &str,
    shape: LutShape,
    size: u32,
    domain: ([f64; 3], [f64; 3]),
    data: &str,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_TEXT {
        return Err("A LUT needs a name of at most 200 characters".into());
    }
    let size_ok = match shape {
        LutShape::OneD => (2..=MAX_LUT_1D).contains(&size),
        LutShape::ThreeD => (2..=MAX_LUT_3D).contains(&size),
    };
    if !size_ok {
        return Err(format!("A LUT of size {size} is not supported"));
    }
    for axis in 0..3 {
        let (low, high) = (domain.0[axis], domain.1[axis]);
        if !(low.is_finite() && high.is_finite() && low < high) {
            return Err("A LUT's input range is invalid".into());
        }
    }
    let bytes = entries(shape, size) * 6;
    if crate::base64::decoded_len(data) != Some(bytes as usize) {
        return Err("A LUT's data does not match its size".into());
    }
    Ok(())
}

impl LutSpec {
    pub fn entries(&self) -> u64 {
        entries(self.shape, self.size)
    }

    pub(crate) fn check(&self) -> Result<(), String> {
        check_lut(
            &self.name,
            self.shape,
            self.size,
            (self.domain_min, self.domain_max),
            &self.data,
        )
    }

    pub(crate) fn build(&self, id: LutId) -> Result<Lut, String> {
        self.check()?;
        if crate::base64::decode(&self.data).is_none() {
            return Err("A LUT's data is damaged".into());
        }
        Ok(Lut {
            id,
            name: self.name.trim().to_string(),
            shape: self.shape,
            size: self.size,
            domain_min: self.domain_min,
            domain_max: self.domain_max,
            data: self.data.clone(),
        })
    }
}

impl Lut {
    pub(crate) fn check(&self) -> Result<(), String> {
        check_lut(
            &self.name,
            self.shape,
            self.size,
            (self.domain_min, self.domain_max),
            &self.data,
        )
    }

    pub fn info(&self) -> LutInfo<'_> {
        LutInfo {
            id: self.id,
            name: &self.name,
            shape: self.shape,
            size: self.size,
        }
    }

    pub fn spec(&self) -> LutSpec {
        LutSpec {
            name: self.name.clone(),
            shape: self.shape,
            size: self.size,
            domain_min: self.domain_min,
            domain_max: self.domain_max,
            data: self.data.clone(),
        }
    }

    /// The RGB outputs as 16-bit values.
    pub fn values(&self) -> Vec<u16> {
        crate::base64::decode(&self.data)
            .unwrap_or_default()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect()
    }
}

/// What the UI needs to know of a LUT, without its data.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LutInfo<'a> {
    pub id: LutId,
    pub name: &'a str,
    pub shape: LutShape,
    pub size: u32,
}

/// The `Text` value with which an effect setting names a project LUT.
pub fn lut_ref(id: LutId) -> String {
    format!("lut-{id}")
}

/// The LUT a setting value names, if it names one.
pub fn parse_lut_ref(text: &str) -> Option<LutId> {
    text.strip_prefix("lut-")?.parse().ok().map(LutId)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_read_as_numbers_switches_colours_and_text() {
        let params: Params = serde_json::from_str(
            r#"{"amount":0.5,"on":true,"tint":{"r":1,"g":0.5,"b":0},"lut":"lut-7"}"#,
        )
        .unwrap();
        assert_eq!(params["amount"], ParamValue::Number(0.5));
        assert_eq!(params["on"], ParamValue::Bool(true));
        assert_eq!(
            params["tint"],
            ParamValue::Color(Color {
                r: 1.0,
                g: 0.5,
                b: 0.0,
                a: 1.0
            })
        );
        assert_eq!(params["lut"], ParamValue::Text("lut-7".into()));
        assert_eq!(parse_lut_ref("lut-7"), Some(LutId(7)));
        assert_eq!(parse_lut_ref("look"), None);
        assert!(check_params(&params).is_ok());
        let bad: Params = serde_json::from_str(r#"{"9lives":1}"#).unwrap();
        assert!(check_params(&bad).is_err());
        let red: Params = serde_json::from_str(r#"{"c":{"r":2,"g":0,"b":0}}"#).unwrap();
        assert!(check_params(&red).is_err());
    }

    #[test]
    fn centred_windows_put_whole_frames_before_the_cut() {
        let frame = Flicks(10);
        let mut transition = Transition {
            id: TransitionId(1),
            kind: "cross-dissolve".into(),
            pack: BUILTIN_PACK.into(),
            version: 1,
            from: Some(ClipId(2)),
            to: Some(ClipId(3)),
            duration: Flicks(50),
            alignment: Alignment::Center,
            params: Params::new(),
        };
        assert_eq!(
            transition.window(Flicks(100), frame),
            (Flicks(80), Flicks(130))
        );
        transition.duration = Flicks(40);
        assert_eq!(
            transition.window(Flicks(100), frame),
            (Flicks(80), Flicks(120))
        );
        transition.alignment = Alignment::Start;
        assert_eq!(
            transition.window(Flicks(100), frame),
            (Flicks(100), Flicks(140))
        );
        transition.alignment = Alignment::End;
        assert_eq!(
            transition.window(Flicks(100), frame),
            (Flicks(60), Flicks(100))
        );
        assert!(transition.check().is_ok());
        transition.from = None;
        assert!(
            transition.check().is_err(),
            "a free start edge starts at it"
        );
        transition.alignment = Alignment::Start;
        assert!(transition.check().is_ok());
    }
}

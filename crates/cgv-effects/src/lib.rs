//! Effects and transitions as data: each one is a JSON definition (its settings,
//! passes and variants) and a WGSL shader written against a fixed prelude. The
//! built-in pack is every folder in `assets/effects` and `assets/transitions`,
//! embedded at build time. Pure Rust: the renderer compiles the shaders, and the
//! UI reads the catalogue to build its controls.
//!
//! Sound effects (`assets/audio-effects`) are definitions without a shader: their
//! settings are data, and the mixer runs the processor named by their id.
use std::collections::BTreeSet;

use cgv_model::{ParamValue, Params, BUILTIN_PACK};
use serde::{Deserialize, Serialize};

mod lut;
mod shader;

pub use lut::{lut_texels, CUBE_FROM_1D};
pub use shader::{pack_params, shader_source, Layout};

/// One file of the embedded pack.
pub(crate) struct Embedded {
    /// `effects/<id>`, `transitions/<id>` or `audio-effects/<id>`, under `assets`.
    folder: &'static str,
    definition: &'static str,
    shader: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/builtin.rs"));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Changes one picture.
    Effect,
    /// Blends from one picture to another as its progress runs from 0 to 1.
    Transition,
    /// Changes a clip's sound; the mixer runs it.
    Audio,
}

/// The colour a shader reads and returns.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Space {
    /// Linear light, premultiplied alpha: for blurs, blends and geometry.
    #[default]
    Linear,
    /// sRGB-encoded, straight alpha: for colour adjustments and LUTs, as the
    /// picture looks.
    Srgb,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choice {
    pub id: String,
    pub name: String,
    /// An image beside the definition that the shader reads while this is chosen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ParamKind {
    Number {
        min: f64,
        max: f64,
        default: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        step: Option<f64>,
        /// Shown after the value, such as `%` or `°`.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        unit: String,
        /// The UI shows the value times this (100 for a fraction shown as %).
        #[serde(default = "one", skip_serializing_if = "is_one")]
        display: f64,
    },
    Bool {
        default: bool,
    },
    /// sRGB-encoded, straight alpha, as a colour picker gives it.
    Color {
        default: [f64; 4],
    },
    Choice {
        options: Vec<Choice>,
        default: String,
    },
    /// A LUT of the project; the shader reads it with `apply_lut`.
    Lut,
}

fn one() -> f64 {
    1.0
}

fn is_one(value: &f64) -> bool {
    *value == 1.0
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamDef {
    /// The field name in the shader's `params`.
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub kind: ParamKind,
    /// Numbers and colours can be keyframed unless this is false.
    #[serde(default = "yes")]
    pub animate: bool,
}

impl ParamDef {
    pub fn default_value(&self) -> Option<ParamValue> {
        Some(match &self.kind {
            ParamKind::Number { default, .. } => ParamValue::Number(*default),
            ParamKind::Bool { default } => ParamValue::Bool(*default),
            ParamKind::Color { default } => ParamValue::Color(cgv_model::Color {
                r: default[0],
                g: default[1],
                b: default[2],
                a: default[3],
            }),
            ParamKind::Choice { default, .. } => ParamValue::Text(default.clone()),
            ParamKind::Lut => return None,
        })
    }

    /// Whether `value` is the kind of value this setting takes.
    fn accepts(&self, value: &ParamValue) -> bool {
        match (&self.kind, value) {
            (ParamKind::Number { min, max, .. }, ParamValue::Number(v)) => {
                (*min..=*max).contains(v)
            }
            (ParamKind::Bool { .. }, ParamValue::Bool(_)) => true,
            (ParamKind::Color { .. }, ParamValue::Color(_)) => true,
            (ParamKind::Choice { options, .. }, ParamValue::Text(id)) => {
                options.iter().any(|option| &option.id == id)
            }
            (ParamKind::Lut, ParamValue::Text(_)) => true,
            _ => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pass {
    /// The shader function that returns this pass's colour at a uv.
    pub entry: String,
    /// The pass's target size as a fraction of the effect's.
    #[serde(default = "one")]
    pub scale: f64,
}

/// A named set of settings shown as its own item, such as "Wipe left".
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Variant {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub params: Params,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    pub id: String,
    pub name: String,
    pub category: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub version: u32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default)]
    pub space: Space,
    #[serde(default)]
    pub params: Vec<ParamDef>,
    #[serde(default = "main_pass")]
    pub passes: Vec<Pass>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variants: Vec<Variant>,
}

fn main_pass() -> Vec<Pass> {
    vec![Pass {
        entry: "render".into(),
        scale: 1.0,
    }]
}

fn slug(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn identifier(text: &str) -> bool {
    let mut chars = text.chars();
    text.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Names the prelude or WGSL already use.
const RESERVED: [&str; 5] = ["frame", "params", "in", "out", "uv"];

impl Definition {
    /// The definition is well formed: names, ranges, defaults, passes, variants.
    pub fn check(&self) -> Result<(), String> {
        let at = |what: String| format!("{}: {what}", self.id);
        if !slug(&self.id) {
            return Err(format!("{:?} is not an effect id", self.id));
        }
        if self.name.trim().is_empty() || self.category.trim().is_empty() {
            return Err(at("needs a name and a category".into()));
        }
        if self.version == 0 {
            return Err(at("versions start at 1".into()));
        }
        let mut names = BTreeSet::new();
        let mut luts = 0;
        for param in &self.params {
            if !identifier(&param.id) || RESERVED.contains(&param.id.as_str()) {
                return Err(at(format!("{:?} is not a setting name", param.id)));
            }
            if !names.insert(param.id.as_str()) {
                return Err(at(format!("{} is listed twice", param.id)));
            }
            match &param.kind {
                ParamKind::Number {
                    min,
                    max,
                    default,
                    step,
                    display,
                    ..
                } => {
                    let finite = [*min, *max, *default, *display]
                        .iter()
                        .all(|v| v.is_finite());
                    if !finite || min >= max || !(*min..=*max).contains(default) {
                        return Err(at(format!("{} has an invalid range", param.id)));
                    }
                    if step.is_some_and(|step| step.is_nan() || step <= 0.0) {
                        return Err(at(format!("{} has an invalid step", param.id)));
                    }
                }
                ParamKind::Color { default } => {
                    if !default.iter().all(|c| (0.0..=1.0).contains(c)) {
                        return Err(at(format!("{} has an invalid colour", param.id)));
                    }
                }
                ParamKind::Choice { options, default } => {
                    let ids: BTreeSet<&str> = options.iter().map(|o| o.id.as_str()).collect();
                    if options.is_empty()
                        || ids.len() != options.len()
                        || !options.iter().all(|o| slug(&o.id))
                        || !ids.contains(default.as_str())
                    {
                        return Err(at(format!("{} has invalid options", param.id)));
                    }
                }
                ParamKind::Lut => luts += 1,
                ParamKind::Bool { .. } => {}
            }
            let sound_setting = matches!(
                param.kind,
                ParamKind::Number { .. } | ParamKind::Bool { .. } | ParamKind::Choice { .. }
            );
            if self.kind == Kind::Audio && (!sound_setting || param.animate) {
                return Err(at(format!(
                    "{} is not a number, switch or choice that stays still",
                    param.id
                )));
            }
        }
        if luts > 1 {
            return Err(at("an effect reads at most one LUT".into()));
        }
        if self.kind == Kind::Transition && self.passes.len() != 1 {
            return Err(at("a transition has one pass".into()));
        }
        if self.passes.is_empty() || self.passes.len() > 8 {
            return Err(at("an effect has 1 to 8 passes".into()));
        }
        for pass in &self.passes {
            if !identifier(&pass.entry) || !(pass.scale > 0.0 && pass.scale <= 1.0) {
                return Err(at(format!("pass {} is invalid", pass.entry)));
            }
        }
        let mut variants = BTreeSet::new();
        for variant in &self.variants {
            if !slug(&variant.id) || !variants.insert(variant.id.as_str()) {
                return Err(at(format!("variant {:?} is invalid", variant.id)));
            }
            for (name, value) in &variant.params {
                let param = self
                    .params
                    .iter()
                    .find(|p| &p.id == name)
                    .ok_or_else(|| at(format!("variant {} sets {name}", variant.id)))?;
                if !param.accepts(value) {
                    return Err(at(format!("variant {} sets {name} wrongly", variant.id)));
                }
            }
        }
        Ok(())
    }

    pub fn param(&self, id: &str) -> Option<&ParamDef> {
        self.params.iter().find(|param| param.id == id)
    }

    /// Every setting at its default (LUTs have none).
    pub fn defaults(&self) -> Params {
        self.params
            .iter()
            .filter_map(|param| Some((param.id.clone(), param.default_value()?)))
            .collect()
    }

    /// The image the shader reads with `params`: the one of the chosen option of
    /// the first choice that has images. A file name beside the definition.
    pub fn image(&self, params: &Params) -> Option<&str> {
        self.params.iter().find_map(|param| {
            let ParamKind::Choice { options, default } = &param.kind else {
                return None;
            };
            if options.iter().all(|option| option.image.is_none()) {
                return None;
            }
            let chosen = match params.get(&param.id) {
                Some(ParamValue::Text(id)) => id.as_str(),
                _ => default.as_str(),
            };
            options
                .iter()
                .find(|option| option.id == chosen)
                .or_else(|| options.iter().find(|option| &option.id == default))
                .and_then(|option| option.image.as_deref())
        })
    }

    /// The id of the setting that names a LUT, if the effect reads one.
    pub fn lut_param(&self) -> Option<&str> {
        self.params
            .iter()
            .find(|param| param.kind == ParamKind::Lut)
            .map(|param| param.id.as_str())
    }
}

/// A definition and its shader, from a pack.
#[derive(Clone, Debug)]
pub struct Entry {
    pub pack: String,
    /// The folder it came from, relative to the pack's root.
    pub folder: String,
    pub definition: Definition,
    /// The shader's own code, without the prelude.
    pub source: String,
    pub layout: Layout,
}

impl Entry {
    /// The key a renderer stores the definition's image `file` under.
    pub fn image_key(&self, file: &str) -> String {
        format!("{}:{}/{}", self.pack, self.folder, file)
    }
}

/// A file a pack's definitions read, for the host to load and hand the renderer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackImage {
    pub key: String,
    /// Relative to the pack's root (`assets` for the built-in pack).
    pub path: String,
}

/// What the UI lists: a definition and its pack, without shader code.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry<'a> {
    pub pack: &'a str,
    #[serde(flatten)]
    pub definition: &'a Definition,
}

/// The effects and transitions the engine knows, by pack and id.
#[derive(Clone, Debug, Default)]
pub struct Registry {
    entries: Vec<Entry>,
}

impl Registry {
    /// The pack that ships with the app.
    pub fn builtin() -> Result<Registry, String> {
        let mut registry = Registry::default();
        for file in BUILTIN {
            registry.register(BUILTIN_PACK, file.folder, file.definition, file.shader)?;
        }
        Ok(registry)
    }

    /// Adds a definition (JSON) and its shader. A pack may not register an id twice.
    pub fn register(
        &mut self,
        pack: &str,
        folder: &str,
        definition: &str,
        source: &str,
    ) -> Result<(), String> {
        let definition: Definition = serde_json::from_str(definition)
            .map_err(|error| format!("{folder}/effect.json: {error}"))?;
        definition.check()?;
        if self.get(pack, &definition.id).is_some() {
            return Err(format!("{pack} has {} twice", definition.id));
        }
        let layout = Layout::of(&definition);
        self.entries.push(Entry {
            pack: pack.into(),
            folder: folder.into(),
            definition,
            source: source.into(),
            layout,
        });
        Ok(())
    }

    pub fn get(&self, pack: &str, id: &str) -> Option<&Entry> {
        self.entries
            .iter()
            .find(|entry| entry.pack == pack && entry.definition.id == id)
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn catalog(&self) -> Vec<CatalogEntry<'_>> {
        self.entries
            .iter()
            .map(|entry| CatalogEntry {
                pack: &entry.pack,
                definition: &entry.definition,
            })
            .collect()
    }

    /// Every image the definitions read.
    pub fn images(&self) -> Vec<PackImage> {
        let mut images = Vec::new();
        for entry in &self.entries {
            for param in &entry.definition.params {
                if let ParamKind::Choice { options, .. } = &param.kind {
                    for file in options.iter().filter_map(|o| o.image.as_deref()) {
                        let image = PackImage {
                            key: entry.image_key(file),
                            path: format!("{}/{file}", entry.folder),
                        };
                        if !images.contains(&image) {
                            images.push(image);
                        }
                    }
                }
            }
        }
        images
    }
}

#[cfg(test)]
mod tests;

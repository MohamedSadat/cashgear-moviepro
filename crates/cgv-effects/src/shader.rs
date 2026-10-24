//! A definition's full WGSL (the prelude, its settings as a uniform struct, its
//! own code and one fragment entry per pass) and its settings packed to match.
use std::fmt::Write;

use cgv_model::{ParamValue, Params};

use crate::{Definition, Entry, ParamKind, Space};

const PRELUDE: &str = include_str!("prelude.wgsl");

/// Where each setting sits in the `params` uniform: colours first, as `vec4`s
/// (16-byte aligned), then numbers, switches and choices as `f32`s.
#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub fields: Vec<Field>,
    /// A multiple of 16 bytes.
    pub size: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    /// Index into the definition's settings.
    pub param: usize,
    pub offset: u32,
    pub vector: bool,
}

impl Layout {
    pub fn of(definition: &Definition) -> Layout {
        let mut fields = Vec::new();
        let mut offset = 0;
        for vector in [true, false] {
            for (param, def) in definition.params.iter().enumerate() {
                let is_vector = matches!(def.kind, ParamKind::Color { .. });
                if is_vector != vector || def.kind == ParamKind::Lut {
                    continue;
                }
                fields.push(Field {
                    param,
                    offset,
                    vector,
                });
                offset += if vector { 16 } else { 4 };
            }
        }
        Layout {
            fields,
            size: offset.div_ceil(16).max(1) * 16,
        }
    }
}

/// `PARAM_OPTION`: the WGSL name of a choice's option, whose value is its index.
fn constant(param: &str, option: &str) -> String {
    format!("{}_{}", param, option.replace('-', "_")).to_uppercase()
}

/// The complete shader of `entry`. Its vertex entry is `cgv_vertex` and pass `i`
/// is fragment entry `cgv_pass_<i>`.
pub fn shader_source(entry: &Entry) -> String {
    let definition = &entry.definition;
    let mut source = String::from(PRELUDE);
    source.push_str(match definition.space {
        Space::Linear => {
            "\nfn cgv_load(c: vec4<f32>) -> vec4<f32> {\n    return c;\n}\n\n\
             fn cgv_store(c: vec4<f32>) -> vec4<f32> {\n    return c;\n}\n"
        }
        Space::Srgb => {
            "\nfn cgv_load(c: vec4<f32>) -> vec4<f32> {\n    return cgv_to_srgb(c);\n}\n\n\
             fn cgv_store(c: vec4<f32>) -> vec4<f32> {\n    return cgv_from_srgb(c);\n}\n"
        }
    });
    source.push_str("\nstruct Params {\n");
    for field in &entry.layout.fields {
        let id = &definition.params[field.param].id;
        let ty = if field.vector { "vec4<f32>" } else { "f32" };
        writeln!(source, "    {id}: {ty},").unwrap();
    }
    let used = entry
        .layout
        .fields
        .iter()
        .map(|field| if field.vector { 16 } else { 4 })
        .sum::<u32>();
    for pad in 0..(entry.layout.size - used) / 4 {
        writeln!(source, "    cgv_pad{pad}: f32,").unwrap();
    }
    source.push_str("}\n\n@group(0) @binding(1) var<uniform> params: Params;\n\n");
    for param in &definition.params {
        if let ParamKind::Choice { options, .. } = &param.kind {
            for (index, option) in options.iter().enumerate() {
                let name = constant(&param.id, &option.id);
                writeln!(source, "const {name}: f32 = {index}.0;").unwrap();
            }
        }
    }
    writeln!(source, "\n// ---- {}/{} ----\n", entry.pack, definition.id).unwrap();
    source.push_str(&entry.source);
    for (index, pass) in definition.passes.iter().enumerate() {
        write!(
            source,
            "\n@fragment\nfn cgv_pass_{index}(in: FullOut) -> @location(0) vec4<f32> {{\n    \
             return cgv_store({}(in.uv));\n}}\n",
            pass.entry
        )
        .unwrap();
    }
    source
}

fn srgb_to_linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// `params` (a clip's settings at a frame) as the bytes of the `params` uniform.
/// Missing or unusable values take the default; numbers are clamped to their range.
pub fn pack_params(entry: &Entry, params: &Params) -> Vec<u8> {
    let definition = &entry.definition;
    let mut bytes = vec![0u8; entry.layout.size as usize];
    let mut put = |at: u32, value: f64| {
        let at = at as usize;
        bytes[at..at + 4].copy_from_slice(&(value as f32).to_le_bytes());
    };
    for field in &entry.layout.fields {
        let def = &definition.params[field.param];
        let value = params.get(&def.id);
        match &def.kind {
            ParamKind::Number {
                min, max, default, ..
            } => {
                let v = match value {
                    Some(ParamValue::Number(v)) if v.is_finite() => *v,
                    Some(ParamValue::Bool(b)) => *b as u8 as f64,
                    _ => *default,
                };
                put(field.offset, v.clamp(*min, *max));
            }
            ParamKind::Bool { default } => {
                let on = match value {
                    Some(ParamValue::Bool(b)) => *b,
                    Some(ParamValue::Number(v)) => *v != 0.0,
                    _ => *default,
                };
                put(field.offset, on as u8 as f64);
            }
            ParamKind::Choice { options, default } => {
                let chosen = match value {
                    Some(ParamValue::Text(id)) if options.iter().any(|o| &o.id == id) => id,
                    _ => default,
                };
                let index = options.iter().position(|o| &o.id == chosen).unwrap_or(0);
                put(field.offset, index as f64);
            }
            ParamKind::Color { default } => {
                let mut c = match value {
                    Some(ParamValue::Color(color)) => color.components(),
                    _ => *default,
                };
                for channel in c.iter_mut() {
                    *channel = if channel.is_finite() {
                        channel.clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                }
                if definition.space == Space::Linear {
                    for channel in c.iter_mut().take(3) {
                        *channel = srgb_to_linear(*channel);
                    }
                }
                for (i, channel) in c.iter().enumerate() {
                    put(field.offset + 4 * i as u32, *channel);
                }
            }
            ParamKind::Lut => {}
        }
    }
    bytes
}

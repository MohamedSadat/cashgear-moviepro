//! Timelines to and from other editors: OpenTimelineIO (`.otio`) and FCP7 XML
//! (`.xml`), which DaVinci Resolve and Premiere Pro read and write. A timeline
//! goes through [`cut::Cut`], which holds what those formats can say.
pub mod cut;
pub mod fcp7;
pub mod otio;

use cgv_model::{file, Node, Project, SequenceId};
use serde::Serialize;

/// The file formats a timeline can go in and out as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Otio,
    Fcp7,
}

impl Format {
    pub fn parse(name: &str) -> Result<Format, String> {
        match name {
            "otio" => Ok(Format::Otio),
            "fcp7" => Ok(Format::Fcp7),
            other => Err(format!("{other} is not a timeline format")),
        }
    }
}

/// A timeline as a file's text, and what the file leaves out.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    pub text: String,
    pub left_out: Vec<String>,
}

/// Writes timeline `sequence` (the main timeline without one) of `.cgvproj` text.
pub fn export_timeline(
    project: &str,
    sequence: Option<u64>,
    format: Format,
) -> Result<Exported, String> {
    let project: Project = file::from_json(project)?;
    let node = sequence.map_or(Node::Main, |id| Node::Sequence(SequenceId(id)));
    export_project(&project, node, format)
}

/// Writes timeline `node` of `project`.
pub fn export_project(project: &Project, node: Node, format: Format) -> Result<Exported, String> {
    let cut = cut::from_project(project, node)?;
    let mut left_out = cut.left_out.clone();
    collect_left_out(&cut, &mut left_out, &mut Vec::new());
    left_out.sort();
    left_out.dedup();
    Ok(Exported {
        text: match format {
            Format::Otio => otio::write(&cut),
            Format::Fcp7 => fcp7::write(&cut),
        },
        left_out,
    })
}

/// What nested sequences leave out too.
fn collect_left_out(cut: &cut::Cut, into: &mut Vec<String>, seen: &mut Vec<*const cut::Cut>) {
    for track in cut.picture.iter().chain(&cut.sound) {
        for item in &track.items {
            if let cut::Source::Nest(inner) = &item.source {
                let key = std::rc::Rc::as_ptr(inner);
                if !seen.contains(&key) {
                    seen.push(key);
                    into.extend(
                        inner
                            .left_out
                            .iter()
                            .map(|text| format!("{}: {text}", inner.name)),
                    );
                    collect_left_out(inner, into, seen);
                }
            }
        }
    }
}

/// A timeline read from a file, as a project.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// The project, as `.cgvproj` text.
    pub project: String,
    pub left_out: Vec<String>,
}

/// Reads a timeline file as a new project with id `id`.
pub fn import_timeline(text: &str, format: Format, id: &str) -> Result<Imported, String> {
    let cut = match format {
        Format::Otio => otio::read(text)?,
        Format::Fcp7 => fcp7::read(text)?,
    };
    let imported = cut::to_project(&cut, id, None)?;
    Ok(Imported {
        project: file::to_json(&imported.project),
        left_out: imported.left_out,
    })
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    use super::*;

    fn js_error(error: String) -> JsValue {
        JsValue::from_str(&error)
    }

    /// See [`crate::export_timeline`]. Returns JSON `{ text, leftOut }`.
    #[wasm_bindgen]
    pub fn export_timeline(
        project: &str,
        sequence: Option<f64>,
        format: &str,
    ) -> Result<String, JsValue> {
        let format = Format::parse(format).map_err(js_error)?;
        let exported = crate::export_timeline(project, sequence.map(|id| id as u64), format)
            .map_err(js_error)?;
        serde_json::to_string(&exported).map_err(|error| js_error(error.to_string()))
    }

    /// See [`crate::import_timeline`]. Returns JSON `{ project, leftOut }`.
    #[wasm_bindgen]
    pub fn import_timeline(text: &str, format: &str, id: &str) -> Result<String, JsValue> {
        let format = Format::parse(format).map_err(js_error)?;
        let imported = crate::import_timeline(text, format, id).map_err(js_error)?;
        serde_json::to_string(&imported).map_err(|error| js_error(error.to_string()))
    }
}

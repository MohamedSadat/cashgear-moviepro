//! Installed fonts for titles: listed once, each file made readable through the
//! `cgv-media` protocol under a `font-<n>` id, so the engine's workers can fetch it.
use std::sync::OnceLock;

use cgv_native::fonts::{self, InstalledFace};
use serde::Serialize;
use tauri::State;

use crate::media::MediaState;

/// An installed font file as the UI receives it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFile {
    id: String,
    url: String,
    name: String,
    faces: Vec<InstalledFace>,
}

static INSTALLED: OnceLock<Vec<FontFile>> = OnceLock::new();

/// The installed fonts. The first call scans the system; later calls answer at once.
#[tauri::command]
pub async fn fonts_installed(state: State<'_, MediaState>) -> Result<Vec<FontFile>, String> {
    if let Some(files) = INSTALLED.get() {
        return Ok(files.clone());
    }
    let found = tauri::async_runtime::spawn_blocking(fonts::installed)
        .await
        .map_err(|error| error.to_string())?;
    let mut files = Vec::new();
    for (index, font) in found.into_iter().enumerate() {
        let id = format!("font-{index}");
        // A file that cannot be read is left out.
        if let Ok(registered) = state.register_file(&id, &font.path) {
            files.push(FontFile {
                id,
                url: registered.url,
                name: registered.name,
                faces: font.faces,
            });
        }
    }
    Ok(INSTALLED.get_or_init(|| files).clone())
}

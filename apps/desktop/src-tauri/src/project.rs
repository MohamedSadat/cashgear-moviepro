//! Project files, autosaves and relinking. Project files go where the user saves
//! them; autosaves stay in the app data folder (or `CGV_DATA_DIR`, for tests).
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use cgv_native::project::{self, Autosave, Wanted};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::media::{register, MediaFile, MediaState};

pub struct ProjectState {
    data_root: PathBuf,
}

impl ProjectState {
    pub fn new(app: &AppHandle) -> ProjectState {
        let data_root = std::env::var_os("CGV_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| app.path().app_data_dir().ok())
            .unwrap_or_else(|| std::env::temp_dir().join("cashgear-video-data"));
        ProjectState { data_root }
    }
}

/// A project file on disk, as the UI's recent list keeps it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    path: String,
    modified: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    path: String,
    modified: Option<i64>,
    contents: String,
}

fn described(path: &Path) -> ProjectFile {
    ProjectFile {
        path: path.display().to_string(),
        modified: project::modified_ms(path),
    }
}

/// A file name from a project name: no characters Windows refuses, never empty.
fn file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if r#"\/:*?"<>|"#.contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.');
    let stem = if cleaned.is_empty() {
        "Untitled project"
    } else {
        cleaned
    };
    format!("{stem}.{}", project::EXTENSION)
}

fn with_extension(path: PathBuf) -> PathBuf {
    let matches = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(project::EXTENSION));
    if matches {
        return path;
    }
    let mut name = OsString::from(path.as_os_str());
    name.push(format!(".{}", project::EXTENSION));
    PathBuf::from(name)
}

/// Writes the project file. Without a `path` (first save, or Save As) it asks where.
/// Returns None when the user cancels the dialog.
#[tauri::command]
pub async fn project_save(
    app: AppHandle,
    path: Option<String>,
    contents: String,
    name: String,
) -> Result<Option<ProjectFile>, String> {
    let path = match path {
        Some(path) => PathBuf::from(path),
        None => {
            let picked = app
                .dialog()
                .file()
                .set_title("Save project")
                .add_filter("CashGear Video project", &[project::EXTENSION])
                .set_file_name(file_name(&name))
                .blocking_save_file();
            let Some(picked) = picked else {
                return Ok(None);
            };
            with_extension(picked.into_path().map_err(|error| error.to_string())?)
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        project::write_project(&path, &contents).map(|()| described(&path))
    })
    .await
    .map_err(|error| error.to_string())?
    .map(Some)
}

/// Asks for a project file and reads it. None when the user cancels.
#[tauri::command]
pub async fn project_open(app: AppHandle) -> Result<Option<OpenedProject>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Open project")
        .add_filter("CashGear Video project", &[project::EXTENSION])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    project_read(path.display().to_string()).map(Some)
}

/// Reads a project file from the recent list.
#[tauri::command]
pub fn project_read(path: String) -> Result<OpenedProject, String> {
    let path = PathBuf::from(path);
    let contents = project::read_project(&path)?;
    Ok(OpenedProject {
        path: path.display().to_string(),
        modified: project::modified_ms(&path),
        contents,
    })
}

#[tauri::command]
pub fn autosave_read(
    state: State<'_, ProjectState>,
    id: String,
) -> Result<Option<Autosave>, String> {
    project::read_autosave(&state.data_root, &id)
}

#[tauri::command]
pub fn autosave_write(
    state: State<'_, ProjectState>,
    id: String,
    contents: String,
) -> Result<(), String> {
    project::write_autosave(&state.data_root, &id, &contents)
}

#[tauri::command]
pub fn autosave_remove(state: State<'_, ProjectState>, id: String) -> Result<(), String> {
    project::remove_autosave(&state.data_root, &id)
}

/// Asks where a missing file is now and registers it under its old id.
#[tauri::command]
pub async fn media_locate(
    app: AppHandle,
    state: State<'_, MediaState>,
    id: String,
    name: String,
) -> Result<Option<MediaFile>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title(format!("Locate {name}"))
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|error| error.to_string())?;
    register(&state, id, &path).map(Some)
}

/// Asks for a folder and looks in it for missing files by name and size.
#[tauri::command]
pub async fn media_search(
    app: AppHandle,
    state: State<'_, MediaState>,
    wanted: Vec<Wanted>,
) -> Result<Vec<MediaFile>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Search a folder for missing media")
        .blocking_pick_folder();
    let Some(picked) = picked else {
        return Ok(Vec::new());
    };
    let root = picked.into_path().map_err(|error| error.to_string())?;
    let found =
        tauri::async_runtime::spawn_blocking(move || project::search_folder(&root, &wanted))
            .await
            .map_err(|error| error.to_string())?;
    found
        .into_iter()
        .map(|(id, path)| register(&state, id, &path))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_safe_and_end_in_cgvproj() {
        assert_eq!(file_name("Trip"), "Trip.cgvproj");
        assert_eq!(file_name("a/b: c?"), "a_b_ c_.cgvproj");
        assert_eq!(file_name("  "), "Untitled project.cgvproj");
        assert_eq!(file_name("Dots..."), "Dots.cgvproj");
        assert_eq!(
            with_extension(PathBuf::from("C:\\p\\My.Trip")),
            PathBuf::from("C:\\p\\My.Trip.cgvproj")
        );
        assert_eq!(
            with_extension(PathBuf::from("C:\\p\\x.CGVPROJ")),
            PathBuf::from("C:\\p\\x.CGVPROJ")
        );
    }
}

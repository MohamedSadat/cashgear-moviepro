//! Project files, autosaves and finding moved media on disk.
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

/// Project files are small JSON; anything bigger is not one of ours.
pub const MAX_PROJECT_BYTES: u64 = 64 * 1024 * 1024;
pub const EXTENSION: &str = "cgvproj";

/// Last-modified time in milliseconds since 1970, if the file system has one.
pub fn modified_ms(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

fn has_project_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(EXTENSION))
}

/// Reads a `.cgvproj` file. Only that extension, and only up to [`MAX_PROJECT_BYTES`].
pub fn read_project(path: &Path) -> Result<String, String> {
    if !has_project_extension(path) {
        return Err(format!("{} is not a .{EXTENSION} file", path.display()));
    }
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("{} cannot be read: {error}", path.display()))?;
    if !metadata.is_file() || metadata.len() > MAX_PROJECT_BYTES {
        return Err(format!("{} is not a project file", path.display()));
    }
    std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))
}

/// Writes `bytes` beside `path` first and then renames, so a crash never leaves a
/// half-written project.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    let mut partial = path.as_os_str().to_owned();
    partial.push(".part");
    let partial = PathBuf::from(partial);
    std::fs::write(&partial, bytes).map_err(|error| format!("Saving failed: {error}"))?;
    std::fs::rename(&partial, path).map_err(|error| {
        let _ = std::fs::remove_file(&partial);
        format!("Saving failed: {error}")
    })
}

/// Writes a project file, which must end in `.cgvproj`.
pub fn write_project(path: &Path, text: &str) -> Result<(), String> {
    if !has_project_extension(path) {
        return Err(format!("{} is not a .{EXTENSION} file", path.display()));
    }
    write_atomic(path, text.as_bytes())
}

/// Same rule as project ids in `cgv-model`: they name autosave files.
pub fn valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Autosaves live in `<data>/autosave/<project id>.cgvproj`, apart from the user's file.
pub fn autosave_path(data_root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_project_id(id) {
        return Err(format!("Invalid project id {id:?}"));
    }
    Ok(data_root.join("autosave").join(format!("{id}.{EXTENSION}")))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Autosave {
    pub contents: String,
    pub modified: Option<i64>,
}

pub fn read_autosave(data_root: &Path, id: &str) -> Result<Option<Autosave>, String> {
    let path = autosave_path(data_root, id)?;
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(Autosave {
        contents: read_project(&path)?,
        modified: modified_ms(&path),
    }))
}

pub fn write_autosave(data_root: &Path, id: &str, text: &str) -> Result<(), String> {
    write_atomic(&autosave_path(data_root, id)?, text.as_bytes())
}

pub fn remove_autosave(data_root: &Path, id: &str) -> Result<(), String> {
    match std::fs::remove_file(autosave_path(data_root, id)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Removing the autosave failed: {error}")),
    }
}

/// A missing media file to look for.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wanted {
    pub id: String,
    pub name: String,
    pub size: u64,
}

/// Search limits, so a click on a huge drive returns promptly.
pub const SEARCH_DEPTH: usize = 6;
pub const SEARCH_ENTRIES: usize = 50_000;

/// Looks under `root` for files with each wanted name and size. Returns the
/// matches as (media id, path), each wanted file at most once.
pub fn search_folder(root: &Path, wanted: &[Wanted]) -> Vec<(String, PathBuf)> {
    let mut found: Vec<(String, PathBuf)> = Vec::new();
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut seen = 0;
    while let Some((folder, depth)) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > SEARCH_ENTRIES || found.len() == wanted.len() {
                return found;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                if depth < SEARCH_DEPTH {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let size = entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
            for want in wanted {
                let same_name = if cfg!(windows) {
                    want.name.eq_ignore_ascii_case(&name)
                } else {
                    want.name == name
                };
                if same_name && want.size == size && !found.iter().any(|(id, _)| id == &want.id) {
                    found.push((want.id.clone(), path.clone()));
                }
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("cgv-project-test-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn writes_and_reads_project_files_only() {
        let root = temp("files");
        let file = root.join("Trip.cgvproj");
        write_project(&file, "{\"format\":1}").unwrap();
        write_project(&file, "{\"format\":2}").unwrap();
        assert_eq!(read_project(&file).unwrap(), "{\"format\":2}");
        assert!(!root.join("Trip.cgvproj.part").exists());
        assert!(modified_ms(&file).unwrap() > 1_600_000_000_000);
        let other = root.join("notes.txt");
        std::fs::write(&other, "x").unwrap();
        assert!(read_project(&other).is_err());
        assert!(write_project(&other, "x").is_err());
        assert!(read_project(&root.join("missing.cgvproj")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn autosaves_round_trip_and_refuse_odd_ids() {
        let root = temp("autosave");
        assert_eq!(read_autosave(&root, "p-1").unwrap(), None);
        write_autosave(&root, "p-1", "{}").unwrap();
        let autosave = read_autosave(&root, "p-1").unwrap().unwrap();
        assert_eq!(autosave.contents, "{}");
        assert!(autosave.modified.is_some());
        remove_autosave(&root, "p-1").unwrap();
        remove_autosave(&root, "p-1").unwrap();
        assert_eq!(read_autosave(&root, "p-1").unwrap(), None);
        for bad in ["", "../x", "a/b", "a.b"] {
            assert!(autosave_path(&root, bad).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn finds_moved_media_by_name_and_size() {
        let root = temp("search");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/clip.mp4"), b"12345").unwrap();
        std::fs::write(root.join("clip.mp4.bak"), b"12345").unwrap();
        std::fs::write(root.join("a/other.mov"), b"123").unwrap();
        std::fs::write(root.join("song.wav"), b"1").unwrap();
        let wanted = [
            Wanted {
                id: "m1".into(),
                name: "clip.mp4".into(),
                size: 5,
            },
            Wanted {
                id: "m2".into(),
                name: "other.mov".into(),
                size: 999,
            },
            Wanted {
                id: "m3".into(),
                name: "song.wav".into(),
                size: 1,
            },
        ];
        let mut found = search_folder(&root, &wanted);
        found.sort();
        assert_eq!(
            found,
            [
                ("m1".to_string(), root.join("a").join("b").join("clip.mp4")),
                ("m3".to_string(), root.join("song.wav")),
            ]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

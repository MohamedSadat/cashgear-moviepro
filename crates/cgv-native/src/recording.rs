//! Voiceover recordings on the desktop: kept as WAV files in a `Voiceovers`
//! folder beside the project's file, or in the app's data folder for a project
//! that has not been saved yet.
use std::path::{Path, PathBuf};

/// The folder a project's recordings go in.
pub fn folder(project: Option<&Path>, data: &Path) -> PathBuf {
    project
        .and_then(Path::parent)
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(data)
        .join("Voiceovers")
}

/// A plain file name: no folders, no characters Windows refuses, ending in `.wav`.
fn check_name(name: &str) -> Result<(), String> {
    let plain = !name.is_empty()
        && name.len() <= 120
        && name.to_ascii_lowercase().ends_with(".wav")
        && !name.starts_with('.')
        && name.chars().all(|c| {
            !c.is_control() && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        });
    if plain {
        Ok(())
    } else {
        Err(format!("{name:?} is not a recording's file name"))
    }
}

/// A path in `folder` for `name` that no file has: `Voiceover 1.wav`, then
/// `Voiceover 1 (2).wav` and so on.
pub fn free_path(folder: &Path, name: &str) -> Result<PathBuf, String> {
    check_name(name)?;
    let stem = &name[..name.len() - 4];
    let extension = &name[name.len() - 4..];
    let mut path = folder.join(name);
    let mut count = 2;
    while path.exists() {
        path = folder.join(format!("{stem} ({count}){extension}"));
        count += 1;
    }
    Ok(path)
}

/// Moves the recording at `from` to a free path for `name` in `folder`, which
/// is made if needed. Returns where it went.
pub fn keep(from: &Path, folder: &Path, name: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(folder).map_err(|error| format!("Voiceovers folder: {error}"))?;
    let path = free_path(folder, name)?;
    if std::fs::rename(from, &path).is_err() {
        // Another drive: copy, then remove the cached copy.
        std::fs::copy(from, &path).map_err(|error| format!("Saving the recording: {error}"))?;
        let _ = std::fs::remove_file(from);
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recordings_go_beside_the_project_or_in_the_data_folder() {
        let data = Path::new("data");
        assert_eq!(
            folder(Some(Path::new("projects/Trip.cgvproj")), data),
            Path::new("projects").join("Voiceovers")
        );
        assert_eq!(folder(None, data), data.join("Voiceovers"));
        assert_eq!(
            folder(Some(Path::new("Trip.cgvproj")), data),
            data.join("Voiceovers")
        );
    }

    #[test]
    fn names_are_plain_and_never_overwrite() {
        let root = std::env::temp_dir().join(format!("cgv-recording-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let cached = root.join("cached.wav");
        std::fs::create_dir_all(&root).unwrap();
        for _ in 0..2 {
            std::fs::write(&cached, b"RIFF").unwrap();
            keep(&cached, &root.join("Voiceovers"), "Voiceover 1.wav").unwrap();
        }
        assert!(root.join("Voiceovers/Voiceover 1.wav").is_file());
        assert!(root.join("Voiceovers/Voiceover 1 (2).wav").is_file());
        assert!(!cached.exists());
        for bad in [
            "../x.wav", "a/b.wav", "x.mp4", "", ".wav", "c:x.wav", "a?.wav",
        ] {
            assert!(free_path(&root, bad).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}

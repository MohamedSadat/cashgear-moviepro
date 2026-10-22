//! Derived data (thumbnails, waveform peaks, proxies) under the app cache folder.
use std::path::{Path, PathBuf};

/// Maps a cache key such as `media/<id>/thumb-0.jpg` to a path under `root`,
/// refusing anything that could escape it.
pub fn key_path(root: &Path, key: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for part in key.split('/') {
        let safe = !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !safe {
            return Err(format!("Invalid cache key {key:?}"));
        }
        path.push(part);
    }
    Ok(path)
}

pub fn read(root: &Path, key: &str) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(key_path(root, key)?) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cache read failed: {error}")),
    }
}

/// Writes through a temporary file so a crash never leaves a half-written entry.
pub fn write(root: &Path, key: &str, bytes: &[u8]) -> Result<(), String> {
    let path = key_path(root, key)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("Cache folder: {error}"))?;
    }
    let partial = path.with_extension("part");
    std::fs::write(&partial, bytes).map_err(|error| format!("Cache write failed: {error}"))?;
    std::fs::rename(&partial, &path).map_err(|error| format!("Cache write failed: {error}"))
}

/// Removes a cached file or a whole folder of them.
pub fn remove(root: &Path, prefix: &str) -> Result<(), String> {
    let path = key_path(root, prefix)?;
    let result = if path.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    };
    match result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cache remove failed: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_stay_inside_the_root() {
        let root = Path::new("cache-root");
        assert_eq!(
            key_path(root, "media/abc/thumb-0.jpg").unwrap(),
            root.join("media").join("abc").join("thumb-0.jpg")
        );
        for bad in [
            "../x",
            "media/../../x",
            "/abs",
            "a//b",
            "a\\b",
            "c:x",
            "a/./b",
            "",
        ] {
            assert!(key_path(root, bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn write_read_and_remove() {
        let root = std::env::temp_dir().join("cgv-cache-test");
        let _ = std::fs::remove_dir_all(&root);
        write(&root, "media/one/peaks.bin", &[1, 2, 3]).unwrap();
        assert_eq!(
            read(&root, "media/one/peaks.bin").unwrap(),
            Some(vec![1, 2, 3])
        );
        assert_eq!(read(&root, "media/one/missing.bin").unwrap(), None);
        remove(&root, "media/one").unwrap();
        assert_eq!(read(&root, "media/one/peaks.bin").unwrap(), None);
        remove(&root, "media/never").unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }
}

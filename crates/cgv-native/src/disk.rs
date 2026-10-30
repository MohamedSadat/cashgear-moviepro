//! Free disk space, so an export can say up front that it will not fit.

use std::path::Path;

/// Bytes free to this user on the disk that holds `path` (or its nearest existing
/// folder), or None where the system cannot say.
pub fn free_bytes(path: &Path) -> Option<u64> {
    let folder = path.ancestors().find(|candidate| candidate.is_dir())?;
    platform_free(folder)
}

#[cfg(windows)]
fn platform_free(folder: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = folder
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0u64;
    // SAFETY: `wide` is a NUL-terminated path, and the other two outputs may be null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (ok != 0).then_some(available)
}

#[cfg(not(windows))]
fn platform_free(_folder: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn reads_the_free_space_of_a_folder_and_of_a_file_still_to_come() {
        let temp = std::env::temp_dir();
        let free = free_bytes(&temp).expect("the temp folder's disk");
        assert!(free > 0);
        let later = free_bytes(&temp.join("not yet").join("export.mp4")).unwrap();
        // Other programs write meanwhile; the two readings are of the same disk.
        assert!(later.abs_diff(free) < 1 << 30);
    }
}

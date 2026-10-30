//! This computer's id for licences: a salted SHA-256 of the id Windows gives the
//! installation (`MachineGuid`), so the licence server never sees the id itself and
//! reinstalling the app keeps its activation.

use sha2::{Digest, Sha256};

/// The hashed id, or None where the platform has no id to read.
pub fn machine_id() -> Option<String> {
    platform_id().map(|id| hashed(&id))
}

/// The salted hash of a platform id, as 64 hex digits.
pub fn hashed(id: &str) -> String {
    Sha256::digest(format!("cashgear-video:{}", id.trim()).as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(windows)]
fn platform_id() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Cryptography",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .ok()?
        .get_value::<String, _>("MachineGuid")
        .ok()
        .filter(|id| !id.trim().is_empty())
}

#[cfg(not(windows))]
fn platform_id() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id")
        .ok()
        .filter(|id| !id.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_the_id_behind_a_salted_hash() {
        let id = hashed("4c4c4544-0000-1010-8000-b2c04f4e3132");
        assert_eq!(id.len(), 64);
        assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(id, hashed(" 4c4c4544-0000-1010-8000-b2c04f4e3132\n"));
        assert_ne!(id, hashed("4c4c4544-0000-1010-8000-b2c04f4e3133"));
    }

    #[cfg(windows)]
    #[test]
    fn reads_this_computers_id() {
        let first = machine_id().expect("Windows has a MachineGuid");
        assert_eq!(first, machine_id().unwrap());
    }
}

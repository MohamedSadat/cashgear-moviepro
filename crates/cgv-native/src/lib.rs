//! Desktop-only native side: the media registry behind the `cgv-media://`
//! protocol, FFmpeg probes, proxies and export conversions (run as child
//! processes), the cache folder for thumbnails and waveforms, export files, and
//! project files and autosaves.
pub mod cache;
pub mod export;
pub mod ffmpeg;
pub mod probe;
pub mod project;
pub mod proxy;
pub mod range;
pub mod registry;

use serde::Serialize;

/// Identifies the native host to the UI. Returned by the `native_info` Tauri command.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInfo {
    pub product: &'static str,
    pub version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
}

pub fn info() -> NativeInfo {
    NativeInfo {
        product: "CashGear Video",
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_this_build() {
        let info = info();
        assert_eq!(info.product, "CashGear Video");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.os, std::env::consts::OS);
        assert!(!info.arch.is_empty());
    }
}

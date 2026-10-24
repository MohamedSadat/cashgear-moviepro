//! Embeds the built-in pack: every folder in `assets/effects` and
//! `assets/transitions` that holds an `effect.json` and an `effect.wgsl`.
//! Adding a folder adds an effect; no code changes.
use std::fmt::Write;
use std::path::{Path, PathBuf};

fn folders(root: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.join("effect.json").is_file())
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let assets = manifest.join("..").join("..").join("assets");
    let mut code = String::from("pub(crate) const BUILTIN: &[Embedded] = &[\n");
    for group in ["effects", "transitions"] {
        let root = assets.join(group);
        println!("cargo:rerun-if-changed={}", root.display());
        for folder in folders(&root) {
            let name = folder.file_name().unwrap().to_string_lossy().to_string();
            let shader = folder.join("effect.wgsl");
            assert!(shader.is_file(), "{} has no effect.wgsl", folder.display());
            println!("cargo:rerun-if-changed={}", folder.display());
            writeln!(
                code,
                "    Embedded {{ folder: {:?}, definition: include_str!({:?}), shader: include_str!({:?}) }},",
                format!("{group}/{name}"),
                folder.join("effect.json"),
                shader,
            )
            .unwrap();
        }
    }
    code.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("builtin.rs");
    std::fs::write(out, code).unwrap();
}

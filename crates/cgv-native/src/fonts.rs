//! The fonts installed on this computer, for titles: each file with the faces it
//! holds. The engine reads the files themselves (through the media protocol), so
//! only names, weights and styles are read here.
use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;

/// One face of an installed font file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledFace {
    /// The family a picker groups it under (the typographic family where the font has one).
    pub family: String,
    pub weight: u16,
    pub italic: bool,
}

/// An installed font file and its faces.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledFont {
    pub path: PathBuf,
    pub faces: Vec<InstalledFace>,
}

/// Every font file the system has, by path, with its faces.
pub fn installed() -> Vec<InstalledFont> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut files: BTreeMap<PathBuf, Vec<InstalledFace>> = BTreeMap::new();
    for face in db.faces() {
        let fontdb::Source::File(path) = &face.source else {
            continue;
        };
        let Some((family, _)) = face.families.first() else {
            continue;
        };
        files.entry(path.clone()).or_default().push(InstalledFace {
            family: family.clone(),
            weight: face.weight.0,
            italic: face.style != fontdb::Style::Normal,
        });
    }
    files
        .into_iter()
        .map(|(path, faces)| InstalledFont { path, faces })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_installed_fonts_with_their_families() {
        let fonts = installed();
        // Every desktop the app supports has fonts; Windows has Arial, macOS Helvetica.
        assert!(!fonts.is_empty());
        assert!(fonts
            .iter()
            .all(|font| font.path.is_file() && !font.faces.is_empty()));
        if cfg!(windows) {
            assert!(
                fonts
                    .iter()
                    .flat_map(|f| &f.faces)
                    .any(|face| face.family == "Arial"),
                "Arial is installed on Windows"
            );
        }
    }
}

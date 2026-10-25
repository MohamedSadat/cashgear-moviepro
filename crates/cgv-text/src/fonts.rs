//! The fonts titles draw with: loaded from file bytes, found by family, weight
//! and style, and instanced at a weight for shaping and drawing.
use std::collections::{HashMap, HashSet};

use rustybuzz::ttf_parser::{self, name_id, Language, Style, Tag};
use rustybuzz::{Face, Variation};

const WGHT: Tag = Tag::from_bytes(b"wght");

/// Where letters a font lacks come from: Arabic, then Latin, Greek and
/// Cyrillic, then emoji (in one colour). All are bundled.
pub const ARABIC_FALLBACK: &str = "Noto Sans Arabic";
pub const LATIN_FALLBACK: &str = "Inter";
pub const EMOJI_FALLBACK: &str = "Noto Emoji";

/// A face as the font picker lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FaceInfo {
    pub family: String,
    /// The weights it draws: one for a static face, the axis range for a variable one.
    pub weights: (u16, u16),
    pub italic: bool,
}

struct Loaded {
    info: FaceInfo,
    /// Font files stay loaded for the engine's life, so faces can borrow them.
    data: &'static [u8],
    index: u32,
}

/// A loaded face at one weight: what shaping and drawing use.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FaceKey {
    face: u32,
    weight: u16,
}

/// A face found for a request, and whether it must be slanted to look italic.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Found {
    pub key: FaceKey,
    pub synthetic_italic: bool,
}

#[derive(Default)]
pub struct Fonts {
    faces: Vec<Loaded>,
    sources: HashSet<String>,
    instances: HashMap<FaceKey, Face<'static>>,
    /// Changes whenever a font is added, so drawings made before can be redone.
    generation: u64,
}

/// The face's family as a picker groups it: the typographic family when the
/// font names one ("Tajawal" for "Tajawal ExtraLight"), else its family.
fn family_name(face: &ttf_parser::Face) -> Option<String> {
    let names: Vec<_> = face.names().into_iter().collect();
    for id in [name_id::TYPOGRAPHIC_FAMILY, name_id::FAMILY] {
        let mut candidates: Vec<_> = names
            .iter()
            .filter(|name| name.name_id == id && name.is_unicode())
            .collect();
        // English names first.
        candidates.sort_by_key(|name| name.language() != Language::English_UnitedStates);
        if let Some(name) = candidates.iter().find_map(|name| name.to_string()) {
            let name = name.trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

impl Fonts {
    pub fn new() -> Fonts {
        Fonts::default()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Whether the file `source` names was added already.
    pub fn has_source(&self, source: &str) -> bool {
        self.sources.contains(source)
    }

    /// Adds every face of a font file (one, or several in a collection) under
    /// the name `source`; adding a source again does nothing. Returns its faces.
    pub fn add(&mut self, source: &str, data: Vec<u8>) -> Result<Vec<FaceInfo>, String> {
        if self.sources.contains(source) {
            return Ok(Vec::new());
        }
        let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
        let mut parsed = Vec::new();
        for index in 0..count {
            let face = ttf_parser::Face::parse(&data, index)
                .map_err(|error| format!("{source} is not a font this app reads: {error}"))?;
            let family =
                family_name(&face).ok_or_else(|| format!("{source} has no family name"))?;
            let weights = match face
                .variation_axes()
                .into_iter()
                .find(|axis| axis.tag == WGHT)
            {
                Some(axis) => (axis.min_value as u16, axis.max_value as u16),
                None => {
                    let weight = face.weight().to_number();
                    (weight, weight)
                }
            };
            parsed.push((
                index,
                FaceInfo {
                    family,
                    weights,
                    italic: face.style() != Style::Normal,
                },
            ));
        }
        let data: &'static [u8] = Box::leak(data.into_boxed_slice());
        let infos = parsed.iter().map(|(_, info)| info.clone()).collect();
        for (index, info) in parsed {
            self.faces.push(Loaded { info, data, index });
        }
        self.sources.insert(source.to_string());
        self.generation += 1;
        Ok(infos)
    }

    /// The families loaded so far.
    pub fn families(&self) -> Vec<FaceInfo> {
        self.faces.iter().map(|face| face.info.clone()).collect()
    }

    pub fn has_family(&self, family: &str) -> bool {
        self.faces
            .iter()
            .any(|face| face.info.family.eq_ignore_ascii_case(family))
    }

    /// The face of `family` closest to `weight` and `italic`, as CSS picks:
    /// a face of the right style first (else an upright one, slanted), then the
    /// nearest weight, the heavier on a tie.
    pub fn find(&self, family: &str, weight: u16, italic: bool) -> Option<Found> {
        let candidates: Vec<(usize, &Loaded)> = self
            .faces
            .iter()
            .enumerate()
            .filter(|(_, face)| face.info.family.eq_ignore_ascii_case(family))
            .collect();
        let styled: Vec<_> = candidates
            .iter()
            .filter(|(_, face)| face.info.italic == italic)
            .copied()
            .collect();
        let synthetic_italic = italic && styled.is_empty();
        let pool = if styled.is_empty() {
            &candidates
        } else {
            &styled
        };
        let distance = |(lo, hi): (u16, u16)| {
            if weight < lo {
                lo - weight
            } else {
                weight.saturating_sub(hi)
            }
        };
        let (index, face) = pool
            .iter()
            .min_by_key(|(_, face)| {
                let (lo, hi) = face.info.weights;
                (distance((lo, hi)), u16::MAX - hi)
            })
            .copied()?;
        let (lo, hi) = face.info.weights;
        Some(Found {
            key: FaceKey {
                face: index as u32,
                weight: weight.clamp(lo, hi.max(lo)),
            },
            synthetic_italic,
        })
    }

    /// The face for shaping and outlines, set to its weight.
    pub fn face(&mut self, key: FaceKey) -> &Face<'static> {
        let loaded = &self.faces[key.face as usize];
        self.instances.entry(key).or_insert_with(|| {
            let mut face = Face::from_slice(loaded.data, loaded.index).expect("parsed when added");
            if loaded.info.weights.0 != loaded.info.weights.1 {
                face.set_variations(&[Variation {
                    tag: WGHT,
                    value: key.weight as f32,
                }]);
            }
            face
        })
    }

    pub fn family_of(&self, key: FaceKey) -> &str {
        &self.faces[key.face as usize].info.family
    }

    /// Whether the face draws `c`.
    pub fn covers(&mut self, key: FaceKey, c: char) -> bool {
        self.face(key).glyph_index(c).is_some()
    }
}

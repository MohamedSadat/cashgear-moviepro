//! Text layout: font fallback, shaping, line breaking and bidirectional
//! reordering, then the units a reveal counts in.
//!
//! Lines break on the logical text. Each line is then shaped again on its own,
//! so letters at its edges take their forms there, and reordered for display:
//! Arabic runs right to left, numbers and Latin inside it left to right.
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use cgv_model::title::{Align, Direction, Text};
use rustybuzz::{GlyphBuffer, UnicodeBuffer};
use unicode_bidi::{BidiInfo, Level};
use unicode_linebreak::{linebreaks, BreakOpportunity};

use crate::fonts::{FaceKey, Fonts, Found, ARABIC_FALLBACK, EMOJI_FALLBACK, LATIN_FALLBACK};

/// How far a synthetic italic slants: x moves by this much of the height.
pub const ITALIC_SKEW: f32 = 0.2;

/// A rectangle in pixels, y down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

impl Rect {
    pub fn union(self, other: Rect) -> Rect {
        Rect {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }

    pub fn grow(self, by: f32) -> Rect {
        Rect {
            left: self.left - by,
            top: self.top - by,
            right: self.right + by,
            bottom: self.bottom + by,
        }
    }

    pub fn width(&self) -> f32 {
        self.right - self.left
    }

    pub fn height(&self) -> f32 {
        self.bottom - self.top
    }
}

/// A glyph placed in its block: pixels from the block's top left, y down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlacedGlyph {
    pub face: FaceKey,
    pub id: u16,
    /// The pen position on the baseline.
    pub x: f32,
    pub y: f32,
    /// Pixels per font unit.
    pub scale: f32,
    /// Horizontal shear of a synthetic italic.
    pub skew: f32,
    /// The reveal units it belongs to, counted in reading order from 0.
    pub letter: u32,
    pub word: u32,
    pub line: u32,
}

/// A line's text extent: where its glyphs run and the height it takes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LineBox {
    pub left: f32,
    pub width: f32,
    pub top: f32,
    pub height: f32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextLayout {
    pub glyphs: Vec<PlacedGlyph>,
    pub lines: Vec<LineBox>,
    /// The block: the wrapping width, or the widest line, by the lines' heights.
    pub width: f32,
    pub height: f32,
    /// Reveal units in the text.
    pub letters: u32,
    pub words: u32,
    /// The bounds of the glyphs' outlines.
    pub ink: Option<Rect>,
    /// Families the text needs that are not loaded: load them and lay it out again.
    pub missing: Vec<String>,
}

fn is_arabic(c: char) -> bool {
    matches!(c as u32,
        0x0600..=0x06FF | 0x0750..=0x077F | 0x0870..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF)
}

fn is_emoji(c: char) -> bool {
    matches!(c as u32,
        0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0x2300..=0x23FF)
}

/// Marks, joiners and selectors stay in the font of the letter before them.
fn joins_previous(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036F | 0x0483..=0x0489 | 0x0591..=0x05C7 | 0x0610..=0x061A | 0x064B..=0x065F
        | 0x0670 | 0x06D6..=0x06ED | 0x08D3..=0x08FF | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF
        | 0x200C..=0x200F | 0x20D0..=0x20FF | 0xFE00..=0xFE0F | 0xFE20..=0xFE2F
        | 0x1F3FB..=0x1F3FF | 0xE0020..=0xE007F | 0xE0100..=0xE01EF)
}

fn breaks_paragraph(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2029}' | '\u{85}' | '\u{1C}'..='\u{1E}')
}

/// The face that draws `c`: the text's own font, the font of the letter before it
/// for marks and spaces, else a bundled fallback for its script.
fn choose(
    fonts: &mut Fonts,
    c: char,
    primary: Option<Found>,
    previous: Option<Found>,
    weight: u16,
    missing: &mut BTreeSet<String>,
) -> Option<Found> {
    if joins_previous(c) && previous.is_some() {
        return previous;
    }
    if let Some(found) = primary.filter(|found| fonts.covers(found.key, c)) {
        return Some(found);
    }
    if c.is_whitespace() || c.is_ascii_punctuation() {
        if let Some(found) = previous.filter(|found| fonts.covers(found.key, c)) {
            return Some(found);
        }
    }
    let first = if is_arabic(c) {
        ARABIC_FALLBACK
    } else if is_emoji(c) {
        EMOJI_FALLBACK
    } else {
        LATIN_FALLBACK
    };
    for family in [first, LATIN_FALLBACK, ARABIC_FALLBACK, EMOJI_FALLBACK] {
        match fonts.find(family, weight, false) {
            Some(found) if fonts.covers(found.key, c) => return Some(found),
            None if family == first => {
                missing.insert(family.to_string());
            }
            _ => {}
        }
    }
    // Nothing draws it: the text's font shows its missing-glyph box.
    primary.or(previous)
}

/// Runs of `range` with one face, in logical order.
fn items(
    faces: &BTreeMap<usize, Option<Found>>,
    range: Range<usize>,
) -> Vec<(Range<usize>, Found)> {
    let mut items: Vec<(Range<usize>, Found)> = Vec::new();
    let mut current: Option<(usize, Option<Found>)> = None;
    for (&at, &face) in faces.range(range.clone()) {
        match current {
            Some((_, f)) if f == face => {}
            Some((start, Some(f))) => {
                items.push((start..at, f));
                current = Some((at, face));
            }
            _ => current = Some((at, face)),
        }
    }
    if let Some((start, Some(f))) = current {
        items.push((start..range.end, f));
    }
    items
}

struct Shaper<'t> {
    text: &'t str,
    size: f32,
    letter_spacing: f32,
}

impl Shaper<'_> {
    fn shape(
        &self,
        fonts: &mut Fonts,
        found: Found,
        range: &Range<usize>,
        para: &Range<usize>,
        rtl: bool,
    ) -> GlyphBuffer {
        let face = fonts.face(found.key);
        let mut buffer = UnicodeBuffer::new();
        buffer.push_str(&self.text[range.clone()]);
        buffer.set_pre_context(&self.text[para.start..range.start]);
        buffer.set_post_context(&self.text[range.end..para.end]);
        buffer.set_direction(if rtl {
            rustybuzz::Direction::RightToLeft
        } else {
            rustybuzz::Direction::LeftToRight
        });
        buffer.guess_segment_properties();
        rustybuzz::shape(face, &[], buffer)
    }

    fn scale(&self, fonts: &mut Fonts, key: FaceKey) -> f32 {
        self.size / fonts.face(key).units_per_em() as f32
    }

    /// Letter spacing suits scripts whose letters stand apart, not cursive Arabic.
    fn spacing(&self, range: &Range<usize>) -> f32 {
        if self.letter_spacing == 0.0 || self.text[range.clone()].chars().any(is_arabic) {
            0.0
        } else {
            self.letter_spacing
        }
    }
}

/// Lays `text` out with the loaded fonts.
pub fn layout(fonts: &mut Fonts, text: &Text) -> TextLayout {
    let s = text.text.as_str();
    let size = text.size as f32;
    let weight = text.font.weight;
    let mut missing = BTreeSet::new();
    let primary = fonts.find(&text.font.family, weight, text.font.italic);
    if primary.is_none() {
        missing.insert(text.font.family.clone());
    }
    let shaper = Shaper {
        text: s,
        size,
        letter_spacing: text.letter_spacing as f32,
    };
    // The face of every letter.
    let mut faces: BTreeMap<usize, Option<Found>> = BTreeMap::new();
    let mut previous = None;
    for (at, c) in s.char_indices() {
        let face = if breaks_paragraph(c) {
            None
        } else {
            choose(fonts, c, primary, previous, weight, &mut missing)
        };
        faces.insert(at, face);
        previous = face.or(previous);
    }
    let base = match text.direction {
        Direction::Auto => None,
        Direction::Ltr => Some(Level::ltr()),
        Direction::Rtl => Some(Level::rtl()),
    };
    let bidi = BidiInfo::new(s, base);
    // The primary face sets the height of empty lines and the gap between lines.
    let fallback_key = primary.or_else(|| faces.values().flatten().next().copied());
    let mut layout = TextLayout {
        missing: missing.into_iter().collect(),
        ..Default::default()
    };
    let Some(fallback_key) = fallback_key else {
        return layout;
    };
    let metrics = |fonts: &mut Fonts, key: FaceKey| {
        let scale = size / fonts.face(key).units_per_em() as f32;
        let face = fonts.face(key);
        (
            face.ascender() as f32 * scale,
            -(face.descender() as f32) * scale,
            face.line_gap() as f32 * scale,
        )
    };
    let (_, _, gap) = metrics(fonts, fallback_key.key);
    let wrap = text.wrap.map(|wrap| wrap as f32);
    let mut lines: Vec<(Vec<PlacedGlyph>, f32, f32, f32)> = Vec::new();
    let mut clusters: BTreeSet<usize> = BTreeSet::new();
    let mut paragraphs: Vec<Range<usize>> =
        bidi.paragraphs.iter().map(|p| p.range.clone()).collect();
    if paragraphs.is_empty() {
        paragraphs.push(0..0);
    }
    for (para_index, para_range) in paragraphs.iter().enumerate() {
        let para = bidi.paragraphs.get(para_index);
        let mut content = para_range.clone();
        while content.end > content.start {
            let last = s[content.clone()].chars().next_back().unwrap();
            if !breaks_paragraph(last) {
                break;
            }
            content.end -= last.len_utf8();
        }
        let rtl_at = |at: usize| bidi.levels.get(at).is_some_and(|level| level.is_rtl());
        // Widths of each cluster, from the paragraph shaped in logical runs.
        let mut advances: BTreeMap<usize, f32> = BTreeMap::new();
        if let Some(para) = para {
            let mut start = content.start;
            for (at, _) in s[content.clone()]
                .char_indices()
                .map(|(i, c)| (i + content.start, c))
            {
                if bidi.levels[at] != bidi.levels[start] {
                    measure(
                        fonts,
                        &shaper,
                        &faces,
                        start..at,
                        &content,
                        rtl_at(start),
                        &mut advances,
                    );
                    start = at;
                }
            }
            if start < content.end {
                measure(
                    fonts,
                    &shaper,
                    &faces,
                    start..content.end,
                    &content,
                    rtl_at(start),
                    &mut advances,
                );
            }
            let _ = para;
        }
        // Greedy line breaking at the allowed opportunities.
        let mut ranges = Vec::new();
        let mut line_start = content.start;
        let mut segment_start = content.start;
        let mut width = 0.0;
        let width_of = |range: Range<usize>, trim: bool| {
            let mut end = range.end;
            if trim {
                while end > range.start {
                    let c = s[range.start..end].chars().next_back().unwrap();
                    if !c.is_whitespace() {
                        break;
                    }
                    end -= c.len_utf8();
                }
            }
            advances
                .range(range.start..end)
                .map(|(_, w)| w)
                .sum::<f32>()
        };
        for (relative, opportunity) in linebreaks(&s[content.clone()]) {
            let segment_end = content.start + relative;
            let full = width_of(segment_start..segment_end, false);
            let trimmed = width_of(segment_start..segment_end, true);
            if let Some(wrap) = wrap {
                if segment_start > line_start && width + trimmed > wrap {
                    ranges.push(line_start..segment_start);
                    line_start = segment_start;
                    width = 0.0;
                }
            }
            width += full;
            segment_start = segment_end;
            if opportunity == BreakOpportunity::Mandatory && segment_end < content.end {
                ranges.push(line_start..segment_end);
                line_start = segment_end;
                width = 0.0;
            }
        }
        ranges.push(line_start..content.end);
        for mut range in ranges {
            // Trailing spaces and separators take no room at a line's end.
            while range.end > range.start {
                let c = s[range.clone()].chars().next_back().unwrap();
                if !(c.is_whitespace() || breaks_paragraph(c)) {
                    break;
                }
                range.end -= c.len_utf8();
            }
            let mut glyphs = Vec::new();
            let mut pen = 0.0f32;
            let (mut ascent, mut descent, _) = metrics(fonts, fallback_key.key);
            if let (Some(para), false) = (para, range.is_empty()) {
                let (levels, runs) = bidi.visual_runs(para, range.clone());
                for run in runs {
                    let rtl = levels[run.start].is_rtl();
                    let mut run_items = items(&faces, run.clone());
                    if rtl {
                        run_items.reverse();
                    }
                    for (item, found) in run_items {
                        let (a, d, _) = metrics(fonts, found.key);
                        ascent = ascent.max(a);
                        descent = descent.max(d);
                        let scale = shaper.scale(fonts, found.key);
                        let spacing = shaper.spacing(&item);
                        let shaped = shaper.shape(fonts, found, &item, &content, rtl);
                        let infos = shaped.glyph_infos();
                        let positions = shaped.glyph_positions();
                        for (index, (info, position)) in infos.iter().zip(positions).enumerate() {
                            let cluster = item.start + info.cluster as usize;
                            clusters.insert(cluster);
                            glyphs.push(PlacedGlyph {
                                face: found.key,
                                id: info.glyph_id as u16,
                                x: pen + position.x_offset as f32 * scale,
                                // The baseline is set once the line's height is known.
                                y: -(position.y_offset as f32) * scale,
                                scale,
                                skew: if found.synthetic_italic {
                                    ITALIC_SKEW
                                } else {
                                    0.0
                                },
                                letter: cluster as u32,
                                word: 0,
                                line: lines.len() as u32,
                            });
                            pen += position.x_advance as f32 * scale;
                            let last_of_cluster = infos
                                .get(index + 1)
                                .is_none_or(|next| next.cluster != info.cluster);
                            if last_of_cluster {
                                pen += spacing;
                            }
                        }
                    }
                }
            }
            lines.push((glyphs, pen, ascent, descent));
        }
    }
    // Letters and words in reading order.
    let letter_of: BTreeMap<usize, u32> = clusters
        .iter()
        .enumerate()
        .map(|(i, &c)| (c, i as u32))
        .collect();
    let mut word_of: BTreeMap<usize, u32> = BTreeMap::new();
    let mut words = 0u32;
    let mut in_word = false;
    for (at, c) in s.char_indices() {
        let space = c.is_whitespace();
        if !space && !in_word {
            words += 1;
        }
        in_word = !space;
        word_of.insert(at, words.saturating_sub(1));
    }
    let box_width = wrap.unwrap_or_else(|| lines.iter().map(|(_, w, _, _)| *w).fold(0.0, f32::max));
    let mut top = 0.0f32;
    for (glyphs, line_width, ascent, descent) in lines {
        let natural = ascent + descent + gap;
        let height = natural * text.line_spacing as f32;
        let baseline = top + (height - (ascent + descent)) / 2.0 + ascent;
        let left = match text.align {
            Align::Left => 0.0,
            Align::Center => (box_width - line_width) / 2.0,
            Align::Right => box_width - line_width,
        };
        for mut glyph in glyphs {
            let cluster = glyph.letter as usize;
            glyph.letter = letter_of[&cluster];
            glyph.word = word_of.range(..=cluster).next_back().map_or(0, |(_, w)| *w);
            glyph.x += left;
            glyph.y += baseline;
            let face = fonts.face(glyph.face);
            if let Some(bounds) = face.glyph_bounding_box(rustybuzz::ttf_parser::GlyphId(glyph.id))
            {
                let s = glyph.scale;
                let xs = [bounds.x_min as f32, bounds.x_max as f32];
                let ys = [bounds.y_min as f32, bounds.y_max as f32];
                for fy in ys {
                    for fx in xs {
                        let x = glyph.x + (fx + glyph.skew * fy) * s;
                        let y = glyph.y - fy * s;
                        let point = Rect {
                            left: x,
                            top: y,
                            right: x,
                            bottom: y,
                        };
                        layout.ink = Some(layout.ink.map_or(point, |ink| ink.union(point)));
                    }
                }
            }
            layout.glyphs.push(glyph);
        }
        layout.lines.push(LineBox {
            left,
            width: line_width,
            top,
            height,
        });
        top += height;
    }
    layout.width = box_width;
    layout.height = top;
    layout.letters = clusters.len() as u32;
    layout.words = words;
    layout
}

/// Adds the widths of the clusters of `range` (one bidi level) to `advances`.
fn measure(
    fonts: &mut Fonts,
    shaper: &Shaper,
    faces: &BTreeMap<usize, Option<Found>>,
    range: Range<usize>,
    para: &Range<usize>,
    rtl: bool,
    advances: &mut BTreeMap<usize, f32>,
) {
    for (item, found) in items(faces, range) {
        let scale = shaper.scale(fonts, found.key);
        let spacing = shaper.spacing(&item);
        let shaped = shaper.shape(fonts, found, &item, para, rtl);
        for (info, position) in shaped.glyph_infos().iter().zip(shaped.glyph_positions()) {
            *advances
                .entry(item.start + info.cluster as usize)
                .or_default() += position.x_advance as f32 * scale;
        }
        let clusters: BTreeSet<u32> = shaped
            .glyph_infos()
            .iter()
            .map(|info| info.cluster)
            .collect();
        for cluster in clusters {
            *advances.entry(item.start + cluster as usize).or_default() += spacing;
        }
    }
}

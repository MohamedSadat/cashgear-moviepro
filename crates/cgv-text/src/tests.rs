//! Layout and drawing checked with the bundled fonts.
use std::path::PathBuf;

use cgv_model::title::{
    Align, Background, Content, Direction, Element, Font, RevealUnit, Shadow, Shape, ShapeKind,
    Stroke, Text, Title,
};
use cgv_model::{Color, ElementId};

use crate::fonts::Fonts;
use crate::layout::{layout, TextLayout};
use crate::paint::{Painter, View};

fn font_file(folder: &str, file: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../assets/fonts")
        .join(folder)
        .join(file);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Inter, Cairo, Tajawal (static weights) and the Arabic fallback.
fn fonts() -> Fonts {
    let mut fonts = Fonts::new();
    for (folder, file) in [
        ("inter", "Inter-Variable.ttf"),
        ("cairo", "Cairo-Variable.ttf"),
        ("tajawal", "Tajawal-Regular.ttf"),
        ("tajawal", "Tajawal-Bold.ttf"),
        ("noto-sans-arabic", "NotoSansArabic-Variable.ttf"),
        ("noto-naskh-arabic", "NotoNaskhArabic-Variable.ttf"),
    ] {
        fonts.add(file, font_file(folder, file)).unwrap();
    }
    fonts
}

fn text(content: &str, family: &str) -> Text {
    Text {
        text: content.into(),
        font: Font {
            family: family.into(),
            weight: 400,
            italic: false,
        },
        size: 100.0,
        align: Align::Left,
        direction: Direction::Auto,
        line_spacing: 1.0,
        letter_spacing: 0.0,
        wrap: None,
        background: None,
        reveal: 1.0,
        reveal_by: RevealUnit::Letter,
    }
}

/// Letters (reading order numbers) left to right, by their first glyph's pen position.
fn letters_by_x(layout: &TextLayout) -> Vec<u32> {
    let mut first: std::collections::BTreeMap<u32, f32> = Default::default();
    for glyph in &layout.glyphs {
        let x = first.entry(glyph.letter).or_insert(glyph.x);
        *x = x.min(glyph.x);
    }
    let mut letters: Vec<(u32, f32)> = first.into_iter().collect();
    letters.sort_by(|a, b| a.1.total_cmp(&b.1));
    letters.into_iter().map(|(letter, _)| letter).collect()
}

/// The glyph ids of each letter.
fn glyphs_of(layout: &TextLayout, letter: u32) -> Vec<u16> {
    layout
        .glyphs
        .iter()
        .filter(|g| g.letter == letter)
        .map(|g| g.id)
        .collect()
}

#[test]
fn faces_are_found_by_family_weight_and_style() {
    let fonts = fonts();
    let regular = fonts.find("tajawal", 400, false).unwrap();
    let bold = fonts.find("Tajawal", 700, false).unwrap();
    let black = fonts.find("Tajawal", 900, false).unwrap();
    assert_ne!(regular.key, bold.key);
    assert_eq!(black.key, bold.key, "the nearest weight loaded");
    // A variable face takes any weight on its axis.
    let semibold = fonts.find("Cairo", 600, false).unwrap();
    assert!(!semibold.synthetic_italic);
    // No italic face: an upright one, slanted.
    assert!(fonts.find("Inter", 400, true).unwrap().synthetic_italic);
    assert!(fonts.find("Lobster", 400, false).is_none());
    let families: Vec<String> = fonts.families().into_iter().map(|f| f.family).collect();
    assert!(families.contains(&"Tajawal".to_string()), "{families:?}");
}

#[test]
fn latin_text_runs_left_to_right_in_reading_order() {
    let mut fonts = fonts();
    let laid = layout(&mut fonts, &text("Hello world", "Inter"));
    assert_eq!(laid.lines.len(), 1);
    assert_eq!(laid.letters, 11);
    assert_eq!(laid.words, 2);
    assert_eq!(letters_by_x(&laid), (0..11).collect::<Vec<_>>());
    assert!(laid.width > 400.0 && laid.width < 600.0, "{}", laid.width);
    assert!(laid.missing.is_empty());
    let ink = laid.ink.unwrap();
    assert!(ink.top >= 0.0 && ink.bottom <= laid.height + 1.0, "{ink:?}");
}

#[test]
fn arabic_runs_right_to_left_with_joined_forms() {
    let mut fonts = fonts();
    let laid = layout(&mut fonts, &text("ببب", "Noto Naskh Arabic"));
    let alone = layout(&mut fonts, &text("ب", "Noto Naskh Arabic"));
    // Initial, medial and final forms differ from each other and from the letter alone.
    let forms: Vec<Vec<u16>> = (0..3).map(|letter| glyphs_of(&laid, letter)).collect();
    let isolated = glyphs_of(&alone, 0);
    assert!(
        forms[0] != forms[1] && forms[1] != forms[2] && forms[0] != forms[2],
        "{forms:?}"
    );
    assert!(
        forms.iter().all(|form| *form != isolated),
        "{forms:?} {isolated:?}"
    );
    // The first letter read is the rightmost.
    let order = letters_by_x(&laid);
    assert_eq!(order, vec![2, 1, 0]);
}

#[test]
fn mixed_text_orders_each_run_by_its_own_direction() {
    let mut fonts = fonts();
    // A Latin paragraph holding Arabic: the Arabic word reads right to left inside it.
    let laid = layout(&mut fonts, &text("Hi مرحبا 42", "Cairo"));
    let order = letters_by_x(&laid);
    let arabic: Vec<u32> = order
        .iter()
        .copied()
        .filter(|l| (3..8).contains(l))
        .collect();
    assert_eq!(arabic, vec![7, 6, 5, 4, 3], "{order:?}");
    assert_eq!(&order[..2], &[0, 1], "Latin first, on the left");
    // Digits after Arabic letters are Arabic numbers (UAX #9, W2): they read left
    // to right and sit before the Arabic word, as browsers show them.
    let place = |letter: u32| order.iter().position(|&l| l == letter).unwrap();
    assert!(place(9) < place(10) && place(10) < place(7), "{order:?}");
    // An Arabic paragraph: Arabic starts on the right, the Latin word sits left of it.
    let laid = layout(&mut fonts, &text("مرحبا Hello", "Cairo"));
    let order = letters_by_x(&laid);
    assert_eq!(&order[..5], &[6, 7, 8, 9, 10], "{order:?}");
    assert_eq!(*order.last().unwrap(), 0);
    // Forcing left to right keeps the Arabic word first.
    let mut forced = text("مرحبا Hello", "Cairo");
    forced.direction = Direction::Ltr;
    let order = letters_by_x(&layout(&mut fonts, &forced));
    assert_eq!(order[0], 4, "{order:?}");
}

#[test]
fn missing_letters_come_from_the_fallbacks() {
    let mut fonts = fonts();
    // Inter has no Arabic: Noto Sans Arabic draws it.
    let laid = layout(&mut fonts, &text("Title عنوان", "Inter"));
    let inter = fonts.find("Inter", 400, false).unwrap().key;
    let arabic = fonts.find("Noto Sans Arabic", 400, false).unwrap().key;
    assert!(laid.glyphs.iter().any(|g| g.face == inter));
    assert!(laid.glyphs.iter().any(|g| g.face == arabic));
    assert!(laid.missing.is_empty());
    // An unloaded family and fallback are reported, for the engine to load.
    let mut bare = Fonts::new();
    bare.add("inter", font_file("inter", "Inter-Variable.ttf"))
        .unwrap();
    let laid = layout(&mut bare, &text("عنوان 🙂", "Lobster"));
    assert_eq!(
        laid.missing,
        vec!["Lobster", "Noto Emoji", "Noto Sans Arabic"]
    );
}

#[test]
fn lines_wrap_at_the_width_and_count_their_units() {
    let mut fonts = fonts();
    let mut long = text("The quick brown fox jumps over the lazy dog", "Inter");
    long.wrap = Some(700.0);
    long.align = Align::Center;
    let laid = layout(&mut fonts, &long);
    assert!(laid.lines.len() >= 3, "{:?}", laid.lines);
    for line in &laid.lines {
        assert!(line.width <= 700.0 + 0.01, "{line:?}");
        assert!((line.left - (700.0 - line.width) / 2.0).abs() < 0.01);
    }
    assert_eq!(laid.width, 700.0);
    assert_eq!(laid.words, 9);
    let last_line = laid.lines.len() as u32 - 1;
    assert!(laid
        .glyphs
        .iter()
        .any(|g| g.line == last_line && g.word == 8));
    // Newlines start new lines whatever the width.
    let laid = layout(&mut fonts, &text("one\ntwo\n\nfour", "Inter"));
    assert_eq!(laid.lines.len(), 4);
    assert!(laid.lines[1].top > laid.lines[0].top);
}

const WHITE: Color = Color {
    r: 1.0,
    g: 1.0,
    b: 1.0,
    a: 1.0,
};
const BLACK: Color = Color {
    r: 0.0,
    g: 0.0,
    b: 0.0,
    a: 1.0,
};

fn title(element_text: Text) -> Title {
    Title {
        elements: vec![Element {
            id: ElementId(1),
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: 1.0,
            fill: WHITE,
            stroke: None,
            shadow: None,
            content: Content::Text(element_text),
        }],
    }
}

fn draw(painter: &mut Painter, title: &Title, canvas: (f64, f64), view: View) -> Vec<u8> {
    let mut out = vec![0u8; (view.width * view.height * 4) as usize];
    painter.draw(title, canvas, view, |top, rows, bytes| {
        let start = (top * view.width * 4) as usize;
        out[start..start + (rows * view.width * 4) as usize].copy_from_slice(bytes);
    });
    out
}

fn whole(canvas: (f64, f64), scale: f64) -> View {
    View {
        left: 0.0,
        top: 0.0,
        scale_x: scale,
        scale_y: scale,
        width: (canvas.0 * scale) as u32,
        height: (canvas.1 * scale) as u32,
    }
}

fn alpha_sum(pixels: &[u8]) -> u64 {
    pixels.chunks(4).map(|p| p[3] as u64).sum()
}

#[test]
fn titles_draw_in_the_middle_and_bands_join_exactly() {
    let mut painter = Painter::new(fonts());
    let canvas = (640.0, 360.0);
    let mut words = text("Hi مرحبا", "Cairo");
    words.align = Align::Center;
    let mut shown = title(words);
    shown.elements[0].stroke = Some(Stroke {
        color: BLACK,
        width: 6.0,
    });
    shown.elements[0].shadow = Some(Shadow {
        color: Color { a: 0.6, ..BLACK },
        x: 8.0,
        y: 8.0,
        blur: 6.0,
    });
    let full = draw(&mut painter, &shown, canvas, whole(canvas, 1.0));
    // Ink near the centre, nothing in the corners.
    let at = |x: usize, y: usize| full[(y * 640 + x) * 4 + 3];
    assert_eq!(at(5, 5), 0);
    assert_eq!(at(634, 354), 0);
    let middle: u64 = (150..210)
        .flat_map(|y| (150..490).map(move |x| (x, y)))
        .map(|(x, y)| at(x, y) as u64)
        .sum();
    assert!(middle > 0);
    // Drawing the lower half alone gives the same rows: bands and windows join exactly.
    let lower = View {
        top: 180.0,
        height: 180,
        ..whole(canvas, 1.0)
    };
    let half = draw(&mut painter, &shown, canvas, lower);
    let worst = full[640 * 180 * 4..]
        .iter()
        .zip(&half)
        .map(|(a, b)| a.abs_diff(*b))
        .max()
        .unwrap();
    let differ = full[640 * 180 * 4..]
        .iter()
        .zip(&half)
        .filter(|(a, b)| a != b)
        .count();
    // Another origin moves the outlines by whole pixels, in f32: a level or two at edges.
    assert!(
        worst <= 2,
        "the lower half differs by up to {worst} at {differ} values"
    );
    let bounds = painter.bounds(&shown, canvas).unwrap();
    assert!(bounds.left > 100.0 && bounds.right < 540.0, "{bounds:?}");
}

#[test]
fn outlines_shadows_backgrounds_and_reveals_add_and_remove_ink() {
    let mut painter = Painter::new(fonts());
    let canvas = (640.0, 360.0);
    let view = whole(canvas, 1.0);
    let mut words = text("Reveal me", "Inter");
    words.align = Align::Center;
    let plain = title(words.clone());
    let base = alpha_sum(&draw(&mut painter, &plain, canvas, view));
    let mut outlined = plain.clone();
    outlined.elements[0].stroke = Some(Stroke {
        color: BLACK,
        width: 8.0,
    });
    assert!(alpha_sum(&draw(&mut painter, &outlined, canvas, view)) > base * 3 / 2);
    let mut boxed = plain.clone();
    if let Content::Text(t) = &mut boxed.elements[0].content {
        t.background = Some(Background {
            color: Color { a: 0.5, ..BLACK },
            padding: 20.0,
            radius: 10.0,
            per_line: false,
        });
    }
    assert!(alpha_sum(&draw(&mut painter, &boxed, canvas, view)) > base * 2);
    // Half the words revealed: the first word only.
    let mut half = plain.clone();
    if let Content::Text(t) = &mut half.elements[0].content {
        t.reveal = 0.5;
        t.reveal_by = RevealUnit::Word;
    }
    let partial = alpha_sum(&draw(&mut painter, &half, canvas, view));
    assert!(
        partial > base / 4 && partial < base * 3 / 4,
        "{partial} of {base}"
    );
    let mut hidden = plain.clone();
    if let Content::Text(t) = &mut hidden.elements[0].content {
        t.reveal = 0.0;
    }
    assert_eq!(alpha_sum(&draw(&mut painter, &hidden, canvas, view)), 0);
}

#[test]
fn shapes_fill_their_boxes() {
    let mut painter = Painter::new(Fonts::new());
    let canvas = (400.0, 400.0);
    let view = whole(canvas, 1.0);
    let shape = |kind: ShapeKind| Title {
        elements: vec![Element {
            id: ElementId(1),
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: 1.0,
            fill: WHITE,
            stroke: None,
            shadow: None,
            content: Content::Shape(Shape {
                kind,
                width: 200.0,
                height: 100.0,
                radius: 0.0,
                sides: 5,
                inner: 0.5,
            }),
        }],
    };
    let rect = alpha_sum(&draw(
        &mut painter,
        &shape(ShapeKind::Rectangle),
        canvas,
        view,
    )) as f64
        / 255.0;
    assert!((rect - 20_000.0).abs() < 50.0, "{rect}");
    let ellipse = alpha_sum(&draw(
        &mut painter,
        &shape(ShapeKind::Ellipse),
        canvas,
        view,
    )) as f64
        / 255.0;
    let expected = std::f64::consts::PI * 100.0 * 50.0;
    assert!((ellipse - expected).abs() / expected < 0.01, "{ellipse}");
    for kind in [
        ShapeKind::Line,
        ShapeKind::Arrow,
        ShapeKind::Polygon,
        ShapeKind::Star,
    ] {
        let ink = alpha_sum(&draw(&mut painter, &shape(kind), canvas, view));
        assert!(ink > 0 && (ink as f64 / 255.0) < 20_000.0, "{kind:?}");
    }
    // A quarter turn makes it tall.
    let mut turned = shape(ShapeKind::Rectangle);
    turned.elements[0].rotation = 90.0;
    let bounds = painter.bounds(&turned, canvas).unwrap();
    assert!(
        (bounds.height() - bounds.width() - 100.0).abs() < 4.0,
        "{bounds:?}"
    );
}

/// Pixels from 10% to 90% coverage across the left edge of a stem, at `scale`.
fn edge_width(painter: &mut Painter, scale: f64) -> usize {
    let canvas = (400.0, 200.0);
    let mut letter = text("l", "Inter");
    letter.size = 150.0;
    letter.align = Align::Center;
    let pixels = draw(painter, &title(letter), canvas, whole(canvas, scale));
    let width = (canvas.0 * scale) as usize;
    let row = (100.0 * scale) as usize;
    let line: Vec<u8> = (0..width)
        .map(|x| pixels[(row * width + x) * 4 + 3])
        .collect();
    let first = line.iter().position(|&a| a > 25).unwrap();
    let full = line.iter().position(|&a| a > 230).unwrap();
    full - first + 1
}

#[test]
fn text_stays_sharp_when_drawn_large() {
    let mut painter = Painter::new(fonts());
    // Drawn at the size shown: an edge takes at most two pixels at any scale.
    for scale in [1.0, 4.0, 8.0] {
        assert!(edge_width(&mut painter, scale) <= 2, "scale {scale}");
    }
}

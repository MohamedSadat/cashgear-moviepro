//! Title clips: text and shapes without media, their elements and keyframes.
mod common;

use cgv_model::title::{
    Align, Background, Direction, RevealUnit, Shadow, Shape, ShapeKind, Stroke, Text,
};
use cgv_model::*;
use cgv_time::Flicks;
use common::*;

fn run(session: &mut Session, command: Command) -> Outcome {
    session.execute(&command).unwrap()
}

fn fails(session: &mut Session, command: Command, message: &str) {
    let before = session.project().clone();
    let error = session.execute(&command).unwrap_err();
    assert!(
        error.contains(message),
        "{error:?} should mention {message:?}"
    );
    assert_eq!(
        session.project(),
        &before,
        "a failed command changed the project"
    );
}

const WHITE: Color = Color {
    r: 1.0,
    g: 1.0,
    b: 1.0,
    a: 1.0,
};

fn text_element(id: u64, text: &str) -> Element {
    Element {
        id: ElementId(id),
        x: 0.0,
        y: 300.0,
        scale: 1.0,
        rotation: 0.0,
        opacity: 1.0,
        fill: WHITE,
        stroke: Some(Stroke {
            color: Color {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 1.0,
            },
            width: 4.0,
        }),
        shadow: Some(Shadow {
            color: Color {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 0.5,
            },
            x: 4.0,
            y: 6.0,
            blur: 8.0,
        }),
        content: Content::Text(Text {
            text: text.into(),
            font: Font {
                family: "Cairo".into(),
                weight: 700,
                italic: false,
            },
            size: 96.0,
            align: Align::Center,
            direction: Direction::Auto,
            line_spacing: 1.0,
            letter_spacing: 0.0,
            wrap: Some(1200.0),
            background: Some(Background {
                color: Color {
                    r: 0.1,
                    g: 0.2,
                    b: 0.8,
                    a: 0.8,
                },
                padding: 16.0,
                radius: 8.0,
                per_line: false,
            }),
            reveal: 1.0,
            reveal_by: RevealUnit::Word,
        }),
    }
}

fn bar(id: u64) -> Element {
    Element {
        id: ElementId(id),
        x: 0.0,
        y: 400.0,
        scale: 1.0,
        rotation: 0.0,
        opacity: 1.0,
        fill: WHITE,
        stroke: None,
        shadow: None,
        content: Content::Shape(Shape {
            kind: ShapeKind::Rectangle,
            width: 1400.0,
            height: 12.0,
            radius: 6.0,
            sides: 5,
            inner: 0.5,
        }),
    }
}

fn keys(value: KeyValue) -> Vec<Keyframe> {
    vec![Keyframe {
        time: Flicks::ZERO,
        value,
        interpolation: Interpolation::Linear,
    }]
}

/// A 3 s title of a text block (id 1) and a bar (id 2), with the text's reveal keyed.
fn title_spec() -> ClipSpec {
    let mut keyframes = Keyframes::new();
    keyframes.insert("title.1.reveal".into(), keys(KeyValue::Number(0.0)));
    ClipSpec {
        kind: ClipKind::Title,
        duration: f(90),
        keyframes,
        title: Some(Title {
            elements: vec![text_element(1, "عنوان Title"), bar(2)],
        }),
        ..Default::default()
    }
}

fn add_title(s: &mut Session, track: usize) -> ClipId {
    let track = track_id(s, track);
    ClipId(
        run(
            s,
            Command::Append {
                track,
                clip: title_spec(),
            },
        )
        .created[0],
    )
}

fn ids(c: &Clip) -> Vec<ElementId> {
    c.title
        .as_ref()
        .unwrap()
        .elements
        .iter()
        .map(|e| e.id)
        .collect()
}

#[test]
fn title_clips_draw_elements_without_media_and_keep_their_keyframes() {
    let mut s = session();
    let clip = add_title(&mut s, 1);
    let c = common::clip(&s, clip);
    assert!(c.is_title() && c.media.is_empty() && c.video && !c.audio);
    // New ids for the elements, and their keyframes follow.
    let [text, shape] = ids(&c)[..] else {
        panic!("two elements")
    };
    assert!(text.0 > 2 && shape.0 > 2 && text != shape);
    assert!(c.keyframes.contains_key(&element_property(text, "reveal")));
    assert!(!c.keyframes.contains_key("title.1.reveal"));
    let track = track_id(&s, 1);
    fails(
        &mut s,
        Command::SetSpeed {
            clip,
            speed: Speed { num: 2, den: 1 },
        },
        "Titles have no speed",
    );
    fails(
        &mut s,
        Command::Slip { clip, delta: f(5) },
        "Titles have nothing to slip",
    );
    // Titles fade in and out with transitions, as pictures do.
    run(
        &mut s,
        Command::AddTransition {
            track,
            from: None,
            to: Some(clip),
            transition: TransitionSpec {
                kind: "cross-dissolve".into(),
                pack: BUILTIN_PACK.into(),
                version: 1,
                duration: f(10),
                alignment: None,
                params: Params::new(),
            },
        },
    );
    // Both halves of a split draw the same title, animated as before.
    let right = ClipId(
        run(
            &mut s,
            Command::Split {
                at: f(45),
                clips: vec![clip],
            },
        )
        .created[0],
    );
    let (left, right) = (common::clip(&s, clip), common::clip(&s, right));
    assert_eq!(left.title, right.title);
    assert!(right
        .keyframes
        .contains_key(&element_property(text, "reveal")));
    // The file keeps all of it.
    let text_json = file::to_json(s.project());
    assert_eq!(&file::from_json(&text_json).unwrap(), s.project());
    // A spec that animates an element it lacks is refused.
    let mut stray = title_spec();
    stray
        .keyframes
        .insert("title.9.x".into(), keys(KeyValue::Number(1.0)));
    fails(
        &mut s,
        Command::Append { track, clip: stray },
        "animates an element the title lacks",
    );
    let mut untitled = title_spec();
    untitled.title = None;
    fails(
        &mut s,
        Command::Append {
            track,
            clip: untitled,
        },
        "Only title clips",
    );
}

#[test]
fn set_title_keeps_named_elements_and_drops_the_keyframes_of_others() {
    let mut s = session();
    let clip = add_title(&mut s, 1);
    let c = common::clip(&s, clip);
    let [text, shape] = ids(&c)[..] else {
        panic!("two elements")
    };
    run(
        &mut s,
        Command::SetKeyframe {
            clip,
            property: element_property(shape, "x"),
            time: f(0),
            value: KeyValue::Number(-200.0),
            interpolation: None,
        },
    );
    // Keep the text (edited), drop the bar, add a star.
    let mut title = c.title.clone().unwrap();
    title.elements.truncate(1);
    if let Content::Text(t) = &mut title.elements[0].content {
        t.text = "Hello".into();
    }
    let mut star = bar(0);
    star.content = Content::Shape(Shape {
        kind: ShapeKind::Star,
        width: 200.0,
        height: 200.0,
        radius: 0.0,
        sides: 5,
        inner: 0.4,
    });
    title.elements.push(star);
    run(&mut s, Command::SetTitle { clip, title });
    let c = common::clip(&s, clip);
    let now = ids(&c);
    assert_eq!(now[0], text);
    assert!(now[1] != shape && now[1].0 > 0);
    assert!(c.keyframes.contains_key(&element_property(text, "reveal")));
    assert!(!c.keyframes.contains_key(&element_property(shape, "x")));
    // A text that becomes a shape loses its reveal keyframes.
    let mut swapped = c.title.clone().unwrap();
    swapped.elements[0].content = bar(0).content;
    run(
        &mut s,
        Command::SetTitle {
            clip,
            title: swapped,
        },
    );
    assert!(common::clip(&s, clip).keyframes.is_empty());
    // One undo step each.
    s.undo();
    s.undo();
    assert_eq!(ids(&common::clip(&s, clip)), vec![text, shape]);
    let video = append(&mut s, 0, "v", 0, 30);
    fails(
        &mut s,
        Command::SetTitle {
            clip: video,
            title: Title::default(),
        },
        "is not a title",
    );
}

#[test]
fn element_keyframes_animate_and_freeze() {
    let mut s = session();
    let clip = add_title(&mut s, 1);
    let [text, shape] = ids(&common::clip(&s, clip))[..] else {
        panic!("two elements")
    };
    let red = Color {
        r: 1.0,
        g: 0.0,
        b: 0.0,
        a: 1.0,
    };
    run(
        &mut s,
        Command::SetKeyframe {
            clip,
            property: element_property(text, "fill"),
            time: f(0),
            value: KeyValue::Color(red),
            interpolation: None,
        },
    );
    fails(
        &mut s,
        Command::SetKeyframe {
            clip,
            property: element_property(text, "fill"),
            time: f(10),
            value: KeyValue::Number(0.5),
            interpolation: None,
        },
        "colours",
    );
    fails(
        &mut s,
        Command::SetKeyframe {
            clip,
            property: element_property(shape, "reveal"),
            time: f(0),
            value: KeyValue::Number(0.5),
            interpolation: None,
        },
        "no text to reveal",
    );
    fails(
        &mut s,
        Command::SetKeyframe {
            clip,
            property: element_property(text, "opacity"),
            time: f(0),
            value: KeyValue::Number(2.0),
            interpolation: None,
        },
        "out of range",
    );
    for (frame, value) in [(0, 100.0), (30, 300.0)] {
        run(
            &mut s,
            Command::SetKeyframe {
                clip,
                property: element_property(text, "y"),
                time: f(frame),
                value: KeyValue::Number(value),
                interpolation: None,
            },
        );
    }
    let c = common::clip(&s, clip);
    let at = c.title.as_ref().unwrap().at(&c.keyframes, f(15));
    let element = at.element(text).unwrap();
    assert_eq!(element.y, 200.0);
    assert_eq!(element.fill, red);
    // Stopping the animation keeps the value at that moment.
    run(
        &mut s,
        Command::ClearKeyframes {
            clip,
            property: element_property(text, "y"),
            at: Some(f(15)),
        },
    );
    let c = common::clip(&s, clip);
    assert_eq!(c.title.as_ref().unwrap().element(text).unwrap().y, 200.0);
}

#[test]
fn validation_refuses_titles_on_media_clips() {
    let mut s = session();
    let clip = append(&mut s, 0, "v", 0, 30);
    let mut project = s.project().clone();
    let track = std::sync::Arc::make_mut(&mut project.tracks[0]);
    track.clips[0].title = Some(Title::default());
    assert!(validate(&project)
        .unwrap_err()
        .contains("title it cannot draw"));
    let _ = clip;
}

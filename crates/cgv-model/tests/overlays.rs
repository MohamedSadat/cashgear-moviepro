//! Animated images: media that loops for as long as its clip lasts.
mod common;

use cgv_model::*;
use common::*;

/// A session with a 2 s animated GIF ("gif") and a sticker from the app's pack.
fn animated() -> Session {
    let mut s = session();
    for (id, location) in [
        ("gif", MediaLocation::Browser),
        (
            "sticker",
            MediaLocation::Pack {
                path: "stickers/party.webp".into(),
            },
        ),
    ] {
        let media = MediaRef {
            duration: f(60),
            location,
            ..media(id, MediaKind::Image, 0)
        };
        s.execute(&Command::AddMedia { media }).unwrap();
    }
    s
}

#[test]
fn animated_images_loop_for_any_length_from_any_frame() {
    let mut s = animated();
    let project = s.project();
    assert!(project.media("gif").unwrap().loops());
    assert!(!project.media("gif").unwrap().is_still());
    assert!(project.media("i").unwrap().is_still());
    // Five loops long, starting half a loop in, at double speed.
    let track = track_id(&s, 1);
    let clip = ClipSpec {
        media: "gif".into(),
        source_in: f(30),
        duration: f(300),
        speed: Some(Speed { num: 2, den: 1 }),
        ..Default::default()
    };
    s.execute(&Command::Append { track, clip }).unwrap();
    // Outside its loop there is no frame to start from.
    let late = ClipSpec {
        media: "gif".into(),
        source_in: f(60),
        duration: f(30),
        ..Default::default()
    };
    assert!(s
        .execute(&Command::Append { track, clip: late })
        .unwrap_err()
        .contains("no frame there"));
    // Pack media keeps its place in the app's files through a save.
    let text = file::to_json(s.project());
    assert!(text.contains(r#""kind": "pack""#), "{text}");
    assert_eq!(&file::from_json(&text).unwrap(), s.project());
}

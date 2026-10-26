//! Creative tools in the model: speed ramps, reverse, freeze frames, frame
//! blending, blend modes and masks.
mod common;

use cgv_model::*;
use cgv_time::Flicks;
use common::*;

const FRAME_F: Flicks = Flicks(FRAME);

fn shape(points: &[(f64, f64)]) -> Vec<RampShape> {
    points
        .iter()
        .map(|&(at, speed)| RampShape { at, speed })
        .collect()
}

fn set_ramp(s: &mut Session, clip: ClipId, points: &[(f64, f64)]) -> Result<Outcome, String> {
    s.execute(&Command::SetRamp {
        clip,
        points: shape(points),
    })
}

/// The source frame each timeline frame of `id` shows, as the plan reads it.
fn frames(s: &Session, id: ClipId) -> Vec<i64> {
    let c = clip(s, id);
    (0..c.duration.0 / FRAME)
        .map(|k| c.source_at(f(k), FRAME_F).0.div_euclid(FRAME))
        .collect()
}

#[test]
fn a_ramp_keeps_the_media_and_its_length_follows_the_curve() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 120);
    // Twice as fast on average: half as long, over the same 4 s of media.
    set_ramp(&mut s, id, &[(0.0, 1.0), (1.0, 3.0)]).unwrap();
    let c = clip(&s, id);
    assert_eq!(c.duration, f(60));
    assert_eq!(c.ramp.len(), 2);
    assert_eq!(c.ramp[1].time, f(60));
    assert!((c.source_out() - f(120)).0.abs() <= FRAME);
    assert!((c.speed_at(f(30)) - 2.0).abs() < 1e-9);
    // The source runs forward, slowly at first, then faster.
    let shown = frames(&s, id);
    assert!(shown.windows(2).all(|pair| pair[1] >= pair[0]));
    assert!(shown[1] - shown[0] <= 1 && shown[59] - shown[58] >= 2);
    // Removing the ramp plays the same media at the clip's speed again.
    set_ramp(&mut s, id, &[]).unwrap();
    let c = clip(&s, id);
    assert!(c.ramp.is_empty());
    assert!((c.duration - f(120)).0.abs() <= FRAME);
    // Out of range or out of order: refused.
    let error = set_ramp(&mut s, id, &[(0.0, 1.0), (1.0, 0.01)]).unwrap_err();
    assert!(error.contains("0.1"), "{error}");
    assert!(set_ramp(&mut s, id, &[(0.5, 1.0), (0.2, 2.0)]).is_err());
    let still = append(&mut s, 1, "i", 0, 30);
    assert!(set_ramp(&mut s, still, &[(0.0, 2.0)]).is_err());
}

#[test]
fn splits_and_trims_keep_a_ramp_where_it_plays() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 150);
    set_ramp(&mut s, id, &[(0.0, 0.5), (0.5, 2.0), (1.0, 0.5)]).unwrap();
    let before = frames(&s, id);
    let length = clip(&s, id).duration.0 / FRAME;
    let at = 40;
    let right = ClipId(
        s.execute(&Command::Split {
            at: f(at),
            clips: vec![id],
        })
        .unwrap()
        .created[0],
    );
    let mut after = frames(&s, id);
    after.extend(frames(&s, right));
    assert_eq!(after.len() as i64, length);
    for (k, (a, b)) in before.iter().zip(&after).enumerate() {
        assert!(
            (a - b).abs() <= 1,
            "frame {k}: {a} before the split, {b} after"
        );
    }
    // Trimming the start of the right part keeps its later frames.
    let right_frames = frames(&s, right);
    s.execute(&Command::Trim {
        clip: right,
        edge: Edge::Start,
        delta: f(10),
        ripple: false,
    })
    .unwrap();
    let trimmed = frames(&s, right);
    for (a, b) in right_frames[10..].iter().zip(&trimmed) {
        assert!((a - b).abs() <= 1);
    }
    let c = clip(&s, right);
    assert!(c
        .ramp
        .iter()
        .all(|p| p.time >= Flicks::ZERO && p.time <= c.duration));
}

#[test]
fn a_reversed_clip_plays_its_media_from_the_out_point_back() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 30, 60);
    s.execute(&Command::SetReverse {
        clip: id,
        reverse: true,
    })
    .unwrap();
    let c = clip(&s, id);
    assert_eq!((c.source_in, c.source_out()), (f(30), f(90)));
    let shown = frames(&s, id);
    assert_eq!(shown[0], 89);
    assert_eq!(shown[59], 30);
    assert!(shown.windows(2).all(|pair| pair[1] == pair[0] - 1));
    // Trimming its start drops the frames it showed first: the out point moves.
    s.execute(&Command::Trim {
        clip: id,
        edge: Edge::Start,
        delta: f(10),
        ripple: false,
    })
    .unwrap();
    let c = clip(&s, id);
    assert_eq!((c.source_in, c.source_out()), (f(30), f(80)));
    assert_eq!(frames(&s, id)[0], 79);
    // Lengthening its end shows earlier media: the in point moves.
    s.execute(&Command::Trim {
        clip: id,
        edge: Edge::End,
        delta: f(20),
        ripple: false,
    })
    .unwrap();
    let c = clip(&s, id);
    assert_eq!((c.source_in, c.source_out()), (f(10), f(80)));
    assert_eq!(*frames(&s, id).last().unwrap(), 10);
    // A split leaves two halves that play on from each other.
    let right = ClipId(
        s.execute(&Command::Split {
            at: f(50),
            clips: vec![id],
        })
        .unwrap()
        .created[0],
    );
    let (left, right) = (clip(&s, id), clip(&s, right));
    assert_eq!(left.source_in, right.source_out());
    assert_eq!(
        frames(&s, right.id)[0],
        frames(&s, left.id).last().unwrap() - 1
    );
    // At twice the speed it shows every other frame, still from the end.
    let fast = append(&mut s, 1, "v", 0, 40);
    s.execute(&Command::SetReverse {
        clip: fast,
        reverse: true,
    })
    .unwrap();
    s.execute(&Command::SetSpeed {
        clip: fast,
        speed: Speed::new(2, 1).unwrap(),
    })
    .unwrap();
    assert_eq!(&frames(&s, fast)[..3], &[39, 37, 35]);
    // Forwards again, it shows the same media from its start.
    s.execute(&Command::SetReverse {
        clip: fast,
        reverse: false,
    })
    .unwrap();
    assert_eq!(&frames(&s, fast)[..3], &[0, 2, 4]);
}

#[test]
fn a_freeze_frame_holds_the_frame_and_pushes_the_rest_along() {
    let mut s = session();
    let video = append(&mut s, 0, "v", 0, 90);
    let after = append(&mut s, 0, "v", 200, 30);
    let sound = detach_onto(&mut s, video, 1);
    let outcome = s
        .execute(&Command::FreezeFrame {
            clip: video,
            at: f(30),
            duration: f(60),
        })
        .unwrap();
    let frozen = ClipId(outcome.created[0]);
    let held = clip(&s, frozen);
    assert!(held.freeze && held.video && !held.audio);
    assert_eq!(
        (held.start, held.duration, held.source_in),
        (f(30), f(60), f(30))
    );
    assert!(frames(&s, frozen).iter().all(|&frame| frame == 30));
    // The clip splits there; the rest plays after the freeze, its sound too.
    assert_eq!(
        layout(&s, 0),
        vec![(0, 30, 0), (30, 60, 30), (90, 60, 30), (150, 30, 200)]
    );
    assert_eq!(clip(&s, after).start, f(150));
    let sounds = layout(&s, 1);
    assert_eq!(sounds, vec![(0, 30, 0), (90, 60, 30)]);
    let _ = sound;
    // A freeze frame has no speed, no direction and no sound.
    assert!(s
        .execute(&Command::SetSpeed {
            clip: frozen,
            speed: Speed::new(2, 1).unwrap(),
        })
        .is_err());
    assert!(s
        .execute(&Command::SetReverse {
            clip: frozen,
            reverse: true,
        })
        .is_err());
    // Trimming it changes how long it holds, not what it shows.
    s.execute(&Command::Trim {
        clip: frozen,
        edge: Edge::Start,
        delta: f(20),
        ripple: false,
    })
    .unwrap();
    assert_eq!(clip(&s, frozen).source_in, f(30));
    // On the magnetic main track the edit settles around it.
    let mut m = magnetic_session();
    let a = append(&mut m, 0, "v", 0, 60);
    let b = append(&mut m, 0, "v", 300, 30);
    m.execute(&Command::FreezeFrame {
        clip: a,
        at: f(20),
        duration: f(15),
    })
    .unwrap();
    assert_eq!(
        layout(&m, 0),
        vec![(0, 20, 0), (20, 15, 20), (35, 40, 20), (75, 30, 300)]
    );
    assert_eq!(clip(&m, b).start, f(75));
}

#[test]
fn a_freeze_frame_looks_as_the_clip_does_there() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 90);
    for (frames, value) in [(0, 0.0), (60, 1.0)] {
        s.execute(&Command::SetKeyframe {
            clip: id,
            property: "opacity".into(),
            time: f(frames),
            value: KeyValue::Number(value),
            interpolation: None,
        })
        .unwrap();
    }
    s.execute(&Command::SetReverse {
        clip: id,
        reverse: true,
    })
    .unwrap();
    let frozen = ClipId(
        s.execute(&Command::FreezeFrame {
            clip: id,
            at: f(30),
            duration: f(30),
        })
        .unwrap()
        .created[0],
    );
    let held = clip(&s, frozen);
    assert_eq!(held.opacity, 0.5);
    assert!(held.keyframes.is_empty());
    // Reversed, frame 30 of the clip shows source frame 59.
    assert_eq!(held.source_in.0.div_euclid(FRAME), 59);
}

fn rectangle() -> Mask {
    Mask {
        id: MaskId(0),
        shape: MaskShape::Rectangle,
        mode: MaskMode::Add,
        invert: false,
        x: 0.5,
        y: 0.5,
        width: 0.4,
        height: 0.3,
        rotation: 0.0,
        roundness: 0.2,
        feather: 0.02,
        expansion: 0.0,
        opacity: 1.0,
        points: Vec::new(),
    }
}

fn pen(points: usize) -> Mask {
    Mask {
        shape: MaskShape::Path,
        roundness: 0.0,
        points: (0..points)
            .map(|i| {
                let angle = i as f64 / points as f64 * std::f64::consts::TAU;
                MaskPoint {
                    x: angle.cos() / 2.0,
                    y: angle.sin() / 2.0,
                    out_x: 0.1,
                    in_x: -0.1,
                    ..MaskPoint::default()
                }
            })
            .collect(),
        ..rectangle()
    }
}

#[test]
fn masks_are_added_changed_animated_and_removed() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 90);
    let first = MaskId(
        s.execute(&Command::AddMask {
            clip: id,
            mask: rectangle(),
            index: None,
        })
        .unwrap()
        .created[0],
    );
    let second = MaskId(
        s.execute(&Command::AddMask {
            clip: id,
            mask: pen(5),
            index: Some(0),
        })
        .unwrap()
        .created[0],
    );
    let c = clip(&s, id);
    assert_eq!(
        c.masks.iter().map(|m| m.id).collect::<Vec<_>>(),
        [second, first]
    );
    // A mask's settings and points animate.
    for (frames, value) in [(0, 0.0), (30, 0.2)] {
        s.execute(&Command::SetKeyframe {
            clip: id,
            property: mask_property(first, "feather"),
            time: f(frames),
            value: KeyValue::Number(value),
            interpolation: None,
        })
        .unwrap();
    }
    s.execute(&Command::SetKeyframe {
        clip: id,
        property: mask_property(second, "point4.x"),
        time: f(0),
        value: KeyValue::Number(0.3),
        interpolation: None,
    })
    .unwrap();
    let at = clip(&s, id).masks_at(f(15));
    assert!((at[1].feather - 0.1).abs() < 1e-9);
    assert_eq!(at[0].points[4].x, 0.3);
    // Out of range, or a point the mask lacks: refused.
    for (property, value) in [
        (mask_property(first, "feather"), 0.9),
        (mask_property(second, "point9.x"), 0.1),
        (mask_property(MaskId(999), "x"), 0.1),
    ] {
        assert!(s
            .execute(&Command::SetKeyframe {
                clip: id,
                property,
                time: f(5),
                value: KeyValue::Number(value),
                interpolation: None,
            })
            .is_err());
    }
    // A path with fewer points drops the keyframes of the ones it lost.
    let mut fewer = pen(4);
    fewer.id = second;
    s.execute(&Command::SetMask {
        clip: id,
        mask: fewer,
    })
    .unwrap();
    assert!(!clip(&s, id)
        .keyframes
        .contains_key(&mask_property(second, "point4.x")));
    let mut bad = pen(2);
    bad.id = second;
    assert!(s
        .execute(&Command::SetMask {
            clip: id,
            mask: bad
        })
        .is_err());
    s.execute(&Command::MoveMask {
        clip: id,
        mask: first,
        index: 0,
    })
    .unwrap();
    assert_eq!(clip(&s, id).masks[0].id, first);
    s.execute(&Command::RemoveMask {
        clip: id,
        mask: first,
    })
    .unwrap();
    let c = clip(&s, id);
    assert_eq!(c.masks.len(), 1);
    assert!(c
        .keyframes
        .keys()
        .all(|name| property_mask(name) != Some(first)));
    // Adjustment layers and sound have no picture of their own to mask.
    let sound = append(&mut s, 1, "a", 0, 30);
    assert!(s
        .execute(&Command::AddMask {
            clip: sound,
            mask: rectangle(),
            index: None,
        })
        .is_err());
}

#[test]
fn split_and_pasted_masks_get_their_own_ids_and_keyframes() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 90);
    let mask = MaskId(
        s.execute(&Command::AddMask {
            clip: id,
            mask: rectangle(),
            index: None,
        })
        .unwrap()
        .created[0],
    );
    s.execute(&Command::SetKeyframe {
        clip: id,
        property: mask_property(mask, "x"),
        time: f(60),
        value: KeyValue::Number(0.8),
        interpolation: None,
    })
    .unwrap();
    let right = ClipId(
        s.execute(&Command::Split {
            at: f(30),
            clips: vec![id],
        })
        .unwrap()
        .created[0],
    );
    let r = clip(&s, right);
    assert_ne!(r.masks[0].id, mask);
    let key = &r.keyframes[&mask_property(r.masks[0].id, "x")];
    assert_eq!(key[0].time, f(30));
    // Pasting a copy brings its masks, renamed.
    let copy = ClipSpec {
        masks: r.masks.clone(),
        keyframes: r.keyframes.clone(),
        ..spec("v", 0, 30)
    };
    let pasted = ClipId(
        s.execute(&Command::Append {
            track: track_id(&s, 1),
            clip: copy,
        })
        .unwrap()
        .created[0],
    );
    let p = clip(&s, pasted);
    assert_eq!(p.masks.len(), 1);
    assert_ne!(p.masks[0].id, r.masks[0].id);
    assert!(p.keyframes.contains_key(&mask_property(p.masks[0].id, "x")));
}

#[test]
fn blend_modes_pitch_and_frame_blending_are_clip_settings() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 30);
    assert!(clip(&s, id).keep_pitch);
    s.execute(&Command::SetClipProperties {
        clip: id,
        properties: ClipProperties {
            blend_mode: Some(BlendMode::Screen),
            keep_pitch: Some(false),
            frame_blending: Some(true),
            ..ClipProperties::default()
        },
    })
    .unwrap();
    let c = clip(&s, id);
    assert_eq!(c.blend_mode, BlendMode::Screen);
    assert!(!c.keep_pitch && c.frame_blending);
    let layer = ClipId(
        s.execute(&Command::Append {
            track: track_id(&s, 1),
            clip: ClipSpec {
                kind: ClipKind::Adjustment,
                duration: f(30),
                ..Default::default()
            },
        })
        .unwrap()
        .created[0],
    );
    assert!(s
        .execute(&Command::SetClipProperties {
            clip: layer,
            properties: ClipProperties {
                blend_mode: Some(BlendMode::Multiply),
                ..ClipProperties::default()
            },
        })
        .is_err());
}

#[test]
fn format_6_saves_the_new_settings_and_opens_format_5() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 90);
    set_ramp(&mut s, id, &[(0.0, 1.0), (0.5, 2.0), (1.0, 1.0)]).unwrap();
    s.execute(&Command::SetReverse {
        clip: id,
        reverse: true,
    })
    .unwrap();
    s.execute(&Command::AddMask {
        clip: id,
        mask: pen(4),
        index: None,
    })
    .unwrap();
    s.execute(&Command::SetClipProperties {
        clip: id,
        properties: ClipProperties {
            blend_mode: Some(BlendMode::Overlay),
            keep_pitch: Some(false),
            ..ClipProperties::default()
        },
    })
    .unwrap();
    let text = file::to_json(s.project());
    assert!(text.contains("\"version\": 6"));
    for field in [
        "\"ramp\"",
        "\"reverse\": true",
        "\"keepPitch\": false",
        "\"overlay\"",
        "\"masks\"",
    ] {
        assert!(text.contains(field), "{field} is missing");
    }
    assert_eq!(&file::from_json(&text).unwrap(), s.project());
    // A format 5 project has none of them: its clips play as before.
    let plain = session();
    let mut old: serde_json::Value = serde_json::from_str(&file::to_json(plain.project())).unwrap();
    old["version"] = 5.into();
    let opened = file::from_json(&old.to_string()).unwrap();
    assert_eq!(&opened, plain.project());
}

/// A template slot: a placeholder title numbered `slot`, `frames` long, on track `index`.
fn placeholder(s: &mut Session, index: usize, slot: u32, frames: i64) -> ClipId {
    use cgv_model::title::{Shape, ShapeKind};
    let track = track_id(s, index);
    let title = Title {
        elements: vec![Element {
            id: ElementId(1),
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: 1.0,
            fill: Color {
                r: 0.2,
                g: 0.2,
                b: 0.2,
                a: 1.0,
            },
            stroke: None,
            shadow: None,
            content: Content::Shape(Shape {
                kind: ShapeKind::Rectangle,
                width: 1920.0,
                height: 1080.0,
                radius: 0.0,
                sides: 4,
                inner: 0.5,
            }),
        }],
    };
    let clip = ClipSpec {
        kind: ClipKind::Title,
        duration: f(frames),
        title: Some(title),
        slot: Some(slot),
        ..Default::default()
    };
    ClipId(s.execute(&Command::Append { track, clip }).unwrap().created[0])
}

#[test]
fn a_slot_takes_media_and_keeps_its_place_look_and_transitions() {
    let mut s = session();
    let slot = placeholder(&mut s, 0, 1, 90);
    let after = placeholder(&mut s, 0, 2, 60);
    s.execute(&Command::AddEffect {
        clip: slot,
        effect: EffectSpec {
            id: None,
            kind: "vignette".into(),
            pack: BUILTIN_PACK.into(),
            version: 1,
            enabled: true,
            params: Params::new(),
        },
        index: None,
        audio: false,
    })
    .unwrap();
    s.execute(&Command::AddTransition {
        track: track_id(&s, 0),
        from: Some(slot),
        to: Some(after),
        transition: TransitionSpec {
            kind: "cross-dissolve".into(),
            pack: BUILTIN_PACK.into(),
            version: 1,
            duration: f(10),
            alignment: None,
            params: Params::new(),
        },
    })
    .unwrap();
    s.execute(&Command::FillSlot {
        clip: slot,
        media: "v".into(),
        source_in: f(30),
    })
    .unwrap();
    let c = clip(&s, slot);
    assert_eq!(
        (c.kind, c.media.as_str(), c.slot),
        (ClipKind::Media, "v", Some(1))
    );
    assert_eq!((c.start, c.duration, c.source_in), (f(0), f(90), f(30)));
    assert!(c.video && !c.audio && c.title.is_none());
    assert_eq!(c.effects.len(), 1);
    let transitions = &s.project().tracks[0].transitions;
    assert_eq!(
        (transitions[0].from, transitions[0].to),
        (Some(slot), Some(after))
    );
    // A still fills any length.
    s.execute(&Command::FillSlot {
        clip: after,
        media: "i".into(),
        source_in: Flicks::ZERO,
    })
    .unwrap();
    assert_eq!(clip(&s, after).duration, f(60));
    // Sound or a clip that is no slot cannot fill one.
    assert!(s
        .execute(&Command::FillSlot {
            clip: slot,
            media: "a".into(),
            source_in: Flicks::ZERO,
        })
        .is_err());
}

#[test]
fn a_short_video_plays_to_its_end_and_holds_its_last_frame() {
    let mut s = session();
    s.execute(&Command::AddMedia {
        media: media("short", MediaKind::Video, 1),
    })
    .unwrap();
    let slot = placeholder(&mut s, 0, 1, 90);
    let next = placeholder(&mut s, 0, 2, 30);
    s.execute(&Command::AddTransition {
        track: track_id(&s, 0),
        from: Some(slot),
        to: Some(next),
        transition: TransitionSpec {
            kind: "cross-dissolve".into(),
            pack: BUILTIN_PACK.into(),
            version: 1,
            duration: f(10),
            alignment: None,
            params: Params::new(),
        },
    })
    .unwrap();
    let held = ClipId(
        s.execute(&Command::FillSlot {
            clip: slot,
            media: "short".into(),
            source_in: Flicks::ZERO,
        })
        .unwrap()
        .created[0],
    );
    // One second plays, then frame 29 holds for the other two.
    assert_eq!(layout(&s, 0), vec![(0, 30, 0), (30, 60, 29), (90, 30, 0)]);
    let h = clip(&s, held);
    assert!(h.freeze && h.slot == Some(1));
    // The slot's transition now leaves from the held frame.
    let t = &s.project().tracks[0].transitions[0];
    assert_eq!((t.from, t.to), (Some(held), Some(next)));
    // Filling it again with longer media makes it whole.
    s.execute(&Command::FillSlot {
        clip: slot,
        media: "v".into(),
        source_in: Flicks::ZERO,
    })
    .unwrap();
    assert_eq!(layout(&s, 0), vec![(0, 90, 0), (90, 30, 0)]);
    let t = &s.project().tracks[0].transitions[0];
    assert_eq!((t.from, t.to), (Some(slot), Some(next)));
}

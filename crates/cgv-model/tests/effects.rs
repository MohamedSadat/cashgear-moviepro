//! Effects, keyframes, transitions, adjustment layers and LUTs.
mod common;

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
    assert!(!error.starts_with("Internal"), "{error}");
    assert_eq!(
        session.project(),
        &before,
        "a failed command changed the project"
    );
}

fn effect(kind: &str) -> EffectSpec {
    EffectSpec {
        id: None,
        kind: kind.into(),
        pack: BUILTIN_PACK.into(),
        version: 1,
        enabled: true,
        params: Params::new(),
    }
}

fn add_effect(s: &mut Session, clip: ClipId, kind: &str) -> EffectId {
    EffectId(
        run(
            s,
            Command::AddEffect {
                clip,
                effect: effect(kind),
                index: None,
            },
        )
        .created[0],
    )
}

fn number(value: f64) -> KeyValue {
    KeyValue::Number(value)
}

fn key(s: &mut Session, clip: ClipId, property: &str, frames: i64, value: f64) {
    run(
        s,
        Command::SetKeyframe {
            clip,
            property: property.into(),
            time: f(frames),
            value: number(value),
            interpolation: None,
        },
    );
}

fn times(s: &Session, clip: ClipId, property: &str) -> Vec<i64> {
    common::clip(s, clip).keyframes[property]
        .iter()
        .map(|k| k.time.0 / FRAME)
        .collect()
}

fn dissolve(frames: i64) -> TransitionSpec {
    TransitionSpec {
        kind: "cross-dissolve".into(),
        pack: BUILTIN_PACK.into(),
        version: 1,
        duration: f(frames),
        alignment: None,
        params: Params::new(),
    }
}

fn transition(
    s: &mut Session,
    index: usize,
    from: Option<ClipId>,
    to: Option<ClipId>,
    frames: i64,
) -> TransitionId {
    let track = track_id(s, index);
    TransitionId(
        run(
            s,
            Command::AddTransition {
                track,
                from,
                to,
                transition: dissolve(frames),
            },
        )
        .created[0],
    )
}

/// (from, to, duration in frames) of each transition on track `index`.
fn transitions(s: &Session, index: usize) -> Vec<(Option<ClipId>, Option<ClipId>, i64)> {
    s.project().tracks[index]
        .transitions
        .iter()
        .map(|t| (t.from, t.to, t.duration.0 / FRAME))
        .collect()
}

// ---- Effects ---------------------------------------------------------------------------

#[test]
fn effects_are_added_reordered_switched_changed_and_removed() {
    let mut s = session();
    let clip = append(&mut s, 0, "v", 0, 60);
    let blur = add_effect(&mut s, clip, "gaussian-blur");
    let vignette = add_effect(&mut s, clip, "vignette");
    let first = EffectId(
        run(
            &mut s,
            Command::AddEffect {
                clip,
                effect: effect("exposure"),
                index: Some(0),
            },
        )
        .created[0],
    );
    let order = |s: &Session| -> Vec<EffectId> {
        common::clip(s, clip).effects.iter().map(|e| e.id).collect()
    };
    assert_eq!(order(&s), [first, blur, vignette]);
    run(
        &mut s,
        Command::MoveEffect {
            clip,
            effect: first,
            index: 2,
        },
    );
    assert_eq!(order(&s), [blur, vignette, first]);
    run(
        &mut s,
        Command::SetEffectEnabled {
            clip,
            effect: blur,
            enabled: false,
        },
    );
    assert!(!common::clip(&s, clip).effects[0].enabled);
    run(
        &mut s,
        Command::SetEffectParams {
            clip,
            effect: blur,
            params: [("radius".to_string(), ParamValue::Number(0.02))].into(),
        },
    );
    run(
        &mut s,
        Command::SetEffectParams {
            clip,
            effect: blur,
            params: [("edges".to_string(), ParamValue::Text("mirror".into()))].into(),
        },
    );
    let params = &common::clip(&s, clip).effects[0].params;
    assert_eq!(
        params["radius"],
        ParamValue::Number(0.02),
        "a patch keeps the rest"
    );
    assert_eq!(params["edges"], ParamValue::Text("mirror".into()));
    key(&mut s, clip, &effect_property(blur, "radius"), 0, 0.0);
    key(&mut s, clip, &effect_property(vignette, "amount"), 0, 0.5);
    run(
        &mut s,
        Command::ResetEffect {
            clip,
            effect: blur,
            params: Params::new(),
        },
    );
    let reset = common::clip(&s, clip);
    assert!(reset.effects[0].params.is_empty());
    assert!(!reset
        .keyframes
        .contains_key(&effect_property(blur, "radius")));
    assert!(reset
        .keyframes
        .contains_key(&effect_property(vignette, "amount")));
    run(
        &mut s,
        Command::RemoveEffect {
            clip,
            effect: vignette,
        },
    );
    let removed = common::clip(&s, clip);
    assert_eq!(order(&s), [blur, first]);
    assert!(removed.keyframes.is_empty(), "its keyframes go with it");
    let undone = s.undo();
    assert!(undone && order(&s) == [blur, vignette, first]);
}

#[test]
fn effects_need_a_picture_valid_names_and_an_unlocked_track() {
    let mut s = session();
    let sound = append(&mut s, 0, "a", 0, 30);
    let video = append(&mut s, 1, "v", 0, 30);
    fails(
        &mut s,
        Command::AddEffect {
            clip: sound,
            effect: effect("vignette"),
            index: None,
        },
        "no picture",
    );
    fails(
        &mut s,
        Command::AddEffect {
            clip: video,
            effect: effect("Not A Slug"),
            index: None,
        },
        "not an effect name",
    );
    fails(
        &mut s,
        Command::AddEffect {
            clip: video,
            effect: effect("vignette"),
            index: Some(3),
        },
        "no effect position",
    );
    let vignette = add_effect(&mut s, video, "vignette");
    fails(
        &mut s,
        Command::SetEffectParams {
            clip: video,
            effect: vignette,
            params: [("amount".to_string(), ParamValue::Number(f64::NAN))].into(),
        },
        "finite",
    );
    fails(
        &mut s,
        Command::RemoveEffect {
            clip: video,
            effect: EffectId(999),
        },
        "no effect 999",
    );
    let track = track_id(&s, 1);
    run(
        &mut s,
        Command::SetTrackLocked {
            track,
            locked: true,
        },
    );
    fails(
        &mut s,
        Command::SetEffectEnabled {
            clip: video,
            effect: vignette,
            enabled: false,
        },
        "locked",
    );
}

#[test]
fn split_halves_have_their_own_effects_and_pasted_copies_keep_their_animation() {
    let mut s = session();
    let clip = append(&mut s, 0, "v", 0, 60);
    let blur = add_effect(&mut s, clip, "gaussian-blur");
    key(&mut s, clip, &effect_property(blur, "radius"), 40, 0.1);
    let right = ClipId(
        run(
            &mut s,
            Command::Split {
                at: f(30),
                clips: vec![clip],
            },
        )
        .created[0],
    );
    let right_clip = common::clip(&s, right);
    let right_blur = right_clip.effects[0].id;
    assert_ne!(right_blur, blur);
    assert_eq!(
        times(&s, right, &effect_property(right_blur, "radius")),
        [10]
    );
    assert_eq!(times(&s, clip, &effect_property(blur, "radius")), [40]);

    // A copy carries its effects; their keyframes follow the new ids.
    let original = common::clip(&s, clip);
    let copy = ClipSpec {
        effects: original.effects.iter().map(EffectSpec::from).collect(),
        keyframes: original.keyframes.clone(),
        ..spec("v", 0, 30)
    };
    let track = track_id(&s, 1);
    let pasted = ClipId(run(&mut s, Command::Append { track, clip: copy }).created[0]);
    let pasted_clip = common::clip(&s, pasted);
    let pasted_blur = pasted_clip.effects[0].id;
    assert!(![blur, right_blur].contains(&pasted_blur));
    assert_eq!(
        times(&s, pasted, &effect_property(pasted_blur, "radius")),
        [40]
    );
    let orphan = ClipSpec {
        keyframes: original.keyframes.clone(),
        ..spec("v", 0, 30)
    };
    fails(
        &mut s,
        Command::Append {
            track,
            clip: orphan,
        },
        "lacks",
    );
}

// ---- Keyframes -------------------------------------------------------------------------

#[test]
fn keyframes_are_set_replaced_moved_eased_and_removed() {
    let mut s = session();
    let clip = append(&mut s, 0, "v", 0, 90);
    key(&mut s, clip, "opacity", 0, 0.0);
    key(&mut s, clip, "opacity", 30, 1.0);
    let c = common::clip(&s, clip);
    assert_eq!(c.opacity_at(f(15)), 0.5);
    assert_eq!(c.opacity_at(f(60)), 1.0, "the last value holds");
    // Times snap to frames; a key at the same time replaces the old one.
    run(
        &mut s,
        Command::SetKeyframe {
            clip,
            property: "opacity".into(),
            time: Flicks(30 * FRAME + 5),
            value: number(0.8),
            interpolation: Some(Interpolation::Hold),
        },
    );
    assert_eq!(times(&s, clip, "opacity"), [0, 30]);
    assert_eq!(common::clip(&s, clip).opacity_at(f(30)), 0.8);
    run(
        &mut s,
        Command::SetInterpolation {
            clip,
            property: "opacity".into(),
            times: vec![f(0)],
            interpolation: Interpolation::EaseIn,
        },
    );
    assert!(common::clip(&s, clip).opacity_at(f(15)) < 0.4);
    key(&mut s, clip, "transform.x", 10, 100.0);
    // Moving the keys at frame 0 and 10 of every property by 5 frames.
    run(
        &mut s,
        Command::MoveKeyframes {
            clip,
            properties: Vec::new(),
            times: vec![f(0), f(10)],
            delta: f(5),
        },
    );
    assert_eq!(times(&s, clip, "opacity"), [5, 30]);
    assert_eq!(times(&s, clip, "transform.x"), [15]);
    // A key moved onto another replaces it.
    run(
        &mut s,
        Command::MoveKeyframes {
            clip,
            properties: vec!["opacity".into()],
            times: vec![f(5)],
            delta: f(25),
        },
    );
    let keys = &common::clip(&s, clip).keyframes["opacity"];
    assert_eq!(keys.len(), 1);
    assert_eq!((keys[0].time, keys[0].value), (f(30), number(0.0)));
    run(
        &mut s,
        Command::RemoveKeyframes {
            clip,
            property: "transform.x".into(),
            times: vec![f(15)],
        },
    );
    assert!(!common::clip(&s, clip).keyframes.contains_key("transform.x"));
}

#[test]
fn a_property_s_keyframes_can_be_replaced_at_once() {
    let mut s = session();
    let clip = append(&mut s, 0, "v", 0, 90);
    key(&mut s, clip, "opacity", 0, 0.0);
    let key_at = |frames: i64, value: f64, interpolation| Keyframe {
        time: Flicks(frames * FRAME + 3),
        value: number(value),
        interpolation,
    };
    run(
        &mut s,
        Command::SetKeyframes {
            clip,
            property: "opacity".into(),
            keys: vec![
                key_at(20, 1.0, Interpolation::Linear),
                key_at(5, 0.2, Interpolation::EaseOut),
                key_at(20, 0.9, Interpolation::Hold),
            ],
        },
    );
    let keys = &common::clip(&s, clip).keyframes["opacity"];
    assert_eq!(times(&s, clip, "opacity"), [5, 20], "sorted and snapped");
    assert_eq!(keys[1].value, number(0.9), "the last key on a frame wins");
    fails(
        &mut s,
        Command::SetKeyframes {
            clip,
            property: "opacity".into(),
            keys: vec![key_at(0, 3.0, Interpolation::Linear)],
        },
        "out of range",
    );
    run(
        &mut s,
        Command::SetKeyframes {
            clip,
            property: "opacity".into(),
            keys: Vec::new(),
        },
    );
    assert!(common::clip(&s, clip).keyframes.is_empty());
}

#[test]
fn a_batch_sets_several_keyframes_as_one_step() {
    let mut s = session();
    let clip = append(&mut s, 0, "v", 0, 90);
    let scale = |property: &str| Command::SetKeyframe {
        clip,
        property: property.into(),
        time: f(10),
        value: number(2.0),
        interpolation: None,
    };
    run(
        &mut s,
        Command::Batch {
            commands: vec![scale("transform.scaleX"), scale("transform.scaleY")],
        },
    );
    let c = common::clip(&s, clip);
    assert_eq!(c.transform_at(f(10)).scale_y, 2.0);
    assert_eq!(s.undo_label(), Some("Set keyframe"));
    assert!(s.undo());
    assert!(common::clip(&s, clip).keyframes.is_empty(), "one undo step");
    fails(
        &mut s,
        Command::Batch {
            commands: vec![
                scale("transform.scaleX"),
                Command::Delete { clips: vec![clip] },
            ],
        },
        "can't run in a batch",
    );
    fails(
        &mut s,
        Command::Batch {
            commands: vec![scale("transform.scaleX"), scale("transform.bogus")],
        },
        "not a property",
    );
}

#[test]
fn stopping_an_animation_keeps_the_value_at_the_playhead() {
    let mut s = session();
    let clip = append(&mut s, 0, "v", 0, 90);
    key(&mut s, clip, "transform.rotation", 0, 0.0);
    key(&mut s, clip, "transform.rotation", 20, 90.0);
    run(
        &mut s,
        Command::ClearKeyframes {
            clip,
            property: "transform.rotation".into(),
            at: Some(f(10)),
        },
    );
    let c = common::clip(&s, clip);
    assert!(c.keyframes.is_empty());
    assert_eq!(c.transform.rotation, 45.0);
    let blur = add_effect(&mut s, clip, "gaussian-blur");
    let name = effect_property(blur, "radius");
    key(&mut s, clip, &name, 0, 0.0);
    key(&mut s, clip, &name, 10, 0.4);
    run(
        &mut s,
        Command::ClearKeyframes {
            clip,
            property: name,
            at: Some(f(5)),
        },
    );
    let params = &common::clip(&s, clip).effects[0].params;
    assert!(matches!(params["radius"], ParamValue::Number(v) if (v - 0.2).abs() < 1e-12));
}

#[test]
fn keyframes_name_real_properties_with_values_in_range() {
    let mut s = session();
    let clip = append(&mut s, 0, "v", 0, 90);
    let sound = append(&mut s, 1, "a", 0, 90);
    let set = |property: &str, value: KeyValue| Command::SetKeyframe {
        clip,
        property: property.into(),
        time: f(0),
        value,
        interpolation: None,
    };
    fails(
        &mut s,
        set("transform.scale", number(1.0)),
        "not a property",
    );
    fails(&mut s, set("opacity", number(1.5)), "out of range");
    fails(&mut s, set("transform.scaleX", number(0.0)), "out of range");
    fails(
        &mut s,
        set("effects.99.radius", number(0.0)),
        "no effect 99",
    );
    fails(
        &mut s,
        set(
            "opacity",
            KeyValue::Color(Color {
                r: 1.0,
                g: 1.0,
                b: 1.0,
                a: 1.0,
            }),
        ),
        "mix colours and numbers",
    );
    fails(
        &mut s,
        Command::SetKeyframe {
            clip: sound,
            property: "opacity".into(),
            time: f(0),
            value: number(0.5),
            interpolation: None,
        },
        "no picture",
    );
    run(
        &mut s,
        Command::SetKeyframe {
            clip: sound,
            property: "volumeDb".into(),
            time: f(0),
            value: number(-12.0),
            interpolation: None,
        },
    );
    let bad_curve = Command::SetKeyframe {
        clip,
        property: "opacity".into(),
        time: f(0),
        value: number(0.5),
        interpolation: Some(Interpolation::Bezier {
            x1: -1.0,
            y1: 0.0,
            x2: 1.0,
            y2: 1.0,
        }),
    };
    fails(&mut s, bad_curve, "Curve handles");
}

#[test]
fn trimming_the_start_keeps_keyframes_on_their_frames_and_detaching_moves_volume() {
    let mut s = session();
    let clip = append(&mut s, 0, "v", 0, 90);
    key(&mut s, clip, "opacity", 30, 0.5);
    key(&mut s, clip, "volumeDb", 30, -6.0);
    run(
        &mut s,
        Command::Trim {
            clip,
            edge: Edge::Start,
            delta: f(10),
            ripple: false,
        },
    );
    assert_eq!(times(&s, clip, "opacity"), [20]);
    run(
        &mut s,
        Command::Trim {
            clip,
            edge: Edge::Start,
            delta: f(5),
            ripple: true,
        },
    );
    assert_eq!(times(&s, clip, "opacity"), [15]);
    let sound = detach_onto(&mut s, clip, 1);
    let picture = common::clip(&s, clip);
    let detached = common::clip(&s, sound);
    assert!(picture.keyframes.contains_key("opacity"));
    assert!(!picture.keyframes.contains_key("volumeDb"));
    assert_eq!(times(&s, sound, "volumeDb"), [15]);
    assert!(!detached.keyframes.contains_key("opacity"));
}

// ---- Transitions -----------------------------------------------------------------------

#[test]
fn transitions_sit_on_cuts_and_free_edges() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 60);
    let b = append(&mut s, 0, "v", 100, 60);
    let cut = transition(&mut s, 0, Some(a), Some(b), 30);
    let t = &s.project().tracks[0].transitions[0];
    assert_eq!(t.alignment, Alignment::Center);
    assert_eq!(t.window(f(60), f(1)), (f(45), f(75)));
    let fade_in = transition(&mut s, 0, None, Some(a), 15);
    let fade_out = transition(&mut s, 0, Some(b), None, 20);
    assert_eq!(
        transitions(&s, 0),
        [
            (None, Some(a), 15),
            (Some(a), Some(b), 30),
            (Some(b), None, 20)
        ]
    );
    let edges: Vec<Alignment> = s.project().tracks[0]
        .transitions
        .iter()
        .map(|t| t.alignment)
        .collect();
    assert_eq!(edges, [Alignment::Start, Alignment::Center, Alignment::End]);
    // A transition at the same cut replaces the one there.
    let wipe = transition(&mut s, 0, Some(a), Some(b), 10);
    assert_eq!(transitions(&s, 0)[1], (Some(a), Some(b), 10));
    assert!(s.project().tracks[0]
        .transitions
        .iter()
        .all(|t| t.id != cut));
    run(
        &mut s,
        Command::SetTransition {
            transition: wipe,
            duration: Some(f(40)),
            alignment: Some(Alignment::End),
            params: Some([("softness".to_string(), ParamValue::Number(0.3))].into()),
        },
    );
    let changed = &s.project().tracks[0].transitions[1];
    assert_eq!(
        (changed.duration, changed.alignment),
        (f(40), Alignment::End)
    );
    assert_eq!(changed.params["softness"], ParamValue::Number(0.3));
    run(
        &mut s,
        Command::RemoveTransition {
            transition: fade_in,
        },
    );
    run(
        &mut s,
        Command::RemoveTransition {
            transition: fade_out,
        },
    );
    assert_eq!(transitions(&s, 0), [(Some(a), Some(b), 40)]);
}

#[test]
fn transitions_need_touching_picture_clips_and_room() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let track = track_id(&s, 0);
    let gap = ClipId(
        run(
            &mut s,
            Command::Overwrite {
                track,
                at: f(40),
                clip: spec("v", 0, 30),
            },
        )
        .created[0],
    );
    let sound = append(&mut s, 1, "a", 0, 30);
    let add = |from, to, frames| Command::AddTransition {
        track,
        from,
        to,
        transition: dissolve(frames),
    };
    fails(&mut s, add(Some(a), Some(gap), 10), "do not touch");
    fails(&mut s, add(None, None, 10), "needs a clip");
    fails(&mut s, add(Some(a), None, 0), "at least one frame");
    fails(&mut s, add(Some(sound), None, 10), "not on");
    let sound_track = track_id(&s, 1);
    fails(
        &mut s,
        Command::AddTransition {
            track: sound_track,
            from: Some(sound),
            to: None,
            transition: dissolve(10),
        },
        "no picture",
    );
    // Too long for its clip: it gets as long as the clip allows.
    transition(&mut s, 0, Some(a), None, 50);
    assert_eq!(transitions(&s, 0), [(Some(a), None, 30)]);
}

#[test]
fn a_centred_transition_shares_its_clips_with_their_other_transitions() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 20);
    let b = append(&mut s, 0, "v", 20, 20);
    let c = append(&mut s, 0, "v", 40, 20);
    transition(&mut s, 0, Some(a), Some(b), 30);
    // 30 frames centred needs 15 before the cut and 15 after: a has 20, b has 20.
    assert_eq!(transitions(&s, 0), [(Some(a), Some(b), 30)]);
    transition(&mut s, 0, Some(b), Some(c), 30);
    // b has 5 frames left before the second cut: 2 · 5 + 1 = 11 frames fit.
    assert_eq!(
        transitions(&s, 0),
        [(Some(a), Some(b), 30), (Some(b), Some(c), 11)]
    );
    validate(s.project()).unwrap();
    // Shortening b shrinks the later transition first.
    run(
        &mut s,
        Command::Trim {
            clip: b,
            edge: Edge::End,
            delta: f(-2),
            ripple: true,
        },
    );
    assert_eq!(
        transitions(&s, 0),
        [(Some(a), Some(b), 30), (Some(b), Some(c), 7)]
    );
}

#[test]
fn transitions_follow_their_clips_and_go_when_the_clips_part() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 60);
    let b = append(&mut s, 0, "v", 100, 60);
    transition(&mut s, 0, Some(a), Some(b), 20);
    // Splitting the second clip leaves the transition at its start.
    run(
        &mut s,
        Command::Split {
            at: f(90),
            clips: vec![b],
        },
    );
    assert_eq!(transitions(&s, 0), [(Some(a), Some(b), 20)]);
    // Splitting the first moves the transition to the right half's end.
    let right = ClipId(
        run(
            &mut s,
            Command::Split {
                at: f(30),
                clips: vec![a],
            },
        )
        .created[0],
    );
    assert_eq!(transitions(&s, 0), [(Some(right), Some(b), 20)]);
    // Moving both clips to another track takes the transition along.
    run(
        &mut s,
        Command::Move {
            clips: vec![right, b],
            delta: f(0),
            tracks: 1,
            overwrite: false,
        },
    );
    assert!(transitions(&s, 0).is_empty());
    assert_eq!(transitions(&s, 1), [(Some(right), Some(b), 20)]);
    // Moving one of them apart drops it.
    run(
        &mut s,
        Command::Move {
            clips: vec![b],
            delta: f(10),
            tracks: 0,
            overwrite: false,
        },
    );
    assert!(transitions(&s, 1).is_empty());
    assert!(s.undo());
    assert_eq!(transitions(&s, 1), [(Some(right), Some(b), 20)]);
    run(&mut s, Command::Delete { clips: vec![b] });
    assert!(transitions(&s, 1).is_empty());
}

#[test]
fn a_free_edge_transition_joins_a_clip_that_comes_to_touch_it() {
    let mut s = magnetic_session();
    let main = track_id(&s, 0);
    let a = append(&mut s, 0, "v", 0, 60);
    transition(&mut s, 0, None, Some(a), 15);
    assert_eq!(transitions(&s, 0), [(None, Some(a), 15)]);
    // Inserting at the start of the magnetic main track puts a clip before it.
    let first = ClipId(
        run(
            &mut s,
            Command::Insert {
                track: main,
                at: f(0),
                clip: spec("v", 100, 30),
            },
        )
        .created[0],
    );
    assert_eq!(transitions(&s, 0), [(Some(first), Some(a), 15)]);
    let t = &s.project().tracks[0].transitions[0];
    assert_eq!(
        t.alignment,
        Alignment::Start,
        "it stays where it was on the clip"
    );
}

// ---- Adjustment layers -----------------------------------------------------------------

#[test]
fn adjustment_layers_are_clips_without_media_that_carry_effects() {
    let mut s = session();
    let track = track_id(&s, 1);
    let adjustment = ClipSpec {
        kind: ClipKind::Adjustment,
        duration: f(90),
        ..Default::default()
    };
    let layer = ClipId(
        run(
            &mut s,
            Command::Append {
                track,
                clip: adjustment.clone(),
            },
        )
        .created[0],
    );
    let c = common::clip(&s, layer);
    assert!(c.is_adjustment() && c.media.is_empty() && c.video && !c.audio);
    add_effect(&mut s, layer, "saturation");
    key(&mut s, layer, "opacity", 0, 0.0);
    run(
        &mut s,
        Command::Split {
            at: f(30),
            clips: vec![layer],
        },
    );
    fails(
        &mut s,
        Command::SetSpeed {
            clip: layer,
            speed: Speed { num: 2, den: 1 },
        },
        "Adjustment layers have no speed",
    );
    fails(
        &mut s,
        Command::Slip {
            clip: layer,
            delta: f(5),
        },
        "nothing to slip",
    );
    fails(
        &mut s,
        Command::DetachAudio {
            clip: layer,
            track: None,
        },
        "own sound",
    );
    fails(
        &mut s,
        Command::AddTransition {
            track,
            from: Some(layer),
            to: None,
            transition: dissolve(10),
        },
        "opacity",
    );
    fails(
        &mut s,
        Command::Append {
            track,
            clip: ClipSpec {
                media: "v".into(),
                ..adjustment.clone()
            },
        },
        "no media",
    );
    fails(
        &mut s,
        Command::Append {
            track,
            clip: ClipSpec {
                audio: Some(true),
                ..adjustment
            },
        },
        "only the picture",
    );
    let text = file::to_json(s.project());
    assert_eq!(&file::from_json(&text).unwrap(), s.project());
    assert!(text.contains("\"kind\": \"adjustment\""));
}

// ---- LUTs ------------------------------------------------------------------------------

fn cube() -> String {
    let mut text = String::from("LUT_3D_SIZE 2\n");
    for b in 0..2 {
        for g in 0..2 {
            for r in 0..2 {
                text.push_str(&format!("{r} {g} {b}\n"));
            }
        }
    }
    text
}

#[test]
fn luts_travel_in_the_project_and_stay_while_used() {
    let mut s = session();
    let clip = append(&mut s, 0, "v", 0, 30);
    let spec = lut::parse_cube("Warm.cube", &cube()).unwrap();
    let id = LutId(run(&mut s, Command::AddLut { lut: spec.clone() }).created[0]);
    let lut = s.project().lut(id).unwrap();
    assert_eq!((lut.name.as_str(), lut.size), ("Warm.cube", 2));
    assert_eq!(lut.values().len(), 24);
    let effect_id = add_effect(&mut s, clip, "lut");
    run(
        &mut s,
        Command::SetEffectParams {
            clip,
            effect: effect_id,
            params: [("lut".to_string(), ParamValue::Text(lut_ref(id)))].into(),
        },
    );
    fails(&mut s, Command::RemoveLut { lut: id }, "used by an effect");
    // The UI's snapshot names the LUT without its data.
    let snapshot = serde_json::to_value(s.snapshot()).unwrap();
    let listed = &snapshot["project"]["luts"][0];
    assert_eq!(listed["name"], "Warm.cube");
    assert!(listed.get("data").is_none());
    let text = file::to_json(s.project());
    assert!(text.contains(&spec.data));
    assert_eq!(&file::from_json(&text).unwrap(), s.project());
    run(
        &mut s,
        Command::RemoveEffect {
            clip,
            effect: effect_id,
        },
    );
    run(&mut s, Command::RemoveLut { lut: id });
    assert!(s.project().luts.is_empty());
    let broken = LutSpec {
        data: "AAAA".into(),
        ..spec
    };
    fails(
        &mut s,
        Command::AddLut { lut: broken },
        "does not match its size",
    );
}

//! Sound settings: track volume, pan, solo, roles and ducking, and clip fades,
//! noise reduction and sound effects.
mod common;

use cgv_model::*;
use cgv_time::Flicks;
use common::*;

fn fades(s: &Session, id: ClipId) -> (i64, i64) {
    let c = clip(s, id);
    (c.fade_in.0 / f(1).0, c.fade_out.0 / f(1).0)
}

fn set_fades(s: &mut Session, clip: ClipId, fade_in: i64, fade_out: i64) -> Result<(), String> {
    s.execute(&Command::SetClipProperties {
        clip,
        properties: ClipProperties {
            fade_in: Some(f(fade_in)),
            fade_out: Some(f(fade_out)),
            ..ClipProperties::default()
        },
    })
    .map(|_| ())
}

fn sound_effect(kind: &str) -> EffectSpec {
    EffectSpec {
        id: None,
        kind: kind.into(),
        pack: BUILTIN_PACK.into(),
        version: 1,
        enabled: true,
        params: Params::new(),
    }
}

#[test]
fn fades_fit_their_clip_and_stay_at_its_outer_edges() {
    let mut s = session();
    let music = append(&mut s, 1, "a", 0, 300);
    set_fades(&mut s, music, 30, 60).unwrap();
    assert_eq!(fades(&s, music), (30, 60));
    let error = set_fades(&mut s, music, 200, 101).unwrap_err();
    assert!(error.contains("Fades fit inside the clip"), "{error}");
    // A split keeps each fade on its own outer edge.
    let outcome = s
        .execute(&Command::Split {
            at: f(100),
            clips: vec![music],
        })
        .unwrap();
    let right = ClipId(outcome.created[0]);
    assert_eq!(fades(&s, music), (30, 0));
    assert_eq!(fades(&s, right), (0, 60));
    // Trimming the right part shorter than its fade shortens the fade.
    s.execute(&Command::Trim {
        clip: right,
        edge: Edge::Start,
        delta: f(170),
        ripple: false,
    })
    .unwrap();
    assert_eq!(clip(&s, right).duration, f(30));
    assert_eq!(fades(&s, right), (0, 30));
    // Undo gives the fade back exactly.
    assert!(s.undo());
    assert_eq!(fades(&s, right), (0, 60));
}

#[test]
fn sound_settings_go_with_detached_sound_and_clips_without_sound_refuse_them() {
    let mut s = session();
    let video = append(&mut s, 0, "v", 0, 90);
    set_fades(&mut s, video, 10, 20).unwrap();
    s.execute(&Command::SetClipProperties {
        clip: video,
        properties: ClipProperties {
            denoise: Some(0.8),
            ..ClipProperties::default()
        },
    })
    .unwrap();
    s.execute(&Command::AddEffect {
        clip: video,
        effect: sound_effect("reverb"),
        index: None,
        audio: true,
    })
    .unwrap();
    let sound = detach_onto(&mut s, video, 1);
    let picture = clip(&s, video);
    assert!(!picture.has_sound_settings());
    let detached = clip(&s, sound);
    assert_eq!(fades(&s, sound), (10, 20));
    assert_eq!(detached.denoise, 0.8);
    assert_eq!(detached.audio_effects.len(), 1);
    // The picture alone takes no fades or sound effects.
    assert!(set_fades(&mut s, video, 5, 0)
        .unwrap_err()
        .contains("no sound"));
    let error = s
        .execute(&Command::AddEffect {
            clip: video,
            effect: sound_effect("reverb"),
            index: None,
            audio: true,
        })
        .unwrap_err();
    assert!(error.contains("no sound for effects"), "{error}");
    let still = append(&mut s, 0, "i", 0, 30);
    assert!(set_fades(&mut s, still, 5, 0)
        .unwrap_err()
        .contains("no sound"));
    let out_of_range = s.execute(&Command::SetClipProperties {
        clip: sound,
        properties: ClipProperties {
            denoise: Some(1.5),
            ..ClipProperties::default()
        },
    });
    assert!(out_of_range.unwrap_err().contains("Noise reduction"));
}

#[test]
fn sound_effects_have_their_own_list_and_the_effect_commands_find_them() {
    let mut s = session();
    let video = append(&mut s, 0, "v", 0, 90);
    let add = |s: &mut Session, kind: &str, audio: bool| {
        EffectId(
            s.execute(&Command::AddEffect {
                clip: video,
                effect: sound_effect(kind),
                index: None,
                audio,
            })
            .unwrap()
            .created[0],
        )
    };
    let blur = add(&mut s, "gaussian-blur", false);
    let eq = add(&mut s, "equalizer", true);
    let reverb = add(&mut s, "reverb", true);
    let c = clip(&s, video);
    assert_eq!(
        c.effects.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![blur]
    );
    assert_eq!(
        c.audio_effects.iter().map(|e| e.id).collect::<Vec<_>>(),
        vec![eq, reverb]
    );
    s.execute(&Command::MoveEffect {
        clip: video,
        effect: reverb,
        index: 0,
    })
    .unwrap();
    s.execute(&Command::SetEffectEnabled {
        clip: video,
        effect: eq,
        enabled: false,
    })
    .unwrap();
    s.execute(&Command::SetEffectParams {
        clip: video,
        effect: reverb,
        params: [("mix".to_string(), ParamValue::Number(0.4))].into(),
    })
    .unwrap();
    let c = clip(&s, video);
    assert_eq!(c.audio_effects[0].id, reverb);
    assert_eq!(c.audio_effects[0].params["mix"], ParamValue::Number(0.4));
    assert!(!c.audio_effects[1].enabled);
    s.execute(&Command::RemoveEffect {
        clip: video,
        effect: reverb,
    })
    .unwrap();
    assert_eq!(clip(&s, video).audio_effects.len(), 1);
    // A split gives the right part's sound effects new ids.
    let right = ClipId(
        s.execute(&Command::Split {
            at: f(30),
            clips: vec![video],
        })
        .unwrap()
        .created[0],
    );
    let (left, right) = (clip(&s, video), clip(&s, right));
    assert_eq!(left.audio_effects[0].kind, right.audio_effects[0].kind);
    assert_ne!(left.audio_effects[0].id, right.audio_effects[0].id);
    // Pasted copies bring their sound effects, with new ids.
    let copy = ClipSpec {
        audio_effects: vec![sound_effect("compressor")],
        ..spec("a", 0, 30)
    };
    let pasted = s
        .execute(&Command::Append {
            track: track_id(&s, 1),
            clip: copy,
        })
        .unwrap();
    let pasted = clip(&s, ClipId(pasted.created[0]));
    assert_eq!(pasted.audio_effects[0].kind, "compressor");
}

#[test]
fn tracks_take_volume_pan_solo_roles_and_ducking_as_one_step_each() {
    let mut s = session();
    let track = track_id(&s, 1);
    let set =
        |s: &mut Session, sound: TrackSound| s.execute(&Command::SetTrackSound { track, sound });
    set(
        &mut s,
        TrackSound {
            volume_db: Some(-6.0),
            pan: Some(-0.5),
            role: Some(TrackRole::Music),
            ..TrackSound::default()
        },
    )
    .unwrap();
    set(
        &mut s,
        TrackSound {
            solo: Some(true),
            ducking: Some(Ducking {
                amount_db: 18.0,
                ..Ducking::default()
            }),
            ..TrackSound::default()
        },
    )
    .unwrap();
    let t = s.project().track(track).unwrap().clone();
    assert_eq!(
        (t.volume_db, t.pan, t.solo, t.role),
        (-6.0, -0.5, true, TrackRole::Music)
    );
    assert_eq!(t.ducking.amount_db, 18.0);
    assert!(set(
        &mut s,
        TrackSound {
            pan: Some(1.5),
            ..TrackSound::default()
        }
    )
    .unwrap_err()
    .contains("Pan"));
    assert!(set(
        &mut s,
        TrackSound {
            volume_db: Some(40.0),
            ..TrackSound::default()
        }
    )
    .unwrap_err()
    .contains("Volume"));
    let bad = Ducking {
        attack: -1.0,
        ..Ducking::default()
    };
    assert!(set(
        &mut s,
        TrackSound {
            ducking: Some(bad),
            ..TrackSound::default()
        }
    )
    .unwrap_err()
    .contains("Ducking"));
    let labels = [
        Command::SetTrackSound {
            track,
            sound: TrackSound {
                solo: Some(true),
                ..TrackSound::default()
            },
        }
        .label(),
        Command::SetTrackSound {
            track,
            sound: TrackSound {
                role: Some(TrackRole::Dialogue),
                ..TrackSound::default()
            },
        }
        .label(),
    ];
    assert_eq!(labels, ["Solo track", "Change track role"]);
    assert!(s.undo());
    assert!(!s.project().track(track).unwrap().solo);
}

#[test]
fn sound_settings_round_trip_and_format_4_files_open_unchanged() {
    let mut s = session();
    let music = append(&mut s, 1, "a", 0, 300);
    set_fades(&mut s, music, 15, 45).unwrap();
    s.execute(&Command::SetTrackSound {
        track: track_id(&s, 1),
        sound: TrackSound {
            role: Some(TrackRole::Music),
            pan: Some(0.25),
            ..TrackSound::default()
        },
    })
    .unwrap();
    let text = file::to_json(s.project());
    assert!(text.contains(r#""role": "music""#), "{text}");
    assert!(text.contains(r#""fadeOut": "#), "{text}");
    assert_eq!(&file::from_json(&text).unwrap(), s.project());
    // A format 4 file has none of the new fields; it opens with their defaults.
    let plain = session();
    let mut old: serde_json::Value = serde_json::from_str(&file::to_json(plain.project())).unwrap();
    old["version"] = 4.into();
    let opened = file::from_json(&old.to_string()).unwrap();
    assert_eq!(&opened, plain.project());
    let track = &opened.tracks[0];
    assert_eq!((track.volume_db, track.pan, track.solo), (0.0, 0.0, false));
    assert_eq!(track.role, TrackRole::None);
    assert_eq!(track.ducking, Ducking::default());
    // New fields at their defaults are not written, so untouched projects stay small.
    assert!(!file::to_json(plain.project()).contains("ducking"));
    assert_eq!(Flicks::ZERO, Flicks::default());
}

//! Sequences: nesting clips, editing inside a sequence, breaking one apart, and
//! what removing media or a sequence does to the others.
mod common;

use cgv_model::*;
use cgv_time::FrameRate;
use common::*;

fn nest(s: &mut Session, clips: &[ClipId]) -> (ClipId, SequenceId) {
    let outcome = s
        .execute(&Command::Nest {
            clips: clips.to_vec(),
            name: None,
        })
        .unwrap();
    (ClipId(outcome.created[0]), SequenceId(outcome.created[1]))
}

fn tracks(project: &Project, id: SequenceId) -> Vec<std::sync::Arc<Track>> {
    project.sequence_tracks(id).unwrap().to_vec()
}

#[test]
fn a_new_frame_rate_refits_the_transitions_inside_a_sequence() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let b = append(&mut s, 0, "v", 30, 1);
    let (_, sequence) = nest(&mut s, &[a, b]);
    let track = tracks(s.project(), sequence)[0].id;
    // Two frames centred on the cut: one each side at 30 fps. At 25 fps the first
    // half is under a frame, so all of it would fall after the cut, past `b`'s end.
    s.execute(&Command::InSequence {
        sequence,
        command: Box::new(Command::AddTransition {
            track,
            from: Some(a),
            to: Some(b),
            transition: TransitionSpec {
                kind: "cross-dissolve".into(),
                pack: BUILTIN_PACK.into(),
                version: 1,
                duration: f(2),
                alignment: None,
                params: Params::new(),
            },
        }),
    })
    .unwrap();
    assert_eq!(tracks(s.project(), sequence)[0].transitions.len(), 1);
    let mut settings = s.project().settings;
    settings.frame_rate = FrameRate::FPS_25;
    s.execute(&Command::SetSettings { settings }).unwrap();
    assert_eq!(s.project().settings.frame_rate, FrameRate::FPS_25);
    let inside = tracks(s.project(), sequence);
    assert!(inside[0].transitions.iter().all(|t| t.duration < f(2)));
    assert!(s.undo());
    assert_eq!(
        tracks(s.project(), sequence)[0].transitions[0].duration,
        f(2)
    );
}

#[test]
fn nesting_moves_clips_into_a_sequence_and_a_sequence_clip_into_their_place() {
    let mut s = session();
    let gap = append(&mut s, 0, "v", 0, 30);
    let a = append(&mut s, 0, "v", 30, 60);
    let b = append(&mut s, 0, "v", 100, 30);
    // A title over the second half of `a`, on the track above.
    s.execute(&Command::Overwrite {
        track: track_id(&s, 1),
        at: f(60),
        clip: ClipSpec {
            kind: ClipKind::Title,
            duration: f(30),
            title: Some(Title::default()),
            ..Default::default()
        },
    })
    .unwrap();
    let title = s.project().tracks[1].clips[0].id;
    let (nested, sequence) = nest(&mut s, &[a, b, title]);
    let project = s.project();
    assert_eq!(project.sequences.len(), 1);
    assert_eq!(project.sequence(sequence).unwrap().name, "Sequence 1");
    // The sequence clip covers the clips, on the lowest of their tracks.
    let bottom: Vec<ClipId> = project.tracks[0].clips.iter().map(|c| c.id).collect();
    assert_eq!(bottom, [gap, nested]);
    assert!(project.tracks[1].clips.is_empty());
    let shown = clip(&s, nested);
    assert_eq!(shown.kind, ClipKind::Sequence);
    assert_eq!(shown.sequence, Some(sequence));
    assert_eq!(
        (shown.start, shown.duration, shown.source_in),
        (f(30), f(90), f(0))
    );
    assert!(shown.video && shown.audio);
    // Inside, the clips keep their ids, from the sequence's start.
    let inside = tracks(project, sequence);
    assert_eq!(inside.len(), 2);
    let starts: Vec<(ClipId, i64)> = inside[0]
        .clips
        .iter()
        .map(|c| (c.id, c.start.0 / FRAME))
        .collect();
    assert_eq!(starts, [(a, 0), (b, 60)]);
    assert_eq!(inside[1].clips[0].id, title);
    assert_eq!(inside[1].clips[0].start, f(30));
    assert!(validate(project).is_ok());
    assert_eq!(s.undo_label(), Some("Nest"));
    assert!(s.undo());
    assert!(s.project().sequences.is_empty());
    assert_eq!(s.project().tracks[0].clips.len(), 3);
}

#[test]
fn nesting_refuses_clips_with_others_between_them() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    append(&mut s, 0, "v", 30, 30);
    let c = append(&mut s, 0, "v", 60, 30);
    let error = s
        .execute(&Command::Nest {
            clips: vec![a, c],
            name: Some("Ends".into()),
        })
        .unwrap_err();
    assert!(error.contains("side by side"), "{error}");
    assert!(s.project().sequences.is_empty());
}

#[test]
fn edits_inside_an_open_sequence_are_single_undo_steps_of_the_project() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 60);
    let (nested, sequence) = nest(&mut s, &[a]);
    s.set_open_sequence(Some(sequence)).unwrap();
    // The view shows the sequence's tracks; commands address them.
    let view = s.snapshot();
    assert_eq!(view.project.open_sequence, Some(sequence));
    assert_eq!(view.project.tracks[0].clips[0].id, a);
    s.execute(&Command::Trim {
        clip: a,
        edge: Edge::End,
        delta: f(-20),
        ripple: false,
    })
    .unwrap();
    assert_eq!(s.undo_label(), Some("Trim"));
    assert_eq!(s.timeline_project().tracks[0].clips[0].duration, f(40));
    assert_eq!(tracks(s.project(), sequence)[0].clips[0].duration, f(40));
    // The main timeline is untouched, and the sequence clip keeps its length.
    assert_eq!(clip(&s, nested).duration, f(60));
    // A drag is one step too.
    s.begin_group("Move");
    for delta in [5, 10, 15] {
        s.preview(&Command::Move {
            clips: vec![a],
            delta: f(delta),
            tracks: 0,
            overwrite: false,
        })
        .unwrap();
    }
    s.end_group();
    assert_eq!(tracks(s.project(), sequence)[0].clips[0].start, f(15));
    assert!(s.undo());
    assert_eq!(tracks(s.project(), sequence)[0].clips[0].start, f(0));
    assert!(s.undo());
    assert_eq!(tracks(s.project(), sequence)[0].clips[0].duration, f(60));
    // Undoing the nest closes the sequence: the main timeline shows again.
    assert!(s.undo());
    assert_eq!(s.open_sequence(), None);
    assert_eq!(s.snapshot().project.open_sequence, None);
    assert_eq!(s.snapshot().project.tracks[0].clips[0].id, a);
}

#[test]
fn a_sequence_cannot_contain_itself() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let (outer, first) = nest(&mut s, &[a]);
    let (_, second) = nest(&mut s, &[outer]);
    s.set_open_sequence(Some(first)).unwrap();
    for sequence in [first, second] {
        let error = s
            .execute(&Command::Append {
                track: s.timeline_project().tracks[0].id,
                clip: ClipSpec {
                    kind: ClipKind::Sequence,
                    sequence: Some(sequence),
                    duration: f(30),
                    ..Default::default()
                },
            })
            .unwrap_err();
        assert!(error.contains("cannot contain itself"), "{error}");
    }
    // A third sequence may show the first.
    s.set_open_sequence(None).unwrap();
    let third = SequenceId(
        s.execute(&Command::AddSequence {
            name: "Third".into(),
        })
        .unwrap()
        .created[0],
    );
    s.set_open_sequence(Some(third)).unwrap();
    let main = s.timeline_project().main_track;
    s.execute(&Command::Append {
        track: main,
        clip: ClipSpec {
            kind: ClipKind::Sequence,
            sequence: Some(first),
            duration: f(30),
            ..Default::default()
        },
    })
    .unwrap();
    assert!(validate(s.project()).is_ok());
}

#[test]
fn sequences_nest_at_most_sixteen_deep() {
    let mut s = session();
    let mut top = append(&mut s, 0, "v", 0, 30);
    for _ in 0..MAX_NESTING {
        top = nest(&mut s, &[top]).0;
    }
    let error = s
        .execute(&Command::Nest {
            clips: vec![top],
            name: None,
        })
        .unwrap_err();
    assert!(error.contains("at most 16 deep"), "{error}");
}

#[test]
fn sequence_clips_play_at_normal_speed() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let (nested, _) = nest(&mut s, &[a]);
    let speed = Speed::new(2, 1).unwrap();
    for command in [
        Command::SetSpeed {
            clip: nested,
            speed,
        },
        Command::SetReverse {
            clip: nested,
            reverse: true,
        },
        Command::FreezeFrame {
            clip: nested,
            at: f(10),
            duration: f(10),
        },
    ] {
        assert!(s.execute(&command).is_err(), "{command:?}");
    }
    // They trim, split and slip as media does.
    s.execute(&Command::Split {
        at: f(10),
        clips: vec![nested],
    })
    .unwrap();
    let right = s.project().tracks[0].clips[1].clone();
    assert_eq!((right.start, right.source_in), (f(10), f(10)));
    s.execute(&Command::Slip {
        clip: right.id,
        delta: f(-5),
    })
    .unwrap();
    assert_eq!(clip(&s, right.id).source_in, f(5));
}

#[test]
fn breaking_apart_puts_copies_of_the_clips_back_trimmed_to_the_clip() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let b = append(&mut s, 0, "v", 40, 30);
    let dissolve = s
        .execute(&Command::AddTransition {
            track: track_id(&s, 0),
            from: Some(a),
            to: Some(b),
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
    assert_eq!(dissolve.created.len(), 1);
    let sound = append(&mut s, 1, "a", 0, 60);
    let (nested, sequence) = nest(&mut s, &[a, b, sound]);
    // Show 10 to 50 of the sequence's 60 frames, from frame 100.
    s.execute(&Command::Trim {
        clip: nested,
        edge: Edge::Start,
        delta: f(10),
        ripple: false,
    })
    .unwrap();
    s.execute(&Command::Trim {
        clip: nested,
        edge: Edge::End,
        delta: f(-10),
        ripple: false,
    })
    .unwrap();
    s.execute(&Command::Move {
        clips: vec![nested],
        delta: f(90),
        tracks: 0,
        overwrite: false,
    })
    .unwrap();
    s.execute(&Command::BreakApart { clip: nested }).unwrap();
    let project = s.project();
    assert!(project.clip(nested).is_none());
    // The sequence stays in the project.
    assert!(project.sequence(sequence).is_some());
    let bottom: Vec<(i64, i64, i64)> = layout(&s, 0);
    assert_eq!(bottom, [(100, 20, 10), (120, 20, 40)]);
    assert_eq!(layout(&s, 1), [(100, 40, 10)]);
    // Copies have new ids, and the dissolve between them came along.
    let copies: Vec<ClipId> = project.tracks[0].clips.iter().map(|c| c.id).collect();
    assert!(!copies.contains(&a) && !copies.contains(&b));
    let transitions = &project.tracks[0].transitions;
    assert_eq!(transitions.len(), 1);
    assert_eq!(
        (transitions[0].from, transitions[0].to),
        (Some(copies[0]), Some(copies[1]))
    );
    assert!(validate(project).is_ok());
}

#[test]
fn removing_media_or_a_sequence_reaches_every_timeline() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let i = append(&mut s, 0, "i", 0, 30);
    let (nested, sequence) = nest(&mut s, &[a, i]);
    append(&mut s, 1, "v", 0, 30);
    s.execute(&Command::RemoveMedia { media: "i".into() })
        .unwrap();
    let inside: Vec<ClipId> = tracks(s.project(), sequence)[0]
        .clips
        .iter()
        .map(|c| c.id)
        .collect();
    assert_eq!(inside, [a]);
    s.execute(&Command::RemoveSequence { sequence }).unwrap();
    assert!(s.project().clip(nested).is_none());
    assert!(s.project().sequences.is_empty());
    assert_eq!(s.project().tracks[1].clips.len(), 1);
    // Deleting the open sequence closes it.
    assert!(s.undo());
    s.set_open_sequence(Some(sequence)).unwrap();
    assert!(s.execute(&Command::RemoveSequence { sequence }).is_ok());
    assert_eq!(s.open_sequence(), None);
}

#[test]
fn projects_with_sequences_save_and_open() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let (_, sequence) = nest(&mut s, &[a]);
    s.execute(&Command::RenameSequence {
        sequence,
        name: "Interview".into(),
    })
    .unwrap();
    let text = file::to_json(s.project());
    assert!(text.contains("\"version\": 8"));
    let opened = file::from_json(&text).unwrap();
    assert_eq!(&opened, s.project());
    assert_eq!(opened.sequence(sequence).unwrap().name, "Interview");
    // A file that shows a missing sequence is refused.
    let broken = text.replace(
        &format!("\"sequence\": {}", sequence.0),
        "\"sequence\": 999999",
    );
    assert!(file::from_json(&broken).is_err());
}

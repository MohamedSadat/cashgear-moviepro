//! Multicam clips: angles synced to a common moment, switching angles, and
//! flattening.
mod common;

use cgv_model::*;
use cgv_time::Flicks;
use common::*;

/// Three angles of "v" on three tracks; returns their ids.
fn angles(s: &mut Session) -> Vec<ClipId> {
    s.execute(&Command::AddTrack {
        index: 2,
        name: None,
    })
    .unwrap();
    vec![
        append(s, 0, "v", 0, 300),
        append(s, 1, "v", 20, 300),
        append(s, 2, "v", 40, 300),
    ]
}

fn make(s: &mut Session, clips: &[ClipId], sync: &[Flicks]) -> (ClipId, SequenceId) {
    let outcome = s
        .execute(&Command::MakeMulticam {
            clips: clips.to_vec(),
            sync: sync.to_vec(),
            name: None,
        })
        .unwrap();
    (ClipId(outcome.created[0]), SequenceId(outcome.created[1]))
}

/// The media time each angle shows at sequence time `at`.
fn media_at(project: &Project, sequence: SequenceId, at: Flicks) -> Vec<Flicks> {
    project
        .sequence_tracks(sequence)
        .unwrap()
        .iter()
        .map(|track| {
            let clip = &track.clips[0];
            clip.source_in + (at - clip.start)
        })
        .collect()
}

#[test]
fn angles_line_up_on_their_sync_points_finer_than_a_frame() {
    let mut s = session();
    let ids = angles(&mut s);
    // The clap is 2.5 s into the first file, 1.9 s into the second and
    // 4.333 ms past 3 s into the third: not on frame boundaries.
    let sync = [
        Flicks(705_600_000 * 5 / 2),
        Flicks(705_600_000 * 19 / 10),
        Flicks(705_600_000 * 3 + 3_057_600),
    ];
    let (multicam, sequence) = make(&mut s, &ids, &sync);
    let project = s.project();
    let entry = project.sequence(sequence).unwrap();
    assert!(entry.multicam);
    assert_eq!(entry.name, "Multicam 1");
    let tracks = project.sequence_tracks(sequence).unwrap();
    assert_eq!(tracks.len(), 3);
    for (track, id) in tracks.iter().zip(&ids) {
        assert_eq!(track.clips[0].id, *id);
        assert_eq!(track.clips[0].start.0 % FRAME, 0, "angles start on frames");
    }
    // At any moment the angles show their media the sync points apart.
    for at in [f(60), f(123)] {
        let shown = media_at(project, sequence, at);
        assert_eq!(shown[1] - shown[0], sync[1] - sync[0]);
        assert_eq!(shown[2] - shown[0], sync[2] - sync[0]);
    }
    // The multicam clip sits where the first clip was, showing and playing angle 1.
    let clip = clip(&s, multicam);
    assert_eq!(clip.start, Flicks::ZERO);
    assert_eq!(
        clip.angles,
        Some(Angles {
            picture: 0,
            sound: 0
        })
    );
    assert!(s.project().tracks.iter().all(|t| t.clips.len() <= 1));
    assert_eq!(s.undo_label(), Some("Make multicam clip"));
}

#[test]
fn switching_angles_cuts_at_the_frame_and_each_switch_is_one_step() {
    let mut s = session();
    let ids = angles(&mut s);
    let (multicam, _) = make(&mut s, &ids, &[f(0), f(20), f(40)]);
    let switch =
        |s: &mut Session, clip, at, angle| s.execute(&Command::SwitchAngle { clip, at, angle });
    // Mid-frame points snap to the nearest frame.
    let outcome = switch(&mut s, multicam, Flicks(f(30).0 + 7), 2).unwrap();
    let right = ClipId(outcome.created[0]);
    assert_eq!(clip(&s, right).start, f(30));
    assert_eq!(clip(&s, right).angles.unwrap().picture, 2);
    assert_eq!(clip(&s, multicam).angles.unwrap().picture, 0);
    assert_eq!(s.undo_label(), Some("Switch angle"));
    // The same angle again changes nothing; within the first frame of a part,
    // the part switches whole.
    let before = s.project().clone();
    switch(&mut s, right, f(40), 2).unwrap();
    assert_eq!(s.project(), &before);
    switch(&mut s, right, f(30), 1).unwrap();
    assert_eq!(clip(&s, right).angles.unwrap().picture, 1);
    assert_eq!(s.project().tracks[0].clips.len(), 2);
    // The sound stays on its angle.
    assert_eq!(clip(&s, right).angles.unwrap().sound, 0);
    assert!(switch(&mut s, right, f(50), 3).is_err());
    s.undo();
    s.undo();
    assert_eq!(s.project().tracks[0].clips.len(), 1);
}

#[test]
fn flattening_keeps_the_picture_of_one_angle_and_the_sound_of_another() {
    let mut s = session();
    let ids = angles(&mut s);
    let (multicam, _) = make(&mut s, &ids, &[f(0), f(0), f(0)]);
    s.execute(&Command::SetAngles {
        clip: multicam,
        picture: Some(1),
        sound: Some(2),
    })
    .unwrap();
    s.execute(&Command::BreakApart { clip: multicam }).unwrap();
    let project = s.project();
    let picture = &project.tracks[0].clips[0];
    let sound = &project.tracks[1].clips[0];
    assert!(picture.video && !picture.audio);
    assert!(!sound.video && sound.audio);
    // The second angle's media from frame 20, the third's from frame 40.
    assert_eq!((picture.source_in, sound.source_in), (f(20), f(40)));
    assert!(validate(project).is_ok());
}

#[test]
fn angles_stay_as_they_are_inside_a_multicam_sequence() {
    let mut s = session();
    let ids = angles(&mut s);
    let (multicam, sequence) = make(&mut s, &ids, &[f(0), f(0), f(0)]);
    s.set_open_sequence(Some(sequence)).unwrap();
    let error = s
        .execute(&Command::AddTrack {
            index: 0,
            name: None,
        })
        .unwrap_err();
    assert!(error.contains("angles stay"), "{error}");
    // Edits of the angles' clips are fine.
    s.execute(&Command::Trim {
        clip: ids[1],
        edge: Edge::Start,
        delta: f(10),
        ripple: false,
    })
    .unwrap();
    s.set_open_sequence(None).unwrap();
    assert!(s
        .execute(&Command::SetAngles {
            clip: multicam,
            picture: Some(3),
            sound: None,
        })
        .is_err());
    // Two to four angles, each a video clip.
    let mut t = session();
    let one = append(&mut t, 0, "v", 0, 30);
    let sound = append(&mut t, 1, "a", 0, 30);
    assert!(t
        .execute(&Command::MakeMulticam {
            clips: vec![one],
            sync: vec![f(0)],
            name: None,
        })
        .is_err());
    assert!(t
        .execute(&Command::MakeMulticam {
            clips: vec![one, sound],
            sync: vec![f(0), f(0)],
            name: None,
        })
        .is_err());
}

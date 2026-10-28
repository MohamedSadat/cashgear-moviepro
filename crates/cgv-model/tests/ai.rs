//! What the AI tools change: jump cuts from detected silences, and beats on clips.
mod common;

use cgv_model::*;
use cgv_time::Flicks;
use common::*;

fn ranges(list: &[(i64, i64)]) -> Vec<[Flicks; 2]> {
    list.iter().map(|&(a, b)| [f(a), f(b)]).collect()
}

#[test]
fn ranges_cut_out_of_a_clip_close_up_as_jump_cuts() {
    let mut s = session();
    let first = append(&mut s, 0, "v", 0, 300);
    let after = append(&mut s, 0, "v", 400, 60);
    let outcome = s
        .execute(&Command::RemoveRanges {
            clip: first,
            ranges: ranges(&[(250, 280), (0, 30), (100, 120), (110, 150)]),
        })
        .unwrap();
    // The overlapping cuts merge: 30 + 50 + 30 frames go, and the next clip follows.
    assert_eq!(
        layout(&s, 0),
        [(0, 70, 30), (70, 100, 150), (170, 20, 280), (190, 60, 400)]
    );
    // The first cut took the clip's start, so every piece left is a new clip.
    assert!(s.project().clip(first).is_none());
    assert_eq!(outcome.created.len(), 3);
    assert!(outcome
        .created
        .iter()
        .all(|&id| s.project().clip(ClipId(id)).is_some()));
    assert_eq!(clip(&s, after).start, f(190));
    assert!(s.undo());
    assert_eq!(layout(&s, 0), [(0, 300, 0), (300, 60, 400)]);
}

#[test]
fn cuts_take_linked_partners_along_and_keep_the_magnetic_track_whole() {
    let mut s = magnetic_session();
    let video = append(&mut s, 0, "v", 0, 300);
    let sound = detach_onto(&mut s, video, 1);
    let music = append(&mut s, 1, "a", 0, 90);
    assert_eq!(clip(&s, music).start, f(300));
    s.execute(&Command::RemoveRanges {
        clip: sound,
        ranges: ranges(&[(60, 90), (200, 240)]),
    })
    .unwrap();
    assert_eq!(layout(&s, 0), [(0, 60, 0), (60, 110, 90), (170, 60, 240)]);
    assert_eq!(
        layout(&s, 1)[..3],
        [(0, 60, 0), (60, 110, 90), (170, 60, 240)]
    );
    // Unlinked clips after them stay where they were, as with any ripple delete
    // on the magnetic main track.
    assert_eq!(clip(&s, music).start, f(300));
    // A range covering the whole clip removes it.
    let last = s.project().tracks[0].clips[2].id;
    s.execute(&Command::RemoveRanges {
        clip: last,
        ranges: ranges(&[(100, 400)]),
    })
    .unwrap();
    assert_eq!(layout(&s, 0), [(0, 60, 0), (60, 110, 90)]);
}

#[test]
fn ranges_outside_the_clip_or_on_locked_tracks_change_nothing() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 100);
    let error = s
        .execute(&Command::RemoveRanges {
            clip: id,
            ranges: ranges(&[(100, 140)]),
        })
        .unwrap_err();
    assert!(error.contains("nothing of the clip"), "{error}");
    let track = track_id(&s, 0);
    s.execute(&Command::SetTrackLocked {
        track,
        locked: true,
    })
    .unwrap();
    assert!(s
        .execute(&Command::RemoveRanges {
            clip: id,
            ranges: ranges(&[(10, 20)]),
        })
        .is_err());
    assert_eq!(layout(&s, 0), [(0, 100, 0)]);
}

#[test]
fn beats_are_media_times_that_splits_and_copies_keep() {
    let mut s = session();
    let id = append(&mut s, 1, "a", 0, 300);
    let beats: Vec<Flicks> = [45, 15, 30, 30].iter().map(|&frame| f(frame)).collect();
    s.execute(&Command::SetBeats { clip: id, beats }).unwrap();
    assert_eq!(clip(&s, id).beats, [f(15), f(30), f(45)]);
    let right = ClipId(
        s.execute(&Command::Split {
            at: f(20),
            clips: vec![id],
        })
        .unwrap()
        .created[0],
    );
    assert_eq!(clip(&s, right).beats, clip(&s, id).beats);
    let text = file::to_json(s.project());
    assert!(text.contains("\"beats\": ["));
    assert_eq!(&file::from_json(&text).unwrap(), s.project());
    s.execute(&Command::SetBeats {
        clip: id,
        beats: vec![],
    })
    .unwrap();
    assert!(clip(&s, id).beats.is_empty());
    assert!(s
        .execute(&Command::SetBeats {
            clip: id,
            beats: vec![Flicks(-1)],
        })
        .is_err());
    let title = s
        .execute(&Command::Append {
            track: track_id(&s, 0),
            clip: ClipSpec {
                kind: ClipKind::Adjustment,
                duration: f(30),
                ..Default::default()
            },
        })
        .unwrap()
        .created[0];
    assert!(s
        .execute(&Command::SetBeats {
            clip: ClipId(title),
            beats: vec![f(1)],
        })
        .is_err());
}

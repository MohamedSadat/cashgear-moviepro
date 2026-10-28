//! What the AI tools change: jump cuts from detected silences, beats on clips and
//! captions on titles.
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

fn caption_spec(words: &[i64], frames: i64) -> ClipSpec {
    let mut rng = Rng(5);
    ClipSpec {
        kind: ClipKind::Title,
        duration: f(frames),
        title: Some(random_title(&mut rng)),
        caption: Some(Caption {
            language: "ar".into(),
            words: words.iter().map(|&w| f(w)).collect(),
        }),
        ..Default::default()
    }
}

#[test]
fn caption_words_stay_where_they_were_said_through_splits_and_trims() {
    let mut s = session();
    let track = track_id(&s, 1);
    let id = ClipId(
        s.execute(&Command::Append {
            track,
            clip: caption_spec(&[0, 10, 25, 40], 60),
        })
        .unwrap()
        .created[0],
    );
    let words = |s: &Session, id: ClipId| -> Vec<i64> {
        clip(s, id)
            .caption
            .unwrap()
            .words
            .iter()
            .map(|w| w.0 / FRAME)
            .collect()
    };
    let right = ClipId(
        s.execute(&Command::Split {
            at: f(20),
            clips: vec![id],
        })
        .unwrap()
        .created[0],
    );
    // The right half's words count from its own start; those before it hold at 0.
    assert_eq!(words(&s, right), [0, 0, 5, 20]);
    assert_eq!(words(&s, id), [0, 10, 25, 40]);
    s.execute(&Command::Trim {
        clip: right,
        edge: Edge::Start,
        delta: f(5),
        ripple: false,
    })
    .unwrap();
    assert_eq!(words(&s, right), [0, 0, 0, 15]);
    let text = file::to_json(s.project());
    assert!(text.contains("\"caption\": {"));
    assert_eq!(&file::from_json(&text).unwrap(), s.project());
}

#[test]
fn captions_belong_to_titles_and_check_their_words() {
    let mut s = session();
    let track = track_id(&s, 1);
    let id = ClipId(
        s.execute(&Command::Append {
            track,
            clip: caption_spec(&[], 30),
        })
        .unwrap()
        .created[0],
    );
    let set = |caption: Option<Caption>| Command::SetCaption { clip: id, caption };
    assert!(s
        .execute(&set(Some(Caption {
            language: "EN".into(),
            words: vec![],
        })))
        .is_err());
    assert!(s
        .execute(&set(Some(Caption {
            language: "en".into(),
            words: vec![f(5), f(2)],
        })))
        .is_err());
    s.execute(&set(Some(Caption {
        language: "en".into(),
        words: vec![f(2), f(5)],
    })))
    .unwrap();
    assert_eq!(clip(&s, id).caption.unwrap().language, "en");
    s.execute(&set(None)).unwrap();
    assert!(clip(&s, id).caption.is_none());
    let media = append(&mut s, 0, "v", 0, 30);
    assert!(s
        .execute(&Command::SetCaption {
            clip: media,
            caption: Some(Caption {
                language: "en".into(),
                words: vec![],
            }),
        })
        .is_err());
    // A caption and its text change together in a batch, as one step.
    let mut title = clip(&s, id).title.unwrap();
    title.elements.truncate(1);
    s.execute(&Command::Batch {
        commands: vec![
            Command::SetTitle { clip: id, title },
            set(Some(Caption {
                language: "en".into(),
                words: vec![f(1)],
            })),
        ],
    })
    .unwrap();
    assert_eq!(clip(&s, id).caption.unwrap().words, [f(1)]);
}

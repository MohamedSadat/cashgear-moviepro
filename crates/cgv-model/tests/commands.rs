//! Unit tests for every edit command. Layouts are (start, duration, source in) in frames.
mod common;

use cgv_model::*;
use cgv_time::{Flicks, FrameRate};
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

// ---- Project and media ------------------------------------------------------------

#[test]
fn rename_trims_and_refuses_empty_names() {
    let mut s = session();
    run(
        &mut s,
        Command::Rename {
            name: "  Trip  ".into(),
        },
    );
    assert_eq!(s.project().name, "Trip");
    fails(
        &mut s,
        Command::Rename { name: "   ".into() },
        "needs a name",
    );
}

#[test]
fn settings_change_and_clips_keep_their_times() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 30);
    let mut settings = s.project().settings;
    settings.width = 1080;
    settings.height = 1920;
    settings.frame_rate = FrameRate::FPS_25;
    run(&mut s, Command::SetSettings { settings });
    assert_eq!(s.project().settings.aspect_label(), "9:16");
    assert_eq!(clip(&s, id).duration, f(30));
    settings.frame_rate = FrameRate::new(15, 1).unwrap();
    fails(&mut s, Command::SetSettings { settings }, "not a supported");
}

#[test]
fn media_is_added_once_and_removing_it_removes_its_clips() {
    let mut s = session();
    fails(
        &mut s,
        Command::AddMedia {
            media: media("v", MediaKind::Video, 5),
        },
        "already in the project",
    );
    append(&mut s, 0, "v", 0, 30);
    append(&mut s, 0, "a", 0, 30);
    append(&mut s, 1, "v", 0, 10);
    run(&mut s, Command::RemoveMedia { media: "v".into() });
    assert!(s.project().media("v").is_none());
    assert_eq!(layout(&s, 0), [(30, 30, 0)]);
    assert!(layout(&s, 1).is_empty());
    fails(
        &mut s,
        Command::RemoveMedia { media: "v".into() },
        "No media",
    );
}

#[test]
fn removing_media_used_on_a_locked_track_fails() {
    let mut s = session();
    append(&mut s, 1, "a", 0, 30);
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
        Command::RemoveMedia { media: "a".into() },
        "Track 2 is locked",
    );
}

// ---- Tracks -----------------------------------------------------------------------

#[test]
fn tracks_are_added_moved_renamed_and_removed() {
    let mut s = session();
    let added = TrackId(
        run(
            &mut s,
            Command::AddTrack {
                index: 2,
                name: Some(" Music ".into()),
            },
        )
        .created[0],
    );
    assert_eq!(s.project().tracks[2].name, "Music");
    run(
        &mut s,
        Command::MoveTrack {
            track: added,
            index: 0,
        },
    );
    assert_eq!(s.project().tracks[0].id, added);
    run(
        &mut s,
        Command::RenameTrack {
            track: added,
            name: "Voice".into(),
        },
    );
    assert_eq!(s.project().tracks[0].name, "Voice");
    fails(
        &mut s,
        Command::MoveTrack {
            track: added,
            index: 3,
        },
        "no track position",
    );
    fails(
        &mut s,
        Command::AddTrack {
            index: 9,
            name: None,
        },
        "no track position",
    );
    run(&mut s, Command::RemoveTrack { track: added });
    assert_eq!(s.project().tracks.len(), 2);
    let main = track_id(&s, 0);
    assert_eq!(main, s.project().main_track);
    fails(
        &mut s,
        Command::RemoveTrack { track: main },
        "main track can't be deleted",
    );
    let other = track_id(&s, 1);
    run(&mut s, Command::RemoveTrack { track: other });
    fails(
        &mut s,
        Command::RemoveTrack { track: main },
        "at least one track",
    );
}

#[test]
fn lock_mute_and_hide_are_flags_and_locks_block_edits() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 30);
    let track = track_id(&s, 0);
    run(&mut s, Command::SetTrackMuted { track, muted: true });
    run(
        &mut s,
        Command::SetTrackHidden {
            track,
            hidden: true,
        },
    );
    run(
        &mut s,
        Command::SetTrackLocked {
            track,
            locked: true,
        },
    );
    let t = &s.project().tracks[0];
    assert!(t.muted && t.hidden && t.locked);
    fails(
        &mut s,
        Command::Append {
            track,
            clip: spec("v", 0, 10),
        },
        "locked",
    );
    fails(&mut s, Command::Delete { clips: vec![id] }, "locked");
    fails(
        &mut s,
        Command::Trim {
            clip: id,
            edge: Edge::End,
            delta: f(-1),
            ripple: false,
        },
        "locked",
    );
    fails(&mut s, Command::RemoveTrack { track }, "locked");
    run(
        &mut s,
        Command::RenameTrack {
            track,
            name: "Main".into(),
        },
    );
    run(
        &mut s,
        Command::SetTrackLocked {
            track,
            locked: false,
        },
    );
    run(&mut s, Command::Delete { clips: vec![id] });
}

// ---- Insert, overwrite, append ------------------------------------------------------

#[test]
fn append_places_clips_end_to_end_with_stream_defaults() {
    let mut s = session();
    let v = append(&mut s, 0, "v", 10, 30);
    let a = append(&mut s, 0, "a", 0, 15);
    let i = append(&mut s, 0, "i", 0, 150);
    assert_eq!(layout(&s, 0), [(0, 30, 10), (30, 15, 0), (45, 150, 0)]);
    let (v, a, i) = (clip(&s, v), clip(&s, a), clip(&s, i));
    assert!(v.video && v.audio);
    assert!(!a.video && a.audio);
    assert!(i.video && !i.audio);
    assert_eq!(v.speed, Speed::NORMAL);
    assert_eq!(v.opacity, 1.0);
}

#[test]
fn placement_checks_media_streams_and_bounds() {
    let mut s = session();
    let track = track_id(&s, 0);
    let mut picture_only = spec("v", 0, 30);
    picture_only.audio = Some(false);
    let id = ClipId(
        run(
            &mut s,
            Command::Append {
                track,
                clip: picture_only,
            },
        )
        .created[0],
    );
    assert!(!clip(&s, id).audio);
    let mut sound_from_still = spec("i", 0, 30);
    sound_from_still.audio = Some(true);
    fails(
        &mut s,
        Command::Append {
            track,
            clip: sound_from_still,
        },
        "has no sound",
    );
    let mut nothing = spec("v", 0, 30);
    nothing.video = Some(false);
    nothing.audio = Some(false);
    fails(
        &mut s,
        Command::Append {
            track,
            clip: nothing,
        },
        "needs its picture",
    );
    fails(
        &mut s,
        Command::Append {
            track,
            clip: spec("v", 590, 30),
        },
        "nothing after",
    );
    fails(
        &mut s,
        Command::Append {
            track,
            clip: spec("v", -1, 30),
        },
        "nothing before",
    );
    fails(
        &mut s,
        Command::Append {
            track,
            clip: spec("i", 3, 30),
        },
        "no source position",
    );
    fails(
        &mut s,
        Command::Append {
            track,
            clip: spec("x", 0, 30),
        },
        "No media x",
    );
    fails(
        &mut s,
        Command::Append {
            track,
            clip: spec("v", 0, 0),
        },
        "shorter than one frame",
    );
    // The whole 20 s video fits exactly.
    run(
        &mut s,
        Command::Append {
            track,
            clip: spec("v", 0, 600),
        },
    );
}

#[test]
fn insert_splits_the_clip_under_it_and_pushes_later_clips() {
    let mut s = session();
    let track = track_id(&s, 0);
    append(&mut s, 0, "v", 0, 60);
    append(&mut s, 0, "a", 0, 30);
    let outcome = run(
        &mut s,
        Command::Insert {
            track,
            at: f(20),
            clip: spec("i", 0, 10),
        },
    );
    assert_eq!(outcome.created.len(), 2, "the new clip and the right half");
    assert_eq!(
        layout(&s, 0),
        [(0, 20, 0), (20, 10, 0), (30, 40, 20), (70, 30, 0)]
    );
    assert_eq!(clip(&s, ClipId(outcome.created[0])).media, "i");
}

#[test]
fn insert_and_overwrite_snap_to_frames() {
    let mut s = session();
    let track = track_id(&s, 0);
    let mut odd = spec("v", 0, 0);
    odd.duration = Flicks(FRAME * 10 + FRAME / 3);
    let id = ClipId(
        run(
            &mut s,
            Command::Insert {
                track,
                at: Flicks(FRAME * 5 + FRAME / 2 + 1),
                clip: odd,
            },
        )
        .created[0],
    );
    assert_eq!((clip(&s, id).start, clip(&s, id).duration), (f(6), f(10)));
    fails(
        &mut s,
        Command::Insert {
            track,
            at: f(-2),
            clip: spec("v", 0, 1),
        },
        "starts at 0",
    );
}

#[test]
fn overwrite_replaces_what_it_covers() {
    let mut s = session();
    let track = track_id(&s, 0);
    append(&mut s, 0, "v", 0, 30);
    append(&mut s, 0, "a", 0, 30);
    append(&mut s, 0, "v", 100, 30);
    // Covers the end of the first clip, all of the second and the start of the third.
    run(
        &mut s,
        Command::Overwrite {
            track,
            at: f(20),
            clip: spec("i", 0, 50),
        },
    );
    assert_eq!(layout(&s, 0), [(0, 20, 0), (20, 50, 0), (70, 20, 110)]);
    // Inside one clip: it splits around the new one.
    let outcome = run(
        &mut s,
        Command::Overwrite {
            track,
            at: f(5),
            clip: spec("a", 0, 5),
        },
    );
    assert_eq!(outcome.created.len(), 2);
    assert_eq!(
        layout(&s, 0),
        [
            (0, 5, 0),
            (5, 5, 0),
            (10, 10, 10),
            (20, 50, 0),
            (70, 20, 110)
        ]
    );
    // Past the end, into empty space.
    run(
        &mut s,
        Command::Overwrite {
            track,
            at: f(200),
            clip: spec("a", 0, 5),
        },
    );
    assert_eq!(layout(&s, 0).last(), Some(&(200, 5, 0)));
}

// ---- Delete and ripple delete ----------------------------------------------------------

#[test]
fn delete_leaves_gaps_and_ripple_delete_closes_them() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 10);
    let b = append(&mut s, 0, "v", 10, 20);
    let c = append(&mut s, 0, "v", 30, 30);
    let d = append(&mut s, 0, "v", 60, 40);
    run(&mut s, Command::Delete { clips: vec![b] });
    assert_eq!(layout(&s, 0), [(0, 10, 0), (30, 30, 30), (60, 40, 60)]);
    run(&mut s, Command::RippleDelete { clips: vec![a, c] });
    // Each removed clip's length closes up; the gap left by the plain delete stays.
    assert_eq!(layout(&s, 0), [(20, 40, 60)]);
    let _ = d;
    fails(
        &mut s,
        Command::RippleDelete { clips: vec![] },
        "Nothing to delete",
    );
    fails(&mut s, Command::Delete { clips: vec![a] }, "No clip");
}

#[test]
fn ripple_delete_is_per_track_and_takes_linked_partners() {
    let mut s = session();
    let v1 = append(&mut s, 1, "v", 0, 30);
    let v2 = append(&mut s, 1, "v", 30, 30);
    let audio = detach_onto(&mut s, v1, 0);
    append(&mut s, 0, "a", 0, 60); // after the detached sound, on the same track
    run(&mut s, Command::RippleDelete { clips: vec![v1] });
    assert!(
        s.project().clip(audio).is_none(),
        "the linked sound goes too"
    );
    assert_eq!(layout(&s, 1), [(0, 30, 30)]);
    assert_eq!(layout(&s, 0), [(0, 60, 0)]);
    assert_eq!(clip(&s, v2).start, Flicks::ZERO);
}

// ---- Split -------------------------------------------------------------------------------

#[test]
fn split_at_the_playhead_splits_every_unlocked_track() {
    let mut s = session();
    append(&mut s, 0, "v", 0, 60);
    append(&mut s, 1, "a", 0, 90);
    let locked = TrackId(
        run(
            &mut s,
            Command::AddTrack {
                index: 2,
                name: None,
            },
        )
        .created[0],
    );
    append(&mut s, 2, "v", 0, 90);
    run(
        &mut s,
        Command::SetTrackLocked {
            track: locked,
            locked: true,
        },
    );
    let outcome = run(
        &mut s,
        Command::Split {
            at: f(40),
            clips: vec![],
        },
    );
    assert_eq!(outcome.created.len(), 2);
    assert_eq!(layout(&s, 0), [(0, 40, 0), (40, 20, 40)]);
    assert_eq!(layout(&s, 1), [(0, 40, 0), (40, 50, 40)]);
    assert_eq!(layout(&s, 2), [(0, 90, 0)]);
    fails(
        &mut s,
        Command::Split {
            at: f(95),
            clips: vec![],
        },
        "no clip to split",
    );
}

#[test]
fn split_named_clips_keeps_links_on_each_side() {
    let mut s = session();
    let v = append(&mut s, 1, "v", 0, 60);
    let other = append(&mut s, 1, "v", 60, 30);
    let audio = detach_onto(&mut s, v, 0);
    let outcome = run(
        &mut s,
        Command::Split {
            at: f(20),
            clips: vec![v],
        },
    );
    assert_eq!(outcome.created.len(), 2, "the clip and its linked sound");
    let (left_link, right_links): (_, Vec<_>) = (
        clip(&s, v).link,
        outcome
            .created
            .iter()
            .map(|&id| clip(&s, ClipId(id)).link)
            .collect(),
    );
    assert_eq!(clip(&s, audio).link, left_link);
    assert!(right_links[0].is_some() && right_links[0] == right_links[1]);
    assert_ne!(right_links[0], left_link);
    fails(
        &mut s,
        Command::Split {
            at: f(20),
            clips: vec![other],
        },
        "not under the split point",
    );
    fails(
        &mut s,
        Command::Split {
            at: f(60),
            clips: vec![other],
        },
        "not under the split point",
    );
}

#[test]
fn split_shifts_keyframes_so_the_animation_stays_put() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 60);
    let mut project = s.project().clone();
    let track = std::sync::Arc::make_mut(&mut project.tracks[0]);
    track.clips[0].keyframes.insert(
        "opacity".into(),
        vec![Keyframe {
            time: f(30),
            value: 0.5,
            interpolation: Interpolation::Linear,
        }],
    );
    let mut s = Session::new(project);
    let right = ClipId(
        run(
            &mut s,
            Command::Split {
                at: f(20),
                clips: vec![id],
            },
        )
        .created[0],
    );
    assert_eq!(clip(&s, right).keyframes["opacity"][0].time, f(10));
    assert_eq!(clip(&s, id).keyframes["opacity"][0].time, f(30));
}

// ---- Trim --------------------------------------------------------------------------------

#[test]
fn trim_moves_one_edge_within_neighbours_and_media() {
    let mut s = session();
    let track = track_id(&s, 0);
    let a = append(&mut s, 0, "v", 0, 30);
    let b = ClipId(
        run(
            &mut s,
            Command::Overwrite {
                track,
                at: f(40),
                clip: spec("v", 100, 30),
            },
        )
        .created[0],
    );
    assert_eq!(layout(&s, 0), [(0, 30, 0), (40, 30, 100)]);
    run(
        &mut s,
        Command::Trim {
            clip: b,
            edge: Edge::Start,
            delta: f(-10),
            ripple: false,
        },
    );
    assert_eq!(layout(&s, 0), [(0, 30, 0), (30, 40, 90)]);
    fails(
        &mut s,
        Command::Trim {
            clip: b,
            edge: Edge::Start,
            delta: f(-1),
            ripple: false,
        },
        "overlap",
    );
    run(
        &mut s,
        Command::Trim {
            clip: a,
            edge: Edge::End,
            delta: f(-5),
            ripple: false,
        },
    );
    fails(
        &mut s,
        Command::Trim {
            clip: a,
            edge: Edge::End,
            delta: f(6),
            ripple: false,
        },
        "overlap",
    );
    fails(
        &mut s,
        Command::Trim {
            clip: a,
            edge: Edge::Start,
            delta: f(-1),
            ripple: false,
        },
        "before 0",
    );
    fails(
        &mut s,
        Command::Trim {
            clip: a,
            edge: Edge::End,
            delta: f(-25),
            ripple: false,
        },
        "shorter than one frame",
    );
    let last = append(&mut s, 0, "v", 590, 10);
    fails(
        &mut s,
        Command::Trim {
            clip: last,
            edge: Edge::End,
            delta: f(1),
            ripple: false,
        },
        "nothing after",
    );
}

#[test]
fn ripple_trim_keeps_the_start_and_shifts_later_clips() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 30, 30);
    append(&mut s, 0, "a", 0, 30);
    run(
        &mut s,
        Command::Trim {
            clip: a,
            edge: Edge::Start,
            delta: f(10),
            ripple: true,
        },
    );
    assert_eq!(layout(&s, 0), [(0, 20, 40), (20, 30, 0)]);
    run(
        &mut s,
        Command::Trim {
            clip: a,
            edge: Edge::Start,
            delta: f(-20),
            ripple: true,
        },
    );
    assert_eq!(layout(&s, 0), [(0, 40, 20), (40, 30, 0)]);
    run(
        &mut s,
        Command::Trim {
            clip: a,
            edge: Edge::End,
            delta: f(15),
            ripple: true,
        },
    );
    assert_eq!(layout(&s, 0), [(0, 55, 20), (55, 30, 0)]);
    run(
        &mut s,
        Command::Trim {
            clip: a,
            edge: Edge::End,
            delta: f(-50),
            ripple: true,
        },
    );
    assert_eq!(layout(&s, 0), [(0, 5, 20), (5, 30, 0)]);
    fails(
        &mut s,
        Command::Trim {
            clip: a,
            edge: Edge::Start,
            delta: f(-21),
            ripple: true,
        },
        "nothing before",
    );
}

#[test]
fn trim_applies_to_linked_partners() {
    let mut s = session();
    let v = append(&mut s, 1, "v", 0, 30);
    let audio = detach_onto(&mut s, v, 0);
    run(
        &mut s,
        Command::Trim {
            clip: v,
            edge: Edge::End,
            delta: f(-10),
            ripple: false,
        },
    );
    assert_eq!(clip(&s, audio).duration, f(20));
    run(
        &mut s,
        Command::Trim {
            clip: audio,
            edge: Edge::Start,
            delta: f(5),
            ripple: false,
        },
    );
    assert_eq!((clip(&s, v).start, clip(&s, v).source_in), (f(5), f(5)));
}

// ---- Roll, slip, slide ---------------------------------------------------------------------

#[test]
fn roll_moves_the_cut_between_two_clips() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let b = append(&mut s, 0, "v", 100, 30);
    run(
        &mut s,
        Command::Roll {
            clip: a,
            edge: Edge::End,
            delta: f(10),
        },
    );
    assert_eq!(layout(&s, 0), [(0, 40, 0), (40, 20, 110)]);
    run(
        &mut s,
        Command::Roll {
            clip: b,
            edge: Edge::Start,
            delta: f(-25),
        },
    );
    assert_eq!(layout(&s, 0), [(0, 15, 0), (15, 45, 85)]);
    fails(
        &mut s,
        Command::Roll {
            clip: a,
            edge: Edge::Start,
            delta: f(1),
        },
        "no clip right next to",
    );
    fails(
        &mut s,
        Command::Roll {
            clip: a,
            edge: Edge::End,
            delta: f(45),
        },
        "shorter than one frame",
    );
    fails(
        &mut s,
        Command::Roll {
            clip: a,
            edge: Edge::End,
            delta: f(-15),
        },
        "shorter than one frame",
    );
}

#[test]
fn slip_changes_the_source_but_not_the_timeline() {
    let mut s = session();
    append(&mut s, 0, "a", 0, 10);
    let v = append(&mut s, 0, "v", 50, 30);
    run(
        &mut s,
        Command::Slip {
            clip: v,
            delta: f(20),
        },
    );
    assert_eq!(layout(&s, 0), [(0, 10, 0), (10, 30, 70)]);
    fails(
        &mut s,
        Command::Slip {
            clip: v,
            delta: f(-71),
        },
        "nothing before",
    );
    fails(
        &mut s,
        Command::Slip {
            clip: v,
            delta: f(501),
        },
        "nothing after",
    );
    let still = append(&mut s, 0, "i", 0, 30);
    fails(
        &mut s,
        Command::Slip {
            clip: still,
            delta: f(1),
        },
        "Stills have nothing to slip",
    );
}

#[test]
fn slide_moves_a_clip_and_its_neighbours_follow() {
    let mut s = session();
    append(&mut s, 0, "v", 0, 30);
    let middle = append(&mut s, 0, "a", 0, 30);
    append(&mut s, 0, "v", 100, 30);
    run(
        &mut s,
        Command::Slide {
            clip: middle,
            delta: f(10),
        },
    );
    assert_eq!(layout(&s, 0), [(0, 40, 0), (40, 30, 0), (70, 20, 110)]);
    run(
        &mut s,
        Command::Slide {
            clip: middle,
            delta: f(-35),
        },
    );
    assert_eq!(layout(&s, 0), [(0, 5, 0), (5, 30, 0), (35, 55, 75)]);
    fails(
        &mut s,
        Command::Slide {
            clip: middle,
            delta: f(-5),
        },
        "shorter than one frame",
    );
}

#[test]
fn linked_clips_on_one_track_slide_together_without_trimming_each_other() {
    let mut s = session();
    let track = track_id(&s, 0);
    let a = append(&mut s, 0, "v", 0, 30);
    let b = ClipId(
        run(
            &mut s,
            Command::Overwrite {
                track,
                at: f(35),
                clip: spec("v", 100, 30),
            },
        )
        .created[0],
    );
    run(&mut s, Command::Link { clips: vec![a, b] });
    // Sliding by the gap's width brings `a` up against where `b` started.
    run(
        &mut s,
        Command::Slide {
            clip: a,
            delta: f(5),
        },
    );
    assert_eq!(layout(&s, 0), [(5, 30, 0), (40, 30, 100)]);
}

#[test]
fn slide_into_a_gap_needs_room() {
    let mut s = session();
    let track = track_id(&s, 0);
    let a = append(&mut s, 0, "v", 0, 30);
    run(
        &mut s,
        Command::Overwrite {
            track,
            at: f(50),
            clip: spec("a", 0, 30),
        },
    );
    run(
        &mut s,
        Command::Slide {
            clip: a,
            delta: f(10),
        },
    );
    assert_eq!(layout(&s, 0), [(10, 30, 0), (50, 30, 0)]);
    fails(
        &mut s,
        Command::Slide {
            clip: a,
            delta: f(11),
        },
        "overlap",
    );
    fails(
        &mut s,
        Command::Slide {
            clip: a,
            delta: f(-11),
        },
        "before 0",
    );
}

// ---- Move ----------------------------------------------------------------------------------

#[test]
fn move_shifts_clips_in_time_and_across_tracks() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let b = append(&mut s, 0, "v", 30, 30);
    run(
        &mut s,
        Command::Move {
            clips: vec![b],
            delta: f(15),
            tracks: 1,
            overwrite: false,
        },
    );
    assert_eq!(layout(&s, 1), [(45, 30, 30)]);
    fails(
        &mut s,
        Command::Move {
            clips: vec![a],
            delta: f(20),
            tracks: 1,
            overwrite: false,
        },
        "land on another clip",
    );
    fails(
        &mut s,
        Command::Move {
            clips: vec![a],
            delta: Flicks::ZERO,
            tracks: 2,
            overwrite: false,
        },
        "no track there",
    );
    fails(
        &mut s,
        Command::Move {
            clips: vec![a],
            delta: f(-1),
            tracks: 0,
            overwrite: false,
        },
        "before 0",
    );
    run(
        &mut s,
        Command::Move {
            clips: vec![a],
            delta: f(20),
            tracks: 1,
            overwrite: true,
        },
    );
    assert_eq!(layout(&s, 1), [(20, 30, 0), (50, 25, 35)]);
    assert!(layout(&s, 0).is_empty());
}

#[test]
fn move_takes_linked_partners_along() {
    let mut s = session();
    let v = append(&mut s, 1, "v", 0, 30);
    let audio = detach_onto(&mut s, v, 0);
    run(
        &mut s,
        Command::Move {
            clips: vec![audio],
            delta: f(12),
            tracks: 0,
            overwrite: false,
        },
    );
    assert_eq!(clip(&s, v).start, f(12));
    assert_eq!(clip(&s, audio).start, f(12));
}

// ---- Links, detach, speed, properties -------------------------------------------------------

#[test]
fn link_and_unlink() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let b = append(&mut s, 1, "a", 0, 30);
    let c = append(&mut s, 1, "a", 30, 30);
    fails(&mut s, Command::Link { clips: vec![a, a] }, "at least two");
    run(&mut s, Command::Link { clips: vec![a, b] });
    run(&mut s, Command::Link { clips: vec![b, c] });
    let link = clip(&s, a).link;
    assert!(link.is_some());
    assert!(
        [b, c].iter().all(|&id| clip(&s, id).link == link),
        "groups merge"
    );
    run(&mut s, Command::Unlink { clips: vec![a, b] });
    assert_eq!(clip(&s, c).link, None, "a group of one is no group");
}

#[test]
fn detach_audio_moves_the_sound_to_a_linked_clip() {
    let mut s = session();
    let v = append(&mut s, 0, "v", 15, 30);
    let outcome = run(
        &mut s,
        Command::DetachAudio {
            clip: v,
            track: None,
        },
    );
    let (audio, track) = (ClipId(outcome.created[0]), TrackId(outcome.created[1]));
    assert_eq!(s.project().tracks.len(), 3);
    assert_eq!(
        s.project().tracks[0].id,
        track,
        "the new track is below the clip's"
    );
    let (video, sound) = (clip(&s, v), clip(&s, audio));
    assert!(video.video && !video.audio);
    assert!(!sound.video && sound.audio);
    assert_eq!(
        (sound.start, sound.duration, sound.source_in),
        (video.start, video.duration, video.source_in)
    );
    assert!(video.link.is_some() && video.link == sound.link);
    fails(
        &mut s,
        Command::DetachAudio {
            clip: v,
            track: None,
        },
        "own sound",
    );
    let still = append(&mut s, 1, "i", 0, 30);
    fails(
        &mut s,
        Command::DetachAudio {
            clip: still,
            track: None,
        },
        "own sound",
    );
}

#[test]
fn detach_audio_onto_a_busy_track_fails() {
    let mut s = session();
    let v = append(&mut s, 1, "v", 0, 30);
    append(&mut s, 0, "a", 20, 30);
    let below = track_id(&s, 0);
    let own = track_id(&s, 1);
    fails(
        &mut s,
        Command::DetachAudio {
            clip: v,
            track: Some(below),
        },
        "has clips where",
    );
    fails(
        &mut s,
        Command::DetachAudio {
            clip: v,
            track: Some(own),
        },
        "different track",
    );
}

#[test]
fn speed_changes_the_length_and_keeps_the_source() {
    let mut s = session();
    let v = append(&mut s, 0, "v", 0, 60);
    run(
        &mut s,
        Command::SetSpeed {
            clip: v,
            speed: Speed { num: 2, den: 1 },
        },
    );
    assert_eq!(
        (clip(&s, v).duration, clip(&s, v).source_out()),
        (f(30), f(60))
    );
    run(
        &mut s,
        Command::SetSpeed {
            clip: v,
            speed: Speed { num: 1, den: 2 },
        },
    );
    assert_eq!(
        (clip(&s, v).duration, clip(&s, v).source_out()),
        (f(120), f(60))
    );
    run(
        &mut s,
        Command::SetSpeed {
            clip: v,
            speed: Speed { num: 3, den: 2 },
        },
    );
    assert_eq!(clip(&s, v).duration, f(40));
    // Splitting a fast clip keeps the source continuous.
    let right = ClipId(
        run(
            &mut s,
            Command::Split {
                at: f(10),
                clips: vec![v],
            },
        )
        .created[0],
    );
    assert_eq!(clip(&s, right).source_in, f(15));
    assert_eq!(clip(&s, right).source_out(), f(60));
    fails(
        &mut s,
        Command::SetSpeed {
            clip: v,
            speed: Speed { num: 4, den: 2 },
        },
        "reduced fraction",
    );
    fails(
        &mut s,
        Command::SetSpeed {
            clip: v,
            speed: Speed { num: 1, den: 20 },
        },
        "reduced fraction",
    );
    let blocker = append(&mut s, 0, "a", 0, 10);
    let _ = blocker;
    fails(
        &mut s,
        Command::SetSpeed {
            clip: right,
            speed: Speed { num: 1, den: 2 },
        },
        "overlap",
    );
    let still = append(&mut s, 0, "i", 0, 30);
    fails(
        &mut s,
        Command::SetSpeed {
            clip: still,
            speed: Speed { num: 2, den: 1 },
        },
        "Stills have no speed",
    );
}

#[test]
fn clip_properties_are_checked_and_set() {
    let mut s = session();
    let v = append(&mut s, 0, "v", 0, 30);
    let transform = Transform {
        x: 120.5,
        rotation: -15.0,
        scale_x: 0.5,
        scale_y: 0.5,
        ..Transform::default()
    };
    let crop = Crop {
        left: 0.1,
        right: 0.2,
        ..Crop::default()
    };
    run(
        &mut s,
        Command::SetClipProperties {
            clip: v,
            properties: ClipProperties {
                transform: Some(transform.into()),
                crop: Some(crop.into()),
                opacity: Some(0.25),
                volume_db: Some(-6.0),
            },
        },
    );
    let c = clip(&s, v);
    assert_eq!(
        (c.transform, c.crop, c.opacity, c.volume_db),
        (transform, crop, 0.25, -6.0)
    );
    // Changing one value keeps the others, so quick edits never undo each other.
    run(
        &mut s,
        Command::SetClipProperties {
            clip: v,
            properties: ClipProperties {
                transform: Some(TransformPatch {
                    y: Some(-40.0),
                    ..TransformPatch::default()
                }),
                crop: Some(CropPatch {
                    top: Some(0.05),
                    ..CropPatch::default()
                }),
                ..Default::default()
            },
        },
    );
    let c = clip(&s, v);
    assert_eq!(
        c.transform,
        Transform {
            y: -40.0,
            ..transform
        }
    );
    assert_eq!(c.crop, Crop { top: 0.05, ..crop });
    let patch: ClipProperties = serde_json::from_str(r#"{"transform":{"scaleX":2}}"#).unwrap();
    assert_eq!(patch.transform.unwrap().scale_x, Some(2.0));
    assert!(serde_json::from_str::<ClipProperties>(r#"{"transform":{"size":2}}"#).is_err());
    for (properties, message) in [
        (
            ClipProperties {
                opacity: Some(1.5),
                ..Default::default()
            },
            "Opacity",
        ),
        (
            ClipProperties {
                volume_db: Some(30.0),
                ..Default::default()
            },
            "Volume",
        ),
        (
            ClipProperties {
                transform: Some(
                    Transform {
                        scale_x: 0.0,
                        ..transform
                    }
                    .into(),
                ),
                ..Default::default()
            },
            "Scale",
        ),
        (
            ClipProperties {
                transform: Some(
                    Transform {
                        x: f64::NAN,
                        ..transform
                    }
                    .into(),
                ),
                ..Default::default()
            },
            "numbers",
        ),
        (
            ClipProperties {
                crop: Some(
                    Crop {
                        left: 0.6,
                        right: 0.5,
                        ..crop
                    }
                    .into(),
                ),
                ..Default::default()
            },
            "nothing",
        ),
    ] {
        fails(
            &mut s,
            Command::SetClipProperties {
                clip: v,
                properties,
            },
            message,
        );
    }
}

// ---- Magnetic main track --------------------------------------------------------------------

/// Detaches `clip`'s sound onto a new track below it and returns the sound clip.
fn detach(session: &mut Session, clip: ClipId) -> ClipId {
    let outcome = run(session, Command::DetachAudio { clip, track: None });
    ClipId(outcome.created[0])
}

#[test]
fn new_projects_have_a_magnetic_main_track_that_stays() {
    let mut s = magnetic_session();
    let main = track_id(&s, 0);
    assert_eq!(s.project().main_track, main);
    assert!(s.project().magnetic);
    let v = append(&mut s, 0, "v", 0, 30);
    detach(&mut s, v);
    assert_eq!(
        s.project().magnetic_index(),
        Some(1),
        "the sound's track went below the main track"
    );
    fails(
        &mut s,
        Command::RemoveTrack { track: main },
        "main track can't be deleted",
    );
    let top = track_id(&s, 2);
    let still = append(&mut s, 2, "i", 0, 30);
    let _ = top;
    fails(
        &mut s,
        Command::DetachAudio {
            clip: still,
            track: Some(main),
        },
        "own sound",
    );
    let other = append(&mut s, 2, "v", 0, 30);
    fails(
        &mut s,
        Command::DetachAudio {
            clip: other,
            track: Some(main),
        },
        "magnetic main track",
    );
}

#[test]
fn deleting_on_the_main_track_closes_the_gap_and_linked_clips_follow() {
    let mut s = magnetic_session();
    let a = append(&mut s, 0, "v", 0, 30);
    append(&mut s, 0, "v", 100, 30);
    let c = append(&mut s, 0, "v", 200, 30);
    detach(&mut s, c);
    // Unlinked music on the sound track stays where it is.
    let sounds = track_id(&s, 0);
    run(
        &mut s,
        Command::Overwrite {
            track: sounds,
            at: f(0),
            clip: spec("a", 0, 20),
        },
    );
    assert_eq!(layout(&s, 0), [(0, 20, 0), (60, 30, 200)]);
    run(&mut s, Command::Delete { clips: vec![a] });
    assert_eq!(layout(&s, 1), [(0, 30, 100), (30, 30, 200)]);
    assert_eq!(layout(&s, 0), [(0, 20, 0), (30, 30, 200)]);
    assert!(s.undo());
    assert_eq!(layout(&s, 1), [(0, 30, 0), (30, 30, 100), (60, 30, 200)]);
    // Ripple delete on the main track does the same: other tracks keep their gaps.
    run(&mut s, Command::RippleDelete { clips: vec![a] });
    assert_eq!(layout(&s, 0), [(0, 20, 0), (30, 30, 200)]);
}

#[test]
fn inserts_and_overwrites_on_the_main_track_land_on_the_nearest_cut() {
    let mut s = magnetic_session();
    append(&mut s, 0, "v", 0, 30);
    let b = append(&mut s, 0, "v", 100, 30);
    detach(&mut s, b);
    let main = track_id(&s, 1);
    // Frame 40 is nearer the cut at 30 than the one at 60: the sound of b moves on too.
    run(
        &mut s,
        Command::Insert {
            track: main,
            at: f(40),
            clip: spec("a", 0, 10),
        },
    );
    assert_eq!(layout(&s, 1), [(0, 30, 0), (30, 10, 0), (40, 30, 100)]);
    assert_eq!(layout(&s, 0), [(40, 30, 100)]);
    // Past the end, a clip goes at the end.
    run(
        &mut s,
        Command::Overwrite {
            track: main,
            at: f(500),
            clip: spec("v", 0, 5),
        },
    );
    assert_eq!(layout(&s, 1)[3], (70, 5, 0));
    // An overwrite at a cut replaces what follows it.
    run(
        &mut s,
        Command::Overwrite {
            track: main,
            at: f(29),
            clip: spec("i", 0, 15),
        },
    );
    assert_eq!(
        layout(&s, 1),
        [(0, 30, 0), (30, 15, 0), (45, 25, 105), (70, 5, 0)]
    );
}

#[test]
fn trims_on_the_main_track_ripple_and_linked_clips_keep_in_step() {
    let mut s = magnetic_session();
    let a = append(&mut s, 0, "v", 10, 30);
    let b = append(&mut s, 0, "v", 100, 30);
    detach(&mut s, a);
    let sounds = track_id(&s, 0);
    let b_sound = detach_onto(&mut s, b, 0);
    run(
        &mut s,
        Command::Overwrite {
            track: sounds,
            at: f(200),
            clip: spec("a", 0, 10),
        },
    );
    let trim = |s: &mut Session, clip: ClipId, edge: Edge, frames: i64| {
        run(
            s,
            Command::Trim {
                clip,
                edge,
                delta: f(frames),
                ripple: false,
            },
        );
    };
    trim(&mut s, a, Edge::End, -10);
    assert_eq!(layout(&s, 1), [(0, 20, 10), (20, 30, 100)]);
    assert_eq!(layout(&s, 0), [(0, 20, 10), (20, 30, 100), (200, 10, 0)]);
    trim(&mut s, a, Edge::Start, 5);
    assert_eq!(layout(&s, 1), [(0, 15, 15), (15, 30, 100)]);
    assert_eq!(layout(&s, 0), [(0, 15, 15), (15, 30, 100), (200, 10, 0)]);
    // Longer clips push the later ones (and their sound) along.
    trim(&mut s, a, Edge::Start, -10);
    assert_eq!(layout(&s, 1), [(0, 25, 5), (25, 30, 100)]);
    trim(&mut s, b_sound, Edge::End, 10);
    assert_eq!(layout(&s, 1), [(0, 25, 5), (25, 40, 100)]);
    assert_eq!(layout(&s, 0), [(0, 25, 5), (25, 40, 100), (200, 10, 0)]);
    // A ripple trim on the main track leaves other tracks alone as well.
    run(
        &mut s,
        Command::Trim {
            clip: a,
            edge: Edge::End,
            delta: f(-5),
            ripple: true,
        },
    );
    assert_eq!(layout(&s, 0), [(0, 20, 5), (20, 40, 100), (200, 10, 0)]);
}

#[test]
fn moving_on_the_main_track_reorders_and_linked_clips_follow() {
    let mut s = magnetic_session();
    let a = append(&mut s, 0, "v", 0, 30);
    append(&mut s, 0, "v", 100, 30);
    append(&mut s, 0, "v", 200, 30);
    let sound = detach(&mut s, a);
    let move_by = |s: &mut Session, clip: ClipId, frames: i64| {
        run(
            s,
            Command::Move {
                clips: vec![clip],
                delta: f(frames),
                tracks: 0,
                overwrite: false,
            },
        );
    };
    // With a lifted out, frame 50 is nearer the cut at 60 (c's start) than b's at 30.
    move_by(&mut s, a, 50);
    assert_eq!(layout(&s, 1), [(0, 30, 100), (30, 30, 0), (60, 30, 200)]);
    assert_eq!(layout(&s, 0), [(30, 30, 0)]);
    // A short drag lands back on the cut it came from.
    move_by(&mut s, a, 10);
    assert_eq!(layout(&s, 1), [(0, 30, 100), (30, 30, 0), (60, 30, 200)]);
    move_by(&mut s, a, -25);
    assert_eq!(layout(&s, 1), [(0, 30, 0), (30, 30, 100), (60, 30, 200)]);
    // Moving the linked sound moves its main-track clip, so the two stay together.
    move_by(&mut s, sound, 1000);
    assert_eq!(layout(&s, 1), [(0, 30, 100), (30, 30, 200), (60, 30, 0)]);
    assert_eq!(layout(&s, 0), [(60, 30, 0)]);
}

#[test]
fn clips_moved_onto_the_main_track_are_inserted_and_moved_off_close_the_gap() {
    let mut s = magnetic_session();
    append(&mut s, 0, "v", 0, 30);
    append(&mut s, 0, "v", 100, 30);
    let title = append(&mut s, 1, "i", 0, 20);
    run(
        &mut s,
        Command::Move {
            clips: vec![title],
            delta: f(28),
            tracks: -1,
            overwrite: true,
        },
    );
    assert_eq!(layout(&s, 0), [(0, 30, 0), (30, 20, 0), (50, 30, 100)]);
    assert!(layout(&s, 1).is_empty());
    run(
        &mut s,
        Command::Move {
            clips: vec![title],
            delta: f(0),
            tracks: 1,
            overwrite: false,
        },
    );
    assert_eq!(layout(&s, 0), [(0, 30, 0), (30, 30, 100)]);
    assert_eq!(layout(&s, 1), [(30, 20, 0)]);
}

#[test]
fn turning_magnetism_on_closes_the_main_track_gaps() {
    let mut s = session();
    assert!(!s.project().magnetic);
    let main = track_id(&s, 0);
    append(&mut s, 0, "v", 0, 30);
    let b = append(&mut s, 0, "v", 100, 30);
    run(
        &mut s,
        Command::Move {
            clips: vec![b],
            delta: f(20),
            tracks: 0,
            overwrite: false,
        },
    );
    assert_eq!(layout(&s, 0), [(0, 30, 0), (50, 30, 100)]);
    run(&mut s, Command::SetMagnetic { magnetic: true });
    assert_eq!(layout(&s, 0), [(0, 30, 0), (30, 30, 100)]);
    assert!(s.undo());
    assert_eq!(layout(&s, 0), [(0, 30, 0), (50, 30, 100)]);
    run(
        &mut s,
        Command::SetTrackLocked {
            track: main,
            locked: true,
        },
    );
    fails(&mut s, Command::SetMagnetic { magnetic: true }, "locked");
}

#[test]
fn a_main_track_edit_that_would_move_a_locked_partner_fails() {
    let mut s = magnetic_session();
    let a = append(&mut s, 0, "v", 0, 30);
    let b = append(&mut s, 0, "v", 100, 30);
    let sound = detach(&mut s, b);
    let sounds = s.project().clip(sound).unwrap().0;
    let track = track_id(&s, sounds);
    run(
        &mut s,
        Command::SetTrackLocked {
            track,
            locked: true,
        },
    );
    fails(&mut s, Command::Delete { clips: vec![a] }, "locked");
}

#[test]
fn linked_partners_move_in_time_but_keep_their_tracks() {
    let mut s = session();
    let v = append(&mut s, 1, "v", 0, 30);
    let sound = detach_onto(&mut s, v, 0);
    run(
        &mut s,
        Command::AddTrack {
            index: 2,
            name: None,
        },
    );
    run(
        &mut s,
        Command::Move {
            clips: vec![v],
            delta: f(10),
            tracks: 1,
            overwrite: false,
        },
    );
    assert_eq!(s.project().clip(v).unwrap().0, 2);
    assert_eq!(s.project().clip(sound).unwrap().0, 0);
    assert_eq!(clip(&s, sound).start, f(10));
}

#[test]
fn clips_can_be_placed_with_a_speed_and_properties() {
    let mut s = magnetic_session();
    let main = track_id(&s, 0);
    let pasted = ClipSpec {
        speed: Some(Speed { num: 2, den: 1 }),
        properties: Some(ClipProperties {
            opacity: Some(0.5),
            volume_db: Some(-6.0),
            ..ClipProperties::default()
        }),
        ..spec("v", 30, 60)
    };
    let id = ClipId(
        run(
            &mut s,
            Command::Append {
                track: main,
                clip: pasted.clone(),
            },
        )
        .created[0],
    );
    let placed = clip(&s, id);
    assert_eq!(placed.speed, Speed { num: 2, den: 1 });
    assert_eq!((placed.duration, placed.source_out()), (f(60), f(150)));
    assert_eq!((placed.opacity, placed.volume_db), (0.5, -6.0));
    fails(
        &mut s,
        Command::Append {
            track: main,
            clip: ClipSpec {
                media: "i".into(),
                source_in: Flicks::ZERO,
                ..pasted.clone()
            },
        },
        "Stills have no speed",
    );
    fails(
        &mut s,
        Command::Append {
            track: main,
            clip: ClipSpec {
                properties: Some(ClipProperties {
                    opacity: Some(2.0),
                    ..ClipProperties::default()
                }),
                ..pasted
            },
        },
        "Opacity",
    );
}

// ---- Markers -------------------------------------------------------------------------------

#[test]
fn markers_snap_sort_change_and_go() {
    let mut s = session();
    let late = MarkerId(
        run(
            &mut s,
            Command::AddMarker {
                at: f(90),
                name: "End".into(),
                color: MarkerColor::Red,
            },
        )
        .created[0],
    );
    let early = MarkerId(
        run(
            &mut s,
            Command::AddMarker {
                at: Flicks(FRAME * 10 + 7),
                name: "Start".into(),
                color: MarkerColor::Blue,
            },
        )
        .created[0],
    );
    let times: Vec<_> = s.project().markers.iter().map(|m| (m.id, m.time)).collect();
    assert_eq!(times, [(early, f(10)), (late, f(90))]);
    run(
        &mut s,
        Command::UpdateMarker {
            marker: early,
            at: Some(f(100)),
            name: Some("Later".into()),
            color: None,
        },
    );
    assert_eq!(s.project().markers[1].name, "Later");
    assert_eq!(s.project().markers[1].color, MarkerColor::Blue);
    run(&mut s, Command::RemoveMarker { marker: late });
    assert_eq!(s.project().markers.len(), 1);
    fails(&mut s, Command::RemoveMarker { marker: late }, "No marker");
    fails(
        &mut s,
        Command::AddMarker {
            at: f(-1),
            name: String::new(),
            color: MarkerColor::Red,
        },
        "starts at 0",
    );
}

// ---- Session: undo, redo, groups, save state -----------------------------------------------

#[test]
fn undo_and_redo_step_through_history() {
    let mut s = session();
    let empty = s.project().clone();
    let id = append(&mut s, 0, "v", 0, 30);
    let one = s.project().clone();
    run(
        &mut s,
        Command::Split {
            at: f(10),
            clips: vec![id],
        },
    );
    let two = s.project().clone();
    assert_eq!(s.undo_label(), Some("Split"));
    assert!(s.undo());
    assert_eq!(s.project(), &one);
    assert_eq!(s.snapshot().redo_label, Some("Split"));
    assert!(s.undo());
    assert_eq!(s.project(), &empty);
    assert!(!s.undo());
    assert!(s.redo() && s.redo());
    assert_eq!(s.project(), &two);
    assert!(!s.redo());
    // A new edit after undo drops the redo stack.
    s.undo();
    append(&mut s, 1, "a", 0, 10);
    assert!(!s.can_redo());
}

#[test]
fn a_group_is_one_undo_step_and_can_be_cancelled() {
    let mut s = session();
    let id = append(&mut s, 0, "v", 0, 30);
    let before = s.project().clone();
    s.begin_group("Drag");
    for _ in 0..5 {
        run(
            &mut s,
            Command::Move {
                clips: vec![id],
                delta: f(2),
                tracks: 0,
                overwrite: false,
            },
        );
    }
    s.begin_group("nested");
    run(
        &mut s,
        Command::Move {
            clips: vec![id],
            delta: f(2),
            tracks: 0,
            overwrite: false,
        },
    );
    s.end_group();
    assert!(s.snapshot().grouping);
    s.end_group();
    assert_eq!(clip(&s, id).start, f(12));
    assert_eq!(s.history_len(), (2, 0));
    assert_eq!(s.undo_label(), Some("Drag"));
    s.undo();
    assert_eq!(s.project(), &before);

    s.begin_group("Drag");
    run(
        &mut s,
        Command::Move {
            clips: vec![id],
            delta: f(2),
            tracks: 0,
            overwrite: false,
        },
    );
    s.cancel_group();
    assert_eq!(s.project(), &before);
    assert_eq!(s.history_len(), (1, 1));
}

#[test]
fn a_gesture_previews_each_step_from_where_it_began() {
    let mut s = magnetic_session();
    let a = append(&mut s, 0, "v", 0, 30);
    append(&mut s, 0, "v", 100, 30);
    let (before, start) = (s.project().clone(), s.generation());
    let drag = |frames: i64| Command::Move {
        clips: vec![a],
        delta: f(frames),
        tracks: 0,
        overwrite: false,
    };
    assert!(s.preview(&drag(20)).is_err(), "no gesture is open");
    s.begin_group("Move");
    s.preview(&drag(50)).unwrap();
    assert_eq!(layout(&s, 0), [(0, 30, 100), (30, 30, 0)]);
    let swapped = s.generation();
    // Each preview starts again from the state before the gesture.
    s.preview(&drag(5)).unwrap();
    assert_eq!(s.project(), &before);
    assert_eq!(s.generation(), start);
    s.preview(&drag(50)).unwrap();
    assert_ne!(s.generation(), swapped);
    // A step that cannot apply keeps the previous one.
    let nowhere = Command::Move {
        clips: vec![a],
        delta: f(0),
        tracks: 5,
        overwrite: false,
    };
    assert!(s.preview(&nowhere).is_err());
    assert_eq!(layout(&s, 0), [(0, 30, 100), (30, 30, 0)]);
    s.end_group();
    assert_eq!(s.history_len(), (3, 0), "two appends and one move");
    assert_eq!(s.undo_label(), Some("Move"));
    s.undo();
    assert_eq!((s.project(), s.generation()), (&before, start));
}

#[test]
fn edits_that_change_nothing_leave_no_step() {
    let mut s = session();
    let track = track_id(&s, 0);
    run(
        &mut s,
        Command::SetTrackMuted {
            track,
            muted: false,
        },
    );
    assert_eq!(s.history_len(), (0, 0));
    assert!(!s.is_dirty());
    s.begin_group("Nothing");
    run(&mut s, Command::SetTrackMuted { track, muted: true });
    run(
        &mut s,
        Command::SetTrackMuted {
            track,
            muted: false,
        },
    );
    s.end_group();
    assert_eq!(s.history_len(), (0, 0));
    assert!(!s.is_dirty(), "back where it started");
}

#[test]
fn dirty_follows_the_saved_state_through_undo() {
    let mut s = session();
    assert!(!s.is_dirty());
    append(&mut s, 0, "v", 0, 30);
    assert!(s.is_dirty() && s.needs_autosave());
    s.mark_autosaved();
    assert!(s.is_dirty() && !s.needs_autosave());
    s.mark_saved();
    assert!(!s.is_dirty());
    append(&mut s, 0, "v", 0, 30);
    assert!(s.is_dirty());
    s.undo();
    assert!(!s.is_dirty(), "undo back to the saved state");
    s.undo();
    assert!(s.is_dirty());
    let recovered = Session::recovered(s.project().clone());
    assert!(recovered.is_dirty());
}

#[test]
fn a_save_that_ends_after_more_edits_marks_the_state_it_wrote() {
    let mut s = session();
    append(&mut s, 0, "v", 0, 30);
    let written = s.generation();
    append(&mut s, 0, "v", 0, 30);
    s.mark_saved_at(written);
    assert!(s.is_dirty() && s.needs_autosave());
    s.undo();
    assert!(!s.is_dirty(), "the written state is the saved one");
    s.mark_autosaved_at(s.generation());
    s.redo();
    assert!(s.needs_autosave());
}

#[test]
fn relinking_media_reaches_every_undo_step() {
    let mut s = session();
    append(&mut s, 0, "v", 0, 30);
    append(&mut s, 0, "v", 30, 30);
    s.mark_saved();
    let mut moved = s.project().media("v").unwrap().clone();
    moved.location = MediaLocation::Path {
        path: "D:\\new\\v.file".into(),
    };
    s.update_media(moved.clone()).unwrap();
    assert!(s.is_dirty());
    s.undo();
    s.undo();
    assert_eq!(s.project().media("v"), Some(&moved));
    s.redo();
    assert_eq!(s.project().media("v"), Some(&moved));
    moved.id = "zzz".into();
    assert!(s.update_media(moved).is_err());
}

// ---- Queries ---------------------------------------------------------------------------------

#[test]
fn clips_at_and_track_ranges() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    let b = append(&mut s, 0, "a", 0, 30);
    let top = append(&mut s, 1, "i", 0, 45);
    let at = |t: i64| -> Vec<ClipId> {
        query::clips_at(s.project(), f(t))
            .iter()
            .map(|c| c.clip.id)
            .collect()
    };
    assert_eq!(at(0), [a, top]);
    assert_eq!(at(29), [a, top]);
    assert_eq!(at(30), [b, top]);
    assert_eq!(at(45), [b]);
    assert!(at(60).is_empty());
    let ranges = query::track_ranges(s.project());
    assert_eq!(
        ranges.iter().map(|r| (r.start, r.end)).collect::<Vec<_>>(),
        [(f(0), f(60)), (f(0), f(45))]
    );
    assert_eq!(s.project().duration(), f(60));
}

#[test]
fn snap_points_include_edges_markers_and_the_playhead() {
    let mut s = session();
    let a = append(&mut s, 0, "v", 0, 30);
    append(&mut s, 1, "a", 0, 45);
    run(
        &mut s,
        Command::AddMarker {
            at: f(50),
            name: String::new(),
            color: MarkerColor::Yellow,
        },
    );
    let points = query::snap_points(s.project(), Some(f(12)), &[a]);
    assert_eq!(points, [f(0), f(12), f(45), f(50)]);
    assert_eq!(query::snap(&points, f(47), f(3)), Some(f(45)));
    assert_eq!(query::snap(&points, f(48), f(3)), Some(f(50)));
    assert_eq!(query::snap(&points, f(30), f(3)), None);
    assert_eq!(query::snap(&points, f(-2), f(3)), Some(f(0)));
}

// ---- Files -------------------------------------------------------------------------------------

#[test]
fn save_then_load_gives_an_identical_project() {
    let mut s = session();
    let v = append(&mut s, 0, "v", 0, 60);
    run(
        &mut s,
        Command::DetachAudio {
            clip: v,
            track: None,
        },
    );
    run(
        &mut s,
        Command::SetSpeed {
            clip: v,
            speed: Speed { num: 3, den: 2 },
        },
    );
    run(
        &mut s,
        Command::SetClipProperties {
            clip: v,
            properties: ClipProperties {
                transform: Some(
                    Transform {
                        x: 0.1 + 0.2,
                        rotation: 1.0 / 3.0,
                        ..Transform::default()
                    }
                    .into(),
                ),
                opacity: Some(0.7),
                volume_db: Some(-3.0103),
                crop: None,
            },
        },
    );
    run(
        &mut s,
        Command::AddMarker {
            at: f(5),
            name: "Ünïcode ✓".into(),
            color: MarkerColor::Purple,
        },
    );
    let text = file::to_json(s.project());
    let loaded = file::from_json(&text).unwrap();
    assert_eq!(&loaded, s.project());
    assert_eq!(file::to_json(&loaded), text);
}

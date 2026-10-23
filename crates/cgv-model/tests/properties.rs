//! Property tests: random edit sequences keep every timeline rule, each step undoes
//! and redoes exactly, and whole histories unwind to the original project.
mod common;

use std::collections::{BTreeMap, BTreeSet};

use cgv_model::*;
use cgv_time::{Flicks, FrameRate};
use common::{random_command, session, Rng};
use proptest::prelude::*;

/// The rules that hold after any sequence of successful commands.
fn check_rules(project: &Project, frame_rate_changed: bool) {
    validate(project).unwrap_or_else(|error| panic!("invalid project: {error}"));
    let frame = project.settings.frame_duration().0;
    for clip in project.clips() {
        if !frame_rate_changed {
            assert_eq!(
                clip.start.0 % frame,
                0,
                "clip {} starts between frames",
                clip.id
            );
            assert_eq!(
                clip.duration.0 % frame,
                0,
                "clip {} ends between frames",
                clip.id
            );
            assert!(
                clip.duration.0 >= frame,
                "clip {} is under a frame",
                clip.id
            );
        }
        let media = project.media(&clip.media).unwrap();
        if !media.is_still() {
            assert!(
                clip.source_in >= Flicks::ZERO,
                "clip {} starts before its media",
                clip.id
            );
            assert!(
                clip.source_out() <= media.duration + SOURCE_SLACK,
                "clip {} runs past its media",
                clip.id
            );
        }
    }
}

/// The same clip in the same place. Links may differ: removing one clip of a pair
/// leaves the other unlinked, wherever it is.
fn kept(clip: &Clip, clips: &[Clip]) -> bool {
    clips.iter().any(|other| {
        Clip {
            link: None,
            ..other.clone()
        } == Clip {
            link: None,
            ..clip.clone()
        }
    })
}

fn covered(track: &Track) -> Flicks {
    track
        .clips
        .iter()
        .fold(Flicks::ZERO, |sum, clip| sum + clip.duration)
}

/// What each kind of command promises beyond the general rules.
fn check_effects(before: &Project, after: &Project, command: &Command, outcome: &Outcome) {
    for track in before.tracks.iter().filter(|track| track.locked) {
        if let Some(now) = after.track(track.id) {
            assert_eq!(
                now.clips.len(),
                track.clips.len(),
                "{command:?} changed a locked track"
            );
            for clip in &track.clips {
                assert!(kept(clip, &now.clips), "{command:?} changed a locked track");
            }
        }
    }
    match command {
        Command::Split { .. } => {
            assert_eq!(
                after.clips().count(),
                before.clips().count() + outcome.created.len()
            );
            for track in &before.tracks {
                let now = after.track(track.id).unwrap();
                assert_eq!(
                    covered(now),
                    covered(track),
                    "split changed what a track covers"
                );
                assert_eq!(now.range(), track.range());
            }
        }
        Command::Slip { .. } => {
            for track in &before.tracks {
                let now = after.track(track.id).unwrap();
                let timeline = |t: &Track| -> Vec<_> {
                    t.clips
                        .iter()
                        .map(|c| (c.id, c.start, c.duration))
                        .collect()
                };
                assert_eq!(
                    timeline(now),
                    timeline(track),
                    "slip moved something on the timeline"
                );
            }
        }
        Command::Delete { .. } => {
            for track in &before.tracks {
                let now = after.track(track.id).unwrap();
                for clip in &now.clips {
                    assert!(kept(clip, &track.clips), "delete changed a clip it kept");
                }
            }
        }
        Command::RippleDelete { .. } => {
            for track in &before.tracks {
                let now = after.track(track.id).unwrap();
                let kept: BTreeSet<ClipId> = now.clips.iter().map(|c| c.id).collect();
                let removed: Vec<&Clip> = track
                    .clips
                    .iter()
                    .filter(|c| !kept.contains(&c.id))
                    .collect();
                for old in track.clips.iter().filter(|c| kept.contains(&c.id)) {
                    let closed = removed
                        .iter()
                        .filter(|r| r.end() <= old.start)
                        .fold(Flicks::ZERO, |sum, r| sum + r.duration);
                    let new = &now.clips[now.position(old.id).unwrap()];
                    assert_eq!(
                        new.start,
                        old.start - closed,
                        "ripple delete closed the wrong gap"
                    );
                    assert_eq!((new.duration, new.source_in), (old.duration, old.source_in));
                }
            }
        }
        Command::Insert { track, .. } => {
            let (index, new) = after.clip(ClipId(outcome.created[0])).unwrap();
            assert_eq!(after.tracks[index].id, *track);
            let old = before.track(*track).unwrap();
            let now = after.track(*track).unwrap();
            assert_eq!(covered(now), covered(old) + new.duration);
            let expected_end = match old.end() {
                Some(end) if end > new.start => end + new.duration,
                _ => new.end(),
            };
            assert_eq!(now.end(), Some(expected_end));
            for clip in old.clips.iter().filter(|c| c.end() <= new.start) {
                assert!(kept(clip, &now.clips), "insert moved a clip before it");
            }
        }
        Command::Append { track, .. } => {
            let (_, new) = after.clip(ClipId(outcome.created[0])).unwrap();
            let old = before.track(*track).unwrap();
            assert_eq!(new.start, old.end().unwrap_or(Flicks::ZERO));
            for clip in &old.clips {
                assert!(kept(clip, &after.track(*track).unwrap().clips));
            }
        }
        Command::Overwrite { track, .. } => {
            let (_, new) = after.clip(ClipId(outcome.created[0])).unwrap();
            let old = before.track(*track).unwrap();
            let now = after.track(*track).unwrap();
            for clip in old
                .clips
                .iter()
                .filter(|c| c.end() <= new.start || c.start >= new.end())
            {
                assert!(
                    kept(clip, &now.clips),
                    "overwrite touched a clip outside its range"
                );
            }
        }
        Command::Move {
            clips,
            delta,
            tracks,
            ..
        } => {
            // The named clips and their partners keep their content and move together.
            let frame = before.settings.frame_duration().0;
            let delta = Flicks((delta.0 as f64 / frame as f64).round() as i64 * frame);
            let links: BTreeSet<LinkId> = clips
                .iter()
                .filter_map(|id| before.clip(*id).and_then(|(_, c)| c.link))
                .collect();
            for (old_index, track) in before.tracks.iter().enumerate() {
                for old in track
                    .clips
                    .iter()
                    .filter(|c| clips.contains(&c.id) || c.link.is_some_and(|l| links.contains(&l)))
                {
                    let (index, new) = after.clip(old.id).unwrap();
                    assert_eq!(new.start, old.start + delta, "move went the wrong distance");
                    assert_eq!((new.duration, new.source_in), (old.duration, old.source_in));
                    assert_eq!(index as i64, old_index as i64 + *tracks as i64);
                }
            }
        }
        Command::Roll { clip, .. } => {
            let (index, rolled) = before.clip(*clip).unwrap();
            if rolled.link.is_none() {
                let (old, now) = (
                    &before.tracks[index],
                    after.track(before.tracks[index].id).unwrap(),
                );
                assert_eq!(
                    covered(now),
                    covered(old),
                    "a roll changed what the track covers"
                );
                assert_eq!(now.range(), old.range());
            }
        }
        Command::Slide { clip, .. } => {
            let (_, old) = before.clip(*clip).unwrap();
            let (_, new) = after.clip(*clip).unwrap();
            assert_eq!((new.duration, new.source_in), (old.duration, old.source_in));
        }
        Command::Trim {
            clip,
            ripple: false,
            ..
        } => {
            let group: BTreeSet<ClipId> = match before.clip(*clip).unwrap().1.link {
                Some(link) => before
                    .clips()
                    .filter(|c| c.link == Some(link))
                    .map(|c| c.id)
                    .collect(),
                None => [*clip].into(),
            };
            for old in before.clips().filter(|c| !group.contains(&c.id)) {
                assert_eq!(
                    after.clip(old.id).map(|(_, c)| c),
                    Some(old),
                    "trim changed another clip"
                );
            }
        }
        _ => {}
    }
}

struct Run {
    applied: usize,
    unchanged: usize,
    rejected: BTreeMap<&'static str, usize>,
    kinds: BTreeMap<&'static str, usize>,
}

/// Applies random commands until `target` have changed the project, checking every
/// rule and an exact undo and redo after each one. Returns the states in order.
fn random_history(session: &mut Session, rng: &mut Rng, target: usize) -> (Vec<Project>, Run) {
    let mut states = vec![session.project().clone()];
    let mut run = Run {
        applied: 0,
        unchanged: 0,
        rejected: BTreeMap::new(),
        kinds: BTreeMap::new(),
    };
    let mut frame_rate_changed = false;
    let mut attempts = 0;
    while run.applied < target {
        attempts += 1;
        assert!(attempts < target * 50 + 100, "too few commands apply");
        let before = session.project().clone();
        let command = random_command(&before, rng);
        match session.execute(&command) {
            Err(_) => {
                assert_eq!(
                    session.project(),
                    &before,
                    "a failed {command:?} changed the project"
                );
                *run.rejected.entry(command.label()).or_default() += 1;
            }
            Ok(_) if session.project() == &before => run.unchanged += 1,
            Ok(outcome) => {
                let after = session.project().clone();
                frame_rate_changed |= after.settings.frame_rate != FrameRate::FPS_30;
                check_rules(&after, frame_rate_changed);
                check_effects(&before, &after, &command, &outcome);
                assert!(session.undo());
                assert_eq!(
                    session.project(),
                    &before,
                    "undo of {command:?} is not exact"
                );
                assert!(session.redo());
                assert_eq!(
                    session.project(),
                    &after,
                    "redo of {command:?} is not exact"
                );
                run.applied += 1;
                *run.kinds.entry(command.label()).or_default() += 1;
                states.push(after);
            }
        }
    }
    (states, run)
}

fn check_file_round_trip(project: &Project) {
    let text = file::to_json(project);
    let loaded = file::from_json(&text).unwrap();
    assert_eq!(&loaded, project, "save then load changed the project");
    assert_eq!(
        file::to_json(&loaded),
        text,
        "saving again changed the file"
    );
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 128, ..ProptestConfig::default() })]

    #[test]
    fn random_edits_keep_every_rule_and_undo_exactly(seed in any::<u64>(), steps in 1usize..120) {
        let mut session = session();
        let original = session.project().clone();
        let mut rng = Rng(seed);
        let (states, _) = random_history(&mut session, &mut rng, steps);
        check_file_round_trip(session.project());
        for state in states.iter().rev().skip(1) {
            prop_assert!(session.undo());
            prop_assert_eq!(session.project(), state);
        }
        prop_assert_eq!(session.project(), &original);
        prop_assert!(!session.is_dirty());
        while session.redo() {}
        prop_assert_eq!(session.project(), states.last().unwrap());
    }
}

#[test]
fn a_thousand_random_commands_then_a_thousand_undos_restore_the_original_exactly() {
    for seed in [1, 2, 3, 0xC0FFEE] {
        let mut session = session();
        let original = session.project().clone();
        let mut rng = Rng(seed);
        let (states, run) = random_history(&mut session, &mut rng, 1000);
        let end = session.project().clone();
        check_file_round_trip(&end);
        assert_eq!(session.history_len(), (1000, 0));
        for (undone, state) in states.iter().rev().skip(1).enumerate() {
            assert!(session.undo(), "undo {} of 1000", undone + 1);
            assert_eq!(session.project(), state);
        }
        assert!(!session.undo());
        assert_eq!(
            session.project(),
            &original,
            "seed {seed}: 1,000 undos did not restore the original"
        );
        assert_eq!(file::to_json(session.project()), file::to_json(&original));
        assert!(!session.is_dirty());
        for _ in 0..1000 {
            assert!(session.redo());
        }
        assert_eq!(session.project(), &end);
        eprintln!(
            "seed {seed}: 1000 applied, {} no-ops, {} rejected {:?}; end state {} tracks, {} clips, {} markers, {} media; kinds {:?}",
            run.unchanged,
            run.rejected.values().sum::<usize>(),
            run.rejected,
            end.tracks.len(),
            end.clips().count(),
            end.markers.len(),
            end.media.len(),
            run.kinds,
        );
    }
}

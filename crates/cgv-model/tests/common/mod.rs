//! Shared test support: a small project with media, and a random command generator
//! that aims at clip edges and existing ids so most commands are meaningful.
#![allow(dead_code)]

use cgv_model::*;
use cgv_time::{Flicks, FrameRate};

/// One frame at 30 fps.
pub const FRAME: i64 = 23_520_000;

pub fn f(frames: i64) -> Flicks {
    Flicks(frames * FRAME)
}

pub fn media(id: &str, kind: MediaKind, seconds: i64) -> MediaRef {
    let (has_video, has_audio) = match kind {
        MediaKind::Video => (true, true),
        MediaKind::Audio => (false, true),
        MediaKind::Image => (true, false),
    };
    MediaRef {
        id: id.into(),
        name: format!("{id}.file"),
        kind,
        duration: if kind == MediaKind::Image {
            Flicks::ZERO
        } else {
            Flicks(seconds * 705_600_000)
        },
        has_video,
        has_audio,
        width: if has_video { 1920 } else { 0 },
        height: if has_video { 1080 } else { 0 },
        frame_rate: has_video.then_some(FrameRate::FPS_30),
        size: 1000,
        modified: Some(1_700_000_000_000),
        location: MediaLocation::Path {
            path: format!("C:\\media\\{id}.file"),
        },
    }
}

/// A project with a 20 s video with sound ("v"), a 30 s audio file ("a") and a
/// still ("i"), its two free tracks and an empty history.
pub fn session() -> Session {
    session_with(false)
}

/// [`session`] with the bottom track as the magnetic main track.
pub fn magnetic_session() -> Session {
    session_with(true)
}

pub fn session_with(magnetic: bool) -> Session {
    let mut session = Session::new(Project::new("test-project", "Test"));
    session.execute(&Command::SetMagnetic { magnetic }).unwrap();
    for media in [
        media("v", MediaKind::Video, 20),
        media("a", MediaKind::Audio, 30),
        media("i", MediaKind::Image, 0),
    ] {
        session.execute(&Command::AddMedia { media }).unwrap();
    }
    Session::new(session.project().clone())
}

pub fn track_id(session: &Session, index: usize) -> TrackId {
    session.project().tracks[index].id
}

pub fn spec(media: &str, source_in: i64, frames: i64) -> ClipSpec {
    ClipSpec {
        media: media.into(),
        source_in: f(source_in),
        duration: f(frames),
        video: None,
        audio: None,
        speed: None,
        properties: None,
    }
}

/// Appends `frames` of `media` (from source frame `source_in`) to track `index`.
pub fn append(
    session: &mut Session,
    index: usize,
    media: &str,
    source_in: i64,
    frames: i64,
) -> ClipId {
    let track = track_id(session, index);
    let outcome = session
        .execute(&Command::Append {
            track,
            clip: spec(media, source_in, frames),
        })
        .unwrap();
    ClipId(outcome.created[0])
}

/// Detaches `clip`'s sound onto track `index` and returns the new audio clip.
pub fn detach_onto(session: &mut Session, clip: ClipId, index: usize) -> ClipId {
    let track = Some(track_id(session, index));
    ClipId(
        session
            .execute(&Command::DetachAudio { clip, track })
            .unwrap()
            .created[0],
    )
}

/// (start, duration, source in) of each clip on track `index`, in frames.
pub fn layout(session: &Session, index: usize) -> Vec<(i64, i64, i64)> {
    session.project().tracks[index]
        .clips
        .iter()
        .map(|c| {
            (
                c.start.0 / FRAME,
                c.duration.0 / FRAME,
                c.source_in.0 / FRAME,
            )
        })
        .collect()
}

pub fn clip(session: &Session, id: ClipId) -> Clip {
    session.project().clip(id).expect("clip exists").1.clone()
}

/// SplitMix64: small, fast and reproducible.
pub struct Rng(pub u64);

impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }
    pub fn range(&mut self, low: i64, high: i64) -> i64 {
        low + self.below((high - low + 1) as u64) as i64
    }
    pub fn percent(&mut self, p: u64) -> bool {
        self.below(100) < p
    }
    pub fn pick<T: Copy>(&mut self, items: &[T]) -> Option<T> {
        (!items.is_empty()).then(|| items[self.below(items.len() as u64) as usize])
    }
}

fn frame(project: &Project) -> i64 {
    project.settings.frame_duration().0
}

/// A time near something interesting: a clip edge, a marker, or anywhere, sometimes off the frame grid.
fn time(project: &Project, rng: &mut Rng) -> Flicks {
    let frame = frame(project);
    let edges: Vec<Flicks> = project
        .clips()
        .flat_map(|c| [c.start, c.end(), c.start + Flicks(c.duration.0 / 2)])
        .collect();
    let base = match rng.below(10) {
        0..=5 => rng.pick(&edges).unwrap_or(Flicks::ZERO) + Flicks(rng.range(-3, 3) * frame),
        6..=8 => Flicks(rng.range(0, project.duration().0 / frame + 60) * frame),
        _ => Flicks(rng.range(0, project.duration().0 + 2 * 705_600_000)),
    };
    if rng.percent(10) {
        base + Flicks(rng.range(-frame / 2, frame / 2))
    } else {
        base
    }
}

fn delta(project: &Project, rng: &mut Rng) -> Flicks {
    let frame = frame(project);
    let frames = match rng.below(10) {
        0..=5 => rng.range(-5, 5),
        6..=8 => rng.range(-90, 90),
        _ => 0,
    };
    let jitter = if rng.percent(10) {
        rng.range(-frame / 2, frame / 2)
    } else {
        0
    };
    Flicks(frames * frame + jitter)
}

fn clip_ids(project: &Project) -> Vec<ClipId> {
    project.clips().map(|c| c.id).collect()
}

fn some_clips(project: &Project, rng: &mut Rng) -> Vec<ClipId> {
    let ids = clip_ids(project);
    let count = rng.range(1, 3) as usize;
    let mut chosen: Vec<ClipId> = (0..count).filter_map(|_| rng.pick(&ids)).collect();
    if rng.percent(3) {
        chosen.push(ClipId(project.next_id + 5)); // missing
    }
    chosen
}

fn random_spec(project: &Project, rng: &mut Rng) -> ClipSpec {
    let frame = frame(project);
    let ids: Vec<&str> = project.media.iter().map(|m| m.id.as_str()).collect();
    let id = rng.pick(&ids).unwrap_or("none");
    let media = project.media(id);
    let frames = rng.range(1, 120);
    let source_in = match media {
        Some(m) if !m.is_still() => {
            let available = (m.duration.0 / frame - frames).max(0);
            let beyond = if rng.percent(5) { 30 } else { 0 };
            Flicks(rng.range(0, available + beyond) * frame)
        }
        _ => Flicks::ZERO,
    };
    let (video, audio) = match rng.below(10) {
        0 => (Some(false), Some(true)),
        1 => (Some(true), Some(false)),
        _ => (None, None),
    };
    // Pasted copies bring their speed and properties along.
    let speed = rng
        .percent(5)
        .then(|| [Speed { num: 2, den: 1 }, Speed { num: 1, den: 2 }][rng.below(2) as usize]);
    let properties = rng.percent(5).then(|| ClipProperties {
        opacity: Some(0.5),
        volume_db: Some(-6.0),
        ..ClipProperties::default()
    });
    ClipSpec {
        media: id.to_string(),
        source_in,
        duration: Flicks(frames * frame),
        video,
        audio,
        speed,
        properties,
    }
}

/// A random command for `project`. Some fail on purpose (locked tracks, overlaps,
/// missing ids); those must change nothing.
pub fn random_command(project: &Project, rng: &mut Rng) -> Command {
    let tracks: Vec<TrackId> = project.tracks.iter().map(|t| t.id).collect();
    let track = rng.pick(&tracks).unwrap();
    let clips = clip_ids(project);
    let any_clip = rng.pick(&clips).unwrap_or(ClipId(0));
    let edge = if rng.percent(50) {
        Edge::Start
    } else {
        Edge::End
    };
    match rng.below(100) {
        0..=11 => Command::Insert {
            track,
            at: time(project, rng),
            clip: random_spec(project, rng),
        },
        12..=21 => Command::Overwrite {
            track,
            at: time(project, rng),
            clip: random_spec(project, rng),
        },
        22..=33 => Command::Append {
            track,
            clip: random_spec(project, rng),
        },
        34..=37 => Command::RippleDelete {
            clips: some_clips(project, rng),
        },
        38..=40 => Command::Delete {
            clips: some_clips(project, rng),
        },
        41..=47 => Command::Split {
            at: time(project, rng),
            clips: if rng.percent(50) {
                Vec::new()
            } else {
                vec![any_clip]
            },
        },
        48..=55 => Command::Trim {
            clip: any_clip,
            edge,
            delta: delta(project, rng),
            ripple: rng.percent(50),
        },
        56..=60 => Command::Roll {
            clip: any_clip,
            edge,
            delta: delta(project, rng),
        },
        61..=67 => Command::Move {
            clips: some_clips(project, rng),
            delta: delta(project, rng),
            tracks: rng.range(-1, 1) as i32,
            overwrite: rng.percent(30),
        },
        68..=70 => Command::Slip {
            clip: any_clip,
            delta: delta(project, rng),
        },
        71..=74 => Command::Slide {
            clip: any_clip,
            delta: delta(project, rng),
        },
        75..=76 => Command::Link {
            clips: some_clips(project, rng),
        },
        77 => Command::Unlink {
            clips: some_clips(project, rng),
        },
        78..=80 => Command::DetachAudio {
            clip: any_clip,
            track: if rng.percent(50) { None } else { Some(track) },
        },
        81 => Command::SetSpeed {
            clip: any_clip,
            speed: *[
                Speed::NORMAL,
                Speed { num: 2, den: 1 },
                Speed { num: 1, den: 2 },
                Speed { num: 3, den: 2 },
                Speed { num: 4, den: 2 }, // not reduced: refused
            ]
            .get(rng.below(5) as usize)
            .unwrap(),
        },
        82 => Command::SetClipProperties {
            clip: any_clip,
            properties: ClipProperties {
                opacity: Some(rng.below(11) as f64 / 10.0 + if rng.percent(5) { 2.0 } else { 0.0 }),
                volume_db: Some(rng.range(-30, 6) as f64 * 0.37),
                transform: rng.percent(50).then(|| Transform {
                    x: rng.range(-500, 500) as f64 / 3.0,
                    rotation: rng.range(-720, 720) as f64 * 0.1,
                    scale_x: rng.range(1, 400) as f64 / 100.0,
                    ..Transform::default()
                }),
                crop: None,
            },
        },
        83..=85 => match rng.below(3) {
            0 => Command::AddMarker {
                at: time(project, rng),
                name: format!("m{}", rng.below(100)),
                color: MarkerColor::Green,
            },
            1 => {
                let ids: Vec<MarkerId> = project.markers.iter().map(|m| m.id).collect();
                Command::UpdateMarker {
                    marker: rng.pick(&ids).unwrap_or(MarkerId(0)),
                    at: Some(time(project, rng)),
                    name: None,
                    color: Some(MarkerColor::Red),
                }
            }
            _ => {
                let ids: Vec<MarkerId> = project.markers.iter().map(|m| m.id).collect();
                Command::RemoveMarker {
                    marker: rng.pick(&ids).unwrap_or(MarkerId(0)),
                }
            }
        },
        86..=87 => Command::AddTrack {
            index: rng.below(project.tracks.len() as u64 + 1) as usize,
            name: rng.percent(30).then(|| "B-roll".to_string()),
        },
        88 => Command::RemoveTrack { track },
        89 => Command::MoveTrack {
            track,
            index: rng.below(project.tracks.len() as u64) as usize,
        },
        90 => Command::SetTrackLocked {
            track,
            locked: rng.percent(40),
        },
        91 => Command::SetTrackMuted {
            track,
            muted: rng.percent(50),
        },
        92 => Command::SetTrackHidden {
            track,
            hidden: rng.percent(50),
        },
        93 => Command::RenameTrack {
            track,
            name: format!("Track {}", rng.below(9)),
        },
        94 => {
            let n = project.next_id;
            let kind =
                [MediaKind::Video, MediaKind::Audio, MediaKind::Image][rng.below(3) as usize];
            Command::AddMedia {
                media: media(&format!("m{n}"), kind, rng.range(1, 40)),
            }
        }
        95 => {
            let ids: Vec<&str> = project.media.iter().map(|m| m.id.as_str()).collect();
            Command::RemoveMedia {
                media: rng.pick(&ids).unwrap_or("none").to_string(),
            }
        }
        96 => {
            let mut settings = project.settings;
            match rng.below(4) {
                0 => (settings.width, settings.height) = (1080, 1920),
                1 => settings.sample_rate = 44_100,
                2 => settings.frame_rate = FrameRate::FPS_25,
                _ => settings.width = 1919, // refused
            }
            Command::SetSettings { settings }
        }
        97 => Command::Rename {
            name: if rng.percent(20) {
                " ".into()
            } else {
                format!("Edit {}", rng.below(50))
            },
        },
        98 => Command::SetMagnetic {
            magnetic: rng.percent(60),
        },
        _ => Command::Trim {
            clip: any_clip,
            edge,
            delta: delta(project, rng),
            ripple: false,
        },
    }
}

//! What the timeline holds at a time: the pure half of `renderFrame(t)`, and the
//! clips the mixer plays. Same project and time, same plan, at any seek position.
use cgv_audio::{db_to_gain, AudioClip};
use cgv_model::{Clip, ClipId, Crop, Project, Speed, TrackId, Transform};
use cgv_time::Flicks;
use serde::{Deserialize, Serialize};

/// One picture to draw.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerPlan {
    pub clip: ClipId,
    pub track: TrackId,
    pub media: String,
    pub still: bool,
    /// Media time to show (zero for stills).
    pub source_time: Flicks,
    pub transform: Transform,
    pub crop: Crop,
    pub opacity: f64,
    /// The clip's timing, so readers can decode ahead.
    pub clip_start: Flicks,
    pub clip_end: Flicks,
    pub source_in: Flicks,
    pub speed: Speed,
}

/// Everything one project frame shows, bottom layer first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePlan {
    /// Project frame number and its start time.
    pub frame: i64,
    pub time: Flicks,
    pub width: u32,
    pub height: u32,
    pub layers: Vec<LayerPlan>,
}

fn visual_layer(project: &Project, track: TrackId, clip: &Clip, time: Flicks) -> Option<LayerPlan> {
    let media = project.media(&clip.media)?;
    if !clip.video || !media.has_video || clip.opacity <= 0.0 {
        return None;
    }
    let still = media.is_still();
    let source_time = if still {
        Flicks::ZERO
    } else {
        clip.source_in + clip.speed.source_span(time - clip.start)
    };
    Some(LayerPlan {
        clip: clip.id,
        track,
        media: clip.media.clone(),
        still,
        source_time,
        transform: clip.transform,
        crop: clip.crop,
        opacity: clip.opacity,
        clip_start: clip.start,
        clip_end: clip.end(),
        source_in: clip.source_in,
        speed: clip.speed,
    })
}

/// The project frame showing at `time`.
pub fn frame_at(project: &Project, time: Flicks) -> i64 {
    project.settings.frame_rate.frame_at(time).max(0)
}

/// The layers of the project frame showing at `time`. Hidden tracks, sound-only
/// clips and invisible clips draw nothing.
pub fn plan_frame(project: &Project, time: Flicks) -> FramePlan {
    let rate = project.settings.frame_rate;
    let frame = frame_at(project, time);
    let time = rate.time_of_frame(frame);
    let layers = cgv_model::query::clips_at(project, time)
        .into_iter()
        .filter(|at| !project.tracks[at.track_index].hidden)
        .filter_map(|at| visual_layer(project, at.track, at.clip, time))
        .collect();
    FramePlan {
        frame,
        time,
        width: project.settings.width,
        height: project.settings.height,
        layers,
    }
}

/// Visible clips that start after `from` and no later than `from + horizon`,
/// planned at their first frame, so their decoders can start early.
pub fn upcoming_layers(project: &Project, from: Flicks, horizon: Flicks) -> Vec<LayerPlan> {
    let mut upcoming: Vec<LayerPlan> = project
        .tracks
        .iter()
        .filter(|track| !track.hidden)
        .flat_map(|track| {
            track
                .clips
                .iter()
                .filter(move |clip| clip.start > from && clip.start <= from + horizon)
                .filter_map(|clip| visual_layer(project, track.id, clip, clip.start))
        })
        .collect();
    upcoming.sort_by_key(|layer| layer.clip_start);
    upcoming
}

/// Whether `clip` can play sound in this phase: only at normal speed (time-stretch
/// comes in Phase 9).
fn audible(project: &Project, clip: &Clip) -> bool {
    clip.audio
        && clip.speed == Speed::NORMAL
        && project
            .media(&clip.media)
            .is_some_and(|media| media.has_audio)
}

/// True when `next` starts where `clip` ends and continues the same source audio.
fn continues(clip: &Clip, next: &Clip) -> bool {
    next.media == clip.media
        && next.start == clip.end()
        && next.source_in == clip.source_out()
        && next.volume_db == clip.volume_db
}

/// The clips heard between timeline samples `from` and `to`, at the project rate.
pub fn audio_clips(project: &Project, from: i64, to: i64) -> Vec<AudioClip> {
    let rate = project.settings.sample_rate;
    let mut clips = Vec::new();
    for track in project.tracks.iter().filter(|track| !track.muted) {
        for (index, clip) in track.clips.iter().enumerate() {
            if !audible(project, clip) {
                continue;
            }
            let start = clip.start.to_samples(rate);
            let end = clip.end().to_samples(rate);
            if end <= from || start >= to {
                continue;
            }
            let before = index.checked_sub(1).map(|i| &track.clips[i]);
            let after = track.clips.get(index + 1);
            clips.push(AudioClip {
                media: clip.media.clone(),
                start,
                end,
                source_start: clip.source_in.to_samples(rate),
                gain: db_to_gain(clip.volume_db),
                fade_in: !before
                    .is_some_and(|before| audible(project, before) && continues(before, clip)),
                fade_out: !after
                    .is_some_and(|after| audible(project, after) && continues(clip, after)),
            });
        }
    }
    clips
}

#[cfg(test)]
mod tests {
    use super::*;
    use cgv_model::{ClipSpec, Command, MediaKind, MediaLocation, MediaRef, Session};
    use cgv_time::FrameRate;

    const FRAME: i64 = 23_520_000;

    fn media(id: &str, kind: MediaKind) -> MediaRef {
        MediaRef {
            id: id.into(),
            name: format!("{id}.file"),
            kind,
            duration: if kind == MediaKind::Image {
                Flicks::ZERO
            } else {
                Flicks(cgv_time::FLICKS_PER_SECOND * 10)
            },
            has_video: kind != MediaKind::Audio,
            has_audio: kind != MediaKind::Image,
            width: 1920,
            height: 1080,
            frame_rate: (kind == MediaKind::Video).then_some(FrameRate::FPS_30),
            size: 1,
            modified: None,
            location: MediaLocation::Browser,
        }
    }

    fn session() -> Session {
        let mut session = Session::new(Project::new("p", "Plan"));
        for item in [
            media("video", MediaKind::Video),
            media("still", MediaKind::Image),
            media("sound", MediaKind::Audio),
        ] {
            session.execute(&Command::AddMedia { media: item }).unwrap();
        }
        session
    }

    fn track(session: &Session, index: usize) -> TrackId {
        session.project().tracks[index].id
    }

    fn append(session: &mut Session, track: TrackId, media: &str, frames: i64) -> ClipId {
        let outcome = session
            .execute(&Command::Append {
                track,
                clip: ClipSpec {
                    media: media.into(),
                    source_in: Flicks::ZERO,
                    duration: Flicks(FRAME * frames),
                    video: None,
                    audio: None,
                },
            })
            .unwrap();
        ClipId(outcome.created[0])
    }

    #[test]
    fn layers_are_listed_bottom_first_at_the_frame_start() {
        let mut session = session();
        let (bottom, top) = (track(&session, 0), track(&session, 1));
        let video = append(&mut session, bottom, "video", 60);
        let still = append(&mut session, top, "still", 30);
        // Halfway into frame 10.
        let plan = plan_frame(session.project(), Flicks(FRAME * 10 + FRAME / 2));
        assert_eq!((plan.frame, plan.time), (10, Flicks(FRAME * 10)));
        assert_eq!((plan.width, plan.height), (1920, 1080));
        let ids: Vec<ClipId> = plan.layers.iter().map(|layer| layer.clip).collect();
        assert_eq!(ids, vec![video, still]);
        assert_eq!(plan.layers[0].source_time, Flicks(FRAME * 10));
        assert!(plan.layers[1].still);
        assert_eq!(plan.layers[1].source_time, Flicks::ZERO);
        // After the still ends only the video remains; after both, nothing.
        assert_eq!(
            plan_frame(session.project(), Flicks(FRAME * 30))
                .layers
                .len(),
            1
        );
        assert!(plan_frame(session.project(), Flicks(FRAME * 60))
            .layers
            .is_empty());
        assert_eq!(plan_frame(session.project(), Flicks(-5)).frame, 0);
    }

    #[test]
    fn source_time_follows_the_in_point_and_speed() {
        let mut session = session();
        let bottom = track(&session, 0);
        let clip = append(&mut session, bottom, "video", 60);
        session
            .execute(&Command::Trim {
                clip,
                edge: cgv_model::Edge::Start,
                delta: Flicks(FRAME * 10),
                ripple: false,
            })
            .unwrap();
        let plan = plan_frame(session.project(), Flicks(FRAME * 12));
        assert_eq!(plan.layers[0].source_time, Flicks(FRAME * 12));
        assert_eq!(plan.layers[0].source_in, Flicks(FRAME * 10));
        session
            .execute(&Command::SetSpeed {
                clip,
                speed: Speed::new(2, 1).unwrap(),
            })
            .unwrap();
        let plan = plan_frame(session.project(), Flicks(FRAME * 12));
        assert_eq!(plan.layers[0].source_time, Flicks(FRAME * 14));
        assert_eq!(plan.layers[0].speed, Speed::new(2, 1).unwrap());
    }

    #[test]
    fn hidden_tracks_sound_only_and_transparent_clips_draw_nothing() {
        let mut session = session();
        let (bottom, top) = (track(&session, 0), track(&session, 1));
        append(&mut session, bottom, "sound", 30);
        let video = append(&mut session, top, "video", 30);
        let at = Flicks(FRAME);
        assert_eq!(plan_frame(session.project(), at).layers.len(), 1);
        session
            .execute(&Command::SetTrackHidden {
                track: top,
                hidden: true,
            })
            .unwrap();
        assert!(plan_frame(session.project(), at).layers.is_empty());
        session
            .execute(&Command::SetTrackHidden {
                track: top,
                hidden: false,
            })
            .unwrap();
        session
            .execute(&Command::SetClipProperties {
                clip: video,
                properties: cgv_model::ClipProperties {
                    opacity: Some(0.0),
                    ..Default::default()
                },
            })
            .unwrap();
        assert!(plan_frame(session.project(), at).layers.is_empty());
    }

    #[test]
    fn upcoming_clips_are_planned_at_their_first_frame() {
        let mut session = session();
        let (bottom, top) = (track(&session, 0), track(&session, 1));
        append(&mut session, bottom, "video", 30);
        let second = append(&mut session, bottom, "video", 30);
        let upcoming = upcoming_layers(session.project(), Flicks(FRAME * 10), Flicks::ONE_SECOND);
        assert_eq!(upcoming.len(), 1);
        assert_eq!(upcoming[0].clip, second);
        assert_eq!(upcoming[0].source_time, Flicks::ZERO);
        assert!(upcoming_layers(session.project(), Flicks::ZERO, Flicks(FRAME * 29)).is_empty());
        let _ = top;
    }

    #[test]
    fn audio_clips_cover_audible_clips_in_samples() {
        let mut session = session();
        let (bottom, top) = (track(&session, 0), track(&session, 1));
        let video = append(&mut session, bottom, "video", 30);
        append(&mut session, top, "sound", 60);
        append(&mut session, top, "still", 30);
        let clips = audio_clips(session.project(), 0, 48_000 * 10);
        assert_eq!(clips.len(), 2);
        assert_eq!((clips[0].start, clips[0].end), (0, 48_000));
        assert!(clips[0].fade_in && clips[0].fade_out);
        assert_eq!(clips[1].end, 96_000);
        assert!(audio_clips(session.project(), 96_000, 200_000).is_empty());
        session
            .execute(&Command::SetClipProperties {
                clip: video,
                properties: cgv_model::ClipProperties {
                    volume_db: Some(-6.0),
                    ..Default::default()
                },
            })
            .unwrap();
        assert!((audio_clips(session.project(), 0, 10)[0].gain - 0.501_187).abs() < 1e-5);
        session
            .execute(&Command::SetTrackMuted {
                track: top,
                muted: true,
            })
            .unwrap();
        assert_eq!(audio_clips(session.project(), 0, 48_000 * 10).len(), 1);
        session
            .execute(&Command::SetSpeed {
                clip: video,
                speed: Speed::new(1, 2).unwrap(),
            })
            .unwrap();
        assert!(audio_clips(session.project(), 0, 48_000 * 10).is_empty());
    }

    #[test]
    fn a_split_plays_through_without_edge_fades() {
        let mut session = session();
        let bottom = track(&session, 0);
        append(&mut session, bottom, "video", 60);
        session
            .execute(&Command::Split {
                at: Flicks(FRAME * 20),
                clips: vec![],
            })
            .unwrap();
        let clips = audio_clips(session.project(), 0, 48_000 * 10);
        assert_eq!(clips.len(), 2);
        assert!(clips[0].fade_in && !clips[0].fade_out);
        assert!(!clips[1].fade_in && clips[1].fade_out);
        assert_eq!(clips[1].source_start, 32_000);
        assert_eq!(clips[1].start, 32_000);
    }
}

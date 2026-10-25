//! What the timeline holds at a time: the pure half of `renderFrame(t)`, and the
//! clips the mixer plays. Same project and time, same plan, at any seek position.
use std::collections::BTreeMap;

use cgv_audio::{db_to_gain, AudioClip};
use cgv_model::{
    parse_lut_ref, Clip, ClipId, Crop, LutId, LutShape, ParamValue, Params, Project, Speed, Title,
    Track, TrackId, Transform, Transition,
};
use cgv_time::Flicks;
use serde::{Deserialize, Serialize};

/// An effect to run on a picture: its definition and its settings at this frame,
/// keyframes applied.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPlan {
    pub pack: String,
    pub kind: String,
    pub params: Params,
}

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
    /// The transform, crop and opacity at this frame, keyframes applied.
    pub transform: Transform,
    pub crop: Crop,
    pub opacity: f64,
    /// The clip's timing, so readers can decode ahead.
    pub clip_start: Flicks,
    pub clip_end: Flicks,
    pub source_in: Flicks,
    pub speed: Speed,
    /// Seconds from the clip's start to this frame: negative before it, and past
    /// its length after it, inside a transition.
    pub clip_seconds: f64,
    /// A number from 0 to 1 that differs from clip to clip, for effects' randomness.
    pub seed: f64,
    /// Enabled effects, in order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<EffectPlan>,
    /// The transform or crop is keyframed, so its drawn size may change each frame.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub moving: bool,
    /// A title's text and shapes at this frame, keyframes applied: the engine
    /// draws them itself, and the layer has no media.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<Title>,
}

/// How a frame is drawn, bottom track first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Step {
    /// A layer over what is below.
    Layer { layer: usize },
    /// Two layers blended by a transition, over what is below. A missing side is
    /// transparent.
    Transition {
        from: Option<usize>,
        to: Option<usize>,
        transition: EffectPlan,
        /// From 0 to 1, at the middle of the frame.
        progress: f64,
    },
    /// Effects applied to everything below, mixed in by `opacity`.
    Adjustment {
        clip: ClipId,
        effects: Vec<EffectPlan>,
        opacity: f64,
        clip_seconds: f64,
        seed: f64,
    },
}

/// A LUT the frame's effects read.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LutPlan {
    pub id: LutId,
    /// What renderers cache it by: the LUT's fingerprint.
    pub key: String,
    pub shape: LutShape,
    pub size: u32,
    pub domain_min: [f64; 3],
    pub domain_max: [f64; 3],
}

/// Everything one project frame shows.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePlan {
    /// Project frame number and its start time.
    pub frame: i64,
    pub time: Flicks,
    pub width: u32,
    pub height: u32,
    /// The pictures to gather, one source each.
    pub layers: Vec<LayerPlan>,
    /// How to draw them, bottom first.
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub luts: Vec<LutPlan>,
}

/// A repeatable number from 0 to 1 for a clip.
fn seed(clip: ClipId) -> f64 {
    (clip.0 as f64 * 0.618_033_988_749_895).fract()
}

fn effect_plans(clip: &Clip, offset: Flicks) -> Vec<EffectPlan> {
    clip.effects
        .iter()
        .enumerate()
        .filter(|(_, effect)| effect.enabled)
        .map(|(index, effect)| EffectPlan {
            pack: effect.pack.clone(),
            kind: effect.kind.clone(),
            params: clip.effect_params_at(index, offset),
        })
        .collect()
}

/// The picture of `clip` at `time`, which may lie outside it inside a transition:
/// the media then continues past the clip's edges, holding its first or last frame
/// where it runs out.
fn visual_layer(project: &Project, track: TrackId, clip: &Clip, time: Flicks) -> Option<LayerPlan> {
    let offset = time - clip.start;
    if let Some(title) = clip.title.as_ref().filter(|_| clip.is_title()) {
        let opacity = clip.opacity_at(offset);
        if !clip.video || opacity <= 0.0 {
            return None;
        }
        return Some(LayerPlan {
            clip: clip.id,
            track,
            media: String::new(),
            still: false,
            source_time: Flicks::ZERO,
            transform: clip.transform_at(offset),
            crop: clip.crop_at(offset),
            opacity,
            clip_start: clip.start,
            clip_end: clip.end(),
            source_in: Flicks::ZERO,
            speed: clip.speed,
            clip_seconds: offset.as_seconds(),
            seed: seed(clip.id),
            effects: effect_plans(clip, offset),
            // Animated elements move and resize what is drawn, as a keyframed
            // transform does.
            moving: !clip.keyframes.is_empty(),
            title: Some(title.at(&clip.keyframes, offset)),
        });
    }
    let media = project.media(&clip.media)?;
    let opacity = clip.opacity_at(offset);
    if !clip.video || !media.has_video || opacity <= 0.0 {
        return None;
    }
    let still = media.is_still();
    let source_time = if still {
        Flicks::ZERO
    } else {
        let at = clip.source_in + clip.speed.source_span(offset);
        Flicks(at.0.clamp(0, (media.duration.0 - 1).max(0)))
    };
    Some(LayerPlan {
        clip: clip.id,
        track,
        media: clip.media.clone(),
        still,
        source_time,
        transform: clip.transform_at(offset),
        crop: clip.crop_at(offset),
        opacity,
        clip_start: clip.start,
        clip_end: clip.end(),
        source_in: clip.source_in,
        speed: clip.speed,
        clip_seconds: offset.as_seconds(),
        seed: seed(clip.id),
        effects: effect_plans(clip, offset),
        moving: clip.has_moving_keyframes(),
        title: None,
    })
}

/// The project frame showing at `time`.
pub fn frame_at(project: &Project, time: Flicks) -> i64 {
    project.settings.frame_rate.frame_at(time).max(0)
}

/// The timeline span of transition `t` on `track`.
fn window(track: &Track, t: &Transition, frame: Flicks) -> Option<(Flicks, Flicks)> {
    Some(t.window(track.cut(t)?, frame))
}

/// The plan of the frame showing at `time`: the pure half of `renderFrame(t)`.
/// Hidden tracks, sound-only clips and invisible clips draw nothing; a transition
/// draws in place of its clips while it runs.
pub fn plan_frame(project: &Project, time: Flicks) -> FramePlan {
    let rate = project.settings.frame_rate;
    let frame_length = rate.frame_duration();
    let frame = frame_at(project, time);
    let time = rate.time_of_frame(frame);
    let mut layers = Vec::new();
    let mut steps = Vec::new();
    let add = |layer: Option<LayerPlan>, layers: &mut Vec<LayerPlan>| {
        layer.map(|layer| {
            layers.push(layer);
            layers.len() - 1
        })
    };
    for track in project.tracks.iter().filter(|track| !track.hidden) {
        let running = track.transitions.iter().find_map(|t| {
            let (start, end) = window(track, t, frame_length)?;
            (start <= time && time < end).then_some((t, start))
        });
        if let Some((t, start)) = running {
            let side = |id: Option<ClipId>| {
                id.and_then(|id| track.clip(id))
                    .and_then(|clip| visual_layer(project, track.id, clip, time))
            };
            let from = add(side(t.from), &mut layers);
            let to = add(side(t.to), &mut layers);
            let middle = (time - start).0 as f64 + frame_length.0 as f64 / 2.0;
            steps.push(Step::Transition {
                from,
                to,
                transition: EffectPlan {
                    pack: t.pack.clone(),
                    kind: t.kind.clone(),
                    params: t.params.clone(),
                },
                progress: (middle / t.duration.0 as f64).clamp(0.0, 1.0),
            });
            continue;
        }
        let next = track.clips.partition_point(|clip| clip.start <= time);
        let Some(clip) = track.clips[..next].last().filter(|c| c.contains(time)) else {
            continue;
        };
        let offset = time - clip.start;
        if clip.is_adjustment() {
            let effects = effect_plans(clip, offset);
            let opacity = clip.opacity_at(offset);
            if !effects.is_empty() && opacity > 0.0 {
                steps.push(Step::Adjustment {
                    clip: clip.id,
                    effects,
                    opacity,
                    clip_seconds: offset.as_seconds(),
                    seed: seed(clip.id),
                });
            }
            continue;
        }
        if let Some(layer) = add(visual_layer(project, track.id, clip, time), &mut layers) {
            steps.push(Step::Layer { layer });
        }
    }
    let luts = frame_luts(project, &layers, &steps);
    FramePlan {
        frame,
        time,
        width: project.settings.width,
        height: project.settings.height,
        layers,
        steps,
        luts,
    }
}

/// The project LUTs the frame's effects name.
fn frame_luts(project: &Project, layers: &[LayerPlan], steps: &[Step]) -> Vec<LutPlan> {
    let adjustments = steps.iter().filter_map(|step| match step {
        Step::Adjustment { effects, .. } => Some(effects.as_slice()),
        _ => None,
    });
    let mut luts = BTreeMap::new();
    for effects in layers
        .iter()
        .map(|l| l.effects.as_slice())
        .chain(adjustments)
    {
        for value in effects.iter().flat_map(|e| e.params.values()) {
            let ParamValue::Text(text) = value else {
                continue;
            };
            let Some(lut) = parse_lut_ref(text).and_then(|id| project.lut(id)) else {
                continue;
            };
            luts.entry(lut.id).or_insert_with(|| LutPlan {
                id: lut.id,
                key: lut.fingerprint.clone(),
                shape: lut.shape,
                size: lut.size,
                domain_min: lut.domain_min,
                domain_max: lut.domain_max,
            });
        }
    }
    luts.into_values().collect()
}

/// Pictures that start after `from` and no later than `from + horizon`, planned at
/// their first frame, so their decoders can start early. A clip a transition
/// brings in starts where the transition does.
pub fn upcoming_layers(project: &Project, from: Flicks, horizon: Flicks) -> Vec<LayerPlan> {
    let frame = project.settings.frame_duration();
    let mut upcoming: Vec<(Flicks, LayerPlan)> = Vec::new();
    for track in project.tracks.iter().filter(|track| !track.hidden) {
        let mut early: BTreeMap<ClipId, Flicks> = BTreeMap::new();
        for t in &track.transitions {
            if let (Some(to), Some((start, _))) = (t.to, window(track, t, frame)) {
                early.insert(to, start);
            }
        }
        for clip in &track.clips {
            let first = early
                .get(&clip.id)
                .copied()
                .unwrap_or(clip.start)
                .min(clip.start);
            if first > from && first <= from + horizon && !clip.is_generated() {
                if let Some(layer) = visual_layer(project, track.id, clip, first) {
                    upcoming.push((first, layer));
                }
            }
        }
    }
    upcoming.sort_by_key(|(first, layer)| (*first, layer.clip));
    upcoming.into_iter().map(|(_, layer)| layer).collect()
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
        && !clip.has_volume_keyframes()
        && !next.has_volume_keyframes()
}

/// Samples between the points of an animated volume's envelope (about 5 ms).
const ENVELOPE_STEP: i64 = 256;

/// Animated volume as linear gains at timeline samples, covering `from..to` of the clip.
fn envelope(clip: &Clip, rate: u32, from: i64, to: i64) -> Vec<(i64, f32)> {
    if !clip.has_volume_keyframes() {
        return Vec::new();
    }
    let start = clip.start.to_samples(rate);
    let (first, last) = (from.max(start), to.min(clip.end().to_samples(rate)));
    let mut points = Vec::new();
    let mut at = first - (first - start).rem_euclid(ENVELOPE_STEP);
    loop {
        let offset = Flicks::from_samples(at - start, rate);
        points.push((at, db_to_gain(clip.volume_db_at(offset))));
        if at >= last {
            break;
        }
        at += ENVELOPE_STEP;
    }
    points
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
                envelope: envelope(clip, rate, from, to),
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

    /// A project with free tracks, so clips sit where each test puts them.
    fn session() -> Session {
        let mut session = Session::new(Project::new("p", "Plan"));
        session
            .execute(&Command::SetMagnetic { magnetic: false })
            .unwrap();
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
                    speed: None,
                    properties: None,
                    ..Default::default()
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

    fn set_key(session: &mut Session, clip: ClipId, property: &str, frames: i64, value: f64) {
        session
            .execute(&Command::SetKeyframe {
                clip,
                property: property.into(),
                time: Flicks(FRAME * frames),
                value: cgv_model::KeyValue::Number(value),
                interpolation: None,
            })
            .unwrap();
    }

    fn add_effect(session: &mut Session, clip: ClipId, kind: &str, params: Params) -> u64 {
        session
            .execute(&Command::AddEffect {
                clip,
                effect: cgv_model::EffectSpec {
                    id: None,
                    kind: kind.into(),
                    pack: cgv_model::BUILTIN_PACK.into(),
                    version: 1,
                    enabled: true,
                    params,
                },
                index: None,
            })
            .unwrap()
            .created[0]
    }

    fn add_transition(
        session: &mut Session,
        track: TrackId,
        from: Option<ClipId>,
        to: Option<ClipId>,
        frames: i64,
    ) {
        session
            .execute(&Command::AddTransition {
                track,
                from,
                to,
                transition: cgv_model::TransitionSpec {
                    kind: "cross-dissolve".into(),
                    pack: cgv_model::BUILTIN_PACK.into(),
                    version: 1,
                    duration: Flicks(FRAME * frames),
                    alignment: None,
                    params: Params::new(),
                },
            })
            .unwrap();
    }

    #[test]
    fn keyframes_and_effects_are_evaluated_at_the_frame() {
        let mut session = session();
        let bottom = track(&session, 0);
        let clip = append(&mut session, bottom, "video", 60);
        set_key(&mut session, clip, "opacity", 0, 0.0);
        set_key(&mut session, clip, "opacity", 30, 1.0);
        let fading = plan_frame(session.project(), Flicks(FRAME * 15));
        assert!(
            !fading.layers[0].moving,
            "opacity keys leave its size alone"
        );
        set_key(&mut session, clip, "transform.x", 10, 200.0);
        let blur = add_effect(&mut session, clip, "gaussian-blur", Params::new());
        set_key(
            &mut session,
            clip,
            &format!("effects.{blur}.radius"),
            0,
            0.0,
        );
        set_key(
            &mut session,
            clip,
            &format!("effects.{blur}.radius"),
            20,
            0.04,
        );
        let off = add_effect(&mut session, clip, "vignette", Params::new());
        session
            .execute(&Command::SetEffectEnabled {
                clip,
                effect: cgv_model::EffectId(off),
                enabled: false,
            })
            .unwrap();
        let plan = plan_frame(session.project(), Flicks(FRAME * 15));
        let layer = &plan.layers[0];
        assert_eq!(layer.opacity, 0.5);
        assert_eq!(layer.transform.x, 200.0);
        assert!(layer.moving, "its position is keyframed");
        assert_eq!(layer.clip_seconds, 0.5);
        assert_eq!(layer.effects.len(), 1, "disabled effects are left out");
        assert_eq!(layer.effects[0].kind, "gaussian-blur");
        assert_eq!(layer.effects[0].params["radius"], ParamValue::Number(0.03));
        assert_eq!(plan.steps, [Step::Layer { layer: 0 }]);
        // Fully transparent at the first frame: nothing to draw.
        assert!(plan_frame(session.project(), Flicks::ZERO)
            .layers
            .is_empty());
    }

    #[test]
    fn a_transition_draws_both_clips_past_their_edges() {
        let mut session = session();
        let bottom = track(&session, 0);
        let a = append(&mut session, bottom, "video", 60);
        let b = append(&mut session, bottom, "video", 60);
        session
            .execute(&Command::Slip {
                clip: b,
                delta: Flicks(FRAME * 100),
            })
            .unwrap();
        add_transition(&mut session, bottom, Some(a), Some(b), 30);
        // The window is frames 45 to 75, centred on the cut at 60.
        assert_eq!(
            plan_frame(session.project(), Flicks(FRAME * 44)).steps,
            [Step::Layer { layer: 0 }]
        );
        let plan = plan_frame(session.project(), Flicks(FRAME * 50));
        assert_eq!(plan.layers.len(), 2);
        assert_eq!((plan.layers[0].clip, plan.layers[1].clip), (a, b));
        assert_eq!(plan.layers[0].source_time, Flicks(FRAME * 50));
        // b shows the media 10 frames before its in point.
        assert_eq!(plan.layers[1].source_time, Flicks(FRAME * 90));
        assert!(plan.layers[1].clip_seconds < 0.0);
        let Step::Transition {
            from,
            to,
            transition,
            progress,
        } = &plan.steps[0]
        else {
            panic!("a transition step")
        };
        assert_eq!((*from, *to), (Some(0), Some(1)));
        assert_eq!(transition.kind, "cross-dissolve");
        assert!((progress - 5.5 / 30.0).abs() < 1e-12);
        let after = plan_frame(session.project(), Flicks(FRAME * 70));
        // a runs past its end into its media: frame 70 of the source.
        assert_eq!(after.layers[0].source_time, Flicks(FRAME * 70));
        assert_eq!(
            plan_frame(session.project(), Flicks(FRAME * 75)).steps,
            [Step::Layer { layer: 0 }]
        );
    }

    #[test]
    fn transitions_hold_the_edge_frame_where_the_media_runs_out() {
        let mut session = session();
        let bottom = track(&session, 0);
        let a = append(&mut session, bottom, "video", 30);
        let b = append(&mut session, bottom, "video", 30);
        add_transition(&mut session, bottom, Some(a), Some(b), 20);
        let plan = plan_frame(session.project(), Flicks(FRAME * 22));
        // b starts at source 0: nothing before it, so its first frame holds.
        assert_eq!(plan.layers[1].source_time, Flicks::ZERO);
        // A free start edge: a fade from transparent, inside the clip.
        let top = track(&session, 1);
        let c = append(&mut session, top, "still", 30);
        add_transition(&mut session, top, None, Some(c), 10);
        let plan = plan_frame(session.project(), Flicks(FRAME * 2));
        let Step::Transition { from, to, .. } = &plan.steps[1] else {
            panic!("a transition on the top track")
        };
        assert_eq!((*from, *to), (None, Some(1)));
    }

    #[test]
    fn titles_are_layers_without_media_drawn_as_their_keyframes_say() {
        use cgv_model::title::{Content, Element, Font, Text};
        let mut session = session();
        let top = track(&session, 1);
        let text = Text {
            text: "Hello".into(),
            font: Font {
                family: "Inter".into(),
                weight: 700,
                italic: false,
            },
            size: 96.0,
            align: Default::default(),
            direction: Default::default(),
            line_spacing: 1.0,
            letter_spacing: 0.0,
            wrap: None,
            background: None,
            reveal: 1.0,
            reveal_by: Default::default(),
        };
        let clip = ClipId(
            session
                .execute(&Command::Append {
                    track: top,
                    clip: ClipSpec {
                        kind: cgv_model::ClipKind::Title,
                        duration: Flicks(FRAME * 60),
                        title: Some(Title {
                            elements: vec![Element {
                                id: cgv_model::ElementId(1),
                                x: 0.0,
                                y: 0.0,
                                scale: 1.0,
                                rotation: 0.0,
                                opacity: 1.0,
                                fill: cgv_model::Color {
                                    r: 1.0,
                                    g: 1.0,
                                    b: 1.0,
                                    a: 1.0,
                                },
                                stroke: None,
                                shadow: None,
                                content: Content::Text(text),
                            }],
                        }),
                        ..Default::default()
                    },
                })
                .unwrap()
                .created[0],
        );
        let plan = plan_frame(session.project(), Flicks(FRAME * 5));
        assert_eq!(plan.steps, [Step::Layer { layer: 0 }]);
        let layer = &plan.layers[0];
        assert!(layer.media.is_empty() && !layer.still && !layer.moving);
        let element = layer.title.as_ref().unwrap().elements[0].id;
        // A reveal keyframed from 0 to 1 over the first second.
        let name = cgv_model::element_property(element, "reveal");
        set_key(&mut session, clip, &name, 0, 0.0);
        set_key(&mut session, clip, &name, 30, 1.0);
        let plan = plan_frame(session.project(), Flicks(FRAME * 15));
        let title = plan.layers[0].title.as_ref().unwrap();
        let Content::Text(text) = &title.elements[0].content else {
            panic!("text")
        };
        assert!((text.reveal - 0.5).abs() < 1e-9);
        assert!(plan.layers[0].moving);
        // No decoder starts early for a title.
        assert!(upcoming_layers(session.project(), Flicks::ZERO, Flicks(FRAME * 90)).is_empty());
    }

    #[test]
    fn adjustment_layers_apply_their_effects_to_what_is_below() {
        let mut session = session();
        let (bottom, top) = (track(&session, 0), track(&session, 1));
        append(&mut session, bottom, "video", 60);
        let layer = ClipId(
            session
                .execute(&Command::Append {
                    track: top,
                    clip: ClipSpec {
                        kind: cgv_model::ClipKind::Adjustment,
                        duration: Flicks(FRAME * 60),
                        ..Default::default()
                    },
                })
                .unwrap()
                .created[0],
        );
        // Without effects it does nothing.
        let plan = plan_frame(session.project(), Flicks(FRAME * 5));
        assert_eq!(plan.steps.len(), 1);
        add_effect(&mut session, layer, "saturation", Params::new());
        set_key(&mut session, layer, "opacity", 0, 0.25);
        let plan = plan_frame(session.project(), Flicks(FRAME * 5));
        assert_eq!(plan.layers.len(), 1, "an adjustment layer has no picture");
        let Step::Adjustment {
            clip,
            effects,
            opacity,
            ..
        } = &plan.steps[1]
        else {
            panic!("an adjustment step")
        };
        assert_eq!((*clip, *opacity), (layer, 0.25));
        assert_eq!(effects[0].kind, "saturation");
    }

    #[test]
    fn frames_list_the_luts_their_effects_read() {
        let mut session = session();
        let bottom = track(&session, 0);
        let clip = append(&mut session, bottom, "video", 30);
        let mut cube = String::from("LUT_3D_SIZE 2\n");
        for i in 0..8 {
            cube.push_str(&format!("{} {} {}\n", i & 1, (i >> 1) & 1, i >> 2));
        }
        let spec = cgv_model::lut::parse_cube("Look", &cube).unwrap();
        let lut = cgv_model::LutId(
            session
                .execute(&Command::AddLut { lut: spec })
                .unwrap()
                .created[0],
        );
        let params: Params =
            [("lut".to_string(), ParamValue::Text(cgv_model::lut_ref(lut)))].into();
        add_effect(&mut session, clip, "lut", params);
        let plan = plan_frame(session.project(), Flicks::ZERO);
        assert_eq!(plan.luts.len(), 1);
        assert_eq!(plan.luts[0].id, lut);
        assert_eq!(
            plan.luts[0].key,
            session.project().lut(lut).unwrap().fingerprint
        );
        assert_eq!(plan.luts[0].size, 2);
    }

    #[test]
    fn a_clip_a_transition_brings_in_decodes_from_the_transition_start() {
        let mut session = session();
        let bottom = track(&session, 0);
        let a = append(&mut session, bottom, "video", 60);
        let b = append(&mut session, bottom, "video", 60);
        session
            .execute(&Command::Slip {
                clip: b,
                delta: Flicks(FRAME * 100),
            })
            .unwrap();
        add_transition(&mut session, bottom, Some(a), Some(b), 30);
        let upcoming = upcoming_layers(session.project(), Flicks(FRAME * 40), Flicks(FRAME * 10));
        assert_eq!(upcoming.len(), 1);
        assert_eq!(upcoming[0].clip, b);
        assert_eq!(upcoming[0].source_time, Flicks(FRAME * 85));
        assert!(
            upcoming_layers(session.project(), Flicks(FRAME * 46), Flicks(FRAME * 30)).is_empty(),
            "b is already drawn by then"
        );
    }

    #[test]
    fn animated_volume_becomes_a_gain_envelope() {
        let mut session = session();
        let bottom = track(&session, 0);
        let clip = append(&mut session, bottom, "sound", 60);
        set_key(&mut session, clip, "volumeDb", 0, -96.0);
        set_key(&mut session, clip, "volumeDb", 30, 0.0);
        let clips = audio_clips(session.project(), 0, 48_000);
        let envelope = &clips[0].envelope;
        assert_eq!(envelope[0], (0, db_to_gain(-96.0)));
        assert!(envelope.windows(2).all(|pair| pair[1].0 - pair[0].0 == 256));
        assert!(envelope.last().unwrap().0 >= 48_000);
        let at_half = envelope
            .iter()
            .find(|(t, _)| *t >= 24_000)
            .map(|(_, gain)| *gain)
            .unwrap();
        assert!((at_half - db_to_gain(-48.0)).abs() < 1e-3, "{at_half}");
        // A window later in the clip covers only that window.
        let later = audio_clips(session.project(), 30_000, 31_000);
        assert!(later[0].envelope[0].0 <= 30_000 && later[0].envelope[0].0 > 29_000);
    }
}

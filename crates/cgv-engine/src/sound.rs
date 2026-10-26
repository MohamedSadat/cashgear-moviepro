//! What the mixer plays: the audible tracks between two timeline samples, with
//! each clip's fades, crossfades, noise reduction and sound effects, and each
//! track's volume, pan, role and ducking. Pure, like the frame plan.
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::OnceLock;

use cgv_audio::{
    db_to_gain, AudioClip, AudioPlan, AudioTrack, DuckSettings, Role, Settings, Timing,
};
use cgv_dsp::biquad::FilterKind;
use cgv_dsp::delay::EchoSettings;
use cgv_dsp::dynamics::{CompressorSettings, GateSettings, LimiterSettings};
use cgv_dsp::effect::{EqBand, PassSettings};
use cgv_dsp::reverb::ReverbSettings;
use cgv_effects::{Definition, Kind, ParamKind, Registry};
use cgv_model::{Clip, Effect, ParamValue, Project, Track, TrackRole};
use cgv_time::{Flicks, FLICKS_PER_SECOND};

/// Media key of a medium's noise-reduced blocks.
pub fn denoised_key(media: &str) -> String {
    format!("{media}#nr")
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Registry::builtin().expect("the built-in pack loads"))
}

/// Whether `clip` plays sound: a freeze frame has none.
fn audible(project: &Project, clip: &Clip) -> bool {
    clip.audio
        && !clip.freeze
        && project
            .media(&clip.media)
            .is_some_and(|media| media.has_audio)
}

/// Timeline samples between the points of a timed clip's map (10 ms at 48 kHz).
const MAP_STEP: i64 = 480;

/// How a clip at another speed, on a ramp or reversed reads its media, over
/// timeline samples `from..to` (the clip's own, from `start`): its source
/// position every [`MAP_STEP`] samples, negated when reversed.
fn timing(clip: &Clip, rate: u32, start: i64, from: i64, to: i64) -> Timing {
    let samples = |flicks: Flicks| flicks.0 as f64 * rate as f64 / FLICKS_PER_SECOND as f64;
    let in_point = samples(clip.source_in);
    let out_point = samples(clip.source_out());
    let position = |t: i64| {
        let span = samples(clip.span_at(Flicks::from_samples(t - start, rate)));
        if clip.reverse {
            -(out_point - span)
        } else {
            in_point + span
        }
    };
    let mut map = Vec::new();
    let mut t = from - (from - start).rem_euclid(MAP_STEP);
    loop {
        map.push((t, position(t)));
        if t >= to {
            break;
        }
        t += MAP_STEP;
    }
    if map.len() < 2 {
        map.push((t + MAP_STEP, position(t + MAP_STEP)));
    }
    let mut hasher = DefaultHasher::new();
    (clip.id.0, &clip.media, clip.source_in.0, clip.duration.0).hash(&mut hasher);
    (
        clip.speed.num,
        clip.speed.den,
        clip.reverse,
        clip.keep_pitch,
        start,
    )
        .hash(&mut hasher);
    for point in &clip.ramp {
        (point.time.0, point.speed.to_bits()).hash(&mut hasher);
    }
    Timing {
        map,
        reverse: clip.reverse,
        keep_pitch: clip.keep_pitch,
        key: hasher.finish(),
    }
}

/// The same sound effects, ids aside.
fn same_effects(a: &Clip, b: &Clip) -> bool {
    a.audio_effects.len() == b.audio_effects.len()
        && a.audio_effects.iter().zip(&b.audio_effects).all(|(x, y)| {
            (&x.kind, &x.pack, x.enabled, &x.params) == (&y.kind, &y.pack, y.enabled, &y.params)
        })
}

/// True when `next` starts where `clip` ends and continues the same sound, so the
/// cut needs no ramp and their effects run as one chain.
fn continues(track: &Track, clip: &Clip, next: &Clip) -> bool {
    !clip.retimed()
        && !next.retimed()
        && next.media == clip.media
        && next.start == clip.end()
        && next.source_in == clip.source_out()
        && next.volume_db == clip.volume_db
        && !clip.has_volume_keyframes()
        && !next.has_volume_keyframes()
        && clip.fade_out == Flicks::ZERO
        && next.fade_in == Flicks::ZERO
        && clip.denoise == next.denoise
        && same_effects(clip, next)
        && !track
            .transitions
            .iter()
            .any(|t| t.from == Some(clip.id) && t.to == Some(next.id))
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

fn number(effect: &Effect, definition: &Definition, id: &str) -> f32 {
    let Some(param) = definition.param(id) else {
        return 0.0;
    };
    let ParamKind::Number {
        min, max, default, ..
    } = param.kind
    else {
        return 0.0;
    };
    let value = match effect.params.get(id) {
        Some(ParamValue::Number(value)) => *value,
        _ => default,
    };
    value.clamp(min, max) as f32
}

fn choice<'a>(effect: &'a Effect, definition: &'a Definition, id: &str) -> &'a str {
    match (effect.params.get(id), definition.param(id).map(|p| &p.kind)) {
        (Some(ParamValue::Text(value)), _) => value,
        (_, Some(ParamKind::Choice { default, .. })) => default,
        _ => "",
    }
}

/// The processor settings of a sound effect; None for one this build lacks or
/// one that is switched off.
pub fn sound_settings(effect: &Effect) -> Option<Settings> {
    if !effect.enabled {
        return None;
    }
    let entry = registry().get(&effect.pack, &effect.kind)?;
    let d = &entry.definition;
    if d.kind != Kind::Audio {
        return None;
    }
    let n = |id: &str| number(effect, d, id);
    let pass = || PassSettings {
        frequency: n("frequency"),
        sections: if choice(effect, d, "slope") == "steep" {
            2
        } else {
            1
        },
    };
    Some(match d.id.as_str() {
        "equalizer" => {
            let band = |kind, frequency: &str, gain: &str, q: Option<&str>| EqBand {
                kind,
                frequency: n(frequency),
                gain_db: n(gain),
                q: q.map_or(std::f32::consts::FRAC_1_SQRT_2, n),
            };
            Settings::Equalizer(vec![
                band(FilterKind::LowShelf, "lowFrequency", "lowGain", None),
                band(FilterKind::Peak, "midFrequency", "midGain", Some("midQ")),
                band(
                    FilterKind::Peak,
                    "presenceFrequency",
                    "presenceGain",
                    Some("presenceQ"),
                ),
                band(FilterKind::HighShelf, "highFrequency", "highGain", None),
            ])
        }
        "high-pass" => Settings::HighPass(pass()),
        "low-pass" => Settings::LowPass(pass()),
        "compressor" => Settings::Compressor(CompressorSettings {
            threshold_db: n("threshold"),
            ratio: n("ratio"),
            knee_db: n("knee"),
            attack: n("attack"),
            release: n("release"),
            makeup_db: n("makeup"),
        }),
        "noise-gate" => Settings::Gate(GateSettings {
            threshold_db: n("threshold"),
            reduction_db: n("reduction"),
            attack: n("attack"),
            hold: n("hold"),
            release: n("release"),
        }),
        "limiter" => Settings::Limiter(LimiterSettings {
            ceiling_db: n("ceiling"),
            release: n("release"),
            true_peak: false,
        }),
        "echo" => Settings::Echo(EchoSettings {
            delay: n("delay"),
            feedback: n("feedback"),
            level: n("level"),
            damping: n("damping"),
        }),
        "reverb" => Settings::Reverb(ReverbSettings {
            room_size: n("roomSize"),
            damping: n("damping"),
            width: n("width"),
            mix: n("mix"),
        }),
        _ => return None,
    })
}

/// Seconds of the plan before and after a stretch that mixing it can read:
/// effect warm-up and ducking's view of the dialogue around it.
pub const MARGIN_BEFORE: f64 = 2.5;
pub const MARGIN_AFTER: f64 = 1.0;

/// The audible tracks and clips between timeline samples `from` and `to`, at the
/// project rate. A clip a transition crosses into or out of extends over the
/// transition, fading at equal power, so the sound crossfades with the picture.
pub fn audio_plan(project: &Project, from: i64, to: i64) -> AudioPlan {
    let rate = project.settings.sample_rate;
    let frame = project.settings.frame_duration();
    let soloing = project.tracks.iter().any(|track| track.solo);
    let mut tracks = Vec::new();
    for track in project.tracks.iter() {
        if track.muted || (soloing && !track.solo) {
            continue;
        }
        let mut clips: Vec<AudioClip> = Vec::new();
        let mut chain = 0;
        for (index, clip) in track.clips.iter().enumerate() {
            if !audible(project, clip) {
                continue;
            }
            let before = index.checked_sub(1).map(|i| &track.clips[i]);
            let after = track.clips.get(index + 1);
            let seamless_in = before
                .is_some_and(|before| audible(project, before) && continues(track, before, clip));
            let seamless_out =
                after.is_some_and(|after| audible(project, after) && continues(track, clip, after));
            if !seamless_in {
                chain = clip.id.0;
            }
            let mut start = clip.start.to_samples(rate);
            let mut end = clip.end().to_samples(rate);
            let mut source_start = clip.source_in.to_samples(rate);
            let mut fade_in = clip.fade_in.to_samples(rate);
            let mut fade_out = clip.fade_out.to_samples(rate);
            // Crossfades over the transitions at the clip's cuts.
            for t in &track.transitions {
                let (Some(t_from), Some(t_to)) = (t.from, t.to) else {
                    continue;
                };
                let Some(cut) = track.cut(t) else {
                    continue;
                };
                let (a, b) = t.window(cut, frame);
                let (a, b) = (a.to_samples(rate), b.to_samples(rate));
                if t_from == clip.id {
                    end = end.max(b);
                    fade_out = b - a;
                }
                if t_to == clip.id {
                    let earlier = start - a.min(start);
                    start -= earlier;
                    source_start -= earlier;
                    fade_in = b - a;
                }
            }
            if end <= from || start >= to {
                continue;
            }
            let effects: Vec<Settings> = clip
                .audio_effects
                .iter()
                .filter_map(sound_settings)
                .collect();
            // The map reaches over the transitions too, from the clip's own start.
            let timing = clip.retimed().then(|| {
                let own = clip.start.to_samples(rate);
                timing(clip, rate, own, start.max(from), end.min(to))
            });
            clips.push(AudioClip {
                media: clip.media.clone(),
                start,
                end,
                source_start,
                gain: db_to_gain(clip.volume_db),
                envelope: envelope(clip, rate, from, to),
                fade_in,
                fade_out,
                seamless_in,
                seamless_out,
                denoised: (clip.denoise > 0.0)
                    .then(|| (denoised_key(&clip.media), clip.denoise as f32)),
                effects,
                chain,
                timing,
            });
        }

        let role = match track.role {
            TrackRole::Dialogue => Role::Dialogue,
            TrackRole::Music => Role::Music,
            _ => Role::Other,
        };
        let ducking = &track.ducking;
        tracks.push(AudioTrack {
            id: track.id.0,
            clips,
            gain: db_to_gain(track.volume_db),
            pan: track.pan as f32,
            role,
            duck: (role == Role::Music && ducking.enabled).then_some(DuckSettings {
                amount_db: ducking.amount_db as f32,
                threshold_db: ducking.threshold_db as f32,
                attack: ducking.attack as f32,
                hold: ducking.hold as f32,
                release: ducking.release as f32,
            }),
        });
    }
    // Tracks with nothing to play stay only while they may duck or be ducked,
    // so the meters list every audible track.
    AudioPlan { tracks }
}

/// Every clip of the plan, in track order.
pub fn plan_clips(plan: &AudioPlan) -> impl Iterator<Item = &AudioClip> {
    plan.tracks.iter().flat_map(|track| track.clips.iter())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cgv_model::{
        ClipId, ClipProperties, ClipSpec, Command, EffectSpec, MediaKind, MediaLocation, MediaRef,
        Session, TrackId, TrackSound, TransitionSpec, BUILTIN_PACK,
    };
    use cgv_time::FrameRate;

    const FRAME: i64 = 23_520_000;
    /// Samples a frame at 30 fps and 48 kHz.
    const SAMPLES: i64 = 1600;
    const FRAME_SAMPLES: i64 = SAMPLES;

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
        let mut session = Session::new(Project::new("p", "Sound"));
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
                    duration: Flicks(FRAME * frames),
                    ..Default::default()
                },
            })
            .unwrap();
        ClipId(outcome.created[0])
    }

    fn clips(session: &Session, from: i64, to: i64) -> Vec<AudioClip> {
        plan_clips(&audio_plan(session.project(), from, to))
            .cloned()
            .collect()
    }

    fn effect(kind: &str, params: cgv_model::Params) -> EffectSpec {
        EffectSpec {
            id: None,
            kind: kind.into(),
            pack: BUILTIN_PACK.into(),
            version: 1,
            enabled: true,
            params,
        }
    }

    #[test]
    fn audible_clips_play_in_samples_and_muted_or_slowed_ones_do_not() {
        let mut session = session();
        let (bottom, top) = (track(&session, 0), track(&session, 1));
        let video = append(&mut session, bottom, "video", 30);
        append(&mut session, top, "sound", 60);
        append(&mut session, top, "still", 30);
        let found = clips(&session, 0, 48_000 * 10);
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].start, found[0].end), (0, 48_000));
        assert!(!found[0].seamless_in && !found[0].seamless_out);
        assert_eq!(found[1].end, 96_000);
        assert!(clips(&session, 96_000, 200_000).is_empty());
        session
            .execute(&Command::SetClipProperties {
                clip: video,
                properties: ClipProperties {
                    volume_db: Some(-6.0),
                    ..Default::default()
                },
            })
            .unwrap();
        assert!((clips(&session, 0, 10)[0].gain - 0.501_187).abs() < 1e-5);
        session
            .execute(&Command::SetTrackMuted {
                track: top,
                muted: true,
            })
            .unwrap();
        assert_eq!(clips(&session, 0, 48_000 * 10).len(), 1);
        // At another speed it plays through its timing.
        session
            .execute(&Command::SetSpeed {
                clip: video,
                speed: cgv_model::Speed::new(1, 2).unwrap(),
            })
            .unwrap();
        let slow = clips(&session, 0, 48_000 * 10);
        let timing = slow[0].timing.as_ref().expect("a timed clip");
        assert_eq!(slow[0].end, 96_000);
        assert!((timing.position(48_000.0) - 24_000.0).abs() < 1e-6);
        assert!((timing.speed(30_000.0) - 0.5).abs() < 1e-9);
        assert!(timing.keep_pitch && !timing.reverse);
    }

    #[test]
    fn reversed_and_ramped_clips_read_their_media_through_a_map() {
        let mut session = session();
        let bottom = track(&session, 0);
        let clip = append(&mut session, bottom, "sound", 60);
        session
            .execute(&Command::SetReverse {
                clip,
                reverse: true,
            })
            .unwrap();
        let found = clips(&session, 0, 48_000 * 2);
        let timing = found[0].timing.as_ref().unwrap();
        // Two seconds of media, from its end back: positions are negated.
        assert!(timing.reverse);
        assert!((timing.position(0.0) + 96_000.0).abs() < 1e-6);
        assert!((timing.position(96_000.0) - 0.0).abs() < 1e-6);
        let (low, high) = timing.source_range(0, 96_000, 48_000);
        assert!(low <= 0 && high >= 96_000, "{low}..{high}");
        session
            .execute(&Command::SetRamp {
                clip,
                points: vec![
                    cgv_model::RampShape {
                        at: 0.0,
                        speed: 1.0,
                    },
                    cgv_model::RampShape {
                        at: 1.0,
                        speed: 3.0,
                    },
                ],
            })
            .unwrap();
        let found = clips(&session, 0, 48_000 * 2);
        let timing = found[0].timing.as_ref().unwrap();
        assert!((timing.speed(1_000.0) - 1.0).abs() < 0.1);
        assert!(timing.speed(40_000.0) > 2.5);
        // The key changes with the timing, so a stretcher never mixes two.
        assert_ne!(timing.key, 0);
        // A freeze frame is silent.
        let top = track(&session, 1);
        let video = append(&mut session, top, "video", 60);
        session
            .execute(&Command::FreezeFrame {
                clip: video,
                at: Flicks(FRAME * 10),
                duration: Flicks(FRAME * 30),
            })
            .unwrap();
        let plan = audio_plan(session.project(), 0, FRAME_SAMPLES * 100);
        let above = plan.tracks.iter().find(|t| t.id == top.0).unwrap();
        // Its sound stops at the freeze and goes on after it.
        let edges: Vec<(i64, i64)> = above.clips.iter().map(|c| (c.start, c.end)).collect();
        assert_eq!(
            edges,
            [
                (0, FRAME_SAMPLES * 10),
                (FRAME_SAMPLES * 40, FRAME_SAMPLES * 90)
            ]
        );
    }

    #[test]
    fn a_split_plays_through_as_one_chain_without_edge_ramps() {
        let mut session = session();
        let bottom = track(&session, 0);
        let video = append(&mut session, bottom, "video", 60);
        session
            .execute(&Command::AddEffect {
                clip: video,
                effect: effect("reverb", Default::default()),
                index: None,
                audio: true,
            })
            .unwrap();
        session
            .execute(&Command::Split {
                at: Flicks(FRAME * 20),
                clips: vec![],
            })
            .unwrap();
        let found = clips(&session, 0, 48_000 * 10);
        assert_eq!(found.len(), 2);
        assert!(!found[0].seamless_in && found[0].seamless_out);
        assert!(found[1].seamless_in && !found[1].seamless_out);
        assert_eq!(found[1].source_start, 32_000);
        assert_eq!(found[1].start, 32_000);
        assert_eq!(found[0].chain, found[1].chain);
        assert_eq!(found[0].effects.len(), 1);
    }

    #[test]
    fn solo_tracks_play_alone_and_tracks_carry_volume_pan_and_roles() {
        let mut session = session();
        let (bottom, top) = (track(&session, 0), track(&session, 1));
        append(&mut session, bottom, "video", 30);
        append(&mut session, top, "sound", 30);
        let set = |session: &mut Session, track, sound| {
            session
                .execute(&Command::SetTrackSound { track, sound })
                .unwrap()
        };
        set(
            &mut session,
            top,
            TrackSound {
                volume_db: Some(-6.0),
                pan: Some(0.5),
                role: Some(TrackRole::Music),
                ..TrackSound::default()
            },
        );
        set(
            &mut session,
            bottom,
            TrackSound {
                role: Some(TrackRole::Dialogue),
                ..TrackSound::default()
            },
        );
        let plan = audio_plan(session.project(), 0, 48_000);
        assert_eq!(plan.tracks.len(), 2);
        let (dialogue, music) = (&plan.tracks[0], &plan.tracks[1]);
        assert_eq!((dialogue.role, dialogue.duck), (Role::Dialogue, None));
        assert_eq!(music.role, Role::Music);
        assert!((music.gain - 0.501_187).abs() < 1e-5);
        assert_eq!(music.pan, 0.5);
        assert_eq!(music.duck.unwrap().amount_db, 12.0);
        set(
            &mut session,
            top,
            TrackSound {
                solo: Some(true),
                ..TrackSound::default()
            },
        );
        let plan = audio_plan(session.project(), 0, 48_000);
        assert_eq!(plan.tracks.len(), 1);
        assert_eq!(plan.tracks[0].id, top.0);
    }

    #[test]
    fn fades_noise_reduction_and_sound_effects_reach_the_mixer() {
        let mut session = session();
        let bottom = track(&session, 0);
        let clip = append(&mut session, bottom, "sound", 90);
        session
            .execute(&Command::SetClipProperties {
                clip,
                properties: ClipProperties {
                    fade_in: Some(Flicks(FRAME * 15)),
                    fade_out: Some(Flicks(FRAME * 30)),
                    denoise: Some(0.6),
                    ..Default::default()
                },
            })
            .unwrap();
        for (kind, params) in [
            (
                "equalizer",
                [("midGain".to_string(), ParamValue::Number(-40.0))].into(),
            ),
            (
                "high-pass",
                [("slope".to_string(), ParamValue::Text("steep".into()))].into(),
            ),
            ("compressor", Default::default()),
            ("not-in-this-build", Default::default()),
        ] {
            session
                .execute(&Command::AddEffect {
                    clip,
                    effect: effect(kind, params),
                    index: None,
                    audio: true,
                })
                .unwrap();
        }
        let found = &clips(&session, 0, 48_000)[0];
        assert_eq!(
            (found.fade_in, found.fade_out),
            (15 * SAMPLES, 30 * SAMPLES)
        );
        assert_eq!(found.denoised, Some(("sound#nr".to_string(), 0.6)));
        assert_eq!(found.effects.len(), 3, "the unknown effect is skipped");
        let Settings::Equalizer(bands) = &found.effects[0] else {
            panic!("{:?}", found.effects[0]);
        };
        assert_eq!(bands.len(), 4);
        assert_eq!(bands[1].gain_db, -24.0, "clamped to the definition's range");
        assert_eq!(bands[0].frequency, 100.0, "defaults fill missing settings");
        let Settings::HighPass(pass) = &found.effects[1] else {
            panic!();
        };
        assert_eq!((pass.frequency, pass.sections), (80.0, 2));
    }

    fn built(kind: &str, params: cgv_model::Params) -> Effect {
        Effect {
            id: cgv_model::EffectId(1),
            kind: kind.into(),
            pack: BUILTIN_PACK.into(),
            version: 1,
            enabled: true,
            params,
        }
    }

    #[test]
    fn every_built_in_sound_effect_has_a_processor() {
        for entry in registry().entries() {
            if entry.definition.kind != Kind::Audio {
                continue;
            }
            let defaults = built(&entry.definition.id, entry.definition.defaults());
            assert!(
                sound_settings(&defaults).is_some(),
                "{}",
                entry.definition.id
            );
            for variant in &entry.definition.variants {
                let preset = built(&entry.definition.id, variant.params.clone());
                assert!(sound_settings(&preset).is_some());
            }
        }
        // Switched off, an effect does not run.
        let mut off = built("reverb", Default::default());
        off.enabled = false;
        assert!(sound_settings(&off).is_none());
    }

    #[test]
    fn transitions_crossfade_the_sound_of_both_clips() {
        let mut session = session();
        let bottom = track(&session, 0);
        let a = append(&mut session, bottom, "sound", 60);
        let b = append(&mut session, bottom, "sound", 60);
        session
            .execute(&Command::AddTransition {
                track: bottom,
                from: Some(a),
                to: Some(b),
                transition: TransitionSpec {
                    kind: "cross-dissolve".into(),
                    pack: BUILTIN_PACK.into(),
                    version: 1,
                    duration: Flicks(FRAME * 30),
                    alignment: Default::default(),
                    params: Default::default(),
                },
            })
            .unwrap();
        let found = clips(&session, 0, 48_000 * 5);
        // Centred on the cut at frame 60: frames 45 to 75.
        assert_eq!(
            (found[0].end, found[0].fade_out),
            (75 * SAMPLES, 30 * SAMPLES)
        );
        assert_eq!(
            (found[1].start, found[1].fade_in),
            (45 * SAMPLES, 30 * SAMPLES)
        );
        assert_eq!(found[1].source_start, -15 * SAMPLES);
        assert!(!found[0].seamless_out && !found[1].seamless_in);
        assert_ne!(found[0].chain, found[1].chain);
    }

    #[test]
    fn animated_volume_becomes_a_gain_envelope() {
        let mut session = session();
        let bottom = track(&session, 0);
        let clip = append(&mut session, bottom, "sound", 60);
        for (frames, value) in [(0, -96.0), (30, 0.0)] {
            session
                .execute(&Command::SetKeyframe {
                    clip,
                    property: "volumeDb".into(),
                    time: Flicks(FRAME * frames),
                    value: cgv_model::KeyValue::Number(value),
                    interpolation: None,
                })
                .unwrap();
        }
        let found = clips(&session, 0, 48_000);
        let envelope = &found[0].envelope;
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
        let later = clips(&session, 30_000, 31_000);
        assert!(later[0].envelope[0].0 <= 30_000 && later[0].envelope[0].0 > 29_000);
    }
}

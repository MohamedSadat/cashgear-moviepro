//! Rules every project meets, checked after every edit and when a file is opened.
use std::collections::{BTreeMap, BTreeSet};

use cgv_time::Flicks;

use crate::animation::{KeyValue, Property};
use crate::command::Edge;
use crate::edit::{check_crop, check_opacity, check_pan, check_transform, check_volume};
use crate::effects::MAX_EFFECTS;
use crate::project::{Clip, ClipKind, Project, Speed, Track, MAX_TIME};
use crate::title::{element_value_ok, Content};

/// Animated properties one clip can have, and keyframes per property.
const MAX_ANIMATED: usize = 256;
const MAX_KEYS: usize = 10_000;

/// Effects are for clips with a picture; their settings are well formed.
pub(crate) fn check_effects(clip: &Clip) -> Result<(), String> {
    if !clip.audio && clip.has_sound_settings() {
        return Err(format!("Clip {} has sound settings but no sound", clip.id));
    }
    if clip.fade_in < Flicks::ZERO
        || clip.fade_out < Flicks::ZERO
        || clip.fade_in + clip.fade_out > clip.duration
    {
        return Err(format!("Clip {} has fades that do not fit", clip.id));
    }
    if !(0.0..=1.0).contains(&clip.denoise) {
        return Err(format!("Clip {} has invalid noise reduction", clip.id));
    }
    if clip.audio_effects.len() > MAX_EFFECTS {
        return Err(format!("A clip has at most {MAX_EFFECTS} effects"));
    }
    for effect in &clip.audio_effects {
        effect.check()?;
    }
    if clip.effects.is_empty() {
        return Ok(());
    }
    if !clip.video {
        return Err(format!("Clip {} has effects but no picture", clip.id));
    }
    if clip.effects.len() > MAX_EFFECTS {
        return Err(format!("A clip has at most {MAX_EFFECTS} effects"));
    }
    for effect in &clip.effects {
        effect.check()?;
    }
    Ok(())
}

fn check_property_value(property: Property, setting: Option<&str>, value: f64) -> bool {
    match property {
        Property::X | Property::Y => value.is_finite() && value.abs() <= 1e6,
        Property::ScaleX | Property::ScaleY => value > 0.0 && value <= 100.0,
        Property::Rotation => value.is_finite() && value.abs() <= 36_000.0,
        Property::AnchorX | Property::AnchorY => value.is_finite() && value.abs() <= 100.0,
        Property::Opacity => (0.0..=1.0).contains(&value),
        Property::CropLeft | Property::CropTop | Property::CropRight | Property::CropBottom => {
            (0.0..1.0).contains(&value)
        }
        Property::VolumeDb => (-96.0..=24.0).contains(&value),
        Property::Effect(_) => value.is_finite() && value.abs() <= 1e9,
        Property::Element(_) => element_value_ok(setting.unwrap_or_default(), value),
    }
}

/// Keyframes name properties the clip has, in time order, with values in range.
pub(crate) fn check_keyframes(clip: &Clip) -> Result<(), String> {
    if clip.keyframes.len() > MAX_ANIMATED {
        return Err(format!("A clip animates at most {MAX_ANIMATED} properties"));
    }
    for (name, keys) in &clip.keyframes {
        let (property, setting) = Property::parse(name)
            .ok_or_else(|| format!("{name} is not a property that can be animated"))?;
        if keys.is_empty() || keys.len() > MAX_KEYS {
            return Err(format!("{name} needs 1 to {MAX_KEYS} keyframes"));
        }
        match property {
            Property::VolumeDb if !clip.audio => {
                return Err(format!("Clip {} has no sound to animate", clip.id))
            }
            Property::Effect(id) if !clip.effects.iter().any(|e| e.id == id) => {
                return Err(format!("Clip {} has no effect {id} to animate", clip.id))
            }
            Property::Element(id) => {
                let element = clip
                    .title
                    .as_ref()
                    .and_then(|title| title.element(id))
                    .ok_or_else(|| format!("Clip {} has no title element {id}", clip.id))?;
                if setting == Some("reveal") && !matches!(element.content, Content::Text(_)) {
                    return Err(format!("Title element {id} has no text to reveal"));
                }
            }
            p if p.visual() && !clip.video => {
                return Err(format!("Clip {} has no picture to animate", clip.id))
            }
            _ => {}
        }
        let colours = keys
            .iter()
            .filter(|key| matches!(key.value, KeyValue::Color(_)))
            .count();
        let takes_colours = matches!(property, Property::Effect(_)) || setting == Some("fill");
        if colours != keys.len() && setting == Some("fill") {
            return Err(format!("{name} keyframes must be colours"));
        }
        if colours != 0 && (colours != keys.len() || !takes_colours) {
            return Err(format!("{name} keyframes mix colours and numbers"));
        }
        for (position, key) in keys.iter().enumerate() {
            if key.time.0.abs() > MAX_TIME.0 {
                return Err(format!("A keyframe of {name} is too far from the clip"));
            }
            if position > 0 && keys[position - 1].time >= key.time {
                return Err(format!("{name} keyframes are out of order"));
            }
            key.interpolation.check()?;
            let ok = match key.value {
                KeyValue::Color(color) => color.check().is_ok(),
                KeyValue::Number(value) => check_property_value(property, setting, value),
            };
            if !ok {
                return Err(format!("A keyframe of {name} is out of range"));
            }
        }
    }
    Ok(())
}

/// Transitions sit on cuts or free edges of their own track's picture clips, one
/// per edge, in time order, each within its clips and clear of its neighbours.
fn check_transitions(track: &Track, frame: Flicks) -> Result<(), String> {
    let mut edges = BTreeSet::new();
    let mut previous: Option<(Flicks, Flicks, Option<u64>)> = None;
    for t in &track.transitions {
        t.check()?;
        let clip = |id| {
            track
                .clip(id)
                .ok_or_else(|| format!("Transition {} uses a clip that is not on its track", t.id))
        };
        let before = t.from.map(clip).transpose()?;
        let after = t.to.map(clip).transpose()?;
        for c in before.iter().chain(&after) {
            if c.is_adjustment() || !c.video {
                return Err(format!(
                    "Transition {} is on a clip without a picture",
                    t.id
                ));
            }
        }
        let free = match (before, after) {
            (Some(a), Some(b)) => a.end() == b.start,
            (None, Some(b)) => !track.clips.iter().any(|c| c.end() == b.start),
            (Some(a), None) => !track.clips.iter().any(|c| c.start == a.end()),
            (None, None) => false,
        };
        if !free {
            return Err(format!(
                "Transition {} is not at a cut or a free edge",
                t.id
            ));
        }
        let new_edges = [
            t.from.map(|id| (id, Edge::End)),
            t.to.map(|id| (id, Edge::Start)),
        ];
        for edge in new_edges.into_iter().flatten() {
            if !edges.insert((edge.0, edge.1 == Edge::End)) {
                return Err(format!("Clip {} has two transitions at one edge", edge.0));
            }
        }
        let cut = track.cut(t).expect("checked clips");
        let (start, end) = t.window(cut, frame);
        if before.is_some_and(|a| start < a.start) || after.is_some_and(|b| end > b.end()) {
            return Err(format!("Transition {} is longer than its clips", t.id));
        }
        if let Some((previous_cut, previous_end, previous_to)) = previous {
            if previous_cut >= cut {
                return Err("Transitions are out of order".into());
            }
            if previous_to.is_some() && previous_to == t.from.map(|id| id.0) && previous_end > start
            {
                return Err(format!("Transition {} overlaps the one before it", t.id));
            }
        }
        previous = Some((cut, end, t.to.map(|id| id.0)));
    }
    Ok(())
}

/// A trimmed, non-empty name of at most `max` characters.
pub(crate) fn check_name(name: &str, what: &str, max: usize) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(format!("{what} needs a name"));
    }
    if name.chars().count() > max {
        return Err(format!("{what}'s name is at most {max} characters"));
    }
    Ok(name.to_string())
}

/// Project ids name files and folders, so they are short and plain.
pub fn valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Checks the structural rules: unique ids below `next_id`, clips sorted and not
/// overlapping on each track, every clip's media in the bin, links with at least
/// two clips, a main track (without gaps when magnetic), markers in time order and
/// values in range.
///
/// Edit-only rules (whole frames, source within the media) are not checked here:
/// a changed frame rate or a relinked file can break them without corrupting anything.
pub fn validate(project: &Project) -> Result<(), String> {
    if !valid_project_id(&project.id) {
        return Err(format!("Invalid project id {:?}", project.id));
    }
    check_name(&project.name, "The project", 200)?;
    project.settings.validate()?;

    let mut media_ids = BTreeSet::new();
    for media in &project.media {
        media.validate()?;
        if !media_ids.insert(media.id.as_str()) {
            return Err(format!("Media {} is listed twice", media.id));
        }
    }

    if project.tracks.is_empty() {
        return Err("A project needs at least one track".into());
    }
    let mut ids = BTreeSet::new();
    let mut unique = |id: u64, what: &str| -> Result<(), String> {
        if id == 0 || id >= project.next_id {
            return Err(format!("{what} {id} is outside the id range"));
        }
        if !ids.insert(id) {
            return Err(format!("Id {id} is used twice"));
        }
        Ok(())
    };
    let mut links: BTreeMap<u64, usize> = BTreeMap::new();
    for (index, track) in project.tracks.iter().enumerate() {
        unique(track.id.0, "Track")?;
        check_volume(track.volume_db)?;
        check_pan(track.pan)?;
        track.ducking.check()?;
        for (position, clip) in track.clips.iter().enumerate() {
            unique(clip.id.0, "Clip")?;
            if clip.duration <= Flicks::ZERO || clip.start < Flicks::ZERO || clip.end() > MAX_TIME {
                return Err(format!("Clip {} has an invalid time range", clip.id));
            }
            if position > 0 && track.clips[position - 1].end() > clip.start {
                return Err(format!(
                    "Clips overlap or are out of order on track {}",
                    index + 1
                ));
            }
            match clip.kind {
                ClipKind::Media => {
                    let media = project.media(&clip.media).ok_or_else(|| {
                        format!("Clip {} uses media that is not in the project", clip.id)
                    })?;
                    if (clip.video && !media.has_video)
                        || (clip.audio && !media.has_audio)
                        || (!clip.video && !clip.audio)
                    {
                        return Err(format!("Clip {} has streams its media lacks", clip.id));
                    }
                    if media.is_still() && clip.source_in != Flicks::ZERO {
                        return Err(format!("Still clip {} has a source position", clip.id));
                    }
                }
                ClipKind::Adjustment | ClipKind::Title => {
                    let plain = clip.media.is_empty()
                        && clip.video
                        && !clip.audio
                        && clip.source_in == Flicks::ZERO
                        && clip.speed == Speed::NORMAL;
                    if !plain {
                        return Err(format!(
                            "Adjustment layer or title {} has media, sound or timing",
                            clip.id
                        ));
                    }
                }
            }
            match (&clip.title, clip.is_title()) {
                (Some(title), true) => {
                    title.check()?;
                    for element in &title.elements {
                        if element.id.0 == 0 || element.id.0 >= project.next_id {
                            return Err(format!(
                                "Title element {} is outside the id range",
                                element.id
                            ));
                        }
                    }
                }
                (None, false) => {}
                _ => return Err(format!("Clip {} has a title it cannot draw", clip.id)),
            }
            if Speed::new(clip.speed.num, clip.speed.den) != Some(clip.speed) {
                return Err(format!("Clip {} has an invalid speed", clip.id));
            }
            check_effects(clip)?;
            for effect in clip.effects.iter().chain(&clip.audio_effects) {
                unique(effect.id.0, "Effect")?;
            }
            check_keyframes(clip)?;
            check_transform(&clip.transform)?;
            check_crop(&clip.crop)?;
            check_opacity(clip.opacity)?;
            check_volume(clip.volume_db)?;
            if let Some(link) = clip.link {
                *links.entry(link.0).or_default() += 1;
            }
        }
        for transition in &track.transitions {
            unique(transition.id.0, "Transition")?;
        }
        check_transitions(track, project.settings.frame_duration())?;
    }
    for lut in &project.luts {
        unique(lut.id.0, "LUT")?;
        lut.check()?;
    }
    let main = project
        .track(project.main_track)
        .ok_or("The main track is missing")?;
    if project.magnetic {
        let mut end = Flicks::ZERO;
        for clip in &main.clips {
            if clip.start != end {
                return Err("The magnetic main track has a gap".into());
            }
            end = clip.end();
        }
    }
    for (&link, &count) in &links {
        unique(link, "Link")?;
        if count < 2 {
            return Err(format!("Link {link} has only one clip"));
        }
    }
    for (position, marker) in project.markers.iter().enumerate() {
        unique(marker.id.0, "Marker")?;
        if marker.time < Flicks::ZERO || marker.time > MAX_TIME {
            return Err(format!("Marker {} is outside the timeline", marker.id));
        }
        if position > 0 {
            let previous = &project.markers[position - 1];
            if (previous.time, previous.id) > (marker.time, marker.id) {
                return Err("Markers are out of order".into());
            }
        }
    }
    Ok(())
}

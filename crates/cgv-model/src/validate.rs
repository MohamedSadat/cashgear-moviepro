//! Rules every project meets, checked after every edit and when a file is opened.
use std::collections::{BTreeMap, BTreeSet};

use cgv_time::Flicks;

use crate::edit::{check_crop, check_opacity, check_transform, check_volume};
use crate::project::{Project, Speed, MAX_TIME};

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
        for (position, clip) in track.clips.iter().enumerate() {
            unique(clip.id.0, "Clip")?;
            let media = project
                .media(&clip.media)
                .ok_or_else(|| format!("Clip {} uses media that is not in the project", clip.id))?;
            if clip.duration <= Flicks::ZERO || clip.start < Flicks::ZERO || clip.end() > MAX_TIME {
                return Err(format!("Clip {} has an invalid time range", clip.id));
            }
            if position > 0 && track.clips[position - 1].end() > clip.start {
                return Err(format!(
                    "Clips overlap or are out of order on track {}",
                    index + 1
                ));
            }
            if (clip.video && !media.has_video)
                || (clip.audio && !media.has_audio)
                || (!clip.video && !clip.audio)
            {
                return Err(format!("Clip {} has streams its media lacks", clip.id));
            }
            if media.is_still() && clip.source_in != Flicks::ZERO {
                return Err(format!("Still clip {} has a source position", clip.id));
            }
            if Speed::new(clip.speed.num, clip.speed.den) != Some(clip.speed) {
                return Err(format!("Clip {} has an invalid speed", clip.id));
            }
            check_transform(&clip.transform)?;
            check_crop(&clip.crop)?;
            check_opacity(clip.opacity)?;
            check_volume(clip.volume_db)?;
            if let Some(link) = clip.link {
                *links.entry(link.0).or_default() += 1;
            }
        }
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

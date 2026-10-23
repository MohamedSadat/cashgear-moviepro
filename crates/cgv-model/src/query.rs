//! Read-only questions about a project: what plays at a time, track extents, snapping.
use cgv_time::Flicks;
use serde::Serialize;

use crate::project::{Clip, ClipId, Project, TrackId};

/// A clip under the playhead, with the track it is on.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAt<'a> {
    pub track: TrackId,
    pub track_index: usize,
    pub clip: &'a Clip,
}

/// The clips at `time`, bottom track first (the order they draw in).
pub fn clips_at(project: &Project, time: Flicks) -> Vec<ClipAt<'_>> {
    project
        .tracks
        .iter()
        .enumerate()
        .filter_map(|(track_index, track)| {
            // Clips are sorted and never overlap: the last one starting at or before
            // `time` is the only candidate.
            let next = track.clips.partition_point(|clip| clip.start <= time);
            let clip = track.clips[..next].last()?;
            clip.contains(time).then_some(ClipAt {
                track: track.id,
                track_index,
                clip,
            })
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRange {
    pub track: TrackId,
    pub start: Flicks,
    pub end: Flicks,
}

/// From the first clip's start to the last clip's end, for each non-empty track.
pub fn track_ranges(project: &Project) -> Vec<TrackRange> {
    project
        .tracks
        .iter()
        .filter_map(|track| {
            let (start, end) = track.range()?;
            Some(TrackRange {
                track: track.id,
                start,
                end,
            })
        })
        .collect()
}

/// Times worth snapping to, sorted and unique: the timeline start, the playhead,
/// markers and the edges of every clip not in `exclude` (the clips being dragged).
pub fn snap_points(project: &Project, playhead: Option<Flicks>, exclude: &[ClipId]) -> Vec<Flicks> {
    let mut points = vec![Flicks::ZERO];
    points.extend(playhead);
    points.extend(project.markers.iter().map(|marker| marker.time));
    for clip in project.clips().filter(|clip| !exclude.contains(&clip.id)) {
        points.push(clip.start);
        points.push(clip.end());
    }
    points.sort();
    points.dedup();
    points
}

/// The point nearest `time` within `tolerance`, if any. `points` must be sorted.
pub fn snap(points: &[Flicks], time: Flicks, tolerance: Flicks) -> Option<Flicks> {
    let next = points.partition_point(|&point| point < time);
    let candidates = [next.checked_sub(1), Some(next)];
    candidates
        .into_iter()
        .flatten()
        .filter_map(|index| points.get(index).copied())
        .map(|point| (Flicks((point.0 - time.0).abs()), point))
        .filter(|(distance, _)| *distance <= tolerance)
        .min()
        .map(|(_, point)| point)
}

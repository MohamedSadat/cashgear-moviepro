use cgv_time::Flicks;
use serde::{Deserialize, Serialize};

use crate::project::{
    ClipId, Crop, MarkerColor, MarkerId, MediaRef, ProjectSettings, Speed, TrackId, Transform,
};

/// Which edge of a clip an edit acts on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Edge {
    Start,
    End,
}

/// What to place for insert, overwrite and append.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSpec {
    pub media: String,
    /// Source time of the first frame. Always zero for still images.
    #[serde(default)]
    pub source_in: Flicks,
    /// Timeline duration, snapped to whole project frames.
    pub duration: Flicks,
    /// Show the picture. Defaults to whether the media has video.
    #[serde(default)]
    pub video: Option<bool>,
    /// Play the sound. Defaults to whether the media has audio.
    #[serde(default)]
    pub audio: Option<bool>,
}

/// Clip properties to change; missing fields stay as they are.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipProperties {
    #[serde(default)]
    pub transform: Option<Transform>,
    #[serde(default)]
    pub crop: Option<Crop>,
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub volume_db: Option<f64>,
}

/// Every change to a project. Each one either applies completely or fails and
/// changes nothing, and each successful one is a step the session can undo.
///
/// Times are flicks. Timeline times and deltas snap to whole project frames.
/// Clip commands also act on the clips' linked partners.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Rename {
        name: String,
    },
    /// Changes the output format. Clips keep their times when the frame rate changes.
    SetSettings {
        settings: ProjectSettings,
    },
    AddMedia {
        media: MediaRef,
    },
    /// Removes media from the bin, with every clip that uses it.
    RemoveMedia {
        media: String,
    },

    /// Adds an empty track at `index` (0 is the bottom).
    AddTrack {
        index: usize,
        #[serde(default)]
        name: Option<String>,
    },
    /// Removes a track and its clips. A project keeps at least one track.
    RemoveTrack {
        track: TrackId,
    },
    MoveTrack {
        track: TrackId,
        index: usize,
    },
    RenameTrack {
        track: TrackId,
        name: String,
    },
    SetTrackLocked {
        track: TrackId,
        locked: bool,
    },
    SetTrackMuted {
        track: TrackId,
        muted: bool,
    },
    SetTrackHidden {
        track: TrackId,
        hidden: bool,
    },

    /// Places a clip at `at`, pushing later clips on the track to the right. A clip
    /// under `at` is split first.
    Insert {
        track: TrackId,
        at: Flicks,
        clip: ClipSpec,
    },
    /// Places a clip at `at`, replacing whatever it covers on the track.
    Overwrite {
        track: TrackId,
        at: Flicks,
        clip: ClipSpec,
    },
    /// Places a clip after the last clip on the track.
    Append {
        track: TrackId,
        clip: ClipSpec,
    },
    /// Removes clips and leaves gaps.
    Delete {
        clips: Vec<ClipId>,
    },
    /// Removes clips and closes their gaps on each track.
    RippleDelete {
        clips: Vec<ClipId>,
    },
    /// Splits clips at `at`. An empty list splits every clip under `at` on unlocked tracks.
    Split {
        at: Flicks,
        #[serde(default)]
        clips: Vec<ClipId>,
    },
    /// Moves one edge of a clip by `delta`. A ripple trim keeps the clip's start and
    /// shifts the later clips on its track by the change in length.
    Trim {
        clip: ClipId,
        edge: Edge,
        delta: Flicks,
        #[serde(default)]
        ripple: bool,
    },
    /// Moves the cut between a clip and its adjacent neighbour at `edge`.
    Roll {
        clip: ClipId,
        edge: Edge,
        delta: Flicks,
    },
    /// Moves clips by `delta` in time and `tracks` up (positive) or down. Without
    /// `overwrite`, landing on another clip fails.
    Move {
        clips: Vec<ClipId>,
        delta: Flicks,
        #[serde(default)]
        tracks: i32,
        #[serde(default)]
        overwrite: bool,
    },
    /// Shows a different part of the source in the same place on the timeline.
    Slip {
        clip: ClipId,
        delta: Flicks,
    },
    /// Moves a clip between its neighbours: adjacent ones get longer or shorter to match.
    Slide {
        clip: ClipId,
        delta: Flicks,
    },
    Link {
        clips: Vec<ClipId>,
    },
    Unlink {
        clips: Vec<ClipId>,
    },
    /// Moves a video clip's sound to a new linked audio clip, on `track` or on a new
    /// track below the clip.
    DetachAudio {
        clip: ClipId,
        #[serde(default)]
        track: Option<TrackId>,
    },
    /// Changes speed, keeping the clip's start and source in point; its length follows.
    SetSpeed {
        clip: ClipId,
        speed: Speed,
    },
    SetClipProperties {
        clip: ClipId,
        properties: ClipProperties,
    },

    AddMarker {
        at: Flicks,
        #[serde(default)]
        name: String,
        color: MarkerColor,
    },
    UpdateMarker {
        marker: MarkerId,
        #[serde(default)]
        at: Option<Flicks>,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        color: Option<MarkerColor>,
    },
    RemoveMarker {
        marker: MarkerId,
    },
}

impl Command {
    /// The undo menu's name for this edit.
    pub fn label(&self) -> &'static str {
        match self {
            Command::Rename { .. } => "Rename project",
            Command::SetSettings { .. } => "Change project settings",
            Command::AddMedia { .. } => "Import media",
            Command::RemoveMedia { .. } => "Remove media",
            Command::AddTrack { .. } => "Add track",
            Command::RemoveTrack { .. } => "Delete track",
            Command::MoveTrack { .. } => "Move track",
            Command::RenameTrack { .. } => "Rename track",
            Command::SetTrackLocked { locked: true, .. } => "Lock track",
            Command::SetTrackLocked { .. } => "Unlock track",
            Command::SetTrackMuted { muted: true, .. } => "Mute track",
            Command::SetTrackMuted { .. } => "Unmute track",
            Command::SetTrackHidden { hidden: true, .. } => "Hide track",
            Command::SetTrackHidden { .. } => "Show track",
            Command::Insert { .. } => "Insert",
            Command::Overwrite { .. } => "Overwrite",
            Command::Append { .. } => "Add to timeline",
            Command::Delete { .. } => "Delete",
            Command::RippleDelete { .. } => "Ripple delete",
            Command::Split { .. } => "Split",
            Command::Trim { ripple: true, .. } => "Ripple trim",
            Command::Trim { .. } => "Trim",
            Command::Roll { .. } => "Roll edit",
            Command::Move { .. } => "Move",
            Command::Slip { .. } => "Slip",
            Command::Slide { .. } => "Slide",
            Command::Link { .. } => "Link",
            Command::Unlink { .. } => "Unlink",
            Command::DetachAudio { .. } => "Detach audio",
            Command::SetSpeed { .. } => "Change speed",
            Command::SetClipProperties { .. } => "Change clip",
            Command::AddMarker { .. } => "Add marker",
            Command::UpdateMarker { .. } => "Change marker",
            Command::RemoveMarker { .. } => "Delete marker",
        }
    }
}

/// What a successful command created, in order: the new clip, track or marker
/// first, then anything made along the way (such as the right half of a split).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub created: Vec<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_read_camel_case_json() {
        let command: Command = serde_json::from_str(
            r#"{"type":"trim","clip":7,"edge":"start","delta":-23543520,"ripple":true}"#,
        )
        .unwrap();
        assert_eq!(
            command,
            Command::Trim {
                clip: ClipId(7),
                edge: Edge::Start,
                delta: Flicks(-23_543_520),
                ripple: true,
            }
        );
        assert_eq!(command.label(), "Ripple trim");
        let insert: Command = serde_json::from_str(
            r#"{"type":"insert","track":1,"at":0,"clip":{"media":"m","duration":705600000}}"#,
        )
        .unwrap();
        let Command::Insert { clip, .. } = insert else {
            panic!("not an insert")
        };
        assert_eq!(clip.source_in, Flicks::ZERO);
        assert_eq!(clip.audio, None);
        assert!(serde_json::from_str::<Command>(r#"{"type":"split","at":0,"bogus":1}"#).is_err());
    }
}

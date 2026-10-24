use cgv_time::Flicks;
use serde::{Deserialize, Serialize};

use crate::animation::{Interpolation, KeyValue, Keyframes};
use crate::effects::{Alignment, EffectSpec, LutSpec, Params, TransitionSpec};
use crate::project::{
    ClipId, ClipKind, Crop, EffectId, LutId, MarkerColor, MarkerId, MediaRef, ProjectSettings,
    Speed, TrackId, Transform, TransitionId,
};

/// Which edge of a clip an edit acts on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Edge {
    Start,
    End,
}

/// What to place for insert, overwrite and append.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSpec {
    /// An adjustment layer has no media (`media` is empty).
    #[serde(default)]
    pub kind: ClipKind,
    #[serde(default)]
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
    /// Speed of the new clip; `duration` is its length at that speed. Defaults to 1×.
    #[serde(default)]
    pub speed: Option<Speed>,
    /// Picture and sound settings of the new clip, as when pasting a copy.
    #[serde(default)]
    pub properties: Option<ClipProperties>,
    /// Effects of the new clip, as when pasting a copy.
    #[serde(default)]
    pub effects: Vec<EffectSpec>,
    /// Keyframes of the new clip. Effect settings are named by the ids in `effects`.
    #[serde(default)]
    pub keyframes: Keyframes,
}

/// Transform values to change; missing ones stay as they are, so edits of
/// different values never undo each other.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransformPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_y: Option<f64>,
}

impl TransformPatch {
    pub fn apply(&self, t: Transform) -> Transform {
        Transform {
            x: self.x.unwrap_or(t.x),
            y: self.y.unwrap_or(t.y),
            scale_x: self.scale_x.unwrap_or(t.scale_x),
            scale_y: self.scale_y.unwrap_or(t.scale_y),
            rotation: self.rotation.unwrap_or(t.rotation),
            anchor_x: self.anchor_x.unwrap_or(t.anchor_x),
            anchor_y: self.anchor_y.unwrap_or(t.anchor_y),
        }
    }
}

impl From<Transform> for TransformPatch {
    fn from(t: Transform) -> Self {
        TransformPatch {
            x: Some(t.x),
            y: Some(t.y),
            scale_x: Some(t.scale_x),
            scale_y: Some(t.scale_y),
            rotation: Some(t.rotation),
            anchor_x: Some(t.anchor_x),
            anchor_y: Some(t.anchor_y),
        }
    }
}

/// Crop sides to change; missing ones stay as they are.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CropPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<f64>,
}

impl CropPatch {
    pub fn apply(&self, c: Crop) -> Crop {
        Crop {
            left: self.left.unwrap_or(c.left),
            top: self.top.unwrap_or(c.top),
            right: self.right.unwrap_or(c.right),
            bottom: self.bottom.unwrap_or(c.bottom),
        }
    }
}

impl From<Crop> for CropPatch {
    fn from(c: Crop) -> Self {
        CropPatch {
            left: Some(c.left),
            top: Some(c.top),
            right: Some(c.right),
            bottom: Some(c.bottom),
        }
    }
}

/// Clip properties to change; missing fields stay as they are.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipProperties {
    #[serde(default)]
    pub transform: Option<TransformPatch>,
    #[serde(default)]
    pub crop: Option<CropPatch>,
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
    /// Turns the main track's magnetism on (closing its gaps) or off.
    SetMagnetic {
        magnetic: bool,
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
    /// Removes a track and its clips. A project keeps at least one track, and its main track.
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
    /// under `at` is split first. On the magnetic main track, insert, overwrite and
    /// moves happen at the cut between clips nearest `at`.
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
    /// Moves clips by `delta` in time and `tracks` up (positive) or down. Linked
    /// partners move in time but keep their tracks. Without `overwrite`, landing on
    /// another clip fails; on the magnetic main track, moved clips are inserted.
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

    /// Adds an effect to a clip's picture at `index` in its list (the end by default).
    AddEffect {
        clip: ClipId,
        effect: EffectSpec,
        #[serde(default)]
        index: Option<usize>,
    },
    /// Removes an effect and its keyframes.
    RemoveEffect {
        clip: ClipId,
        effect: EffectId,
    },
    /// Moves an effect to `index` in the clip's list.
    MoveEffect {
        clip: ClipId,
        effect: EffectId,
        index: usize,
    },
    SetEffectEnabled {
        clip: ClipId,
        effect: EffectId,
        enabled: bool,
    },
    /// Changes the named settings; others stay as they are.
    SetEffectParams {
        clip: ClipId,
        effect: EffectId,
        params: Params,
    },
    /// Replaces every setting with `params` (the definition's defaults) and
    /// removes the effect's keyframes.
    ResetEffect {
        clip: ClipId,
        effect: EffectId,
        #[serde(default)]
        params: Params,
    },

    /// Adds or replaces the keyframe of `property` at `time` (from the clip's start).
    SetKeyframe {
        clip: ClipId,
        property: String,
        time: Flicks,
        value: KeyValue,
        /// Defaults to the replaced keyframe's, or linear.
        #[serde(default)]
        interpolation: Option<Interpolation>,
    },
    RemoveKeyframes {
        clip: ClipId,
        property: String,
        times: Vec<Flicks>,
    },
    /// Replaces every keyframe of `property` (an empty list stops animating it):
    /// one step for a curve edit. Times snap to frames; keys landing on one frame
    /// keep the last.
    SetKeyframes {
        clip: ClipId,
        property: String,
        keys: Vec<crate::animation::Keyframe>,
    },
    /// Moves the keyframes at `times` by `delta`, for each of `properties` (every
    /// animated property when empty). A keyframe moved onto another replaces it.
    MoveKeyframes {
        clip: ClipId,
        #[serde(default)]
        properties: Vec<String>,
        times: Vec<Flicks>,
        delta: Flicks,
    },
    SetInterpolation {
        clip: ClipId,
        property: String,
        times: Vec<Flicks>,
        interpolation: Interpolation,
    },
    /// Removes every keyframe of `property`. With `at`, the property keeps the
    /// value it had then.
    ClearKeyframes {
        clip: ClipId,
        property: String,
        #[serde(default)]
        at: Option<Flicks>,
    },

    /// Adds a transition on `track` between `from` and `to`, which touch, or at the
    /// free start of `to` or free end of `from`. One already at that cut is replaced.
    AddTransition {
        track: TrackId,
        #[serde(default)]
        from: Option<ClipId>,
        #[serde(default)]
        to: Option<ClipId>,
        transition: TransitionSpec,
    },
    /// Changes a transition's duration, alignment or settings (a patch).
    SetTransition {
        transition: TransitionId,
        #[serde(default)]
        duration: Option<Flicks>,
        #[serde(default)]
        alignment: Option<Alignment>,
        #[serde(default)]
        params: Option<Params>,
    },
    RemoveTransition {
        transition: TransitionId,
    },

    /// Adds a LUT to the project, for effects to use.
    AddLut {
        lut: LutSpec,
    },
    /// Removes a LUT no effect uses.
    RemoveLut {
        lut: LutId,
    },

    AddMarker {
        at: Flicks,
        #[serde(default)]
        name: String,
        color: MarkerColor,
    },

    /// Several clip property, effect or keyframe changes as one command, so one
    /// gesture step can change them together (a uniform scale's x and y).
    Batch {
        commands: Vec<Command>,
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
            Command::SetMagnetic { magnetic: true, .. } => "Magnetic main track on",
            Command::SetMagnetic { .. } => "Magnetic main track off",
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
            Command::AddEffect { .. } => "Add effect",
            Command::RemoveEffect { .. } => "Remove effect",
            Command::MoveEffect { .. } => "Reorder effects",
            Command::SetEffectEnabled { enabled: true, .. } => "Turn effect on",
            Command::SetEffectEnabled { .. } => "Turn effect off",
            Command::SetEffectParams { .. } => "Change effect",
            Command::ResetEffect { .. } => "Reset effect",
            Command::SetKeyframe { .. } => "Set keyframe",
            Command::RemoveKeyframes { .. } => "Delete keyframes",
            Command::SetKeyframes { .. } => "Change keyframes",
            Command::MoveKeyframes { .. } => "Move keyframes",
            Command::SetInterpolation { .. } => "Change interpolation",
            Command::ClearKeyframes { .. } => "Stop animating",
            Command::AddTransition { .. } => "Add transition",
            Command::SetTransition { .. } => "Change transition",
            Command::RemoveTransition { .. } => "Delete transition",
            Command::AddLut { .. } => "Import LUT",
            Command::RemoveLut { .. } => "Remove LUT",
            Command::AddMarker { .. } => "Add marker",
            Command::UpdateMarker { .. } => "Change marker",
            Command::RemoveMarker { .. } => "Delete marker",
            Command::Batch { commands } => commands.first().map_or("Change clip", Command::label),
        }
    }
}

/// What a successful command created, in order: the new clip, track, marker,
/// effect, transition or LUT first, then anything made along the way (such as the
/// right half of a split).
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
        assert_eq!((clip.speed, clip.properties), (None, None));
        assert!(serde_json::from_str::<Command>(r#"{"type":"split","at":0,"bogus":1}"#).is_err());
    }
}

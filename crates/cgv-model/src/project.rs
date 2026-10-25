use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use cgv_time::{Flicks, FrameRate};
use serde::{Deserialize, Serialize};

use crate::animation::Keyframes;
use crate::effects::{Effect, Lut, LutInfo, Transition};
use crate::title::Title;

/// The latest time the model accepts: 2^53 − 1 flicks (about 147 days), so every
/// time stays an exact integer in JavaScript.
pub const MAX_TIME: Flicks = Flicks((1 << 53) - 1);

macro_rules! id_type {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub u64);

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }
    };
}

id_type!(TrackId);
id_type!(ClipId);
id_type!(MarkerId);
id_type!(
    /// Clips sharing a link id are selected, moved and trimmed together.
    LinkId
);
id_type!(EffectId);
id_type!(TransitionId);
id_type!(LutId);
id_type!(
    /// A text block or shape of a title; unique within its clip.
    ElementId
);

/// A project: settings, the media it uses, its tracks and markers.
///
/// Tracks are shared (`Arc`) so undo snapshots copy only the tracks an edit changes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub settings: ProjectSettings,
    /// The project's media bin, in import order.
    pub media: Vec<MediaRef>,
    /// Bottom track first: higher tracks draw on top.
    pub tracks: Vec<Arc<Track>>,
    /// The main track. New projects start with it at the bottom; it cannot be removed.
    pub main_track: TrackId,
    /// When set, the main track has no gaps: its clips butt together from 0, and
    /// clips linked to them follow wherever that moves them.
    pub magnetic: bool,
    /// Timeline markers, by time.
    pub markers: Vec<Marker>,
    /// Colour lookup tables effects use, kept in the project so it travels whole.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub luts: Vec<Arc<Lut>>,
    /// The next track, clip, marker, link, effect, transition or LUT id. Counting
    /// within the project keeps replays and undo exact.
    pub next_id: u64,
}

impl Project {
    /// An empty project with the default settings and two tracks; the bottom one
    /// is the magnetic main track.
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Project {
        let mut project = Project {
            id: id.into(),
            name: name.into(),
            settings: ProjectSettings::default(),
            media: Vec::new(),
            tracks: Vec::new(),
            main_track: TrackId(0),
            magnetic: true,
            markers: Vec::new(),
            luts: Vec::new(),
            next_id: 1,
        };
        for _ in 0..2 {
            let id = TrackId(project.alloc_id());
            project.tracks.push(Arc::new(Track::new(id)));
        }
        project.main_track = project.tracks[0].id;
        project
    }

    pub(crate) fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    pub fn media(&self, id: &str) -> Option<&MediaRef> {
        self.media.iter().find(|media| media.id == id)
    }

    pub fn track(&self, id: TrackId) -> Option<&Track> {
        self.tracks
            .iter()
            .find(|track| track.id == id)
            .map(|t| t.as_ref())
    }

    pub fn track_index(&self, id: TrackId) -> Option<usize> {
        self.tracks.iter().position(|track| track.id == id)
    }

    /// The index of the main track when it is magnetic.
    pub fn magnetic_index(&self) -> Option<usize> {
        self.magnetic
            .then(|| self.track_index(self.main_track))
            .flatten()
    }

    /// The track index and clip of `id`.
    pub fn clip(&self, id: ClipId) -> Option<(usize, &Clip)> {
        self.tracks.iter().enumerate().find_map(|(index, track)| {
            track
                .clips
                .iter()
                .find(|clip| clip.id == id)
                .map(|clip| (index, clip))
        })
    }

    pub fn lut(&self, id: LutId) -> Option<&Lut> {
        self.luts
            .iter()
            .find(|lut| lut.id == id)
            .map(|lut| lut.as_ref())
    }

    pub fn clips(&self) -> impl Iterator<Item = &Clip> {
        self.tracks.iter().flat_map(|track| track.clips.iter())
    }

    /// The end of the last clip on any track.
    pub fn duration(&self) -> Flicks {
        self.tracks
            .iter()
            .filter_map(|track| track.end())
            .max()
            .unwrap_or(Flicks::ZERO)
    }
}

/// A project as the UI sees it: the same JSON as the file, with LUTs described
/// rather than included, so every edit's snapshot stays small.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub settings: &'a ProjectSettings,
    pub media: &'a [MediaRef],
    pub tracks: &'a [Arc<Track>],
    pub main_track: TrackId,
    pub magnetic: bool,
    pub markers: &'a [Marker],
    pub luts: Vec<LutInfo<'a>>,
    pub next_id: u64,
}

impl Project {
    pub fn view(&self) -> ProjectView<'_> {
        ProjectView {
            id: &self.id,
            name: &self.name,
            settings: &self.settings,
            media: &self.media,
            tracks: &self.tracks,
            main_track: self.main_track,
            magnetic: self.magnetic,
            markers: &self.markers,
            luts: self.luts.iter().map(|lut| lut.info()).collect(),
            next_id: self.next_id,
        }
    }
}

/// Output format of the timeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    pub frame_rate: FrameRate,
    pub sample_rate: u32,
    pub channels: u16,
}

impl Default for ProjectSettings {
    /// 1920×1080 at 30 fps, 48 kHz stereo.
    fn default() -> Self {
        ProjectSettings {
            width: 1920,
            height: 1080,
            frame_rate: FrameRate::FPS_30,
            sample_rate: 48_000,
            channels: 2,
        }
    }
}

/// A named resolution offered when creating a project or changing its settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub width: u32,
    pub height: u32,
}

pub const PRESETS: [Preset; 4] = [
    Preset {
        id: "landscape",
        label: "16:9 Landscape",
        width: 1920,
        height: 1080,
    },
    Preset {
        id: "portrait",
        label: "9:16 Portrait",
        width: 1080,
        height: 1920,
    },
    Preset {
        id: "square",
        label: "1:1 Square",
        width: 1080,
        height: 1080,
    },
    Preset {
        id: "uhd",
        label: "4K UHD",
        width: 3840,
        height: 2160,
    },
];

pub const SAMPLE_RATES: [u32; 2] = [44_100, 48_000];
const MIN_SIZE: u32 = 16;
const MAX_SIZE: u32 = 8192;

impl ProjectSettings {
    pub fn frame_duration(&self) -> Flicks {
        self.frame_rate.frame_duration()
    }

    /// The preset these settings match, if any.
    pub fn preset(&self) -> Option<&'static Preset> {
        PRESETS
            .iter()
            .find(|preset| preset.width == self.width && preset.height == self.height)
    }

    /// The reduced aspect ratio, such as "16:9".
    pub fn aspect_label(&self) -> String {
        let (mut a, mut b) = (self.width, self.height);
        while b != 0 {
            (a, b) = (b, a % b);
        }
        let divisor = a.max(1);
        format!("{}:{}", self.width / divisor, self.height / divisor)
    }

    pub fn validate(&self) -> Result<(), String> {
        for (label, size) in [("Width", self.width), ("Height", self.height)] {
            if !(MIN_SIZE..=MAX_SIZE).contains(&size) || size % 2 != 0 {
                return Err(format!(
                    "{label} must be an even number from {MIN_SIZE} to {MAX_SIZE} pixels"
                ));
            }
        }
        // Standard rates have exact frame boundaries in flicks, so every edit lands on one.
        if !FrameRate::STANDARD.contains(&self.frame_rate) {
            return Err(format!(
                "{} fps is not a supported project frame rate",
                self.frame_rate.label()
            ));
        }
        if !SAMPLE_RATES.contains(&self.sample_rate) {
            return Err(format!(
                "{} Hz is not a supported sample rate",
                self.sample_rate
            ));
        }
        if !(1..=2).contains(&self.channels) {
            return Err("Projects are mono or stereo".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

/// Where a media file lives. Saved in the project file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MediaLocation {
    /// A local file (desktop).
    Path { path: String },
    /// A file the browser keeps for this media id: a File System Access handle or an OPFS copy.
    Browser,
    /// A file of the app's own pack (a sticker), by its path under `assets`: the
    /// app has it wherever the project opens.
    Pack { path: String },
}

/// A media file the project uses, with what relinking and the timeline need to know.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaRef {
    pub id: String,
    pub name: String,
    pub kind: MediaKind,
    /// Zero for still images, which play for any duration. An animated image's
    /// is one loop of its frames.
    pub duration: Flicks,
    pub has_video: bool,
    pub has_audio: bool,
    pub width: u32,
    pub height: u32,
    pub frame_rate: Option<FrameRate>,
    /// File size in bytes, for relinking and change detection.
    pub size: u64,
    /// Last-modified time in milliseconds since 1970, when known.
    pub modified: Option<i64>,
    pub location: MediaLocation,
}

impl MediaRef {
    /// A still image: one picture for any length of clip.
    pub fn is_still(&self) -> bool {
        self.kind == MediaKind::Image && self.duration == Flicks::ZERO
    }

    /// An animated image (GIF, WebP, APNG): its frames loop for as long as its clip lasts.
    pub fn loops(&self) -> bool {
        self.kind == MediaKind::Image && self.duration > Flicks::ZERO
    }

    pub fn validate(&self) -> Result<(), String> {
        let id_ok = !self.id.is_empty()
            && self.id.len() <= 128
            && self
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'));
        if !id_ok {
            return Err(format!("Invalid media id {:?}", self.id));
        }
        if self.name.trim().is_empty() {
            return Err("Media needs a name".into());
        }
        if self.duration < Flicks::ZERO || self.duration > MAX_TIME {
            return Err(format!("{} has an invalid duration", self.name));
        }
        let streams_ok = match self.kind {
            MediaKind::Video => self.has_video,
            MediaKind::Audio => self.has_audio && !self.has_video,
            MediaKind::Image => self.has_video && !self.has_audio,
        };
        if !streams_ok {
            return Err(format!(
                "{} has streams that do not match its kind",
                self.name
            ));
        }
        Ok(())
    }
}

pub(crate) fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

fn is_no_time(value: &Flicks) -> bool {
    *value == Flicks::ZERO
}

/// What a track carries, so the mixer can lower music under dialogue.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackRole {
    #[default]
    None,
    Dialogue,
    Music,
    Effects,
}

impl TrackRole {
    fn is_none(&self) -> bool {
        *self == TrackRole::None
    }
}

/// How a music track dips while a dialogue track plays.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ducking {
    pub enabled: bool,
    /// How far the music goes down, in decibels (positive).
    pub amount_db: f64,
    /// Dialogue counts as speaking above this level (dBFS RMS over 10 ms).
    pub threshold_db: f64,
    /// Seconds of the fall, which ends as speech starts.
    pub attack: f64,
    /// Seconds speech counts as going on after it stops.
    pub hold: f64,
    /// Seconds of the rise after that.
    pub release: f64,
}

impl Default for Ducking {
    fn default() -> Self {
        Ducking {
            enabled: true,
            amount_db: 12.0,
            threshold_db: -40.0,
            attack: 0.2,
            hold: 0.3,
            release: 0.6,
        }
    }
}

impl Ducking {
    fn is_default(&self) -> bool {
        *self == Ducking::default()
    }

    pub fn check(&self) -> Result<(), String> {
        let times = [self.attack, self.hold, self.release];
        if !(0.0..=60.0).contains(&self.amount_db)
            || !(-80.0..=0.0).contains(&self.threshold_db)
            || !times.iter().all(|t| (0.0..=10.0).contains(t))
        {
            return Err("Ducking settings are out of range".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: TrackId,
    /// Empty means the UI shows its position ("Track 2").
    pub name: String,
    pub locked: bool,
    pub muted: bool,
    pub hidden: bool,
    /// Gain in decibels, after the clips' own.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub volume_db: f64,
    /// -1 (left) to 1 (right).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub pan: f64,
    /// While any track is soloed, only soloed tracks are heard.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub solo: bool,
    #[serde(default, skip_serializing_if = "TrackRole::is_none")]
    pub role: TrackRole,
    /// Applies while the track's role is music.
    #[serde(default, skip_serializing_if = "Ducking::is_default")]
    pub ducking: Ducking,
    /// By start time; never overlapping.
    pub clips: Vec<Clip>,
    /// Transitions between and at the edges of this track's clips, by time.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transitions: Vec<Transition>,
}

impl Track {
    pub fn new(id: TrackId) -> Track {
        Track {
            id,
            name: String::new(),
            locked: false,
            muted: false,
            hidden: false,
            volume_db: 0.0,
            pan: 0.0,
            solo: false,
            role: TrackRole::None,
            ducking: Ducking::default(),
            clips: Vec::new(),
            transitions: Vec::new(),
        }
    }

    pub fn clip(&self, id: ClipId) -> Option<&Clip> {
        self.clips.iter().find(|clip| clip.id == id)
    }

    /// The cut transition `transition` sits on: the end of its first clip or the
    /// start of its second.
    pub fn cut(&self, transition: &Transition) -> Option<Flicks> {
        match (transition.from, transition.to) {
            (Some(from), _) => self.clip(from).map(Clip::end),
            (None, Some(to)) => self.clip(to).map(|clip| clip.start),
            (None, None) => None,
        }
    }

    /// The transition that ends at clip `id`'s start or begins at its end.
    pub fn transition_at(&self, id: ClipId, edge: crate::Edge) -> Option<&Transition> {
        self.transitions.iter().find(|t| match edge {
            crate::Edge::Start => t.to == Some(id),
            crate::Edge::End => t.from == Some(id),
        })
    }

    pub fn end(&self) -> Option<Flicks> {
        self.clips.last().map(Clip::end)
    }

    /// First start and last end, or None for an empty track.
    pub fn range(&self) -> Option<(Flicks, Flicks)> {
        Some((self.clips.first()?.start, self.end()?))
    }

    pub fn position(&self, clip: ClipId) -> Option<usize> {
        self.clips.iter().position(|c| c.id == clip)
    }

    /// True when no clip (other than those in `except`) overlaps `start..end`.
    pub fn is_free(&self, start: Flicks, end: Flicks, except: &[ClipId]) -> bool {
        self.clips
            .iter()
            .filter(|clip| !except.contains(&clip.id))
            .all(|clip| clip.end() <= start || clip.start >= end)
    }

    /// Adds `clip` in start order. The caller guarantees it overlaps nothing.
    pub(crate) fn insert_sorted(&mut self, clip: Clip) {
        let index = self.clips.partition_point(|c| c.start < clip.start);
        self.clips.insert(index, clip);
    }
}

/// Playback speed as a fraction: source time advances `num / den` times as fast as the timeline.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Speed {
    pub num: u32,
    pub den: u32,
}

impl Speed {
    pub const NORMAL: Speed = Speed { num: 1, den: 1 };

    /// A reduced speed from 0.1× to 100×, or None.
    pub fn new(num: u32, den: u32) -> Option<Speed> {
        if num == 0 || den == 0 {
            return None;
        }
        let (mut a, mut b) = (num, den);
        while b != 0 {
            (a, b) = (b, a % b);
        }
        let speed = Speed {
            num: num / a,
            den: den / a,
        };
        let in_range =
            speed.num as u64 * 10 >= speed.den as u64 && speed.num as u64 <= speed.den as u64 * 100;
        in_range.then_some(speed)
    }

    pub fn as_f64(self) -> f64 {
        self.num as f64 / self.den as f64
    }

    /// Source time covered by `timeline` time, rounded towards zero (so ± spans mirror).
    pub fn source_span(self, timeline: Flicks) -> Flicks {
        Flicks((timeline.0 as i128 * self.num as i128 / self.den as i128) as i64)
    }

    /// Timeline time that plays `source` time, rounded towards zero.
    pub fn timeline_span(self, source: Flicks) -> Flicks {
        Flicks((source.0 as i128 * self.den as i128 / self.num as i128) as i64)
    }
}

impl Default for Speed {
    fn default() -> Self {
        Speed::NORMAL
    }
}

/// Position, scale, rotation and anchor of a clip's picture. Positions are project
/// pixels from the frame centre; the anchor is a fraction of the clip's size.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    /// Degrees, clockwise.
    pub rotation: f64,
    pub anchor_x: f64,
    pub anchor_y: f64,
}

impl Default for Transform {
    fn default() -> Self {
        Transform {
            x: 0.0,
            y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            rotation: 0.0,
            anchor_x: 0.5,
            anchor_y: 0.5,
        }
    }
}

/// Fractions of the clip's picture cut from each side.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

/// What a clip shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipKind {
    /// A piece of its media file.
    #[default]
    Media,
    /// Nothing of its own: its effects apply to everything on the tracks below it.
    Adjustment,
    /// Text and shapes the engine draws ([`Clip::title`]).
    Title,
}

impl ClipKind {
    fn is_media(&self) -> bool {
        *self == ClipKind::Media
    }
}

/// A piece of media, an adjustment layer or a title, placed on a track.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: ClipId,
    #[serde(default, skip_serializing_if = "ClipKind::is_media")]
    pub kind: ClipKind,
    /// The media file; empty for an adjustment layer or a title.
    pub media: String,
    /// Timeline position of the first frame.
    pub start: Flicks,
    /// Timeline duration.
    pub duration: Flicks,
    /// Source time shown at `start`.
    pub source_in: Flicks,
    pub speed: Speed,
    /// Whether the clip shows the media's picture.
    pub video: bool,
    /// Whether the clip plays the media's sound. "Detach audio" moves it to a linked clip.
    pub audio: bool,
    pub link: Option<LinkId>,
    pub transform: Transform,
    pub crop: Crop,
    /// 0 to 1.
    pub opacity: f64,
    /// Gain in decibels; 0 leaves the sound as recorded.
    pub volume_db: f64,
    /// Sound fades at the start and end. Without them a clip's edges still get
    /// a 5 ms ramp, so they never click.
    #[serde(default, skip_serializing_if = "is_no_time")]
    pub fade_in: Flicks,
    #[serde(default, skip_serializing_if = "is_no_time")]
    pub fade_out: Flicks,
    /// Noise reduction, 0 (off) to 1 (only the cleaned sound).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub denoise: f64,
    /// Video effects, applied in order to the picture.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    /// Sound effects, applied in order to the sound after noise reduction.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub audio_effects: Vec<Effect>,
    /// Animated properties by name ([`crate::Property`]).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub keyframes: Keyframes,
    /// What a title clip draws; None for other clips.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<Title>,
}

impl Clip {
    pub fn is_adjustment(&self) -> bool {
        self.kind == ClipKind::Adjustment
    }

    pub fn is_title(&self) -> bool {
        self.kind == ClipKind::Title
    }

    /// Adjustment layers and titles: clips without media, timing or sound.
    pub fn is_generated(&self) -> bool {
        self.kind != ClipKind::Media
    }

    pub fn end(&self) -> Flicks {
        self.start + self.duration
    }

    /// Whether a transition may join `before` and `after` (either may be a free
    /// edge): two pictures, or at a cut two sounds, which then crossfade.
    pub fn can_transition(before: Option<&Clip>, after: Option<&Clip>) -> Result<(), String> {
        for clip in before.iter().chain(&after) {
            if clip.is_adjustment() {
                return Err("Adjustment layers fade with their opacity, not transitions".into());
            }
        }
        match (before, after) {
            (Some(a), Some(b)) if a.video != b.video => {
                Err("A transition joins two pictures or two sounds".into())
            }
            (Some(clip), None) | (None, Some(clip)) if !clip.video => Err(format!(
                "Clip {} has no picture to transition; fade its sound instead",
                clip.id
            )),
            _ => Ok(()),
        }
    }

    /// Whether the clip has sound settings beyond its volume.
    pub fn has_sound_settings(&self) -> bool {
        self.fade_in != Flicks::ZERO
            || self.fade_out != Flicks::ZERO
            || self.denoise != 0.0
            || !self.audio_effects.is_empty()
    }

    /// Source time just after the last frame.
    pub fn source_out(&self) -> Flicks {
        self.source_in + self.speed.source_span(self.duration)
    }

    /// True when `time` falls inside the clip.
    pub fn contains(&self, time: Flicks) -> bool {
        self.start <= time && time < self.end()
    }

    /// True when `time` is strictly between the clip's edges, where a split can happen.
    pub fn spans(&self, time: Flicks) -> bool {
        self.start < time && time < self.end()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkerColor {
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: MarkerId,
    pub time: Flicks,
    pub name: String,
    pub color: MarkerColor,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_projects_use_the_default_settings() {
        let project = Project::new("p", "Untitled");
        assert_eq!(project.settings.width, 1920);
        assert_eq!(project.settings.height, 1080);
        assert_eq!(project.settings.frame_rate, FrameRate::FPS_30);
        assert_eq!(project.settings.sample_rate, 48_000);
        assert_eq!(project.settings.channels, 2);
        assert_eq!(project.settings.aspect_label(), "16:9");
        assert_eq!(project.settings.preset().map(|p| p.id), Some("landscape"));
        assert_eq!(project.tracks.len(), 2);
        assert_eq!(project.main_track, project.tracks[0].id);
        assert!(project.magnetic);
        assert_eq!(project.magnetic_index(), Some(0));
        assert_eq!(project.next_id, 3);
        assert!(project.settings.validate().is_ok());
    }

    #[test]
    fn presets_have_their_aspect_ratios() {
        let aspects: Vec<String> = PRESETS
            .iter()
            .map(|preset| {
                ProjectSettings {
                    width: preset.width,
                    height: preset.height,
                    ..ProjectSettings::default()
                }
                .aspect_label()
            })
            .collect();
        assert_eq!(aspects, ["16:9", "9:16", "1:1", "16:9"]);
    }

    #[test]
    fn settings_validation() {
        let ok = ProjectSettings::default();
        let odd = ProjectSettings { width: 1921, ..ok };
        let tiny = ProjectSettings { height: 8, ..ok };
        let odd_rate = ProjectSettings {
            frame_rate: FrameRate::new(15, 1).unwrap(),
            ..ok
        };
        let rate = ProjectSettings {
            sample_rate: 22_050,
            ..ok
        };
        let channels = ProjectSettings { channels: 6, ..ok };
        for bad in [odd, tiny, odd_rate, rate, channels] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
        let ntsc = ProjectSettings {
            frame_rate: FrameRate::FPS_29_97,
            sample_rate: 44_100,
            channels: 1,
            ..ok
        };
        assert!(ntsc.validate().is_ok());
    }

    #[test]
    fn speeds_reduce_and_stay_in_range() {
        assert_eq!(Speed::new(4, 2), Some(Speed { num: 2, den: 1 }));
        assert_eq!(Speed::new(1, 10), Some(Speed { num: 1, den: 10 }));
        assert_eq!(Speed::new(100, 1), Some(Speed { num: 100, den: 1 }));
        assert_eq!(Speed::new(1, 11), None);
        assert_eq!(Speed::new(101, 1), None);
        assert_eq!(Speed::new(0, 1), None);
        let half = Speed::new(1, 2).unwrap();
        assert_eq!(half.source_span(Flicks(10)), Flicks(5));
        assert_eq!(half.source_span(Flicks(-3)), Flicks(-1));
        assert_eq!(half.source_span(Flicks(3)), Flicks(1));
        assert_eq!(half.timeline_span(Flicks(5)), Flicks(10));
    }

    #[test]
    fn media_validation() {
        let media = MediaRef {
            id: "2c1d0f7e-aaaa".into(),
            name: "clip.mp4".into(),
            kind: MediaKind::Video,
            duration: Flicks::ONE_SECOND,
            has_video: true,
            has_audio: true,
            width: 1920,
            height: 1080,
            frame_rate: Some(FrameRate::FPS_30),
            size: 10,
            modified: None,
            location: MediaLocation::Browser,
        };
        assert!(media.validate().is_ok());
        for bad in [
            MediaRef {
                id: "../x".into(),
                ..media.clone()
            },
            MediaRef {
                name: " ".into(),
                ..media.clone()
            },
            MediaRef {
                has_video: false,
                ..media.clone()
            },
            MediaRef {
                kind: MediaKind::Image,
                ..media.clone()
            },
            MediaRef {
                duration: Flicks(-1),
                ..media.clone()
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
    }
}

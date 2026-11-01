//! A timeline as exchange formats see it: picture and sound tracks of items
//! with source ranges, dissolves and markers, and what each side of the exchange
//! leaves out. OTIO and FCP7 XML read and write this; [`from_project`] and
//! [`to_project`] turn it from and into a project.
use std::collections::{BTreeMap, BTreeSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::rc::Rc;
use std::sync::Arc;

use cgv_model::{
    Alignment, Clip, ClipId, ClipKind, ClipProperties, ClipSpec, Command, MarkerColor, MediaKind,
    MediaLocation, MediaRef, Node, Params, Project, ProjectSettings, SequenceId, Speed, Track,
    TrackId, TransitionSpec, BUILTIN_PACK,
};
use cgv_time::{Flicks, FrameRate, FLICKS_PER_SECOND};

/// A media file, as far as a format knows it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MediaFile {
    pub name: String,
    /// A local path, when the format holds one.
    pub path: Option<String>,
    /// How long the file is, when the format says.
    pub duration: Option<Flicks>,
}

/// What an item shows.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    Media(MediaFile),
    /// Another timeline, shared by every item that shows it.
    Nest(Rc<Cut>),
}

/// A clip on a track.
#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub start: Flicks,
    pub duration: Flicks,
    pub source: Source,
    /// The source time shown first: for a reversed item, the last of its range.
    pub source_in: Flicks,
    /// Source time per timeline time; negative plays backwards.
    pub speed: f64,
    pub freeze: bool,
    pub opacity: f64,
    pub volume_db: f64,
}

impl Item {
    pub fn end(&self) -> Flicks {
        self.start + self.duration
    }
}

/// A dissolve at a cut: its length before and after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dissolve {
    pub cut: Flicks,
    pub before: Flicks,
    pub after: Flicks,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CutTrack {
    pub name: String,
    /// By start, never overlapping.
    pub items: Vec<Item>,
    /// By cut.
    pub dissolves: Vec<Dissolve>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CutMarker {
    pub time: Flicks,
    pub name: String,
    pub color: MarkerColor,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Cut {
    pub name: String,
    pub rate: FrameRate,
    pub size: (u32, u32),
    pub sample_rate: u32,
    /// Bottom track first.
    pub picture: Vec<CutTrack>,
    pub sound: Vec<CutTrack>,
    pub markers: Vec<CutMarker>,
    /// What the file could not say, or the project could not show.
    pub left_out: Vec<String>,
}

impl Cut {
    pub fn duration(&self) -> Flicks {
        self.picture
            .iter()
            .chain(&self.sound)
            .flat_map(|track| track.items.iter().map(Item::end))
            .max()
            .unwrap_or(Flicks::ZERO)
    }
}

/// `time` in frames at `rate`, as a number that may hold a fraction.
pub fn to_frames(time: Flicks, rate: f64) -> f64 {
    time.0 as f64 * rate / FLICKS_PER_SECOND as f64
}

/// `frames` at `rate` as flicks.
pub fn from_frames(frames: f64, rate: f64) -> Flicks {
    Flicks((frames * FLICKS_PER_SECOND as f64 / rate).round() as i64)
}

/// The timecode-free clock label users read in the lists of what was left out.
fn clock(time: Flicks) -> String {
    let seconds = time.0 as f64 / FLICKS_PER_SECOND as f64;
    format!(
        "{}:{:02}:{:04.1}",
        (seconds / 3600.0) as u64,
        (seconds / 60.0) as u64 % 60,
        seconds % 60.0
    )
}

struct Exporting<'a> {
    project: &'a Project,
    /// Each sequence's cut, shared by the items that show it.
    nests: BTreeMap<SequenceId, Rc<Cut>>,
}

/// The cut timeline `node` of `project` holds. Multicam clips go as the angles
/// they show. What the formats cannot carry is listed in `left_out`.
pub fn from_project(project: &Project, node: Node) -> Result<Cut, String> {
    let mut exporting = Exporting {
        project,
        nests: BTreeMap::new(),
    };
    exporting.cut(node)
}

impl Exporting<'_> {
    fn cut(&mut self, node: Node) -> Result<Cut, String> {
        let timeline = self
            .project
            .timeline(node)
            .ok_or("That timeline is not in the project")?;
        let settings = &self.project.settings;
        let name = match node {
            Node::Main => self.project.name.clone(),
            Node::Sequence(id) => self
                .project
                .sequence(id)
                .map_or_else(|| "Sequence".into(), |sequence| sequence.name.clone()),
        };
        let mut cut = Cut {
            name,
            rate: settings.frame_rate,
            size: (settings.width, settings.height),
            sample_rate: settings.sample_rate,
            picture: Vec::new(),
            sound: Vec::new(),
            markers: timeline
                .markers
                .iter()
                .map(|marker| CutMarker {
                    time: marker.time,
                    name: marker.name.clone(),
                    color: marker.color,
                })
                .collect(),
            left_out: Vec::new(),
        };
        for (index, track) in timeline.tracks.iter().enumerate() {
            let name = if track.name.is_empty() {
                format!("Track {}", index + 1)
            } else {
                track.name.clone()
            };
            let mut picture = CutTrack {
                name: name.clone(),
                ..CutTrack::default()
            };
            let mut sound = CutTrack {
                name,
                ..CutTrack::default()
            };
            for clip in &track.clips {
                self.clip(clip, &mut picture, &mut sound, &mut cut.left_out)?;
            }
            self.dissolves(track, &mut picture, &mut sound, &mut cut.left_out);
            if !picture.items.is_empty() {
                cut.picture.push(picture);
            }
            if !sound.items.is_empty() {
                cut.sound.push(sound);
            }
        }
        Ok(cut)
    }

    fn media_file(&self, clip: &Clip) -> Result<MediaFile, String> {
        let media = self
            .project
            .media(&clip.media)
            .ok_or_else(|| format!("Clip {} has no media", clip.id))?;
        Ok(MediaFile {
            name: media.name.clone(),
            path: match &media.location {
                MediaLocation::Path { path } => Some(path.clone()),
                _ => None,
            },
            duration: (!media.is_still()).then_some(media.duration),
        })
    }

    fn clip(
        &mut self,
        clip: &Clip,
        picture: &mut CutTrack,
        sound: &mut CutTrack,
        left_out: &mut Vec<String>,
    ) -> Result<(), String> {
        let at = clock(clip.start);
        match clip.kind {
            ClipKind::Title => {
                left_out.push(format!("The title at {at}"));
                return Ok(());
            }
            ClipKind::Adjustment => {
                left_out.push(format!("The adjustment layer at {at}"));
                return Ok(());
            }
            ClipKind::Media | ClipKind::Sequence => {}
        }
        let what = if clip.is_sequence() {
            "sequence clip"
        } else {
            "clip"
        };
        if !clip.effects.is_empty() || !clip.audio_effects.is_empty() {
            left_out.push(format!("The effects of the {what} at {at}"));
        }
        if !clip.masks.is_empty() {
            left_out.push(format!("The masks of the {what} at {at}"));
        }
        if !clip.keyframes.is_empty() {
            left_out.push(format!("The keyframes of the {what} at {at}"));
        }
        if !clip.ramp.is_empty() {
            left_out.push(format!("The speed ramp of the {what} at {at}"));
        }
        if !clip.blend_mode.is_normal() {
            left_out.push(format!("The blend mode of the {what} at {at}"));
        }
        if clip.transform != Default::default() || clip.crop != Default::default() {
            left_out.push(format!("The transform and crop of the {what} at {at}"));
        }
        if clip.angles.is_some() {
            return self.angles(clip, picture, sound, left_out);
        }
        let source = match clip.sequence {
            Some(sequence) => Source::Nest(self.nest(sequence)?),
            None => Source::Media(self.media_file(clip)?),
        };
        let speed = clip.speed.as_f64();
        let item = Item {
            start: clip.start,
            duration: clip.duration,
            source,
            source_in: if clip.reverse {
                clip.source_out()
            } else {
                clip.source_in
            },
            speed: if clip.reverse { -speed } else { speed },
            freeze: clip.freeze,
            opacity: clip.opacity,
            volume_db: clip.volume_db,
        };
        if clip.video {
            picture.items.push(item.clone());
        }
        if clip.audio && !clip.freeze {
            sound.items.push(item);
        }
        Ok(())
    }

    fn nest(&mut self, sequence: SequenceId) -> Result<Rc<Cut>, String> {
        if let Some(cut) = self.nests.get(&sequence) {
            return Ok(cut.clone());
        }
        let cut = Rc::new(self.cut(Node::Sequence(sequence))?);
        self.nests.insert(sequence, cut.clone());
        Ok(cut)
    }

    /// A multicam clip, as its picture angle's clips and its sound angle's.
    fn angles(
        &mut self,
        clip: &Clip,
        picture: &mut CutTrack,
        sound: &mut CutTrack,
        left_out: &mut Vec<String>,
    ) -> Result<(), String> {
        let angles = clip.angles.expect("a multicam clip");
        let tracks: Vec<Arc<Track>> = clip
            .sequence
            .and_then(|id| self.project.sequence_tracks(id))
            .ok_or("A multicam clip's sequence is missing")?
            .to_vec();
        let (from, to) = (clip.source_in, clip.source_out());
        let shift = clip.start - from;
        let mut add =
            |track: &Track, into: &mut CutTrack, want_video: bool| -> Result<(), String> {
                for inner in &track.clips {
                    let (start, end) = (inner.start.max(from), inner.end().min(to));
                    if start >= end {
                        continue;
                    }
                    if (want_video && !inner.video) || (!want_video && !inner.audio) {
                        continue;
                    }
                    if inner.kind != ClipKind::Media {
                        left_out.push(format!(
                            "What the angle shows at {} of the multicam clip",
                            clock(start)
                        ));
                        continue;
                    }
                    let span = inner.speed.source_span(start - inner.start);
                    into.items.push(Item {
                        start: start + shift,
                        duration: end - start,
                        source: Source::Media(self.media_file(inner)?),
                        source_in: inner.source_in + span,
                        speed: inner.speed.as_f64(),
                        freeze: inner.freeze,
                        opacity: inner.opacity * clip.opacity,
                        volume_db: inner.volume_db + clip.volume_db,
                    });
                }
                Ok(())
            };
        if clip.video {
            add(&tracks[angles.picture as usize], picture, true)?;
        }
        if clip.audio {
            add(&tracks[angles.sound as usize], sound, false)?;
        }
        Ok(())
    }

    fn dissolves(
        &self,
        track: &Track,
        picture: &mut CutTrack,
        sound: &mut CutTrack,
        left_out: &mut Vec<String>,
    ) {
        let frame = self.project.settings.frame_duration();
        for transition in &track.transitions {
            let Some(cut) = track.cut(transition) else {
                continue;
            };
            let at = clock(cut);
            if transition.from.is_none() || transition.to.is_none() {
                left_out.push(format!("The transition at the free edge at {at}"));
                continue;
            }
            if transition.kind != "cross-dissolve" {
                left_out.push(format!("The transition at {at} goes as a dissolve"));
            }
            let (start, end) = transition.window(cut, frame);
            let dissolve = Dissolve {
                cut,
                before: cut - start,
                after: end - cut,
            };
            let clip = |id: Option<ClipId>| id.and_then(|id| track.clip(id));
            let (from, to) = (clip(transition.from), clip(transition.to));
            let both = |test: fn(&Clip) -> bool| from.is_some_and(test) && to.is_some_and(test);
            if both(|clip| clip.video) {
                picture.dissolves.push(dissolve);
            }
            if both(|clip| clip.audio) {
                sound.dissolves.push(dissolve);
            }
        }
    }
}

/// A project made from a cut, and what it could not show.
#[derive(Debug)]
pub struct Imported {
    pub project: Project,
    pub left_out: Vec<String>,
}

/// The standard rate nearest `rate`: projects run only at those.
fn standard_rate(rate: FrameRate) -> FrameRate {
    FrameRate::STANDARD
        .iter()
        .copied()
        .min_by(|a, b| {
            let distance = |other: &FrameRate| (other.as_f64() - rate.as_f64()).abs();
            distance(a).total_cmp(&distance(b))
        })
        .unwrap_or(FrameRate::FPS_30)
}

/// An id for a file, the same each time its path and name come up.
fn media_id(file: &MediaFile) -> String {
    let mut hasher = DefaultHasher::new();
    (&file.path, &file.name).hash(&mut hasher);
    format!("imported-{:016x}", hasher.finish())
}

const STILLS: [&str; 8] = ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp", "gif"];

/// What the media of a cut needs: its use and the reach of its source ranges.
#[derive(Default)]
struct MediaUse {
    file: MediaFile,
    picture: bool,
    sound: bool,
    reach: Flicks,
}

fn gather(cut: &Cut, seen: &mut BTreeSet<*const Cut>, uses: &mut BTreeMap<String, MediaUse>) {
    let mut track = |track: &CutTrack, picture: bool, uses: &mut BTreeMap<String, MediaUse>| {
        for item in &track.items {
            match &item.source {
                Source::Media(file) => {
                    let entry = uses.entry(media_id(file)).or_default();
                    entry.file = file.clone();
                    entry.picture |= picture;
                    entry.sound |= !picture;
                    let span = Flicks((item.duration.0 as f64 * item.speed.abs()).ceil() as i64);
                    let reach = if item.speed < 0.0 || item.freeze {
                        item.source_in + Flicks(1)
                    } else {
                        item.source_in + span
                    };
                    entry.reach = entry.reach.max(reach);
                }
                Source::Nest(inner) => {
                    if seen.insert(Rc::as_ptr(inner)) {
                        gather(inner, seen, uses);
                    }
                }
            }
        }
    };
    for each in &cut.picture {
        track(each, true, uses);
    }
    for each in &cut.sound {
        track(each, false, uses);
    }
}

/// A reduced speed the model takes for `speed`, and whether it had to change.
fn model_speed(speed: f64) -> (Speed, bool) {
    let magnitude = speed.abs();
    let thousandths = (magnitude * 1000.0).round().clamp(100.0, 100_000.0) as u32;
    let fraction = Speed::new(thousandths, 1000).unwrap_or(Speed::NORMAL);
    let changed = (fraction.as_f64() - magnitude).abs() > 0.0005;
    (fraction, changed)
}

struct Importing {
    project: Project,
    left_out: Vec<String>,
    /// The sequence made of each nested cut.
    nests: Vec<(Rc<Cut>, SequenceId)>,
    frame: Flicks,
}

/// A project of `cut`, its media in the bin with no file yet (the project asks to
/// relink them): new id `id`, named after the cut unless `name` says otherwise.
pub fn to_project(cut: &Cut, id: &str, name: Option<&str>) -> Result<Imported, String> {
    let project = Project::new(id, name.unwrap_or(&cut.name));
    let rate = standard_rate(cut.rate);
    let frame = rate.frame_duration();
    let mut importing = Importing {
        project,
        left_out: cut.left_out.clone(),
        nests: Vec::new(),
        frame,
    };
    if rate != cut.rate {
        importing.left_out.push(format!(
            "The timeline runs at {} fps, which projects don't: it plays at {} fps",
            cut.rate.label(),
            rate.label()
        ));
    }
    let settings = ProjectSettings {
        width: (cut.size.0.max(16) & !1).min(8192),
        height: (cut.size.1.max(16) & !1).min(8192),
        frame_rate: rate,
        sample_rate: if cut.sample_rate == 44_100 {
            44_100
        } else {
            48_000
        },
        channels: 2,
    };
    importing.run(&Command::SetSettings { settings })?;
    importing.run(&Command::SetMagnetic { magnetic: false })?;
    let mut uses = BTreeMap::new();
    gather(cut, &mut BTreeSet::new(), &mut uses);
    for (id, used) in uses {
        importing.add_media(id, &used, settings)?;
    }
    importing.fill(cut, None)?;
    for marker in &cut.markers {
        importing.run(&Command::AddMarker {
            at: marker.time,
            name: marker.name.clone(),
            color: marker.color,
        })?;
    }
    let Importing {
        project, left_out, ..
    } = importing;
    Ok(Imported { project, left_out })
}

/// An item to place: a picture with the sound that joined it, or sound alone.
struct Placed<'a> {
    item: &'a Item,
    video: bool,
    audio: bool,
    volume_db: f64,
}

/// Tracks of a cut once sound that goes with a picture has joined it: bottom
/// first, the sound-only ones under the picture.
struct Layout<'a> {
    tracks: Vec<(&'a CutTrack, Vec<Placed<'a>>)>,
}

fn same_clip(a: &Item, b: &Item) -> bool {
    a.start == b.start
        && a.duration == b.duration
        && a.source_in == b.source_in
        && a.speed == b.speed
        && a.source == b.source
}

fn layout(cut: &Cut) -> Layout<'_> {
    // The sound's volume of each picture item it joined.
    let mut with_sound: BTreeMap<(usize, usize), f64> = BTreeMap::new();
    let mut sound_tracks = Vec::new();
    let mut seen: Vec<&Item> = Vec::new();
    for track in &cut.sound {
        let mut own = Vec::new();
        for item in &track.items {
            let joined = cut.picture.iter().enumerate().find_map(|(t, picture)| {
                picture
                    .items
                    .iter()
                    .position(|other| same_clip(item, other))
                    .map(|i| (t, i))
            });
            if let Some(place) = joined {
                with_sound.entry(place).or_insert(item.volume_db);
            } else if !seen.iter().any(|other| same_clip(item, other)) {
                // Stereo split over two tracks plays as one clip.
                seen.push(item);
                own.push(Placed {
                    item,
                    video: false,
                    audio: true,
                    volume_db: item.volume_db,
                });
            }
        }
        if !own.is_empty() {
            sound_tracks.push((track, own));
        }
    }
    let mut tracks = sound_tracks;
    for (t, track) in cut.picture.iter().enumerate() {
        let items = track
            .items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                let sound = with_sound.get(&(t, i));
                Placed {
                    item,
                    video: true,
                    audio: sound.is_some(),
                    volume_db: sound.copied().unwrap_or(item.volume_db),
                }
            })
            .collect();
        tracks.push((track, items));
    }
    Layout { tracks }
}

impl Importing {
    fn run(&mut self, command: &Command) -> Result<Vec<u64>, String> {
        let (next, outcome) = self.project.apply(command)?;
        self.project = next;
        Ok(outcome.created)
    }

    /// Runs `command` in sequence `sequence`, or the main timeline.
    fn run_in(
        &mut self,
        sequence: Option<SequenceId>,
        command: Command,
    ) -> Result<Vec<u64>, String> {
        match sequence {
            Some(sequence) => self.run(&Command::InSequence {
                sequence,
                command: Box::new(command),
            }),
            None => self.run(&command),
        }
    }

    fn add_media(
        &mut self,
        id: String,
        used: &MediaUse,
        settings: ProjectSettings,
    ) -> Result<(), String> {
        let file = &used.file;
        let extension = file
            .name
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let still = used.picture && !used.sound && STILLS.contains(&extension.as_str());
        let kind = if still {
            MediaKind::Image
        } else if used.picture {
            MediaKind::Video
        } else {
            MediaKind::Audio
        };
        let duration = if still {
            Flicks::ZERO
        } else {
            file.duration.unwrap_or(Flicks::ZERO).max(used.reach)
        };
        let name = if file.name.trim().is_empty() {
            "Unnamed media".to_string()
        } else {
            file.name.clone()
        };
        self.run(&Command::AddMedia {
            media: MediaRef {
                id,
                name,
                kind,
                duration,
                has_video: used.picture,
                has_audio: used.sound,
                width: if used.picture { settings.width } else { 0 },
                height: if used.picture { settings.height } else { 0 },
                frame_rate: used.picture.then_some(settings.frame_rate),
                size: 0,
                modified: None,
                location: match &file.path {
                    Some(path) => MediaLocation::Path { path: path.clone() },
                    None => MediaLocation::Browser,
                },
            },
        })?;
        Ok(())
    }

    /// The sequence of nested cut `cut`, made the first time it comes up.
    fn sequence_of(&mut self, cut: &Rc<Cut>) -> Result<SequenceId, String> {
        // OTIO repeats a nested timeline where it is shown again: the same one.
        if let Some((_, id)) = self.nests.iter().find(|(other, _)| other == cut) {
            return Ok(*id);
        }
        let name = if cut.name.trim().is_empty() {
            "Sequence".to_string()
        } else {
            cut.name.clone()
        };
        let created = self.run(&Command::AddSequence { name })?;
        let id = SequenceId(created[0]);
        self.nests.push((cut.clone(), id));
        self.run(&Command::InSequence {
            sequence: id,
            command: Box::new(Command::SetMagnetic { magnetic: false }),
        })?;
        self.fill(cut, Some(id))?;
        for marker in &cut.markers {
            self.run_in(
                Some(id),
                Command::AddMarker {
                    at: marker.time,
                    name: marker.name.clone(),
                    color: marker.color,
                },
            )?;
        }
        Ok(id)
    }

    /// Puts cut `cut`'s tracks and items on the main timeline or a sequence.
    fn fill(&mut self, cut: &Cut, sequence: Option<SequenceId>) -> Result<(), String> {
        let layout = layout(cut);
        let tracks = self.make_tracks(layout.tracks.len(), sequence)?;
        for ((source, items), track) in layout.tracks.iter().zip(tracks) {
            if !source.name.trim().is_empty() {
                self.run_in(
                    sequence,
                    Command::RenameTrack {
                        track,
                        name: source.name.chars().take(100).collect(),
                    },
                )?;
            }
            let mut placed: BTreeMap<i64, ClipId> = BTreeMap::new();
            let mut ends: BTreeMap<i64, ClipId> = BTreeMap::new();
            for item in items {
                if let Some(clip) = self.place(item, track, sequence)? {
                    placed.insert(item.item.start.0, clip);
                    ends.insert(item.item.end().0, clip);
                }
            }
            for dissolve in &source.dissolves {
                let from = ends.get(&dissolve.cut.0).copied();
                let to = placed.get(&dissolve.cut.0).copied();
                self.dissolve(dissolve, from, to, track, sequence);
            }
        }
        Ok(())
    }

    /// Makes `count` empty tracks, bottom first, and returns them.
    fn make_tracks(
        &mut self,
        count: usize,
        sequence: Option<SequenceId>,
    ) -> Result<Vec<TrackId>, String> {
        let existing = |project: &Project| -> Vec<TrackId> {
            let node = sequence.map_or(Node::Main, Node::Sequence);
            project
                .timeline(node)
                .map(|timeline| timeline.tracks.iter().map(|track| track.id).collect())
                .unwrap_or_default()
        };
        let mut tracks = existing(&self.project);
        for index in tracks.len()..count.max(1) {
            self.run_in(sequence, Command::AddTrack { index, name: None })?;
        }
        tracks = existing(&self.project);
        // A new project's second track goes when one is enough.
        while tracks.len() > count.max(1) {
            let last = *tracks.last().expect("tracks");
            self.run_in(sequence, Command::RemoveTrack { track: last })?;
            tracks.pop();
        }
        Ok(tracks)
    }

    fn place(
        &mut self,
        placed: &Placed,
        track: TrackId,
        sequence: Option<SequenceId>,
    ) -> Result<Option<ClipId>, String> {
        let Placed {
            item,
            video,
            audio,
            volume_db,
        } = *placed;
        let at = to_frames(item.start, 1.0 / self.frame.as_seconds()).round();
        let start = Flicks(at as i64 * self.frame.0);
        let duration = Flicks(
            ((item.duration.0 as f64 / self.frame.0 as f64).round() as i64).max(1) * self.frame.0,
        );
        let (speed, changed) = model_speed(item.speed);
        let mut spec = ClipSpec {
            duration,
            video: Some(video),
            audio: Some(audio && !item.freeze),
            properties: Some(ClipProperties {
                opacity: Some(item.opacity.clamp(0.0, 1.0)),
                volume_db: Some(volume_db.clamp(-96.0, 24.0)),
                ..ClipProperties::default()
            }),
            ..ClipSpec::default()
        };
        match &item.source {
            Source::Media(file) => {
                let id = media_id(file);
                let still = self.project.media(&id).is_some_and(MediaRef::is_still);
                spec.media = id;
                if still {
                    spec.audio = Some(false);
                } else {
                    if changed {
                        self.left_out.push(format!(
                            "{}'s speed of {:.1}% plays at {:.1}%",
                            file.name,
                            item.speed.abs() * 100.0,
                            speed.as_f64() * 100.0
                        ));
                    }
                    spec.freeze = item.freeze;
                    if item.freeze {
                        spec.source_in = item.source_in;
                    } else if item.speed < 0.0 {
                        spec.speed = Some(speed);
                        spec.reverse = true;
                        spec.source_in = item.source_in - speed.source_span(duration);
                    } else {
                        spec.speed = Some(speed);
                        spec.source_in = item.source_in;
                    }
                    spec.source_in = spec.source_in.max(Flicks::ZERO);
                }
            }
            Source::Nest(inner) => {
                spec.kind = ClipKind::Sequence;
                spec.sequence = Some(self.sequence_of(inner)?);
                spec.source_in = item.source_in.max(Flicks::ZERO);
                if (item.speed - 1.0).abs() > 0.0005 || item.freeze {
                    self.left_out.push(format!(
                        "The speed of the nested sequence {} (sequence clips play at normal speed)",
                        inner.name
                    ));
                }
            }
        }
        let command = Command::Overwrite {
            track,
            at: start,
            clip: spec,
        };
        match self.run_in(sequence, command) {
            Ok(created) => Ok(Some(ClipId(created[0]))),
            Err(error) => {
                self.left_out
                    .push(format!("The clip at {}: {error}", clock(item.start)));
                Ok(None)
            }
        }
    }

    fn dissolve(
        &mut self,
        dissolve: &Dissolve,
        from: Option<ClipId>,
        to: Option<ClipId>,
        track: TrackId,
        sequence: Option<SequenceId>,
    ) {
        let at = clock(dissolve.cut);
        // Sound that joined its pictures takes its dissolve from theirs.
        if from.is_none() && to.is_none() {
            return;
        }
        if from.is_none() || to.is_none() {
            self.left_out
                .push(format!("The dissolve at {at} has no clips on both sides"));
            return;
        }
        let alignment = if dissolve.before == Flicks::ZERO {
            Alignment::Start
        } else if dissolve.after == Flicks::ZERO {
            Alignment::End
        } else {
            Alignment::Center
        };
        let command = Command::AddTransition {
            track,
            from,
            to,
            transition: TransitionSpec {
                kind: "cross-dissolve".into(),
                pack: BUILTIN_PACK.into(),
                version: 1,
                duration: dissolve.before + dissolve.after,
                alignment: Some(alignment),
                params: Params::new(),
            },
        };
        if let Err(error) = self.run_in(sequence, command) {
            self.left_out.push(format!("The dissolve at {at}: {error}"));
        }
    }
}

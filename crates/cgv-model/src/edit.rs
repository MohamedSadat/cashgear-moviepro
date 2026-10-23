//! How each [`Command`] changes a project.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use cgv_time::Flicks;

use crate::command::{ClipProperties, ClipSpec, Command, Edge, Outcome};
use crate::project::{
    Clip, ClipId, Crop, LinkId, Marker, MarkerId, Project, Speed, Track, TrackId, Transform,
    MAX_TIME,
};
use crate::validate::{check_name, validate};

/// Source ranges may end this many flicks past the media's end, to absorb the
/// rounding of fractional speeds. About 1.4 µs.
pub const SOURCE_SLACK: Flicks = Flicks(1000);
const MAX_NAME: usize = 200;

impl Project {
    /// Applies `command` to a copy of the project. Either the whole command applies
    /// and the new project comes back, or nothing changes and the error says why.
    pub fn apply(&self, command: &Command) -> Result<(Project, Outcome), String> {
        let mut edit = Edit {
            frame: self.settings.frame_duration(),
            project: self.clone(),
            created: Vec::new(),
        };
        edit.run(command)?;
        edit.normalize_links();
        validate(&edit.project).map_err(|error| format!("Internal edit error: {error}"))?;
        Ok((
            edit.project,
            Outcome {
                created: edit.created,
            },
        ))
    }
}

struct Edit {
    project: Project,
    frame: Flicks,
    created: Vec<u64>,
}

fn div_round(numerator: i128, denominator: i128) -> i128 {
    let half = denominator / 2;
    if numerator >= 0 {
        (numerator + half) / denominator
    } else {
        -((-numerator + half) / denominator)
    }
}

impl Edit {
    fn run(&mut self, command: &Command) -> Result<(), String> {
        match command {
            Command::Rename { name } => {
                self.project.name = check_name(name, "The project", MAX_NAME)?;
            }
            Command::SetSettings { settings } => {
                settings.validate()?;
                self.project.settings = *settings;
            }
            Command::AddMedia { media } => {
                media.validate()?;
                if self.project.media(&media.id).is_some() {
                    return Err(format!("{} is already in the project", media.name));
                }
                self.project.media.push(media.clone());
            }
            Command::RemoveMedia { media } => self.remove_media(media)?,
            Command::AddTrack { index, name } => {
                if *index > self.project.tracks.len() {
                    return Err(format!("There is no track position {}", index + 1));
                }
                let mut track = Track::new(TrackId(self.alloc()));
                if let Some(name) = name {
                    track.name = check_track_name(name)?;
                }
                self.created.push(track.id.0);
                self.project.tracks.insert(*index, Arc::new(track));
            }
            Command::RemoveTrack { track } => {
                let index = self.track_index(*track)?;
                if self.project.tracks.len() == 1 {
                    return Err("A project keeps at least one track".into());
                }
                self.unlocked(index)?;
                self.project.tracks.remove(index);
            }
            Command::MoveTrack { track, index } => {
                let from = self.track_index(*track)?;
                if *index >= self.project.tracks.len() {
                    return Err(format!("There is no track position {}", index + 1));
                }
                let moved = self.project.tracks.remove(from);
                self.project.tracks.insert(*index, moved);
            }
            Command::RenameTrack { track, name } => {
                let index = self.track_index(*track)?;
                self.track_mut(index).name = check_track_name(name)?;
            }
            Command::SetTrackLocked { track, locked } => {
                let index = self.track_index(*track)?;
                self.track_mut(index).locked = *locked;
            }
            Command::SetTrackMuted { track, muted } => {
                let index = self.track_index(*track)?;
                self.track_mut(index).muted = *muted;
            }
            Command::SetTrackHidden { track, hidden } => {
                let index = self.track_index(*track)?;
                self.track_mut(index).hidden = *hidden;
            }
            Command::Insert { track, at, clip } => self.place(*track, Some(*at), clip, true)?,
            Command::Overwrite { track, at, clip } => self.place(*track, Some(*at), clip, false)?,
            Command::Append { track, clip } => self.place(*track, None, clip, false)?,
            Command::Delete { clips } => self.delete(clips, false)?,
            Command::RippleDelete { clips } => self.delete(clips, true)?,
            Command::Split { at, clips } => self.split(*at, clips)?,
            Command::Trim {
                clip,
                edge,
                delta,
                ripple,
            } => self.trim(*clip, *edge, *delta, *ripple)?,
            Command::Roll { clip, edge, delta } => self.roll(*clip, *edge, *delta)?,
            Command::Move {
                clips,
                delta,
                tracks,
                overwrite,
            } => self.move_clips(clips, *delta, *tracks, *overwrite)?,
            Command::Slip { clip, delta } => self.slip(*clip, *delta)?,
            Command::Slide { clip, delta } => self.slide(*clip, *delta)?,
            Command::Link { clips } => self.link(clips)?,
            Command::Unlink { clips } => {
                for &id in clips {
                    let (index, _) = self.find(id)?;
                    self.unlocked(index)?;
                    self.clip_mut(index, id).link = None;
                }
            }
            Command::DetachAudio { clip, track } => self.detach_audio(*clip, *track)?,
            Command::SetSpeed { clip, speed } => self.set_speed(*clip, *speed)?,
            Command::SetClipProperties { clip, properties } => {
                self.set_properties(*clip, properties)?
            }
            Command::AddMarker { at, name, color } => {
                let marker = Marker {
                    id: MarkerId(self.alloc()),
                    time: self.position(*at)?,
                    name: check_marker_name(name)?,
                    color: *color,
                };
                self.created.push(marker.id.0);
                self.project.markers.push(marker);
                self.sort_markers();
            }
            Command::UpdateMarker {
                marker,
                at,
                name,
                color,
            } => {
                let time = at.map(|at| self.position(at)).transpose()?;
                let name = name.as_deref().map(check_marker_name).transpose()?;
                let target = self
                    .project
                    .markers
                    .iter_mut()
                    .find(|m| m.id == *marker)
                    .ok_or_else(|| format!("No marker {marker}"))?;
                if let Some(time) = time {
                    target.time = time;
                }
                if let Some(name) = name {
                    target.name = name;
                }
                if let Some(color) = color {
                    target.color = *color;
                }
                self.sort_markers();
            }
            Command::RemoveMarker { marker } => {
                let before = self.project.markers.len();
                self.project.markers.retain(|m| m.id != *marker);
                if self.project.markers.len() == before {
                    return Err(format!("No marker {marker}"));
                }
            }
        }
        Ok(())
    }

    // ---- Lookups and checks ----------------------------------------------------

    fn alloc(&mut self) -> u64 {
        self.project.alloc_id()
    }

    fn track_name(&self, index: usize) -> String {
        let name = &self.project.tracks[index].name;
        if name.is_empty() {
            format!("Track {}", index + 1)
        } else {
            name.clone()
        }
    }

    fn track_index(&self, id: TrackId) -> Result<usize, String> {
        self.project
            .track_index(id)
            .ok_or_else(|| format!("No track {id}"))
    }

    fn unlocked(&self, index: usize) -> Result<(), String> {
        if self.project.tracks[index].locked {
            Err(format!("{} is locked", self.track_name(index)))
        } else {
            Ok(())
        }
    }

    fn track_mut(&mut self, index: usize) -> &mut Track {
        Arc::make_mut(&mut self.project.tracks[index])
    }

    /// The track index and a copy of clip `id`.
    fn find(&self, id: ClipId) -> Result<(usize, Clip), String> {
        self.project
            .clip(id)
            .map(|(index, clip)| (index, clip.clone()))
            .ok_or_else(|| format!("No clip {id}"))
    }

    fn clip_mut(&mut self, index: usize, id: ClipId) -> &mut Clip {
        let track = self.track_mut(index);
        let position = track.position(id).expect("clip on its track");
        &mut track.clips[position]
    }

    fn is_still(&self, media: &str) -> bool {
        self.project.media(media).is_some_and(|m| m.is_still())
    }

    /// `ids` plus every clip linked to one of them, in id order.
    fn with_partners(&self, ids: &[ClipId]) -> Result<Vec<ClipId>, String> {
        let mut links = BTreeSet::new();
        let mut clips = BTreeSet::new();
        for &id in ids {
            let (_, clip) = self.find(id)?;
            clips.insert(id);
            links.extend(clip.link);
        }
        for clip in self.project.clips() {
            if clip.link.is_some_and(|link| links.contains(&link)) {
                clips.insert(clip.id);
            }
        }
        Ok(clips.into_iter().collect())
    }

    /// The nearest frame boundary to `time`.
    fn snap(&self, time: Flicks) -> Result<Flicks, String> {
        if time.0.abs() > MAX_TIME.0 {
            return Err("That time is too far from the start of the timeline".into());
        }
        let frame = self.frame.0 as i128;
        Ok(Flicks((div_round(time.0 as i128, frame) * frame) as i64))
    }

    /// A snapped timeline position, which cannot be before zero.
    fn position(&self, time: Flicks) -> Result<Flicks, String> {
        let time = self.snap(time)?;
        if time < Flicks::ZERO {
            return Err("The timeline starts at 0".into());
        }
        Ok(time)
    }

    /// The edit rules every changed clip must meet: at least a frame long, inside
    /// the timeline and inside its media.
    fn check_clip(&self, clip: &Clip) -> Result<(), String> {
        if clip.duration < self.frame {
            return Err(format!("Clip {} would be shorter than one frame", clip.id));
        }
        if clip.start < Flicks::ZERO {
            return Err(format!("Clip {} would start before 0", clip.id));
        }
        if clip.end() > MAX_TIME {
            return Err(format!("Clip {} would end too late", clip.id));
        }
        let media = self
            .project
            .media(&clip.media)
            .ok_or_else(|| format!("Clip {} has no media", clip.id))?;
        if media.is_still() {
            if clip.source_in != Flicks::ZERO {
                return Err("Stills have no source position".into());
            }
        } else if clip.source_in < Flicks::ZERO {
            return Err(format!("{} has nothing before that point", media.name));
        } else if clip.source_out() > media.duration + SOURCE_SLACK {
            return Err(format!("{} has nothing after that point", media.name));
        }
        Ok(())
    }

    fn check_clip_id(&self, id: ClipId) -> Result<(), String> {
        let (_, clip) = self.find(id)?;
        self.check_clip(&clip)
    }

    /// Fails when clips on track `index` overlap.
    fn check_track(&self, index: usize) -> Result<(), String> {
        let clips = &self.project.tracks[index].clips;
        for pair in clips.windows(2) {
            if pair[0].end() > pair[1].start {
                return Err(format!(
                    "Clips {} and {} would overlap on {}",
                    pair[0].id,
                    pair[1].id,
                    self.track_name(index)
                ));
            }
        }
        Ok(())
    }

    // ---- Building blocks ---------------------------------------------------------

    /// Splits clip `id` at `at` (strictly inside it) and returns the right half's id.
    fn split_clip(
        &mut self,
        index: usize,
        id: ClipId,
        at: Flicks,
        right_link: Option<LinkId>,
    ) -> Result<ClipId, String> {
        let right_id = ClipId(self.alloc());
        let (_, clip) = self.find(id)?;
        let still = self.is_still(&clip.media);
        let offset = at - clip.start;
        if offset < self.frame || clip.duration - offset < self.frame {
            return Err(format!(
                "Clip {id} can't be split less than a frame from its edge"
            ));
        }
        let mut right = clip.clone();
        right.id = right_id;
        right.start = at;
        right.duration = clip.duration - offset;
        if !still {
            right.source_in = clip.source_in + clip.speed.source_span(offset);
        }
        right.link = right_link;
        // Keyframes are relative to the clip's start: keep the animation where it was.
        for keys in right.keyframes.values_mut() {
            for key in keys.iter_mut() {
                key.time -= offset;
            }
        }
        let track = self.track_mut(index);
        let position = track.position(id).expect("clip on its track");
        track.clips[position].duration = offset;
        track.clips.insert(position + 1, right);
        Ok(right_id)
    }

    /// Moves the start of clip `id` to `start`, keeping its end and adjusting its source.
    fn set_start(&mut self, index: usize, id: ClipId, start: Flicks) {
        let still = self.is_still(&self.find(id).expect("clip").1.media);
        let clip = self.clip_mut(index, id);
        let delta = start - clip.start;
        clip.start = start;
        clip.duration -= delta;
        if !still {
            clip.source_in += clip.speed.source_span(delta);
        }
    }

    /// Empties `start..end` on track `index`, trimming, splitting or removing clips.
    fn clear_range(&mut self, index: usize, start: Flicks, end: Flicks) -> Result<(), String> {
        let overlapping: Vec<Clip> = self.project.tracks[index]
            .clips
            .iter()
            .filter(|clip| clip.start < end && clip.end() > start)
            .cloned()
            .collect();
        let mut changed = Vec::new();
        for clip in overlapping {
            if clip.start >= start && clip.end() <= end {
                self.track_mut(index).clips.retain(|c| c.id != clip.id);
                continue;
            }
            if clip.start < start && clip.end() > end {
                let right = self.split_clip(index, clip.id, end, None)?;
                self.created.push(right.0);
                self.clip_mut(index, clip.id).duration = start - clip.start;
                changed.push(right);
            } else if clip.start < start {
                self.clip_mut(index, clip.id).duration = start - clip.start;
            } else {
                self.set_start(index, clip.id, end);
            }
            changed.push(clip.id);
        }
        for id in changed {
            self.check_clip_id(id)?;
        }
        Ok(())
    }

    /// Moves every clip on track `index` that starts at or after `from` by `delta`.
    fn shift(&mut self, index: usize, from: Flicks, delta: Flicks) -> Result<(), String> {
        if delta == Flicks::ZERO {
            return Ok(());
        }
        for clip in self.track_mut(index).clips.iter_mut() {
            if clip.start >= from {
                clip.start += delta;
            }
        }
        let track = &self.project.tracks[index];
        if let Some(clip) = track
            .clips
            .iter()
            .find(|clip| clip.start < Flicks::ZERO || clip.end() > MAX_TIME)
        {
            return Err(format!("Clip {} would leave the timeline", clip.id));
        }
        self.check_track(index)
    }

    fn new_clip(&mut self, spec: &ClipSpec, start: Flicks) -> Result<Clip, String> {
        let media = self
            .project
            .media(&spec.media)
            .ok_or_else(|| format!("No media {} in the project", spec.media))?
            .clone();
        let video = spec.video.unwrap_or(media.has_video);
        let audio = spec.audio.unwrap_or(media.has_audio);
        if video && !media.has_video {
            return Err(format!("{} has no picture", media.name));
        }
        if audio && !media.has_audio {
            return Err(format!("{} has no sound", media.name));
        }
        if !video && !audio {
            return Err("A clip needs its picture, its sound or both".into());
        }
        let clip = Clip {
            id: ClipId(self.alloc()),
            media: media.id,
            start,
            duration: self.snap(spec.duration)?,
            source_in: spec.source_in,
            speed: Speed::NORMAL,
            video,
            audio,
            link: None,
            transform: Transform::default(),
            crop: Crop::default(),
            opacity: 1.0,
            volume_db: 0.0,
            effects: Vec::new(),
            keyframes: BTreeMap::new(),
        };
        self.check_clip(&clip)?;
        Ok(clip)
    }

    // ---- Commands ----------------------------------------------------------------

    fn remove_media(&mut self, id: &str) -> Result<(), String> {
        let position = self
            .project
            .media
            .iter()
            .position(|media| media.id == id)
            .ok_or_else(|| format!("No media {id} in the project"))?;
        for index in 0..self.project.tracks.len() {
            if self.project.tracks[index]
                .clips
                .iter()
                .any(|clip| clip.media == id)
            {
                self.unlocked(index)?;
                self.track_mut(index).clips.retain(|clip| clip.media != id);
            }
        }
        self.project.media.remove(position);
        Ok(())
    }

    /// Insert (`at` with `push`), overwrite (`at` without) or append (no `at`).
    fn place(
        &mut self,
        track: TrackId,
        at: Option<Flicks>,
        spec: &ClipSpec,
        push: bool,
    ) -> Result<(), String> {
        let index = self.track_index(track)?;
        self.unlocked(index)?;
        let at = match at {
            Some(at) => self.position(at)?,
            None => self.project.tracks[index].end().unwrap_or(Flicks::ZERO),
        };
        let clip = self.new_clip(spec, at)?;
        self.created.push(clip.id.0);
        if push {
            let under = self.project.tracks[index]
                .clips
                .iter()
                .find(|c| c.spans(at))
                .map(|c| c.id);
            if let Some(under) = under {
                let right = self.split_clip(index, under, at, None)?;
                self.created.push(right.0);
            }
            self.shift(index, at, clip.duration)?;
        } else {
            self.clear_range(index, at, clip.end())?;
        }
        self.track_mut(index).insert_sorted(clip);
        self.check_track(index)
    }

    fn delete(&mut self, ids: &[ClipId], ripple: bool) -> Result<(), String> {
        if ids.is_empty() {
            return Err("Nothing to delete".into());
        }
        let mut by_track: BTreeMap<usize, Vec<Clip>> = BTreeMap::new();
        for id in self.with_partners(ids)? {
            let (index, clip) = self.find(id)?;
            self.unlocked(index)?;
            by_track.entry(index).or_default().push(clip);
        }
        for (index, mut clips) in by_track {
            // Latest first, so each gap closes without moving the earlier ones.
            clips.sort_by_key(|clip| std::cmp::Reverse(clip.start));
            for clip in clips {
                self.track_mut(index).clips.retain(|c| c.id != clip.id);
                if ripple {
                    self.shift(index, clip.end(), -clip.duration)?;
                }
            }
        }
        Ok(())
    }

    fn split(&mut self, at: Flicks, ids: &[ClipId]) -> Result<(), String> {
        let at = self.position(at)?;
        let targets: Vec<ClipId> = if ids.is_empty() {
            let mut all = Vec::new();
            for track in &self.project.tracks {
                if !track.locked {
                    all.extend(track.clips.iter().filter(|c| c.spans(at)).map(|c| c.id));
                }
            }
            all.sort();
            all
        } else {
            for &id in ids {
                if !self.find(id)?.1.spans(at) {
                    return Err(format!("Clip {id} is not under the split point"));
                }
            }
            self.with_partners(ids)?
                .into_iter()
                .filter(|&id| self.find(id).is_ok_and(|(_, clip)| clip.spans(at)))
                .collect()
        };
        if targets.is_empty() {
            return Err("There is no clip to split there".into());
        }
        // Left halves keep their links; each group's right halves form a new group.
        let mut right_links: BTreeMap<LinkId, LinkId> = BTreeMap::new();
        for id in targets {
            let (index, clip) = self.find(id)?;
            self.unlocked(index)?;
            let right_link = clip.link.map(|link| {
                *right_links
                    .entry(link)
                    .or_insert_with(|| LinkId(self.alloc()))
            });
            let right = self.split_clip(index, id, at, right_link)?;
            self.created.push(right.0);
        }
        Ok(())
    }

    fn trim(&mut self, id: ClipId, edge: Edge, delta: Flicks, ripple: bool) -> Result<(), String> {
        let delta = self.snap(delta)?;
        for target in self.with_partners(&[id])? {
            let (index, clip) = self.find(target)?;
            self.unlocked(index)?;
            match (edge, ripple) {
                (Edge::Start, false) => {
                    let start = clip.start + delta;
                    if start >= clip.end() {
                        return Err(format!("Clip {target} would be shorter than one frame"));
                    }
                    self.set_start(index, target, start);
                }
                (Edge::End, false) => self.clip_mut(index, target).duration += delta,
                (Edge::Start, true) => {
                    // The clip keeps its place; its content and everything after move.
                    let still = self.is_still(&clip.media);
                    let changed = self.clip_mut(index, target);
                    changed.duration -= delta;
                    if !still {
                        changed.source_in += changed.speed.source_span(delta);
                    }
                    self.shift_after(index, target, clip.end(), -delta)?;
                }
                (Edge::End, true) => {
                    self.clip_mut(index, target).duration += delta;
                    self.shift_after(index, target, clip.end(), delta)?;
                }
            }
            self.check_clip_id(target)?;
            self.check_track(index)?;
        }
        Ok(())
    }

    /// [`Edit::shift`], leaving clip `except` where it is.
    fn shift_after(
        &mut self,
        index: usize,
        except: ClipId,
        from: Flicks,
        delta: Flicks,
    ) -> Result<(), String> {
        let position = self.project.tracks[index]
            .position(except)
            .expect("clip on its track");
        let held = self.track_mut(index).clips.remove(position);
        self.shift(index, from, delta)?;
        self.track_mut(index).insert_sorted(held);
        Ok(())
    }

    fn roll(&mut self, id: ClipId, edge: Edge, delta: Flicks) -> Result<(), String> {
        let delta = self.snap(delta)?;
        for target in self.with_partners(&[id])? {
            let (index, clip) = self.find(target)?;
            self.unlocked(index)?;
            let neighbour = self.project.tracks[index]
                .clips
                .iter()
                .find(|c| match edge {
                    Edge::End => c.start == clip.end(),
                    Edge::Start => c.end() == clip.start,
                })
                .map(|c| c.id);
            let Some(neighbour) = neighbour else {
                if target == id {
                    return Err(format!(
                        "Clip {id} has no clip right next to its {} to roll with",
                        match edge {
                            Edge::Start => "start",
                            Edge::End => "end",
                        }
                    ));
                }
                // A linked partner without a neighbour there is simply trimmed.
                match edge {
                    Edge::Start => self.set_start(index, target, clip.start + delta),
                    Edge::End => self.clip_mut(index, target).duration += delta,
                }
                self.check_clip_id(target)?;
                self.check_track(index)?;
                continue;
            };
            let (left, right) = match edge {
                Edge::End => (target, neighbour),
                Edge::Start => (neighbour, target),
            };
            self.clip_mut(index, left).duration += delta;
            let cut = self.find(right)?.1.start + delta;
            if cut >= self.find(right)?.1.end() {
                return Err(format!("Clip {right} would be shorter than one frame"));
            }
            self.set_start(index, right, cut);
            self.check_clip_id(left)?;
            self.check_clip_id(right)?;
            self.check_track(index)?;
        }
        Ok(())
    }

    fn move_clips(
        &mut self,
        ids: &[ClipId],
        delta: Flicks,
        tracks: i32,
        overwrite: bool,
    ) -> Result<(), String> {
        if ids.is_empty() {
            return Err("Nothing to move".into());
        }
        let delta = self.snap(delta)?;
        let count = self.project.tracks.len() as i64;
        let mut moving = Vec::new();
        for id in self.with_partners(ids)? {
            let (from, mut clip) = self.find(id)?;
            self.unlocked(from)?;
            let to = from as i64 + tracks as i64;
            if !(0..count).contains(&to) {
                return Err("There is no track there".into());
            }
            let to = to as usize;
            self.unlocked(to)?;
            clip.start += delta;
            self.check_clip(&clip)?;
            moving.push((from, to, clip));
        }
        for (from, _, clip) in &moving {
            self.track_mut(*from).clips.retain(|c| c.id != clip.id);
        }
        moving.sort_by_key(|(_, to, clip)| (*to, clip.start));
        for (_, to, clip) in moving {
            if overwrite {
                self.clear_range(to, clip.start, clip.end())?;
            } else if !self.project.tracks[to].is_free(clip.start, clip.end(), &[]) {
                return Err(format!(
                    "Clip {} would land on another clip on {}",
                    clip.id,
                    self.track_name(to)
                ));
            }
            self.track_mut(to).insert_sorted(clip);
            self.check_track(to)?;
        }
        Ok(())
    }

    fn slip(&mut self, id: ClipId, delta: Flicks) -> Result<(), String> {
        if self.is_still(&self.find(id)?.1.media) {
            return Err("Stills have nothing to slip".into());
        }
        let delta = self.snap(delta)?;
        for target in self.with_partners(&[id])? {
            let (index, clip) = self.find(target)?;
            if self.is_still(&clip.media) {
                continue;
            }
            self.unlocked(index)?;
            self.clip_mut(index, target).source_in += delta;
            self.check_clip_id(target)?;
        }
        Ok(())
    }

    fn slide(&mut self, id: ClipId, delta: Flicks) -> Result<(), String> {
        let delta = self.snap(delta)?;
        let mut by_track: BTreeMap<usize, Vec<Clip>> = BTreeMap::new();
        for target in self.with_partners(&[id])? {
            let (index, clip) = self.find(target)?;
            self.unlocked(index)?;
            by_track.entry(index).or_default().push(clip);
        }
        for (index, mut clips) in by_track {
            // Linked clips that touch slide as one block between the block's neighbours.
            clips.sort_by_key(|c| c.start);
            let mut blocks: Vec<Vec<ClipId>> = Vec::new();
            let mut block_end = None;
            for clip in &clips {
                match blocks.last_mut() {
                    Some(block) if block_end == Some(clip.start) => block.push(clip.id),
                    _ => blocks.push(vec![clip.id]),
                }
                block_end = Some(clip.end());
            }
            for block in blocks {
                let first = self.find(block[0])?.1.start;
                let last = self.find(*block.last().expect("block"))?.1.end();
                let neighbours = &self.project.tracks[index].clips;
                let outside = |c: &&Clip| !block.contains(&c.id);
                let previous = neighbours
                    .iter()
                    .filter(outside)
                    .find(|c| c.end() == first)
                    .map(|c| c.id);
                let next = neighbours
                    .iter()
                    .filter(outside)
                    .find(|c| c.start == last)
                    .map(|c| c.id);
                if let Some(previous) = previous {
                    self.clip_mut(index, previous).duration += delta;
                    self.check_clip_id(previous)?;
                }
                if let Some(next) = next {
                    let (_, next_clip) = self.find(next)?;
                    let start = next_clip.start + delta;
                    if start >= next_clip.end() {
                        return Err(format!("Clip {next} would be shorter than one frame"));
                    }
                    self.set_start(index, next, start);
                    self.check_clip_id(next)?;
                }
                for &member in &block {
                    self.clip_mut(index, member).start += delta;
                    self.check_clip_id(member)?;
                }
            }
            // Sorting keeps order when the previous clip shrinks before the block moves.
            self.track_mut(index).clips.sort_by_key(|c| c.start);
            self.check_track(index)?;
        }
        Ok(())
    }

    fn link(&mut self, ids: &[ClipId]) -> Result<(), String> {
        let unique: BTreeSet<ClipId> = ids.iter().copied().collect();
        if unique.len() < 2 {
            return Err("Linking needs at least two clips".into());
        }
        let link = LinkId(self.alloc());
        for id in self.with_partners(ids)? {
            let (index, _) = self.find(id)?;
            self.unlocked(index)?;
            self.clip_mut(index, id).link = Some(link);
        }
        Ok(())
    }

    fn detach_audio(&mut self, id: ClipId, track: Option<TrackId>) -> Result<(), String> {
        let (index, clip) = self.find(id)?;
        self.unlocked(index)?;
        if !clip.video || !clip.audio {
            return Err("Only a video clip with its own sound can detach it".into());
        }
        let audio_id = ClipId(self.alloc());
        self.created.push(audio_id.0);
        let to = match track {
            Some(track) => {
                let to = self.track_index(track)?;
                if to == index {
                    return Err("The sound needs a different track".into());
                }
                self.unlocked(to)?;
                if !self.project.tracks[to].is_free(clip.start, clip.end(), &[]) {
                    return Err(format!(
                        "{} has clips where the sound would go",
                        self.track_name(to)
                    ));
                }
                to
            }
            None => {
                let new = Track::new(TrackId(self.alloc()));
                self.created.push(new.id.0);
                self.project.tracks.insert(index, Arc::new(new));
                index
            }
        };
        let link = match clip.link {
            Some(link) => link,
            None => LinkId(self.alloc()),
        };
        let audio = Clip {
            id: audio_id,
            video: false,
            audio: true,
            link: Some(link),
            transform: Transform::default(),
            crop: Crop::default(),
            opacity: 1.0,
            effects: Vec::new(),
            keyframes: BTreeMap::new(),
            ..clip.clone()
        };
        // A new track below the clip moved the clip's track up by one.
        let (video_index, _) = self.find(id)?;
        let video = self.clip_mut(video_index, id);
        video.audio = false;
        video.link = Some(link);
        self.track_mut(to).insert_sorted(audio);
        self.check_track(to)
    }

    fn set_speed(&mut self, id: ClipId, speed: Speed) -> Result<(), String> {
        if Speed::new(speed.num, speed.den) != Some(speed) {
            return Err("Speed must be a reduced fraction from 0.1× to 100×".into());
        }
        if self.is_still(&self.find(id)?.1.media) {
            return Err("Stills have no speed".into());
        }
        for target in self.with_partners(&[id])? {
            let (index, clip) = self.find(target)?;
            if self.is_still(&clip.media) {
                continue;
            }
            self.unlocked(index)?;
            // Keep the same source span, rounded down to whole frames.
            let source = clip.speed.source_span(clip.duration);
            let frames = speed.timeline_span(source).0 / self.frame.0;
            let duration = Flicks(frames.max(1) * self.frame.0);
            let changed = self.clip_mut(index, target);
            changed.speed = speed;
            changed.duration = duration;
            self.check_clip_id(target)?;
            self.check_track(index)?;
        }
        Ok(())
    }

    fn set_properties(&mut self, id: ClipId, properties: &ClipProperties) -> Result<(), String> {
        let (index, _) = self.find(id)?;
        self.unlocked(index)?;
        if let Some(transform) = &properties.transform {
            check_transform(transform)?;
        }
        if let Some(crop) = &properties.crop {
            check_crop(crop)?;
        }
        if let Some(opacity) = properties.opacity {
            check_opacity(opacity)?;
        }
        if let Some(volume) = properties.volume_db {
            check_volume(volume)?;
        }
        let clip = self.clip_mut(index, id);
        if let Some(transform) = properties.transform {
            clip.transform = transform;
        }
        if let Some(crop) = properties.crop {
            clip.crop = crop;
        }
        if let Some(opacity) = properties.opacity {
            clip.opacity = opacity;
        }
        if let Some(volume) = properties.volume_db {
            clip.volume_db = volume;
        }
        Ok(())
    }

    fn sort_markers(&mut self) {
        self.project.markers.sort_by_key(|m| (m.time, m.id));
    }

    /// A link with one clip left is no link: clear it.
    fn normalize_links(&mut self) {
        let mut counts: BTreeMap<LinkId, usize> = BTreeMap::new();
        for clip in self.project.clips() {
            if let Some(link) = clip.link {
                *counts.entry(link).or_default() += 1;
            }
        }
        let lone: BTreeSet<LinkId> = counts
            .into_iter()
            .filter(|(_, count)| *count < 2)
            .map(|(link, _)| link)
            .collect();
        if lone.is_empty() {
            return;
        }
        for index in 0..self.project.tracks.len() {
            let has_lone = self.project.tracks[index]
                .clips
                .iter()
                .any(|c| c.link.is_some_and(|l| lone.contains(&l)));
            if has_lone {
                for clip in self.track_mut(index).clips.iter_mut() {
                    if clip.link.is_some_and(|l| lone.contains(&l)) {
                        clip.link = None;
                    }
                }
            }
        }
    }
}

fn check_track_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.chars().count() > 100 {
        return Err("Track names are at most 100 characters".into());
    }
    Ok(name.to_string())
}

fn check_marker_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.chars().count() > MAX_NAME {
        return Err(format!("Marker names are at most {MAX_NAME} characters"));
    }
    Ok(name.to_string())
}

pub(crate) fn check_transform(t: &Transform) -> Result<(), String> {
    let finite = [
        t.x, t.y, t.scale_x, t.scale_y, t.rotation, t.anchor_x, t.anchor_y,
    ]
    .iter()
    .all(|v| v.is_finite());
    if !finite {
        return Err("Transform values must be numbers".into());
    }
    if t.x.abs() > 1e6 || t.y.abs() > 1e6 {
        return Err("Position is out of range".into());
    }
    if !(t.scale_x > 0.0 && t.scale_x <= 100.0 && t.scale_y > 0.0 && t.scale_y <= 100.0) {
        return Err("Scale must be above 0 and at most 10,000%".into());
    }
    if t.rotation.abs() > 36_000.0 || t.anchor_x.abs() > 100.0 || t.anchor_y.abs() > 100.0 {
        return Err("Rotation or anchor is out of range".into());
    }
    Ok(())
}

pub(crate) fn check_crop(c: &Crop) -> Result<(), String> {
    let sides = [c.left, c.top, c.right, c.bottom];
    if !sides
        .iter()
        .all(|v| v.is_finite() && (0.0..1.0).contains(v))
    {
        return Err("Crop sides are fractions from 0 to 1".into());
    }
    if c.left + c.right >= 1.0 || c.top + c.bottom >= 1.0 {
        return Err("Crop would leave nothing".into());
    }
    Ok(())
}

pub(crate) fn check_opacity(opacity: f64) -> Result<(), String> {
    if !(0.0..=1.0).contains(&opacity) {
        return Err("Opacity is from 0 to 1".into());
    }
    Ok(())
}

pub(crate) fn check_volume(volume_db: f64) -> Result<(), String> {
    if !(-96.0..=24.0).contains(&volume_db) {
        return Err("Volume is from -96 dB to +24 dB".into());
    }
    Ok(())
}

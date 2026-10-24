//! How each [`Command`] changes a project.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use cgv_time::Flicks;

use crate::animation::{property_effect, value_at, Keyframe, Keyframes, Property};
use crate::command::{ClipProperties, ClipSpec, Command, Edge, Outcome};
use crate::effects::{
    parse_lut_ref, Alignment, EffectSpec, ParamValue, Transition, TransitionSpec, MAX_EFFECTS,
};
use crate::project::{
    Clip, ClipId, ClipKind, Crop, EffectId, LinkId, LutId, Marker, MarkerId, Project, Speed, Track,
    TrackId, Transform, TransitionId, MAX_TIME,
};
use crate::validate::{check_effects, check_keyframes, check_name, validate};

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
            deferred: BTreeSet::new(),
            required: None,
        };
        edit.run(command)?;
        edit.settle()?;
        edit.normalize_transitions();
        if let Some(id) = edit.required {
            if edit.find_transition(id).is_err() {
                return Err("There is no room for a transition there".into());
            }
        }
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
    /// Tracks to check for overlaps once the magnetic main track has settled: until
    /// then, a clip may overlap one that settling moves out of its way.
    deferred: BTreeSet<TrackId>,
    /// A transition the command added, which must still fit once the edit settles.
    required: Option<TransitionId>,
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
            // Turning magnetism on closes the main track's gaps as the edit settles.
            Command::SetMagnetic { magnetic } => self.project.magnetic = *magnetic,
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
                if *track == self.project.main_track {
                    return Err("The main track can't be deleted".into());
                }
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
            Command::AddEffect {
                clip,
                effect,
                index,
            } => self.add_effect(*clip, effect, *index)?,
            Command::RemoveEffect { clip, effect } => {
                let (index, mut changed) = self.editable(*clip)?;
                let position = effect_position(&changed, *effect)?;
                changed.effects.remove(position);
                changed
                    .keyframes
                    .retain(|name, _| property_effect(name) != Some(*effect));
                *self.clip_mut(index, *clip) = changed;
            }
            Command::MoveEffect {
                clip,
                effect,
                index: to,
            } => {
                let (index, mut changed) = self.editable(*clip)?;
                let position = effect_position(&changed, *effect)?;
                if *to >= changed.effects.len() {
                    return Err(format!("There is no effect position {}", to + 1));
                }
                let moved = changed.effects.remove(position);
                changed.effects.insert(*to, moved);
                *self.clip_mut(index, *clip) = changed;
            }
            Command::SetEffectEnabled {
                clip,
                effect,
                enabled,
            } => {
                let (index, mut changed) = self.editable(*clip)?;
                let position = effect_position(&changed, *effect)?;
                changed.effects[position].enabled = *enabled;
                *self.clip_mut(index, *clip) = changed;
            }
            Command::SetEffectParams {
                clip,
                effect,
                params,
            } => {
                let (index, mut changed) = self.editable(*clip)?;
                let position = effect_position(&changed, *effect)?;
                let target = &mut changed.effects[position];
                for (name, value) in params {
                    target.params.insert(name.clone(), value.clone());
                }
                target.check()?;
                *self.clip_mut(index, *clip) = changed;
            }
            Command::ResetEffect {
                clip,
                effect,
                params,
            } => {
                let (index, mut changed) = self.editable(*clip)?;
                let position = effect_position(&changed, *effect)?;
                changed.effects[position].params = params.clone();
                changed.effects[position].check()?;
                changed
                    .keyframes
                    .retain(|name, _| property_effect(name) != Some(*effect));
                *self.clip_mut(index, *clip) = changed;
            }
            Command::SetKeyframe {
                clip,
                property,
                time,
                value,
                interpolation,
            } => {
                let time = self.snap(*time)?;
                let (index, mut changed) = self.editable(*clip)?;
                let keys = changed.keyframes.entry(property.clone()).or_default();
                let position = keys.partition_point(|key| key.time < time);
                let replaced = keys.get(position).filter(|key| key.time == time).copied();
                let key = Keyframe {
                    time,
                    value: *value,
                    interpolation: interpolation
                        .or(replaced.map(|key| key.interpolation))
                        .unwrap_or_default(),
                };
                if replaced.is_some() {
                    keys[position] = key;
                } else {
                    keys.insert(position, key);
                }
                check_keyframes(&changed)?;
                *self.clip_mut(index, *clip) = changed;
            }
            Command::RemoveKeyframes {
                clip,
                property,
                times,
            } => {
                let (index, mut changed) = self.editable(*clip)?;
                if let Some(keys) = changed.keyframes.get_mut(property) {
                    keys.retain(|key| !times.contains(&key.time));
                    if keys.is_empty() {
                        changed.keyframes.remove(property);
                    }
                }
                *self.clip_mut(index, *clip) = changed;
            }
            Command::SetKeyframes {
                clip,
                property,
                keys,
            } => {
                let (index, mut changed) = self.editable(*clip)?;
                let mut snapped: Vec<Keyframe> = Vec::with_capacity(keys.len());
                for key in keys {
                    let key = Keyframe {
                        time: self.snap(key.time)?,
                        ..*key
                    };
                    snapped.retain(|k| k.time != key.time);
                    snapped.push(key);
                }
                snapped.sort_by_key(|key| key.time);
                if snapped.is_empty() {
                    changed.keyframes.remove(property);
                } else {
                    changed.keyframes.insert(property.clone(), snapped);
                }
                check_keyframes(&changed)?;
                *self.clip_mut(index, *clip) = changed;
            }
            Command::MoveKeyframes {
                clip,
                properties,
                times,
                delta,
            } => {
                let delta = self.snap(*delta)?;
                let (index, mut changed) = self.editable(*clip)?;
                for (name, keys) in changed.keyframes.iter_mut() {
                    if !properties.is_empty() && !properties.contains(name) {
                        continue;
                    }
                    let (mut moved, rest): (Vec<Keyframe>, Vec<Keyframe>) =
                        keys.iter().partition(|key| times.contains(&key.time));
                    for key in moved.iter_mut() {
                        key.time += delta;
                    }
                    let mut merged: Vec<Keyframe> = rest
                        .into_iter()
                        .filter(|key| !moved.iter().any(|m| m.time == key.time))
                        .collect();
                    merged.extend(moved);
                    merged.sort_by_key(|key| key.time);
                    *keys = merged;
                }
                check_keyframes(&changed)?;
                *self.clip_mut(index, *clip) = changed;
            }
            Command::SetInterpolation {
                clip,
                property,
                times,
                interpolation,
            } => {
                interpolation.check()?;
                let (index, mut changed) = self.editable(*clip)?;
                let keys = changed
                    .keyframes
                    .get_mut(property)
                    .ok_or_else(|| format!("{property} is not animated"))?;
                for key in keys.iter_mut().filter(|key| times.contains(&key.time)) {
                    key.interpolation = *interpolation;
                }
                *self.clip_mut(index, *clip) = changed;
            }
            Command::ClearKeyframes { clip, property, at } => {
                let (index, mut changed) = self.editable(*clip)?;
                if !changed.keyframes.contains_key(property) {
                    return Ok(());
                }
                if let Some(at) = at {
                    freeze(&mut changed, property, *at)?;
                }
                changed.keyframes.remove(property);
                *self.clip_mut(index, *clip) = changed;
            }
            Command::AddTransition {
                track,
                from,
                to,
                transition,
            } => self.add_transition(*track, *from, *to, transition)?,
            Command::SetTransition {
                transition,
                duration,
                alignment,
                params,
            } => {
                let (index, position) = self.find_transition(*transition)?;
                self.unlocked(index)?;
                let duration = duration.map(|d| self.snap(d)).transpose()?;
                let mut changed = self.project.tracks[index].transitions[position].clone();
                if let Some(duration) = duration {
                    if duration < self.frame {
                        return Err("A transition lasts at least one frame".into());
                    }
                    changed.duration = duration;
                }
                if let Some(alignment) = alignment {
                    changed.alignment = *alignment;
                }
                if let Some(params) = params {
                    for (name, value) in params {
                        changed.params.insert(name.clone(), value.clone());
                    }
                }
                changed.check()?;
                self.track_mut(index).transitions[position] = changed;
            }
            Command::RemoveTransition { transition } => {
                let (index, position) = self.find_transition(*transition)?;
                self.unlocked(index)?;
                self.track_mut(index).transitions.remove(position);
            }
            Command::AddLut { lut } => {
                let lut = lut.build(LutId(self.alloc()))?;
                self.created.push(lut.id.0);
                self.project.luts.push(Arc::new(lut));
            }
            Command::RemoveLut { lut } => {
                let position = self
                    .project
                    .luts
                    .iter()
                    .position(|entry| entry.id == *lut)
                    .ok_or_else(|| format!("No LUT {lut}"))?;
                let names = |value: &ParamValue| matches!(value, ParamValue::Text(text) if parse_lut_ref(text) == Some(*lut));
                let used = self
                    .project
                    .clips()
                    .any(|clip| clip.effects.iter().any(|e| e.params.values().any(names)));
                if used {
                    return Err(format!(
                        "{} is used by an effect",
                        self.project.luts[position].name
                    ));
                }
                self.project.luts.remove(position);
            }
            Command::Batch { commands } => {
                for command in commands {
                    let batchable = matches!(
                        command,
                        Command::SetClipProperties { .. }
                            | Command::SetEffectParams { .. }
                            | Command::SetEffectEnabled { .. }
                            | Command::SetKeyframe { .. }
                            | Command::SetKeyframes { .. }
                            | Command::RemoveKeyframes { .. }
                            | Command::MoveKeyframes { .. }
                            | Command::ClearKeyframes { .. }
                            | Command::SetTransition { .. }
                    );
                    if !batchable {
                        return Err(format!("{} can't run in a batch", command.label()));
                    }
                    self.run(command)?;
                }
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

    /// Stills and adjustment layers (no media) have no source position or speed.
    fn is_still(&self, media: &str) -> bool {
        media.is_empty() || self.project.media(media).is_some_and(|m| m.is_still())
    }

    /// The track index and a copy of clip `id`, whose track must be unlocked.
    fn editable(&self, id: ClipId) -> Result<(usize, Clip), String> {
        let (index, clip) = self.find(id)?;
        self.unlocked(index)?;
        Ok((index, clip))
    }

    /// The track index and position of transition `id`.
    fn find_transition(&self, id: TransitionId) -> Result<(usize, usize), String> {
        self.project
            .tracks
            .iter()
            .enumerate()
            .find_map(|(index, track)| {
                track
                    .transitions
                    .iter()
                    .position(|t| t.id == id)
                    .map(|position| (index, position))
            })
            .ok_or_else(|| format!("No transition {id}"))
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

    /// The magnetic main track's index, when magnetism is on.
    fn main_index(&self) -> Option<usize> {
        self.project.magnetic_index()
    }

    /// True when clip `id` is on the magnetic main track or linked to a clip there:
    /// the main track's rules then decide where it ends up.
    fn main_driven(&self, id: ClipId) -> bool {
        let (Some(main), Ok((index, clip))) = (self.main_index(), self.find(id)) else {
            return false;
        };
        index == main
            || clip.link.is_some_and(|link| {
                self.project.tracks[main]
                    .clips
                    .iter()
                    .any(|c| c.link == Some(link))
            })
    }

    /// The cut on track `index` nearest `time`: the timeline start or a clip's
    /// start or end. Ties go to the earlier cut.
    fn nearest_cut(&self, index: usize, time: Flicks) -> Flicks {
        let mut best = Flicks::ZERO;
        for clip in &self.project.tracks[index].clips {
            for cut in [clip.start, clip.end()] {
                if (cut.0 - time.0).abs() < (best.0 - time.0).abs() {
                    best = cut;
                }
            }
        }
        best
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
        if clip.is_adjustment() {
            return Ok(());
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

    /// Fails when clips on track `index` overlap. With a magnetic main track the
    /// check waits until the edit has settled.
    fn check_track(&mut self, index: usize) -> Result<(), String> {
        if self.project.magnetic {
            self.deferred.insert(self.project.tracks[index].id);
            return Ok(());
        }
        self.check_overlaps(index)
    }

    fn check_overlaps(&self, index: usize) -> Result<(), String> {
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
        // The right half's effects are its own, and its keyframes follow them.
        let renamed: BTreeMap<EffectId, EffectId> = right
            .effects
            .iter()
            .map(|effect| (effect.id, EffectId(self.alloc())))
            .collect();
        for effect in right.effects.iter_mut() {
            effect.id = renamed[&effect.id];
        }
        right.keyframes = rename_effects(&right.keyframes, &renamed);
        let track = self.track_mut(index);
        let position = track.position(id).expect("clip on its track");
        track.clips[position].duration = offset;
        track.clips.insert(position + 1, right);
        // The clip's end is now the right half's.
        for transition in track.transitions.iter_mut() {
            if transition.from == Some(id) {
                transition.from = Some(right_id);
            }
        }
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
        shift_keys(clip, -delta);
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
        let speed = spec.speed.unwrap_or(Speed::NORMAL);
        if Speed::new(speed.num, speed.den) != Some(speed) {
            return Err("Speed must be a reduced fraction from 0.1× to 100×".into());
        }
        let (media, video, audio) = match spec.kind {
            ClipKind::Adjustment => {
                if !spec.media.is_empty() {
                    return Err("An adjustment layer has no media".into());
                }
                if spec.audio == Some(true) || spec.video == Some(false) {
                    return Err("An adjustment layer changes only the picture".into());
                }
                if speed != Speed::NORMAL || spec.source_in != Flicks::ZERO {
                    return Err("Adjustment layers have no speed or source position".into());
                }
                (String::new(), true, false)
            }
            ClipKind::Media => {
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
                if media.is_still() && speed != Speed::NORMAL {
                    return Err("Stills have no speed".into());
                }
                (media.id, video, audio)
            }
        };
        let mut clip = Clip {
            id: ClipId(self.alloc()),
            kind: spec.kind,
            media,
            start,
            duration: self.snap(spec.duration)?,
            source_in: spec.source_in,
            speed,
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
        if let Some(properties) = &spec.properties {
            apply_properties(&mut clip, properties)?;
        }
        // Copied effects get new ids, and their keyframes follow them.
        if spec.effects.len() > MAX_EFFECTS {
            return Err(format!("A clip has at most {MAX_EFFECTS} effects"));
        }
        let mut renamed: BTreeMap<EffectId, EffectId> = BTreeMap::new();
        for effect in &spec.effects {
            let id = EffectId(self.alloc());
            if let Some(old) = effect.id {
                renamed.insert(old, id);
            }
            clip.effects.push(effect.build(id)?);
        }
        if let Some(name) = spec
            .keyframes
            .keys()
            .find(|name| property_effect(name).is_some_and(|old| !renamed.contains_key(&old)))
        {
            return Err(format!("{name} animates an effect the clip lacks"));
        }
        clip.keyframes = rename_effects(&spec.keyframes, &renamed);
        check_effects(&clip)?;
        check_keyframes(&clip)?;
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
        let main = self.main_index() == Some(index);
        let at = match at {
            Some(at) if main => self.nearest_cut(index, self.position(at)?),
            Some(at) => self.position(at)?,
            None => self.project.tracks[index].end().unwrap_or(Flicks::ZERO),
        };
        let clip = self.new_clip(spec, at)?;
        self.created.push(clip.id.0);
        if push && main {
            // Settling pushes the later clips, and the clips linked to them, aside.
        } else if push {
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
        let mut driven = BTreeSet::new();
        for id in self.with_partners(ids)? {
            let (index, clip) = self.find(id)?;
            self.unlocked(index)?;
            if self.main_driven(id) {
                driven.insert(id);
            }
            by_track.entry(index).or_default().push(clip);
        }
        for (index, mut clips) in by_track {
            // Latest first, so each gap closes without moving the earlier ones.
            clips.sort_by_key(|clip| std::cmp::Reverse(clip.start));
            for clip in clips {
                self.track_mut(index).clips.retain(|c| c.id != clip.id);
                // The magnetic main track closes its own gaps; other tracks keep theirs.
                if ripple && !driven.contains(&clip.id) {
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
        let targets = self.with_partners(&[id])?;
        // On the magnetic main track every trim ripples: settling closes or opens
        // the room, for the clips linked to it too.
        let driven = targets.iter().any(|&target| self.main_driven(target));
        let ripple = ripple && !driven;
        for target in targets {
            let (index, clip) = self.find(target)?;
            self.unlocked(index)?;
            match (edge, ripple) {
                (Edge::Start, false) if driven => {
                    // The clip keeps its place and settling moves the later ones, so a
                    // longer first clip never starts before 0.
                    let still = self.is_still(&clip.media);
                    let changed = self.clip_mut(index, target);
                    changed.duration -= delta;
                    if !still {
                        changed.source_in += changed.speed.source_span(delta);
                    }
                    shift_keys(changed, -delta);
                }
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
                    shift_keys(changed, -delta);
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
        let main = self.main_index();
        let named: BTreeSet<ClipId> = ids.iter().copied().collect();
        let mut moving = Vec::new();
        for id in self.with_partners(ids)? {
            let (from, clip) = self.find(id)?;
            self.unlocked(from)?;
            // The named clips change tracks; their partners only move in time.
            let to = if named.contains(&id) {
                from as i64 + tracks as i64
            } else {
                from as i64
            };
            if !(0..count).contains(&to) {
                return Err("There is no track there".into());
            }
            let to = to as usize;
            self.unlocked(to)?;
            moving.push((from, to, clip));
        }
        // Clips linked to ones going onto the magnetic main track follow them there.
        let main_links: BTreeSet<LinkId> = moving
            .iter()
            .filter(|(_, to, _)| Some(*to) == main)
            .filter_map(|(_, _, clip)| clip.link)
            .collect();
        let (onto_main, rest): (Vec<_>, Vec<_>) =
            moving.into_iter().partition(|(_, to, _)| Some(*to) == main);
        let (followers, mut moving): (Vec<_>, Vec<_>) = rest
            .into_iter()
            .partition(|(_, _, clip)| clip.link.is_some_and(|l| main_links.contains(&l)));
        for (from, _, clip) in onto_main.iter().chain(&moving) {
            self.track_mut(*from).clips.retain(|c| c.id != clip.id);
        }
        for (_, _, clip) in moving.iter_mut() {
            clip.start += delta;
            self.check_clip(clip)?;
        }
        moving.sort_by_key(|(_, to, clip)| (*to, clip.start));
        // Followers move too, so nothing may be overwritten onto them either.
        let mut placed: Vec<(usize, Flicks, Flicks)> = followers
            .iter()
            .map(|(index, _, clip)| (*index, clip.start, clip.end()))
            .collect();
        for (_, to, clip) in moving {
            // A clip moved onto its partner's track must not land on it.
            if placed
                .iter()
                .any(|&(track, start, end)| track == to && start < clip.end() && clip.start < end)
            {
                return Err(format!(
                    "Clip {} would land on a clip that moves with it",
                    clip.id
                ));
            }
            placed.push((to, clip.start, clip.end()));
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
        if let (Some(main), false) = (main, onto_main.is_empty()) {
            self.insert_on_main(main, onto_main, delta, &followers)?;
        }
        Ok(())
    }

    /// Inserts `clips`, moved onto the magnetic main track at `main`, as one block
    /// at the cut nearest where `delta` takes the first of them. Their `followers`
    /// (linked clips on other tracks) move as far as they did.
    fn insert_on_main(
        &mut self,
        main: usize,
        mut clips: Vec<(usize, usize, Clip)>,
        delta: Flicks,
        followers: &[(usize, usize, Clip)],
    ) -> Result<(), String> {
        clips.sort_by_key(|(from, _, clip)| (clip.start, *from));
        let cut = self.nearest_cut(main, clips[0].2.start + delta);
        let position = self.project.tracks[main]
            .clips
            .partition_point(|c| c.start < cut);
        let mut at = cut;
        let mut shifts: BTreeMap<LinkId, Flicks> = BTreeMap::new();
        let mut block = Vec::new();
        for (_, _, mut clip) in clips {
            if let Some(link) = clip.link {
                shifts.entry(link).or_insert(at - clip.start);
            }
            clip.start = at;
            at += clip.duration;
            self.check_clip(&clip)?;
            block.push(clip);
        }
        let track = self.track_mut(main);
        for (offset, clip) in block.into_iter().enumerate() {
            track.clips.insert(position + offset, clip);
        }
        for (index, _, follower) in followers {
            let shift = follower.link.and_then(|link| shifts.get(&link)).copied();
            let position = self.project.tracks[*index].position(follower.id);
            if let (Some(shift), Some(position)) = (shift, position) {
                self.track_mut(*index).clips[position].start += shift;
                self.track_mut(*index).clips.sort_by_key(|c| c.start);
                self.check_clip_id(follower.id)?;
                self.check_track(*index)?;
            }
        }
        Ok(())
    }

    fn slip(&mut self, id: ClipId, delta: Flicks) -> Result<(), String> {
        let (_, target) = self.find(id)?;
        if target.is_adjustment() {
            return Err("Adjustment layers have nothing to slip".into());
        }
        if self.is_still(&target.media) {
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
            // Neighbours come from where the clips are now, and are never clips that
            // slide themselves: a block that moves next to another is not its neighbour.
            let neighbours = &self.project.tracks[index].clips;
            let still = |c: &&Clip| !clips.iter().any(|target| target.id == c.id);
            let plan: Vec<(Vec<ClipId>, Option<ClipId>, Option<ClipId>)> = blocks
                .into_iter()
                .map(|block| {
                    let first = clips
                        .iter()
                        .find(|c| c.id == block[0])
                        .expect("member")
                        .start;
                    let last_id = *block.last().expect("block");
                    let last = clips
                        .iter()
                        .find(|c| c.id == last_id)
                        .expect("member")
                        .end();
                    let previous = neighbours.iter().filter(still).find(|c| c.end() == first);
                    let next = neighbours.iter().filter(still).find(|c| c.start == last);
                    (block, previous.map(|c| c.id), next.map(|c| c.id))
                })
                .collect();
            for (block, previous, next) in plan {
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
                if self.main_index() == Some(to) {
                    return Err("Sound can't be detached onto the magnetic main track".into());
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
        // Volume keyframes go with the sound; the rest stay with the picture.
        let (sound_keys, picture_keys): (Keyframes, Keyframes) = clip
            .keyframes
            .clone()
            .into_iter()
            .partition(|(name, _)| name == "volumeDb");
        let audio = Clip {
            id: audio_id,
            video: false,
            audio: true,
            link: Some(link),
            transform: Transform::default(),
            crop: Crop::default(),
            opacity: 1.0,
            effects: Vec::new(),
            keyframes: sound_keys,
            ..clip.clone()
        };
        // A new track below the clip moved the clip's track up by one.
        let (video_index, _) = self.find(id)?;
        let video = self.clip_mut(video_index, id);
        video.audio = false;
        video.link = Some(link);
        video.keyframes = picture_keys;
        self.track_mut(to).insert_sorted(audio);
        self.check_track(to)
    }

    fn set_speed(&mut self, id: ClipId, speed: Speed) -> Result<(), String> {
        if Speed::new(speed.num, speed.den) != Some(speed) {
            return Err("Speed must be a reduced fraction from 0.1× to 100×".into());
        }
        let (_, target) = self.find(id)?;
        if target.is_adjustment() {
            return Err("Adjustment layers have no speed".into());
        }
        if self.is_still(&target.media) {
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

    fn add_effect(
        &mut self,
        id: ClipId,
        spec: &EffectSpec,
        index: Option<usize>,
    ) -> Result<(), String> {
        let (track, mut clip) = self.editable(id)?;
        if !clip.video {
            return Err(format!("Clip {id} has no picture for effects to change"));
        }
        if clip.effects.len() >= MAX_EFFECTS {
            return Err(format!("A clip has at most {MAX_EFFECTS} effects"));
        }
        let index = index.unwrap_or(clip.effects.len());
        if index > clip.effects.len() {
            return Err(format!("There is no effect position {}", index + 1));
        }
        let effect = spec.build(EffectId(self.alloc()))?;
        self.created.push(effect.id.0);
        clip.effects.insert(index, effect);
        *self.clip_mut(track, id) = clip;
        Ok(())
    }

    fn add_transition(
        &mut self,
        track: TrackId,
        from: Option<ClipId>,
        to: Option<ClipId>,
        spec: &TransitionSpec,
    ) -> Result<(), String> {
        let index = self.track_index(track)?;
        self.unlocked(index)?;
        let name = self.track_name(index);
        let on_track = |id: Option<ClipId>| -> Result<Option<Clip>, String> {
            id.map(|id| {
                self.project.tracks[index]
                    .clip(id)
                    .cloned()
                    .ok_or_else(|| format!("Clip {id} is not on {name}"))
            })
            .transpose()
        };
        let (before, after) = (on_track(from)?, on_track(to)?);
        match (&before, &after) {
            (None, None) => return Err("A transition needs a clip".into()),
            (Some(a), Some(b)) if a.end() != b.start => {
                return Err(format!("Clips {} and {} do not touch", a.id, b.id))
            }
            _ => {}
        }
        for clip in before.iter().chain(&after) {
            if clip.is_adjustment() {
                return Err("Adjustment layers fade with their opacity, not transitions".into());
            }
            if !clip.video {
                return Err(format!("Clip {} has no picture to transition", clip.id));
            }
        }
        let duration = self.snap(spec.duration)?;
        if duration < self.frame {
            return Err("A transition lasts at least one frame".into());
        }
        let alignment = match (from, to) {
            (Some(_), Some(_)) => spec.alignment.unwrap_or_default(),
            (None, _) => Alignment::Start,
            (_, None) => Alignment::End,
        };
        let transition = Transition {
            id: TransitionId(self.alloc()),
            kind: spec.kind.clone(),
            pack: spec.pack.clone(),
            version: spec.version,
            from,
            to,
            duration,
            alignment,
            params: spec.params.clone(),
        };
        transition.check()?;
        self.created.push(transition.id.0);
        self.required = Some(transition.id);
        // A transition already on either edge is replaced.
        let transitions = &mut self.track_mut(index).transitions;
        transitions.retain(|t| !(from.is_some() && t.from == from || to.is_some() && t.to == to));
        transitions.push(transition);
        Ok(())
    }

    fn set_properties(&mut self, id: ClipId, properties: &ClipProperties) -> Result<(), String> {
        let (index, mut clip) = self.find(id)?;
        self.unlocked(index)?;
        apply_properties(&mut clip, properties)?;
        *self.clip_mut(index, id) = clip;
        Ok(())
    }

    /// Closes the gaps on the magnetic main track, keeping its clips in the order
    /// the edit left them, and moves the clips linked to them by as much. Then runs
    /// the overlap checks that waited for it.
    fn settle(&mut self) -> Result<(), String> {
        if let Some(main) = self.main_index() {
            let mut end = Flicks::ZERO;
            let shifts: Vec<(Option<LinkId>, Flicks)> = self.project.tracks[main]
                .clips
                .iter()
                .map(|clip| {
                    let shift = end - clip.start;
                    end += clip.duration;
                    (clip.link, shift)
                })
                .collect();
            if shifts.iter().any(|(_, shift)| *shift != Flicks::ZERO) {
                self.unlocked(main)?;
                for (clip, (_, shift)) in self.track_mut(main).clips.iter_mut().zip(&shifts) {
                    clip.start += *shift;
                }
                self.deferred.insert(self.project.main_track);
                // A link follows the first main-track clip it holds.
                let mut by_link: BTreeMap<LinkId, Flicks> = BTreeMap::new();
                for (link, shift) in &shifts {
                    if let Some(link) = link {
                        by_link.entry(*link).or_insert(*shift);
                    }
                }
                by_link.retain(|_, shift| *shift != Flicks::ZERO);
                let follows = |clip: &Clip| clip.link.and_then(|link| by_link.get(&link)).copied();
                for index in (0..self.project.tracks.len()).filter(|&i| i != main) {
                    let moved: Vec<ClipId> = self.project.tracks[index]
                        .clips
                        .iter()
                        .filter(|clip| follows(clip).is_some())
                        .map(|clip| clip.id)
                        .collect();
                    if moved.is_empty() {
                        continue;
                    }
                    self.unlocked(index)?;
                    let track = self.track_mut(index);
                    for clip in track.clips.iter_mut() {
                        if let Some(shift) = follows(clip) {
                            clip.start += shift;
                        }
                    }
                    track.clips.sort_by_key(|c| c.start);
                    let id = track.id;
                    self.deferred.insert(id);
                    for clip in moved {
                        self.check_clip_id(clip)?;
                    }
                }
            }
        }
        for id in std::mem::take(&mut self.deferred) {
            // A track the edit removed has nothing left to check.
            if let Some(index) = self.project.track_index(id) {
                self.track_mut(index).clips.sort_by_key(|c| c.start);
                self.check_overlaps(index)?;
            }
        }
        Ok(())
    }

    /// Keeps every transition where its clips are and within the room they leave.
    ///
    /// A transition goes to the track that holds its clips, and is dropped when
    /// they are gone, apart, or no longer touch. One at a free edge that another
    /// clip now touches becomes a transition between the two. Transitions that no
    /// longer fit get shorter, earlier ones first keeping their length, and are
    /// dropped when not even a frame fits.
    fn normalize_transitions(&mut self) {
        if self.project.tracks.iter().all(|t| t.transitions.is_empty()) {
            return;
        }
        // The settings' frame: a frame rate change has just set it.
        let frame = self.project.settings.frame_duration();
        let mut placed: BTreeMap<usize, Vec<Transition>> = BTreeMap::new();
        for transition in self
            .project
            .tracks
            .iter()
            .flat_map(|t| t.transitions.iter())
        {
            let mut transition = transition.clone();
            let homes: Vec<Option<usize>> = [transition.from, transition.to]
                .into_iter()
                .flatten()
                .map(|id| self.project.clip(id).map(|(index, _)| index))
                .collect();
            let Some(Some(index)) = homes.first().copied() else {
                continue;
            };
            if homes.iter().any(|&home| home != Some(index)) {
                continue;
            }
            let track = &self.project.tracks[index];
            let clip = |id: ClipId| track.clip(id).expect("clip on the track");
            let usable = |c: &Clip| c.video && !c.is_adjustment();
            if [transition.from, transition.to]
                .into_iter()
                .flatten()
                .any(|id| !usable(clip(id)))
            {
                continue;
            }
            match (transition.from, transition.to) {
                (Some(a), Some(b)) => {
                    if clip(a).end() != clip(b).start {
                        continue;
                    }
                }
                (None, Some(b)) => {
                    let start = clip(b).start;
                    if let Some(before) = track.clips.iter().find(|c| c.end() == start) {
                        if !usable(before) {
                            continue;
                        }
                        transition.from = Some(before.id);
                    }
                }
                (Some(a), None) => {
                    let end = clip(a).end();
                    if let Some(after) = track.clips.iter().find(|c| c.start == end) {
                        if !usable(after) {
                            continue;
                        }
                        transition.to = Some(after.id);
                    }
                }
                (None, None) => continue,
            }
            placed.entry(index).or_default().push(transition);
        }
        for index in 0..self.project.tracks.len() {
            let mut candidates = placed.remove(&index).unwrap_or_default();
            // One transition per edge: the oldest stays.
            candidates.sort_by_key(|t| t.id);
            let mut kept: Vec<Transition> = Vec::new();
            for t in candidates {
                let taken = kept.iter().any(|k| {
                    (t.from.is_some() && k.from == t.from) || (t.to.is_some() && k.to == t.to)
                });
                if !taken {
                    kept.push(t);
                }
            }
            let track = &self.project.tracks[index];
            kept.sort_by_key(|t| (track.cut(t), t.id));
            // How much of each clip's start the transition before it takes.
            let mut taken: BTreeMap<ClipId, Flicks> = BTreeMap::new();
            let mut fitted = Vec::new();
            for mut t in kept {
                let cut = track.cut(&t).expect("placed transitions have a cut");
                let room_before = t.from.map_or(Flicks::ZERO, |a| {
                    let clip = track.clip(a).expect("clip");
                    clip.duration - taken.get(&a).copied().unwrap_or(Flicks::ZERO)
                });
                let room_after =
                    t.to.map_or(Flicks::ZERO, |b| track.clip(b).expect("clip").duration);
                t.duration = fit(&t, room_before, room_after, frame);
                if t.duration < frame {
                    continue;
                }
                if let Some(b) = t.to {
                    taken.insert(b, t.window(cut, frame).1 - cut);
                }
                fitted.push(t);
            }
            if fitted != track.transitions {
                self.track_mut(index).transitions = fitted;
            }
        }
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

/// The longest duration up to `t`'s own that leaves at most `before` of it
/// before the cut and `after` after.
fn fit(t: &Transition, before: Flicks, after: Flicks, frame: Flicks) -> Flicks {
    let (start, end) = t.window(Flicks::ZERO, frame);
    if -start <= before && end <= after {
        return t.duration;
    }
    let (b, a) = (before.0 / frame.0, after.0 / frame.0);
    let frames = match t.alignment {
        Alignment::Start => a,
        Alignment::End => b,
        // A centred transition of n frames puts n / 2 (rounded down) before the cut.
        Alignment::Center => (2 * b + 1).min(2 * a),
    };
    Flicks(frames.min(t.duration.0 / frame.0).max(0) * frame.0)
}

/// `keyframes` with the effect settings renamed from each old effect id to its new one.
fn rename_effects(keyframes: &Keyframes, renamed: &BTreeMap<EffectId, EffectId>) -> Keyframes {
    keyframes
        .iter()
        .map(|(name, keys)| {
            let name = match property_effect(name).and_then(|old| Some((old, renamed.get(&old)?))) {
                Some((old, new)) => {
                    name.replacen(&format!("effects.{old}."), &format!("effects.{new}."), 1)
                }
                None => name.clone(),
            };
            (name, keys.clone())
        })
        .collect()
}

fn effect_position(clip: &Clip, id: EffectId) -> Result<usize, String> {
    clip.effects
        .iter()
        .position(|effect| effect.id == id)
        .ok_or_else(|| format!("Clip {} has no effect {id}", clip.id))
}

/// Keyframes count from the clip's start: when the start moves over the same
/// content, they move by `delta` to stay with it.
fn shift_keys(clip: &mut Clip, delta: Flicks) {
    if delta == Flicks::ZERO {
        return;
    }
    for keys in clip.keyframes.values_mut() {
        for key in keys.iter_mut() {
            key.time += delta;
        }
    }
}

/// Gives `property` the value its keyframes have at `at`, as its static value.
fn freeze(clip: &mut Clip, property: &str, at: Flicks) -> Result<(), String> {
    let (which, param) =
        Property::parse(property).ok_or_else(|| format!("{property} is not a clip property"))?;
    let transform = clip.transform_at(at);
    let crop = clip.crop_at(at);
    match which {
        Property::X => clip.transform.x = transform.x,
        Property::Y => clip.transform.y = transform.y,
        Property::ScaleX => clip.transform.scale_x = transform.scale_x,
        Property::ScaleY => clip.transform.scale_y = transform.scale_y,
        Property::Rotation => clip.transform.rotation = transform.rotation,
        Property::AnchorX => clip.transform.anchor_x = transform.anchor_x,
        Property::AnchorY => clip.transform.anchor_y = transform.anchor_y,
        Property::Opacity => clip.opacity = clip.opacity_at(at),
        Property::CropLeft => clip.crop.left = crop.left,
        Property::CropTop => clip.crop.top = crop.top,
        Property::CropRight => clip.crop.right = crop.right,
        Property::CropBottom => clip.crop.bottom = crop.bottom,
        Property::VolumeDb => clip.volume_db = clip.volume_db_at(at),
        Property::Effect(id) => {
            let value = clip
                .keyframes
                .get(property)
                .and_then(|keys| value_at(keys, at));
            if let (Some(value), Some(param)) = (value, param) {
                let position = effect_position(clip, id)?;
                clip.effects[position]
                    .params
                    .insert(param.to_string(), value.param());
            }
        }
    }
    check_crop(&clip.crop)
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

/// Checks and applies clip property changes.
fn apply_properties(clip: &mut Clip, properties: &ClipProperties) -> Result<(), String> {
    let transform = properties
        .transform
        .map(|patch| patch.apply(clip.transform));
    let crop = properties.crop.map(|patch| patch.apply(clip.crop));
    if let Some(transform) = &transform {
        check_transform(transform)?;
    }
    if let Some(crop) = &crop {
        check_crop(crop)?;
    }
    if let Some(opacity) = properties.opacity {
        check_opacity(opacity)?;
    }
    if let Some(volume) = properties.volume_db {
        check_volume(volume)?;
    }
    if let Some(transform) = transform {
        clip.transform = transform;
    }
    if let Some(crop) = crop {
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

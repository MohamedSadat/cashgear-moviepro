//! An open project with its undo and redo history.
use std::collections::VecDeque;

use serde::Serialize;

use crate::command::{Command, Outcome};
use crate::project::{MediaRef, Project};

/// Undo steps kept before the oldest is dropped.
pub const HISTORY_LIMIT: usize = 10_000;

struct Step {
    label: String,
    before: Project,
    before_generation: u64,
    after: Project,
    after_generation: u64,
}

struct Group {
    label: String,
    depth: u32,
    before: Project,
    before_generation: u64,
}

/// The open project, its undo and redo stacks, and whether it has unsaved changes.
///
/// Every successful command is one undo step, unless it runs inside a group
/// ([`Session::begin_group`]), which makes the whole group one step: one drag,
/// or one action across many clips. Undo snapshots share unchanged tracks.
pub struct Session {
    state: Project,
    /// Identifies the current state: each new state gets a fresh one, and undo and
    /// redo bring back the one a state had, so returning to the saved state is clean.
    generation: u64,
    next_generation: u64,
    undo: VecDeque<Step>,
    redo: Vec<Step>,
    group: Option<Group>,
    saved: Option<u64>,
    autosaved: Option<u64>,
}

/// What the UI renders: the project plus the history and save state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot<'a> {
    pub project: &'a Project,
    pub generation: u64,
    pub dirty: bool,
    pub needs_autosave: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_label: Option<&'a str>,
    pub redo_label: Option<&'a str>,
    pub grouping: bool,
}

impl Session {
    /// A session for a project that matches its saved file (or a new, empty one).
    pub fn new(project: Project) -> Session {
        Session {
            state: project,
            generation: 0,
            next_generation: 1,
            undo: VecDeque::new(),
            redo: Vec::new(),
            group: None,
            saved: Some(0),
            autosaved: Some(0),
        }
    }

    /// A session for a project recovered from an autosave: it has unsaved changes.
    pub fn recovered(project: Project) -> Session {
        Session {
            saved: None,
            ..Session::new(project)
        }
    }

    pub fn project(&self) -> &Project {
        &self.state
    }

    pub fn snapshot(&self) -> Snapshot<'_> {
        Snapshot {
            project: &self.state,
            generation: self.generation,
            dirty: self.is_dirty(),
            needs_autosave: self.needs_autosave(),
            can_undo: self.can_undo(),
            can_redo: self.can_redo(),
            undo_label: self.undo_label(),
            redo_label: self.redo.last().map(|step| step.label.as_str()),
            grouping: self.group.is_some(),
        }
    }

    /// Applies `command`. A command that changes nothing leaves no undo step.
    pub fn execute(&mut self, command: &Command) -> Result<Outcome, String> {
        let (next, outcome) = self.state.apply(command)?;
        if next == self.state {
            return Ok(outcome);
        }
        let generation = self.fresh_generation();
        let before = std::mem::replace(&mut self.state, next);
        let before_generation = std::mem::replace(&mut self.generation, generation);
        if self.group.is_none() {
            self.push(Step {
                label: command.label().to_string(),
                before,
                before_generation,
                after: self.state.clone(),
                after_generation: generation,
            });
        }
        Ok(outcome)
    }

    /// Starts a group: the commands until the matching [`Session::end_group`] undo as one step.
    pub fn begin_group(&mut self, label: &str) {
        match &mut self.group {
            Some(group) => group.depth += 1,
            None => {
                self.group = Some(Group {
                    label: label.to_string(),
                    depth: 1,
                    before: self.state.clone(),
                    before_generation: self.generation,
                })
            }
        }
    }

    pub fn end_group(&mut self) {
        let Some(group) = &mut self.group else {
            return;
        };
        group.depth -= 1;
        if group.depth > 0 {
            return;
        }
        let group = self.group.take().expect("group");
        if self.state == group.before {
            // Net no change: the state is the one from before the group.
            self.generation = group.before_generation;
            return;
        }
        self.push(Step {
            label: group.label,
            before: group.before,
            before_generation: group.before_generation,
            after: self.state.clone(),
            after_generation: self.generation,
        });
    }

    /// Ends the open group and reverts everything it did (a cancelled drag).
    pub fn cancel_group(&mut self) {
        if let Some(group) = self.group.take() {
            self.state = group.before;
            self.generation = group.before_generation;
        }
    }

    /// Undoes the last step, closing an open group first. False when there is nothing to undo.
    pub fn undo(&mut self) -> bool {
        self.end_open_group();
        let Some(step) = self.undo.pop_back() else {
            return false;
        };
        self.state = step.before.clone();
        self.generation = step.before_generation;
        self.redo.push(step);
        true
    }

    pub fn redo(&mut self) -> bool {
        self.end_open_group();
        let Some(step) = self.redo.pop() else {
            return false;
        };
        self.state = step.after.clone();
        self.generation = step.after_generation;
        self.undo.push_back(step);
        true
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty() || self.group.as_ref().is_some_and(|g| g.before != self.state)
    }

    pub fn can_redo(&self) -> bool {
        self.group.is_none() && !self.redo.is_empty()
    }

    pub fn undo_label(&self) -> Option<&str> {
        match &self.group {
            Some(group) if group.before != self.state => Some(&group.label),
            _ => self.undo.back().map(|step| step.label.as_str()),
        }
    }

    /// Number of undo and redo steps.
    pub fn history_len(&self) -> (usize, usize) {
        (self.undo.len(), self.redo.len())
    }

    /// True when the project differs from its saved file.
    pub fn is_dirty(&self) -> bool {
        self.saved != Some(self.generation)
    }

    /// True when there are unsaved changes the autosave has not written yet.
    pub fn needs_autosave(&self) -> bool {
        self.is_dirty() && self.autosaved != Some(self.generation)
    }

    pub fn mark_saved(&mut self) {
        self.saved = Some(self.generation);
        self.autosaved = Some(self.generation);
    }

    pub fn mark_autosaved(&mut self) {
        self.autosaved = Some(self.generation);
    }

    /// Records where a media file is now (relinking, or a file that changed on disk).
    /// The new location applies to every undo step too, so undo never brings back a
    /// missing path. It is not an undo step itself, but it leaves unsaved changes.
    pub fn update_media(&mut self, media: MediaRef) -> Result<(), String> {
        media.validate()?;
        if self.state.media(&media.id).is_none() {
            return Err(format!("No media {} in the project", media.id));
        }
        let replace = |project: &mut Project| {
            if let Some(entry) = project.media.iter_mut().find(|m| m.id == media.id) {
                *entry = media.clone();
            }
        };
        replace(&mut self.state);
        if let Some(group) = &mut self.group {
            replace(&mut group.before);
        }
        for step in self.undo.iter_mut().chain(self.redo.iter_mut()) {
            replace(&mut step.before);
            replace(&mut step.after);
        }
        self.saved = None;
        self.autosaved = None;
        Ok(())
    }

    fn end_open_group(&mut self) {
        if let Some(group) = &mut self.group {
            group.depth = 1;
            self.end_group();
        }
    }

    fn fresh_generation(&mut self) -> u64 {
        let generation = self.next_generation;
        self.next_generation += 1;
        generation
    }

    fn push(&mut self, step: Step) {
        self.redo.clear();
        self.undo.push_back(step);
        if self.undo.len() > HISTORY_LIMIT {
            self.undo.pop_front();
        }
    }
}

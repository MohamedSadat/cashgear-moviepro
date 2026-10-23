//! Project and timeline model, edit commands and undo/redo. Pure Rust, no I/O.
//!
//! A [`Project`] holds settings, a media bin, free tracks (any clip on any track,
//! bottom track drawn first) and markers. Every change is a [`Command`]: it either
//! applies completely or fails and changes nothing. A [`Session`] keeps the undo
//! and redo history, and [`file`] reads and writes the versioned `.cgvproj` format.
mod command;
mod edit;
pub mod file;
mod project;
pub mod query;
mod session;
mod validate;

pub use command::{ClipProperties, ClipSpec, Command, Edge, Outcome};
pub use edit::SOURCE_SLACK;
pub use project::*;
pub use session::{Session, Snapshot, HISTORY_LIMIT};
pub use validate::{valid_project_id, validate};

//! Project and timeline model, edit commands and undo/redo. Pure Rust, no I/O.
//!
//! A [`Project`] holds settings, a media bin, free tracks (any clip on any track,
//! bottom track drawn first), markers and LUTs. Clips carry effects and keyframes;
//! tracks carry transitions. Every change is a [`Command`]: it either applies
//! completely or fails and changes nothing. A [`Session`] keeps the undo and redo
//! history, and [`file`] reads and writes the versioned `.cgvproj` format.
mod animation;
pub mod base64;
mod command;
mod edit;
mod effects;
pub mod file;
pub mod lut;
mod project;
pub mod query;
mod session;
mod validate;

pub use animation::{
    effect_property, property_effect, value_at, Interpolation, KeyValue, Keyframe, Keyframes,
    Property,
};
pub use command::{ClipProperties, ClipSpec, Command, CropPatch, Edge, Outcome, TransformPatch};
pub use edit::SOURCE_SLACK;
pub use effects::{
    lut_ref, parse_lut_ref, Alignment, Color, Effect, EffectSpec, Lut, LutInfo, LutShape, LutSpec,
    ParamValue, Params, Transition, TransitionSpec, BUILTIN_PACK, MAX_EFFECTS, MAX_LUT_1D,
    MAX_LUT_3D,
};
pub use project::*;
pub use session::{Session, Snapshot, HISTORY_LIMIT};
pub use validate::{valid_project_id, validate};

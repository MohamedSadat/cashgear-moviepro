//! Project and timeline model, edit commands and undo/redo. Pure Rust, no I/O.
//!
//! A [`Project`] holds settings, a media bin, free tracks (any clip on any track,
//! bottom track drawn first), markers and LUTs. Clips carry effects and keyframes;
//! tracks carry transitions. Clips play at a speed or along a speed ramp, forwards,
//! backwards or frozen ([`timing`]), and mix with what is below through masks and
//! blend modes ([`masks`]). Every change is a [`Command`]: it either applies
//! completely or fails and changes nothing. A [`Session`] keeps the undo and redo
//! history, and [`file`] reads and writes the versioned `.cgvproj` format.
mod animation;
pub mod base64;
mod command;
mod edit;
mod effects;
pub mod file;
pub mod lut;
pub mod masks;
mod project;
pub mod query;
mod session;
pub mod timing;
pub mod title;
mod validate;

pub use animation::{
    effect_property, property_effect, property_element, property_mask, value_at, Interpolation,
    KeyValue, Keyframe, Keyframes, Property,
};
pub use command::{
    ClipProperties, ClipSpec, Command, CropPatch, Edge, Outcome, TrackSound, TransformPatch,
};
pub use edit::SOURCE_SLACK;
pub use effects::{
    lut_ref, parse_lut_ref, Alignment, Color, Effect, EffectSpec, Lut, LutInfo, LutShape, LutSpec,
    ParamValue, Params, Transition, TransitionSpec, BUILTIN_PACK, MAX_EFFECTS, MAX_LUT_1D,
    MAX_LUT_3D,
};
pub use masks::{mask_property, BlendMode, Mask, MaskMode, MaskPoint, MaskShape};
pub use project::*;
pub use session::{Session, Snapshot, HISTORY_LIMIT};
pub use timing::{RampPoint, RampShape};
pub use title::{element_property, Content, Element, Font, Title};
pub use validate::{valid_project_id, validate};

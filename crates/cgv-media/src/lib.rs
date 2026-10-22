//! The media library model: what was imported, what it contains and whether
//! the engine can decode it. Pure Rust with no I/O. The engine worker probes
//! files (demuxing and decoding live there, next to WebCodecs) and hands the
//! measurements to [`MediaLibrary::add`], which normalizes them.
mod codec;
mod library;
mod model;

pub use codec::{audio_codec_label, channel_label, image_codec_label, video_codec_label};
pub use library::{MediaLibrary, Platform};
pub use model::*;

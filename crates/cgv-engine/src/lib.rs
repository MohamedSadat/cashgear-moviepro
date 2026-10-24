//! Playback and the frame path. `plan` is the pure half of `renderFrame(t)`:
//! what a frame shows and which clips sound. `transport`, `quality` and `stats`
//! hold the playback rules the engine worker drives, with the audio clock as
//! master. In the browser, `Engine` turns plans into composed frames.
mod clock;
pub mod plan;
pub mod quality;
pub mod stats;
pub mod transport;
pub use clock::PatternClock;

#[cfg(target_arch = "wasm32")]
mod engine;
#[cfg(target_arch = "wasm32")]
pub use engine::Engine;

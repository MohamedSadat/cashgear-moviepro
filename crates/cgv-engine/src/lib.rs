//! Playback clock and scheduler. Phase 0 animates the test pattern; Phase 3
//! replaces the pattern clock with the audio-mastered playback clock.
mod clock;
pub use clock::PatternClock;

#[cfg(target_arch = "wasm32")]
mod engine;
#[cfg(target_arch = "wasm32")]
pub use engine::Engine;

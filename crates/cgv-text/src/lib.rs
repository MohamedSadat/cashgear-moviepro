//! The text engine: fonts, shaping, bidirectional layout and line breaking, and
//! drawing titles (text and shapes) at the size they are shown. Pure Rust, so the
//! same pixels come out on every GPU; the renderer uploads them.
pub mod fonts;
pub mod layout;
pub mod paint;

pub use fonts::{FaceInfo, Fonts};
pub use layout::{layout, Rect, TextLayout};
pub use paint::{Painter, View};

#[cfg(test)]
mod tests;

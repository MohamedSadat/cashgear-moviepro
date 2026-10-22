//! CPU-side description of the test pattern drawn by `pattern.wgsl`.
//! Browser tests sample these colors, so every channel is 0 or 255: the values
//! survive both sRGB and unorm surfaces unchanged.

/// Fraction of the frame height covered by the color bars.
pub const BARS_HEIGHT: f32 = 0.7;
/// Seconds the sweep band takes to cross the frame once.
pub const SWEEP_PERIOD: f32 = 2.0;
/// Sweep band width as a fraction of the frame width.
pub const SWEEP_WIDTH: f32 = 1.0 / 16.0;
/// Left to right: white, yellow, cyan, green, magenta, red, blue, black.
pub const BAR_COLORS: [[u8; 3]; 8] = [
    [255, 255, 255],
    [255, 255, 0],
    [0, 255, 255],
    [0, 255, 0],
    [255, 0, 255],
    [255, 0, 0],
    [0, 0, 255],
    [0, 0, 0],
];

/// Horizontal center of the sweep band, from 0 (left) to 1 (right).
pub fn sweep_center(seconds: f32) -> f32 {
    (seconds / SWEEP_PERIOD).rem_euclid(1.0)
}

/// Uniform block shared with `pattern.wgsl` (16 bytes, std140 compatible).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PatternUniforms {
    pub width: f32,
    pub height: f32,
    pub seconds: f32,
}

impl PatternUniforms {
    pub fn to_bytes(self) -> [u8; 16] {
        let mut bytes = [0; 16];
        for (slot, value) in [self.width, self.height, self.seconds, 0.0]
            .into_iter()
            .enumerate()
        {
            bytes[slot * 4..slot * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweep_wraps_every_period() {
        assert_eq!(sweep_center(0.0), 0.0);
        assert_eq!(sweep_center(1.0), 0.5);
        assert_eq!(sweep_center(SWEEP_PERIOD + 0.5), 0.25);
        assert!(sweep_center(-0.5) >= 0.0);
    }

    #[test]
    fn uniforms_match_the_shader_layout() {
        let bytes = PatternUniforms {
            width: 1920.0,
            height: 1080.0,
            seconds: 1.5,
        }
        .to_bytes();
        assert_eq!(&bytes[0..4], &1920.0f32.to_le_bytes());
        assert_eq!(&bytes[4..8], &1080.0f32.to_le_bytes());
        assert_eq!(&bytes[8..12], &1.5f32.to_le_bytes());
        assert_eq!(&bytes[12..16], &[0; 4]);
    }

    #[test]
    fn shader_constants_match_the_cpu_description() {
        let shader = include_str!("pattern.wgsl");
        assert!(shader.contains("const BARS_HEIGHT: f32 = 0.7;"));
        assert!(shader.contains("const SWEEP_PERIOD: f32 = 2.0;"));
        assert!(shader.contains("const SWEEP_WIDTH: f32 = 0.0625;"));
    }
}

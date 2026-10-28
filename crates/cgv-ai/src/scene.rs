//! Scene detection by frame differences, as PySceneDetect's adaptive detector
//! does it: each frame is scored by how much its hue, saturation and value
//! changed from the frame before, and a cut is a score that stands out from
//! the scores around it. Camera moves raise every score together, so they are
//! not cuts; a cut raises one. A single different frame (a flash) is not a cut
//! either: the frame after it matches the frame before.

/// How a cut must stand out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SceneSettings {
    /// A cut's score is at least this many times the mean of the two frames
    /// either side of it.
    pub ratio: f32,
    /// ...and at least this much (0 to 255) on its own.
    pub min_score: f32,
    /// Scenes last at least this many seconds.
    pub min_length: f64,
}

impl Default for SceneSettings {
    fn default() -> Self {
        SceneSettings {
            ratio: 3.0,
            min_score: 15.0,
            min_length: 0.5,
        }
    }
}

/// Frames either side a score is compared with.
const WINDOW: usize = 2;

/// Scores small RGBA frames, one after another.
pub struct SceneScores {
    previous: Option<Vec<[f32; 3]>>,
    before_previous: Option<Vec<[f32; 3]>>,
    scores: Vec<f32>,
    /// Each frame's change from the frame two before it.
    skips: Vec<f32>,
}

impl Default for SceneScores {
    fn default() -> Self {
        Self::new()
    }
}

impl SceneScores {
    pub fn new() -> SceneScores {
        SceneScores {
            previous: None,
            before_previous: None,
            scores: Vec::new(),
            skips: Vec::new(),
        }
    }

    /// Adds the next frame (RGBA bytes, any size but always the same) and
    /// returns its score: the mean change of hue, saturation and value, each
    /// on a 0 to 255 scale. The first frame scores 0.
    pub fn push(&mut self, rgba: &[u8]) -> f32 {
        let pixels: Vec<[f32; 3]> = rgba.as_chunks::<4>().0.iter().map(hsv).collect();
        let score = change(&pixels, self.previous.as_deref());
        self.skips
            .push(change(&pixels, self.before_previous.as_deref()));
        self.before_previous = self.previous.replace(pixels);
        self.scores.push(score);
        score
    }

    pub fn scores(&self) -> &[f32] {
        &self.scores
    }

    pub fn skips(&self) -> &[f32] {
        &self.skips
    }
}

/// The mean change of hue, saturation and value from `before` to `now`; 0
/// without a frame before.
fn change(now: &[[f32; 3]], before: Option<&[[f32; 3]]>) -> f32 {
    let Some(before) = before.filter(|b| b.len() == now.len() && !now.is_empty()) else {
        return 0.0;
    };
    let mut sums = [0.0f64; 3];
    for (a, b) in now.iter().zip(before) {
        let hue = (a[0] - b[0]).abs();
        sums[0] += hue.min(255.0 - hue) as f64;
        sums[1] += (a[1] - b[1]).abs() as f64;
        sums[2] += (a[2] - b[2]).abs() as f64;
    }
    (sums.iter().sum::<f64>() / (3 * now.len()) as f64) as f32
}

/// Hue, saturation and value of an RGBA pixel, each from 0 to 255.
fn hsv(pixel: &[u8; 4]) -> [f32; 3] {
    let [r, g, b] = [pixel[0], pixel[1], pixel[2]].map(|c| c as f32);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let hue = if delta == 0.0 {
        0.0
    } else if max == r {
        ((g - b) / delta).rem_euclid(6.0)
    } else if max == g {
        (b - r) / delta + 2.0
    } else {
        (r - g) / delta + 4.0
    };
    let saturation = if max == 0.0 { 0.0 } else { delta / max };
    [hue / 6.0 * 255.0, saturation * 255.0, max]
}

/// The frames that start new scenes: indices into `scores` (with `skips` from
/// the same [`SceneScores`]), whose frames show at `times` (seconds, in order).
/// The first frame never counts.
pub fn cuts(scores: &[f32], skips: &[f32], times: &[f64], settings: &SceneSettings) -> Vec<usize> {
    let mut found: Vec<usize> = Vec::new();
    let mut scene_start = times.first().copied().unwrap_or(0.0);
    for i in 1..scores.len().min(times.len()) {
        let score = scores[i];
        if score < settings.min_score {
            continue;
        }
        let neighbours: Vec<f32> = (i.saturating_sub(WINDOW)..=(i + WINDOW).min(scores.len() - 1))
            .filter(|&j| j != i && j > 0)
            .map(|j| scores[j])
            .collect();
        let mean = if neighbours.is_empty() {
            0.0
        } else {
            neighbours.iter().sum::<f32>() / neighbours.len() as f32
        };
        // A lone change over still frames stands out however small the mean is.
        let stands_out = score >= settings.ratio * mean.max(1e-3);
        // A lone frame between two that match: into a flash, or back out of one.
        let flash = skips
            .get(i + 1)
            .is_some_and(|&skip| skip < settings.min_score)
            || (i >= 2 && skips.get(i).is_some_and(|&skip| skip < settings.min_score));
        if stands_out && !flash && times[i] - scene_start >= settings.min_length {
            found.push(i);
            scene_start = times[i];
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 48;
    const H: usize = 27;

    /// A frame of a scene: a coloured gradient, its pattern shifted by `shift` pixels.
    fn frame(scene: u8, shift: usize) -> Vec<u8> {
        let mut rgba = Vec::with_capacity(W * H * 4);
        for y in 0..H {
            for x in 0..W {
                let wave = (((x + shift) * 255 / W) as u8).wrapping_add((y * 3) as u8);
                let [r, g, b] = match scene % 4 {
                    0 => [wave, 90, 40],
                    1 => [30, wave / 2 + 60, 200],
                    2 => [220, 210, wave],
                    _ => [wave / 3, wave / 3, wave / 3],
                };
                rgba.extend([r, g, b, 255]);
            }
        }
        rgba
    }

    fn run(frames: &[Vec<u8>], fps: f64) -> Vec<usize> {
        let mut scores = SceneScores::new();
        for f in frames {
            scores.push(f);
        }
        let times: Vec<f64> = (0..frames.len()).map(|i| i as f64 / fps).collect();
        cuts(
            scores.scores(),
            scores.skips(),
            &times,
            &SceneSettings::default(),
        )
    }

    #[test]
    fn hard_cuts_are_found_on_their_first_frame() {
        let mut frames = Vec::new();
        for (scene, length) in [(0, 40), (1, 25), (2, 60), (3, 31)] {
            for i in 0..length {
                frames.push(frame(scene, i / 3));
            }
        }
        assert_eq!(run(&frames, 30.0), [40, 65, 125]);
    }

    #[test]
    fn pans_and_flashes_are_not_cuts_and_scenes_have_a_least_length() {
        // A fast pan: the pattern moves 4 pixels a frame.
        let pan: Vec<Vec<u8>> = (0..60).map(|i| frame(0, i * 4)).collect();
        assert!(run(&pan, 30.0).is_empty());
        // One white frame in the middle of a scene.
        let mut flash: Vec<Vec<u8>> = (0..60).map(|i| frame(1, i / 4)).collect();
        flash[30] = vec![255; W * H * 4];
        assert!(run(&flash, 30.0).is_empty());
        // Two cuts 6 frames apart: the second would make a scene too short.
        let mut quick: Vec<Vec<u8>> = (0..30).map(|_| frame(0, 0)).collect();
        quick.extend((0..6).map(|_| frame(1, 0)));
        quick.extend((0..30).map(|_| frame(2, 0)));
        assert_eq!(run(&quick, 30.0), [30]);
    }

    #[test]
    fn hue_wraps_around() {
        // Red with a touch of blue and red with a touch of green are neighbours.
        let a = hsv(&[255, 0, 10, 255]);
        let b = hsv(&[255, 10, 0, 255]);
        let mut scores = SceneScores::new();
        scores.push(&[255, 0, 10, 255]);
        assert!(scores.push(&[255, 10, 0, 255]) < 5.0, "{a:?} {b:?}");
    }
}

//! Silence detection: the level of a recording every 10 ms, and the stretches
//! quiet and long enough to cut out as jump cuts.

/// Level readings per second.
pub const HOPS_PER_SECOND: u32 = 100;
/// The level a hop of digital silence reads.
pub const FLOOR_DB: f32 = -120.0;

/// Measures sound level every 10 ms: the RMS of each hop over every channel, in
/// dBFS. Fed in blocks of any size, it reads the same as one long block.
pub struct Levels {
    hop: usize,
    sum: f64,
    filled: usize,
    channels: usize,
    levels: Vec<f32>,
}

impl Levels {
    pub fn new(rate: u32) -> Levels {
        Levels {
            hop: (rate / HOPS_PER_SECOND).max(1) as usize,
            sum: 0.0,
            filled: 0,
            channels: 1,
            levels: Vec::new(),
        }
    }

    /// Adds planar sound: one slice per channel, all the same length.
    pub fn push(&mut self, planes: &[&[f32]]) {
        let Some(first) = planes.first() else { return };
        self.channels = planes.len();
        for i in 0..first.len() {
            for plane in planes {
                let x = plane[i] as f64;
                self.sum += x * x;
            }
            self.filled += 1;
            if self.filled == self.hop {
                self.emit();
            }
        }
    }

    /// The readings, with a last partial hop.
    pub fn finish(mut self) -> Vec<f32> {
        if self.filled > 0 {
            self.emit();
        }
        self.levels
    }

    fn emit(&mut self) {
        let mean = self.sum / (self.filled * self.channels) as f64;
        let db = if mean > 0.0 {
            (10.0 * mean.log10()) as f32
        } else {
            FLOOR_DB
        };
        self.levels.push(db.max(FLOOR_DB));
        self.sum = 0.0;
        self.filled = 0;
    }
}

/// What counts as a silence worth cutting.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SilenceSettings {
    /// Hops below this level (dBFS) are quiet. None picks it from the recording
    /// ([`auto_threshold`]).
    pub threshold_db: Option<f32>,
    /// Seconds a quiet stretch must last.
    pub min_length: f64,
    /// Seconds of quiet kept next to the sound on each side, so words keep their
    /// breath.
    pub padding: f64,
}

impl Default for SilenceSettings {
    fn default() -> Self {
        SilenceSettings {
            threshold_db: None,
            min_length: 0.5,
            padding: 0.15,
        }
    }
}

/// Bursts this short (clicks, a tap on the microphone) do not break a silence.
const BLIP_HOPS: usize = 3;
/// The automatic threshold sits this far above the recording's noise floor...
const ABOVE_FLOOR_DB: f32 = 12.0;
/// ...within these bounds.
const AUTO_RANGE_DB: (f32, f32) = (-60.0, -30.0);

/// A threshold from the recording itself: 12 dB above its noise floor (the
/// level that a tenth of its hops stay under), from −60 to −30 dBFS.
pub fn auto_threshold(levels: &[f32]) -> f32 {
    let mut heard: Vec<f32> = levels.iter().copied().filter(|&l| l > FLOOR_DB).collect();
    if heard.is_empty() {
        return AUTO_RANGE_DB.0;
    }
    heard.sort_by(f32::total_cmp);
    let floor = heard[heard.len() / 10];
    (floor + ABOVE_FLOOR_DB).clamp(AUTO_RANGE_DB.0, AUTO_RANGE_DB.1)
}

/// The quiet stretches of a recording (from [`Levels`]) as `(start, end)` seconds,
/// in order. Each is at least `min_length` long before `padding` is kept back
/// from the sound on either side; stretches at the very start or end keep their
/// padding only towards the sound.
pub fn silences(levels: &[f32], settings: &SilenceSettings) -> Vec<(f64, f64)> {
    let threshold = settings
        .threshold_db
        .unwrap_or_else(|| auto_threshold(levels));
    let mut quiet: Vec<bool> = levels.iter().map(|&l| l < threshold).collect();
    // Short bursts inside quiet stretches count as quiet.
    let mut i = 0;
    while i < quiet.len() {
        if quiet[i] {
            i += 1;
            continue;
        }
        let start = i;
        while i < quiet.len() && !quiet[i] {
            i += 1;
        }
        let inside = start > 0 && i < quiet.len();
        if inside && i - start <= BLIP_HOPS {
            quiet[start..i].fill(true);
        }
    }
    let hop = 1.0 / HOPS_PER_SECOND as f64;
    let total = levels.len() as f64 * hop;
    let mut found = Vec::new();
    let mut i = 0;
    while i < quiet.len() {
        if !quiet[i] {
            i += 1;
            continue;
        }
        let start = i;
        while i < quiet.len() && quiet[i] {
            i += 1;
        }
        let (from, to) = (start as f64 * hop, i as f64 * hop);
        if to - from < settings.min_length {
            continue;
        }
        let from = if start == 0 {
            0.0
        } else {
            from + settings.padding
        };
        let to = if i == quiet.len() {
            total
        } else {
            to - settings.padding
        };
        if to > from {
            found.push((from, to));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_signal::{noise, sine};

    const RATE: u32 = 48_000;

    /// Tone bursts at `level` dBFS between `spans` (seconds), over noise at `floor` dBFS.
    fn speech(spans: &[(f64, f64)], seconds: f64, floor: f64) -> Vec<f32> {
        let frames = (seconds * RATE as f64) as usize;
        let hiss = noise(7, frames);
        let tone = sine(RATE, 330.0, 0.3, frames);
        let floor = 10f64.powf(floor / 20.0) as f32 * 1.7;
        (0..frames)
            .map(|i| {
                let t = i as f64 / RATE as f64;
                let on = spans.iter().any(|&(a, b)| t >= a && t < b);
                hiss[i] * floor + if on { tone[i] } else { 0.0 }
            })
            .collect()
    }

    fn levels_of(samples: &[f32], block: usize) -> Vec<f32> {
        let mut levels = Levels::new(RATE);
        for chunk in samples.chunks(block) {
            levels.push(&[chunk]);
        }
        levels.finish()
    }

    #[test]
    fn levels_read_rms_per_hop_in_any_blocks() {
        let tone = sine(RATE, 1000.0, 0.5, RATE as usize);
        let whole = levels_of(&tone, tone.len());
        assert_eq!(whole.len(), 100);
        // A sine's RMS is its peak over √2: 0.5 reads −9.03 dBFS.
        for level in &whole {
            assert!((level - -9.03).abs() < 0.05, "{level}");
        }
        assert_eq!(levels_of(&tone, 333), whole);
        let mut stereo = Levels::new(RATE);
        stereo.push(&[&tone, &vec![0.0; tone.len()]]);
        // Half the power of the same tone in both channels.
        assert!((stereo.finish()[0] - -12.04).abs() < 0.05);
        assert_eq!(levels_of(&[0.0; 960], 960), [FLOOR_DB; 2]);
    }

    #[test]
    fn silences_between_words_are_found_with_padding() {
        let spans = [(0.7, 1.6), (1.8, 2.5), (3.4, 4.0), (5.2, 6.0)];
        let samples = speech(&spans, 7.0, -55.0);
        let levels = levels_of(&samples, 4096);
        let threshold = auto_threshold(&levels);
        assert!((-45.0..=-40.0).contains(&threshold), "{threshold}");
        let found = silences(&levels, &SilenceSettings::default());
        // The 0.2 s pause between words stays; the leading 0.7 s goes.
        let expected = [(0.0, 0.55), (2.65, 3.25), (4.15, 5.05), (6.15, 7.0)];
        assert_eq!(found.len(), expected.len(), "{found:?}");
        for ((a, b), (x, y)) in found.iter().zip(expected) {
            assert!((a - x).abs() < 0.011 && (b - y).abs() < 0.011, "{found:?}");
        }
    }

    #[test]
    fn clicks_do_not_break_a_silence_and_settings_apply() {
        let mut samples = speech(&[(0.0, 1.0), (3.0, 4.0)], 4.0, -60.0);
        // A 20 ms click in the middle of the gap.
        for x in &mut samples[(2.0 * RATE as f64) as usize..(2.02 * RATE as f64) as usize] {
            *x = 0.5;
        }
        let levels = levels_of(&samples, 1024);
        let settings = SilenceSettings {
            threshold_db: Some(-40.0),
            min_length: 0.5,
            padding: 0.1,
        };
        let found = silences(&levels, &settings);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!((found[0].0 - 1.1).abs() < 0.011 && (found[0].1 - 2.9).abs() < 0.011);
        let long = SilenceSettings {
            min_length: 2.5,
            ..settings
        };
        assert!(silences(&levels, &long).is_empty());
        // Silence only: one stretch, the whole recording.
        let quiet = levels_of(&vec![0.0; RATE as usize * 2], 4096);
        assert_eq!(silences(&quiet, &SilenceSettings::default()), [(0.0, 2.0)]);
    }
}

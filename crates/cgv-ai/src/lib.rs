//! The AI tools' analysis, as a WASM module of its own run in the AI worker.
//! The worker decodes media and runs the models; this module does the arithmetic
//! around them: sound levels and onsets for silences and beats.
//!
//! Every result is in the media's own time (seconds from its first sample), so
//! it can be cached per file and reused by every clip of it.
use cgv_dsp::beat::Onsets;
use cgv_dsp::silence::{Levels, SilenceSettings};

/// One pass over a medium's sound: its level and onset envelopes, both every
/// 10 ms, from which silences and beats are found with any settings.
pub struct SoundAnalysis {
    levels: Levels,
    onsets: Onsets,
}

impl SoundAnalysis {
    pub fn new(rate: u32) -> SoundAnalysis {
        SoundAnalysis {
            levels: Levels::new(rate),
            onsets: Onsets::new(rate),
        }
    }

    /// Adds planar sound: `channels` planes one after another in `data`.
    pub fn push(&mut self, channels: usize, data: &[f32]) {
        let channels = channels.max(1);
        let frames = data.len() / channels;
        let planes: Vec<&[f32]> = data.chunks_exact(frames.max(1)).take(channels).collect();
        if frames > 0 {
            self.levels.push(&planes);
            self.onsets.push(&planes);
        }
    }

    /// The level (dBFS) and onset envelopes, each one reading per 10 ms.
    pub fn finish(self) -> (Vec<f32>, Vec<f32>) {
        (self.levels.finish(), self.onsets.finish())
    }
}

/// Quiet stretches as flat `[start, end, …]` seconds. A threshold that is not
/// finite is picked from the recording.
pub fn silences(levels: &[f32], threshold_db: f32, min_length: f64, padding: f64) -> Vec<f64> {
    let settings = SilenceSettings {
        threshold_db: threshold_db.is_finite().then_some(threshold_db),
        min_length,
        padding,
    };
    cgv_dsp::silence::silences(levels, &settings)
        .into_iter()
        .flat_map(|(a, b)| [a, b])
        .collect()
}

/// The tempo (BPM) and beat times (seconds) of an onset envelope; no beats
/// when it has no steady pulse.
pub fn beats(onsets: &[f32]) -> (Option<f64>, Vec<f64>) {
    match cgv_dsp::beat::tempo(onsets) {
        Some(bpm) => (Some(bpm), cgv_dsp::beat::beats(onsets, bpm)),
        None => (None, Vec::new()),
    }
}

#[cfg(target_arch = "wasm32")]
mod bindings {
    use wasm_bindgen::prelude::*;

    /// See [`crate::SoundAnalysis`]. After `finish`, `levels` and `onsets` hold
    /// the envelopes.
    #[wasm_bindgen]
    pub struct SoundAnalysis {
        running: Option<crate::SoundAnalysis>,
        levels: Vec<f32>,
        onsets: Vec<f32>,
    }

    #[wasm_bindgen]
    impl SoundAnalysis {
        #[wasm_bindgen(constructor)]
        pub fn new(rate: u32) -> SoundAnalysis {
            SoundAnalysis {
                running: Some(crate::SoundAnalysis::new(rate)),
                levels: Vec::new(),
                onsets: Vec::new(),
            }
        }

        pub fn push(&mut self, channels: usize, data: &[f32]) {
            if let Some(analysis) = &mut self.running {
                analysis.push(channels, data);
            }
        }

        pub fn finish(&mut self) {
            if let Some(analysis) = self.running.take() {
                (self.levels, self.onsets) = analysis.finish();
            }
        }

        pub fn levels(&self) -> Vec<f32> {
            self.levels.clone()
        }

        pub fn onsets(&self) -> Vec<f32> {
            self.onsets.clone()
        }
    }

    /// See [`crate::silences`].
    #[wasm_bindgen]
    pub fn silences(levels: &[f32], threshold_db: f32, min_length: f64, padding: f64) -> Vec<f64> {
        crate::silences(levels, threshold_db, min_length, padding)
    }

    /// The tempo first (NaN without a steady pulse), then the beat times.
    #[wasm_bindgen]
    pub fn beats(onsets: &[f32]) -> Vec<f64> {
        let (tempo, beats) = crate::beats(onsets);
        std::iter::once(tempo.unwrap_or(f64::NAN))
            .chain(beats)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_pass_gives_both_envelopes_and_their_results() {
        let rate = 48_000;
        // Two seconds of plucks at 120 BPM, then two of silence, in stereo.
        let frames = rate as usize * 4;
        let mut left = vec![0.0f32; frames];
        for beat in 0..4 {
            let start = (0.25 + 0.5 * beat as f64) * rate as f64;
            for (i, x) in left[start as usize..start as usize + 4800]
                .iter_mut()
                .enumerate()
            {
                *x = (0.5 * (-(i as f64) / 1440.0).exp() * (i as f64 * 0.1).sin()) as f32;
            }
        }
        let right = left.clone();
        let mut analysis = SoundAnalysis::new(rate);
        for start in (0..frames).step_by(4800) {
            let block: Vec<f32> =
                [&left[start..start + 4800], &right[start..start + 4800]].concat();
            analysis.push(2, &block);
        }
        let (levels, onsets) = analysis.finish();
        assert_eq!((levels.len(), onsets.len()), (400, 400));
        // Only the silence after the last burst is long enough.
        let found = silences(&levels, -50.0, 0.5, 0.1);
        assert_eq!(found.len(), 2, "{found:?}");
        assert!((1.9..2.05).contains(&found[0]) && (found[1] - 4.0).abs() < 1e-9);
        let (tempo, times) = beats(&onsets);
        assert!((tempo.unwrap() - 120.0).abs() < 2.0, "{tempo:?}");
        assert_eq!(times.len(), 4, "{times:?}");
        for (beat, time) in times.iter().enumerate() {
            assert!(
                (time - (0.25 + 0.5 * beat as f64)).abs() < 0.015,
                "{times:?}"
            );
        }
    }
}

//! Whisper's input: 30 s windows of 16 kHz mono sound as log-mel spectrograms,
//! exactly as OpenAI's `log_mel_spectrogram` and Hugging Face's feature
//! extractor make them (a 400-point periodic Hann STFT every 160 samples,
//! centred with reflected edges, Slaney mel filters, log10, clamped to 8 below
//! the window's peak, then scaled).
use std::sync::Arc;

use cgv_dsp::stretch::{sinc_at, sinc_reach};
use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};

pub const SAMPLE_RATE: u32 = 16_000;
pub const N_FFT: usize = 400;
pub const HOP: usize = 160;
/// Samples in a window: 30 s.
pub const WINDOW_SAMPLES: usize = 480_000;
/// Spectrogram frames in a window: one per hop.
pub const FRAMES: usize = WINDOW_SAMPLES / HOP;
const BINS: usize = N_FFT / 2 + 1;

/// Mono sound at `rate` resampled to 16 kHz with a windowed sinc (cgv-dsp's,
/// which filters out what 16 kHz cannot hold).
pub fn to_16k(samples: &[f32], rate: u32) -> Vec<f32> {
    if rate == SAMPLE_RATE {
        return samples.to_vec();
    }
    let ratio = rate as f64 / SAMPLE_RATE as f64;
    let count = (samples.len() as f64 / ratio).floor() as usize;
    let get = |i: i64| {
        if i < 0 || i >= samples.len() as i64 {
            0.0
        } else {
            samples[i as usize]
        }
    };
    (0..count)
        .map(|n| sinc_at(get, n as f64 * ratio, ratio))
        .collect()
}

/// [`to_16k`] for sound that arrives in pieces: fed in blocks of any size, it
/// gives the same samples as one long block.
pub struct Resampler {
    ratio: f64,
    reach: i64,
    /// Input samples still needed, the first at index `offset` of the whole.
    input: Vec<f32>,
    offset: i64,
    /// The next output sample's index.
    next: usize,
    pushed: usize,
}

impl Resampler {
    pub fn new(rate: u32) -> Resampler {
        let ratio = rate as f64 / SAMPLE_RATE as f64;
        Resampler {
            ratio,
            reach: sinc_reach(ratio),
            input: Vec::new(),
            offset: 0,
            next: 0,
            pushed: 0,
        }
    }

    /// Adds mono samples and returns the 16 kHz samples they complete.
    pub fn push(&mut self, samples: &[f32]) -> Vec<f32> {
        self.input.extend_from_slice(samples);
        self.pushed += samples.len();
        self.run(false)
    }

    /// The samples still held back for want of what follows.
    pub fn finish(&mut self) -> Vec<f32> {
        self.run(true)
    }

    fn run(&mut self, last: bool) -> Vec<f32> {
        let total = (self.pushed as f64 / self.ratio).floor() as usize;
        let mut out = Vec::new();
        while self.next < total {
            let position = self.next as f64 * self.ratio;
            let needed = position.floor() as i64 + self.reach;
            if !last && needed >= self.pushed as i64 {
                break;
            }
            let (input, offset) = (&self.input, self.offset);
            let get = |i: i64| {
                let j = i - offset;
                if i < 0 || j < 0 || j >= input.len() as i64 {
                    0.0
                } else {
                    input[j as usize]
                }
            };
            out.push(sinc_at(get, position, self.ratio));
            self.next += 1;
        }
        // Keep only what later samples still read.
        let keep_from = (self.next as f64 * self.ratio).floor() as i64 - self.reach;
        let drop = (keep_from - self.offset).clamp(0, self.input.len() as i64) as usize;
        if drop > 1 << 14 || last {
            self.input.drain(..drop);
            self.offset += drop as i64;
        }
        out
    }
}

fn hz_to_mel(hz: f64) -> f64 {
    // Slaney's scale: linear to 1 kHz, logarithmic above.
    let linear = hz / (200.0 / 3.0);
    if hz >= 1000.0 {
        15.0 + (hz / 1000.0).ln() / (6.4f64.ln() / 27.0)
    } else {
        linear
    }
}

fn mel_to_hz(mel: f64) -> f64 {
    if mel >= 15.0 {
        1000.0 * ((6.4f64.ln() / 27.0) * (mel - 15.0)).exp()
    } else {
        mel * (200.0 / 3.0)
    }
}

/// `n_mels` Slaney-normalised triangular filters over the 201 bins of a
/// 400-point FFT at 16 kHz, from 0 to 8 kHz, row after row, as
/// `librosa.filters.mel(sr=16000, n_fft=400, n_mels=n_mels)` makes them.
pub fn mel_filters(n_mels: usize) -> Vec<f32> {
    let (low, high) = (hz_to_mel(0.0), hz_to_mel(SAMPLE_RATE as f64 / 2.0));
    let points: Vec<f64> = (0..n_mels + 2)
        .map(|i| mel_to_hz(low + (high - low) * i as f64 / (n_mels + 1) as f64))
        .collect();
    let frequency = |bin: usize| bin as f64 * SAMPLE_RATE as f64 / N_FFT as f64;
    let mut weights = vec![0.0f32; n_mels * BINS];
    for m in 0..n_mels {
        let (left, centre, right) = (points[m], points[m + 1], points[m + 2]);
        let norm = 2.0 / (right - left);
        for bin in 0..BINS {
            let f = frequency(bin);
            let rising = (f - left) / (centre - left);
            let falling = (right - f) / (right - centre);
            weights[m * BINS + bin] = (rising.min(falling).max(0.0) * norm) as f32;
        }
    }
    weights
}

/// Makes log-mel spectrograms of 30 s windows.
pub struct Features {
    n_mels: usize,
    filters: Vec<f32>,
    window: Vec<f32>,
    fft: Arc<dyn RealToComplex<f32>>,
}

impl Features {
    pub fn new(n_mels: usize) -> Features {
        let window = (0..N_FFT)
            .map(|i| {
                let phase = 2.0 * std::f64::consts::PI * i as f64 / N_FFT as f64;
                (0.5 - 0.5 * phase.cos()) as f32
            })
            .collect();
        Features {
            n_mels,
            filters: mel_filters(n_mels),
            window,
            fft: RealFftPlanner::<f32>::new().plan_fft_forward(N_FFT),
        }
    }

    /// The log-mel spectrogram of up to 30 s of 16 kHz sound, padded with
    /// silence to 30 s: `n_mels` rows of 3000 frames.
    pub fn log_mel(&self, samples: &[f32]) -> Vec<f32> {
        let samples = &samples[..samples.len().min(WINDOW_SAMPLES)];
        let pad = N_FFT / 2;
        // Centred frames: the edges are reflected, past the end is silence.
        let at = |i: isize| -> f32 {
            let n = WINDOW_SAMPLES as isize;
            let j = if i < 0 {
                -i
            } else if i >= n {
                2 * (n - 1) - i
            } else {
                i
            };
            samples.get(j as usize).copied().unwrap_or(0.0)
        };
        let mut input = self.fft.make_input_vec();
        let mut spectrum = self.fft.make_output_vec();
        let mut power = vec![0.0f32; BINS];
        let mut mel = vec![0.0f32; self.n_mels * FRAMES];
        for frame in 0..FRAMES {
            let start = (frame * HOP) as isize - pad as isize;
            for (k, x) in input.iter_mut().enumerate() {
                *x = at(start + k as isize) * self.window[k];
            }
            self.fft
                .process(&mut input, &mut spectrum)
                .expect("buffer sizes match the plan");
            for (p, bin) in power.iter_mut().zip(&spectrum) {
                *p = Complex::norm_sqr(bin);
            }
            for m in 0..self.n_mels {
                let row = &self.filters[m * BINS..(m + 1) * BINS];
                let value: f32 = row.iter().zip(&power).map(|(w, p)| w * p).sum();
                mel[m * FRAMES + frame] = value.max(1e-10).log10();
            }
        }
        let peak = mel.iter().copied().fold(f32::MIN, f32::max);
        for value in &mut mel {
            *value = (value.max(peak - 8.0) + 4.0) / 4.0;
        }
        mel
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Values of OpenAI's own filters (whisper/assets/mel_filters.npz, MIT).
    #[test]
    fn filters_match_openai_s() {
        let check = |n_mels: usize, row: usize, entries: &[(usize, f32)]| {
            let filters = mel_filters(n_mels);
            let values = &filters[row * BINS..(row + 1) * BINS];
            for &(bin, expected) in entries {
                let found = values[bin];
                assert!(
                    (found - expected).abs() < 1e-6,
                    "mel_{n_mels}[{row}][{bin}]: {found} vs {expected}"
                );
            }
            let nonzero = values.iter().filter(|&&v| v != 0.0).count();
            (nonzero, values[..entries[0].0].iter().all(|&v| v == 0.0))
        };
        assert_eq!(check(80, 0, &[(1, 0.024_862_59)]), (1, true));
        assert_eq!(
            check(80, 1, &[(1, 0.001_990_82), (2, 0.022_871_77)]),
            (2, true)
        );
        assert_eq!(
            check(
                80,
                40,
                &[(42, 0.005_411_1), (43, 0.014_735_57), (44, 0.006_518_19)]
            ),
            (3, true)
        );
        assert_eq!(check(128, 0, &[(1, 0.012_373_99)]), (1, true));
        assert_eq!(
            check(128, 5, &[(3, 0.005_644_59), (4, 0.006_729_39)]),
            (2, true)
        );
        assert_eq!(check(128, 40, &[(24, 0.040_376_37)]), (1, true));
        check(
            128,
            127,
            &[(191, 0.000_475_7), (192, 0.001_617_17), (196, 0.004_457_12)],
        );
    }

    #[test]
    fn a_tone_lights_its_mel_band_and_silence_pads_the_window() {
        let tone: Vec<f32> = (0..16_000)
            .map(|i| {
                (0.5 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / 16_000.0).sin()) as f32
            })
            .collect();
        let features = Features::new(80);
        let mel = features.log_mel(&tone);
        assert_eq!(mel.len(), 80 * FRAMES);
        // Frame 50 (0.5 s): the band holding 1 kHz is the loudest.
        let column: Vec<f32> = (0..80).map(|m| mel[m * FRAMES + 50]).collect();
        let loudest = (0..80)
            .max_by(|&a, &b| column[a].total_cmp(&column[b]))
            .unwrap();
        let filters = mel_filters(80);
        let bin = 1000 * N_FFT / SAMPLE_RATE as usize;
        let strongest = (0..80)
            .max_by(|&a, &b| filters[a * BINS + bin].total_cmp(&filters[b * BINS + bin]))
            .unwrap();
        assert_eq!(loudest, strongest);
        // Past the tone the window is silence, clamped 8 below the peak: (peak − 8 + 4) / 4.
        let peak = mel.iter().copied().fold(f32::MIN, f32::max);
        assert!((mel[10 * FRAMES + 2000] - (peak - 2.0)).abs() < 1e-5);
    }

    #[test]
    fn resampling_keeps_a_tone_and_its_length() {
        let rate = 48_000;
        let tone: Vec<f32> = (0..rate)
            .map(|i| {
                (0.5 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / rate as f64).sin()) as f32
            })
            .collect();
        let resampled = to_16k(&tone, rate);
        assert_eq!(resampled.len(), 16_000);
        for (i, &x) in resampled.iter().enumerate().skip(100).take(15_800) {
            let expected = 0.5 * (2.0 * std::f64::consts::PI * 440.0 * i as f64 / 16_000.0).sin();
            assert!((x as f64 - expected).abs() < 2e-3, "{i}: {x} vs {expected}");
        }
        assert_eq!(to_16k(&tone[..1000], 16_000).len(), 1000);
        // In pieces, the same samples as at once.
        for rate in [44_100, 48_000] {
            let whole = to_16k(&tone, rate);
            let mut resampler = Resampler::new(rate);
            let mut pieces = Vec::new();
            for chunk in tone.chunks(1021) {
                pieces.extend(resampler.push(chunk));
            }
            pieces.extend(resampler.finish());
            assert_eq!(pieces.len(), whole.len());
            assert!(pieces.iter().zip(&whole).all(|(a, b)| (a - b).abs() < 1e-6));
        }
    }
}

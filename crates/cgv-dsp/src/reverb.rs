//! Reverb after Jezar's Freeverb (public domain): eight damped comb filters in
//! parallel, then four all-pass filters, per channel. The right channel's
//! filters are slightly longer, which spreads the sound in stereo.
use crate::flush;

/// Filter lengths at 44.1 kHz.
const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASSES: [usize; 4] = [556, 441, 341, 225];
const SPREAD: usize = 23;
const INPUT_GAIN: f32 = 0.015;
const WET_SCALE: f32 = 3.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReverbSettings {
    /// 0 to 1: a larger room rings longer.
    pub room_size: f32,
    /// 0 to 1: more damping dulls the tail.
    pub damping: f32,
    /// 0 to 1: stereo width of the tail.
    pub width: f32,
    /// 0 to 1: the share of reverb in the result.
    pub mix: f32,
}

#[derive(Clone, Debug)]
struct Comb {
    buffer: Vec<f32>,
    index: usize,
    store: f32,
}

impl Comb {
    fn process(&mut self, input: f32, feedback: f32, damping: f32) -> f32 {
        let output = self.buffer[self.index];
        self.store = flush(output * (1.0 - damping) + self.store * damping);
        self.buffer[self.index] = flush(input + self.store * feedback);
        self.index = (self.index + 1) % self.buffer.len();
        output
    }
}

#[derive(Clone, Debug)]
struct Allpass {
    buffer: Vec<f32>,
    index: usize,
}

impl Allpass {
    fn process(&mut self, input: f32) -> f32 {
        let delayed = self.buffer[self.index];
        self.buffer[self.index] = flush(input + delayed * 0.5);
        self.index = (self.index + 1) % self.buffer.len();
        delayed - input
    }
}

#[derive(Clone, Debug)]
struct Network {
    combs: Vec<Comb>,
    allpasses: Vec<Allpass>,
}

impl Network {
    fn new(rate: u32, extra: usize) -> Network {
        let scale =
            |length: usize| ((length + extra) as f64 * rate as f64 / 44_100.0).round() as usize;
        Network {
            combs: COMBS
                .iter()
                .map(|&length| Comb {
                    buffer: vec![0.0; scale(length).max(1)],
                    index: 0,
                    store: 0.0,
                })
                .collect(),
            allpasses: ALLPASSES
                .iter()
                .map(|&length| Allpass {
                    buffer: vec![0.0; scale(length).max(1)],
                    index: 0,
                })
                .collect(),
        }
    }

    fn process(&mut self, input: f32, feedback: f32, damping: f32) -> f32 {
        let mut out: f32 = self
            .combs
            .iter_mut()
            .map(|comb| comb.process(input, feedback, damping))
            .sum();
        for allpass in &mut self.allpasses {
            out = allpass.process(out);
        }
        out
    }

    fn reset(&mut self) {
        for comb in &mut self.combs {
            comb.buffer.fill(0.0);
            comb.store = 0.0;
        }
        for allpass in &mut self.allpasses {
            allpass.buffer.fill(0.0);
        }
    }
}

#[derive(Clone, Debug)]
pub struct Reverb {
    settings: ReverbSettings,
    networks: [Network; 2],
}

impl Reverb {
    pub fn new(settings: ReverbSettings, rate: u32) -> Reverb {
        Reverb {
            settings,
            networks: [Network::new(rate, 0), Network::new(rate, SPREAD)],
        }
    }

    pub fn set(&mut self, settings: ReverbSettings) {
        self.settings = settings;
    }

    pub fn reset(&mut self) {
        for network in &mut self.networks {
            network.reset();
        }
    }

    pub fn process(&mut self, channels: &mut [&mut [f32]]) {
        let s = self.settings;
        let feedback = 0.7 + 0.28 * s.room_size.clamp(0.0, 1.0);
        let damping = 0.4 * s.damping.clamp(0.0, 1.0);
        let mix = s.mix.clamp(0.0, 1.0);
        let width = s.width.clamp(0.0, 1.0);
        let wet = mix * WET_SCALE;
        let (wet1, wet2) = (wet * (width / 2.0 + 0.5), wet * ((1.0 - width) / 2.0));
        let dry = 1.0 - mix;
        let [left_network, right_network] = &mut self.networks;
        match crate::split(channels) {
            (left, Some(right)) => {
                for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                    let input = (*l + *r) * INPUT_GAIN;
                    let a = left_network.process(input, feedback, damping);
                    let b = right_network.process(input, feedback, damping);
                    (*l, *r) = (
                        *l * dry + a * wet1 + b * wet2,
                        *r * dry + b * wet1 + a * wet2,
                    );
                }
            }
            (left, None) => {
                for l in left.iter_mut() {
                    let a = left_network.process(*l * 2.0 * INPUT_GAIN, feedback, damping);
                    *l = *l * dry + a * wet;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_signal::rms;

    fn tail(room_size: f32) -> Vec<f32> {
        let settings = ReverbSettings {
            room_size,
            damping: 0.5,
            width: 1.0,
            mix: 1.0,
        };
        let mut reverb = Reverb::new(settings, 48_000);
        let mut left = vec![0.0f32; 96_000];
        let mut right = vec![0.0f32; 96_000];
        left[0] = 1.0;
        right[0] = 1.0;
        reverb.process(&mut [&mut left, &mut right]);
        left
    }

    #[test]
    fn larger_rooms_ring_longer_and_tails_decay() {
        let small = tail(0.2);
        let large = tail(0.9);
        let early = |t: &[f32]| rms(&t[4800..14_400]);
        let late = |t: &[f32]| rms(&t[48_000..72_000]);
        assert!(early(&large) > 0.0);
        assert!(late(&large) / early(&large) > late(&small) / early(&small) * 10.0);
        assert!(late(&large) < early(&large), "the tail decays");
        assert!(large.iter().all(|x| x.is_finite() && x.abs() < 1.0));
        // Nothing comes out before the shortest comb has wrapped round.
        assert!(large[..1000].iter().all(|&x| x == 0.0));
    }

    #[test]
    fn a_full_room_stays_stable_and_dies_away() {
        let settings = ReverbSettings {
            room_size: 1.0,
            damping: 0.0,
            width: 1.0,
            mix: 0.5,
        };
        let mut reverb = Reverb::new(settings, 48_000);
        // Half a second of loud noise, then ten seconds of silence.
        let mut sound = crate::test_signal::noise(9, 24_000);
        sound.resize(504_000, 0.0);
        reverb.process(&mut [&mut sound]);
        assert!(sound.iter().all(|x| x.is_finite()));
        let early = rms(&sound[24_000..72_000]);
        let late = rms(&sound[456_000..]);
        assert!(late < early / 100.0, "{early} {late}");
    }
}

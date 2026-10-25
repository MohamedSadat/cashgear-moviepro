//! Echo: a delay line that feeds back into itself through a gentle low-pass, so
//! each repeat is a little darker than the one before.
use crate::flush;

/// The longest delay, in seconds.
pub const MAX_DELAY: f32 = 2.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EchoSettings {
    /// Seconds between repeats.
    pub delay: f32,
    /// 0 to 0.95: how much of each repeat comes back.
    pub feedback: f32,
    /// Level of the repeats added to the sound, 0 to 1.
    pub level: f32,
    /// 0 keeps repeats bright; 1 darkens them most.
    pub damping: f32,
}

#[derive(Clone, Debug)]
pub struct Echo {
    settings: EchoSettings,
    rate: u32,
    lines: [Vec<f32>; 2],
    position: usize,
    delay: usize,
    filters: [f32; 2],
}

impl Echo {
    pub fn new(settings: EchoSettings, rate: u32) -> Echo {
        let capacity = (MAX_DELAY * rate as f32) as usize + 1;
        let mut echo = Echo {
            settings,
            rate,
            lines: [vec![0.0; capacity], vec![0.0; capacity]],
            position: 0,
            delay: 1,
            filters: [0.0; 2],
        };
        echo.set(settings);
        echo
    }

    pub fn set(&mut self, settings: EchoSettings) {
        self.settings = settings;
        let capacity = self.lines[0].len();
        self.delay = ((settings.delay.clamp(0.001, MAX_DELAY) * self.rate as f32).round() as usize)
            .clamp(1, capacity - 1);
    }

    pub fn reset(&mut self) {
        for line in &mut self.lines {
            line.fill(0.0);
        }
        self.filters = [0.0; 2];
        self.position = 0;
    }

    pub fn process(&mut self, channels: &mut [&mut [f32]]) {
        let feedback = self.settings.feedback.clamp(0.0, 0.95);
        let level = self.settings.level.clamp(0.0, 1.0);
        let damping = self.settings.damping.clamp(0.0, 1.0) * 0.7;
        let capacity = self.lines[0].len();
        let frames = channels.first().map_or(0, |c| c.len());
        for (index, channel) in channels.iter_mut().enumerate().take(2) {
            let line = &mut self.lines[index];
            let filter = &mut self.filters[index];
            let mut position = self.position;
            for sample in channel.iter_mut() {
                let wet = line[(position + capacity - self.delay) % capacity];
                *filter = flush(wet + (*filter - wet) * damping);
                line[position] = flush(*sample + feedback * *filter);
                *sample += level * wet;
                position = (position + 1) % capacity;
            }
        }
        self.position = (self.position + frames) % capacity;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_arrive_at_the_delay_and_fade_by_the_feedback() {
        let rate = 48_000;
        let settings = EchoSettings {
            delay: 0.25,
            feedback: 0.5,
            level: 0.8,
            damping: 0.0,
        };
        let mut echo = Echo::new(settings, rate);
        let mut sound = vec![0.0f32; 48_000];
        sound[0] = 1.0;
        // In two blocks, to cross a block edge mid-way.
        let (first, second) = sound.split_at_mut(10_000);
        echo.process(&mut [first]);
        echo.process(&mut [second]);
        assert_eq!(sound[0], 1.0);
        assert!((sound[12_000] - 0.8).abs() < 1e-6);
        assert!((sound[24_000] - 0.4).abs() < 1e-6);
        assert!((sound[36_000] - 0.2).abs() < 1e-6);
        let elsewhere: f32 = sound
            .iter()
            .enumerate()
            .filter(|(i, _)| i % 12_000 != 0)
            .map(|(_, x)| x.abs())
            .sum();
        assert_eq!(elsewhere, 0.0);
    }
}

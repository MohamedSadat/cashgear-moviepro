use super::*;
use cgv_dsp::biquad::FilterKind;
use cgv_dsp::dynamics::CompressorSettings;
use cgv_dsp::effect::EqBand;
use cgv_dsp::reverb::ReverbSettings;

const RATE: u32 = 48_000;

/// A clip with no edge ramps, as the old mixer tests expect.
fn clip(media: &str, start: i64, end: i64, source_start: i64) -> AudioClip {
    AudioClip {
        seamless_in: true,
        seamless_out: true,
        ..AudioClip::plain(media, start, end, source_start)
    }
}

fn plan(clips: Vec<AudioClip>) -> AudioPlan {
    AudioPlan::single(clips)
}

/// Stereo audio whose left channel is the media time in seconds and right its negative.
fn ramp(mixer: &mut Mixer, media: &str, block: i64, rate: u32) {
    let (start, end) = mixer.block_span(block);
    let first = (start * rate as f64).round() as i64;
    let frames = ((end - start) * rate as f64).round() as usize;
    let left: Vec<f32> = (0..frames)
        .map(|i| ((first + i as i64) as f64 / rate as f64) as f32)
        .collect();
    let right: Vec<f32> = left.iter().map(|value| -value).collect();
    let data = [left, right].concat();
    mixer
        .insert_block(
            media,
            block,
            SourceAudio {
                sample_rate: rate,
                channels: 2,
                data: &data,
                start_seconds: first as f64 / rate as f64,
            },
        )
        .unwrap();
}

/// Mono blocks of `media` from a function of the media sample.
fn fill(mixer: &mut Mixer, media: &str, blocks: std::ops::Range<i64>, sound: impl Fn(i64) -> f32) {
    for block in blocks {
        let (start, end) = mixer.block_span(block);
        let first = (start * RATE as f64).round() as i64;
        let last = (end * RATE as f64).round() as i64;
        let data: Vec<f32> = (first..last).map(&sound).collect();
        mixer
            .insert_block(
                media,
                block,
                SourceAudio {
                    sample_rate: RATE,
                    channels: 1,
                    data: &data,
                    start_seconds: first as f64 / RATE as f64,
                },
            )
            .unwrap();
    }
}

fn dc(mixer: &mut Mixer, media: &str) {
    fill(mixer, media, 0..1, |_| 1.0);
}

fn tone(frequency: f64, amplitude: f32) -> impl Fn(i64) -> f32 {
    move |i| {
        amplitude * (2.0 * std::f64::consts::PI * frequency * i as f64 / RATE as f64).sin() as f32
    }
}

#[test]
fn blocks_hold_one_second_at_the_project_rate() {
    let mut mixer = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
    assert_eq!(mixer.block_span(0), (0.0, 1.1));
    assert_eq!(mixer.block_span(3), (2.9, 4.1));
    ramp(&mut mixer, "a", 2, RATE);
    let out = mixer.mix(&plan(vec![clip("a", 0, 10, 2 * 48_000)]), 0, 10);
    for frame in 0..10 {
        let expected = (2.0 + frame as f64 / 48_000.0) as f32;
        assert_eq!(out[frame * 2], expected);
        assert_eq!(out[frame * 2 + 1], -expected);
    }
    assert_eq!(mixer.cached_blocks(), 1);
    assert_eq!(mixer.cached_bytes(), 2 * 48_000 * 4);
}

#[test]
fn missing_blocks_are_listed_in_play_order_and_play_silent() {
    let mut mixer = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
    // A clip whose source starts half a second into block 1, heard from timeline 0.
    let clips = plan(vec![clip("a", 0, 96_000, 72_000)]);
    assert_eq!(
        mixer.missing(&clips, 0, 96_000),
        vec![
            ("a".to_string(), 1),
            ("a".to_string(), 2),
            ("a".to_string(), 3)
        ]
    );
    assert!(!mixer.ready(&clips, 0, 100));
    ramp(&mut mixer, "a", 1, RATE);
    assert!(mixer.ready(&clips, 0, 100));
    assert_eq!(mixer.missing(&clips, 0, 24_000), vec![]);
    // Block 2 is missing: silence from timeline sample 24,000.
    let out = mixer.mix(&clips, 23_999, 2);
    assert!((out[0] - 1.999_98).abs() < 1e-4);
    assert_eq!(out[2], 0.0);
}

#[test]
fn clips_mix_with_gain_and_mute_outside_their_range() {
    let mut mixer = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
    ramp(&mut mixer, "a", 0, RATE);
    ramp(&mut mixer, "b", 0, RATE);
    let mut quiet = clip("b", 5, 10, 0);
    quiet.gain = db_to_gain(-6.0);
    let out = mixer.mix(&plan(vec![clip("a", 0, 10, 1000), quiet]), 0, 10);
    let a = |i: i64| ((1000 + i) as f64 / 48_000.0) as f32;
    assert_eq!(out[0], a(0));
    let b = |i: i64| (i as f64 / 48_000.0) as f32 * db_to_gain(-6.0);
    assert!((out[7 * 2] - (a(7) + b(2))).abs() < 1e-7);
    assert!((db_to_gain(-6.0) - 0.501_187).abs() < 1e-6);
}

#[test]
fn an_envelope_ramps_the_gain_between_its_points_and_holds_beyond_them() {
    let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    dc(&mut mixer, "dc");
    let mut ramped = clip("dc", 0, 400, 0);
    ramped.envelope = vec![(100, 0.0), (200, 1.0), (300, 0.5)];
    let out = mixer.mix(&plan(vec![ramped.clone()]), 0, 400);
    assert_eq!(out[50], 0.0, "held before the first point");
    assert!((out[150] - 0.5).abs() < 1e-6);
    assert!((out[250] - 0.75).abs() < 1e-6);
    assert!((out[399] - 0.5).abs() < 1e-6, "held after the last point");
    // Mixing from the middle gives the same samples.
    let tail = mixer.mix(&plan(vec![ramped]), 240, 20);
    assert!((tail[10] - out[250]).abs() < 1e-7);
}

#[test]
fn clip_edges_ramp_over_five_milliseconds_except_at_seamless_cuts() {
    let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    dc(&mut mixer, "dc");
    let faded = AudioClip::plain("dc", 0, 2000, 0);
    let out = mixer.mix(&plan(vec![faded]), 0, 2000);
    assert!(out[0] > 0.0 && out[0] < 0.01);
    assert!((out[120] - 120.5 / 240.0).abs() < 1e-6);
    assert_eq!(out[240], 1.0);
    assert_eq!(out[1000], 1.0);
    assert!(out[1999] < 0.01);
    // A split clip continues seamlessly: no dip at the cut.
    let left = AudioClip {
        seamless_out: true,
        ..AudioClip::plain("dc", 0, 1000, 0)
    };
    let right = AudioClip {
        seamless_in: true,
        ..AudioClip::plain("dc", 1000, 2000, 1000)
    };
    let out = mixer.mix(&plan(vec![left, right]), 990, 20);
    assert!(out.iter().all(|&value| value == 1.0), "{out:?}");
}

#[test]
fn fades_and_crossfades_follow_an_equal_power_curve() {
    let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    dc(&mut mixer, "dc");
    let faded = AudioClip {
        fade_in: 4800,
        fade_out: 9600,
        ..AudioClip::plain("dc", 0, 48_000, 0)
    };
    let out = mixer.mix(&plan(vec![faded]), 0, 48_000);
    let rise = |p: f32| (p * std::f32::consts::FRAC_PI_2).sin();
    assert!((out[2400] - rise(2400.5 / 4800.0)).abs() < 1e-6);
    assert_eq!(out[4800], 1.0);
    assert!((out[48_000 - 4800] - rise(4799.5 / 9600.0)).abs() < 1e-6);
    assert!(out[47_999] < 1e-3);
    // Two clips crossfading over 4800 samples: power stays constant.
    let outgoing = AudioClip {
        fade_out: 4800,
        ..AudioClip::plain("dc", 0, 10_000, 0)
    };
    let incoming = AudioClip {
        fade_in: 4800,
        ..AudioClip::plain("dc", 5200, 20_000, 0)
    };
    let mut alone = |clip: AudioClip| Mixer::mix(&mut mixer, &plan(vec![clip]), 5200, 4800);
    let (a, b) = (alone(outgoing), alone(incoming));
    for i in (0..4800).step_by(97) {
        let power = a[i] * a[i] + b[i] * b[i];
        assert!((power - 1.0).abs() < 1e-5, "{i}: {power}");
    }
}

#[test]
fn channel_mapping() {
    let mut stereo_out = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
    let mono = vec![0.25f32; 1000];
    stereo_out
        .insert_block(
            "m",
            0,
            SourceAudio {
                sample_rate: RATE,
                channels: 1,
                data: &mono,
                start_seconds: 0.0,
            },
        )
        .unwrap();
    assert_eq!(
        stereo_out.mix(&plan(vec![clip("m", 0, 1, 0)]), 0, 1),
        vec![0.25, 0.25]
    );
    let mut mono_out = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    // Four channels: only the first two are kept, then averaged for mono.
    let quad: Vec<f32> = [0.2f32, 0.4, 9.0, 9.0]
        .iter()
        .flat_map(|&value| std::iter::repeat_n(value, 10))
        .collect();
    mono_out
        .insert_block(
            "q",
            0,
            SourceAudio {
                sample_rate: RATE,
                channels: 4,
                data: &quad,
                start_seconds: 0.0,
            },
        )
        .unwrap();
    let out = mono_out.mix(&plan(vec![clip("q", 0, 1, 0)]), 0, 1);
    assert!((out[0] - 0.3).abs() < 1e-6);
}

#[test]
fn tracks_have_their_own_volume_and_a_pan_that_keeps_the_centre() {
    let mut mixer = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
    dc(&mut mixer, "dc");
    let mut track = AudioTrack::new(1, vec![clip("dc", 0, 100, 0)]);
    let mut out = |track: &AudioTrack| {
        let out = mixer.mix(
            &AudioPlan {
                tracks: vec![track.clone()],
            },
            0,
            100,
        );
        (out[100], out[101])
    };
    assert_eq!(out(&track), (1.0, 1.0));
    track.pan = -1.0;
    let (left, right) = out(&track);
    assert_eq!(left, 1.0);
    assert!(right.abs() < 1e-6);
    track.pan = 0.5;
    let (left, right) = out(&track);
    assert_eq!(right, 1.0);
    assert!(
        (left - std::f32::consts::SQRT_2 * (3.0 * std::f32::consts::PI / 8.0).cos()).abs() < 1e-6
    );
    track.pan = 0.0;
    track.gain = 0.5;
    assert_eq!(out(&track), (0.5, 0.5));
}

#[test]
fn other_rates_are_resampled_in_time_and_in_tune() {
    let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    let source_rate = 44_100;
    let tone = |t: f64| (2.0 * std::f64::consts::PI * 440.0 * t).sin() as f32;
    for block in [0, 1] {
        let (start, end) = mixer.block_span(block);
        let first = (start * source_rate as f64).round() as i64;
        let frames = ((end - start) * source_rate as f64).round() as i64;
        let data: Vec<f32> = (first..first + frames)
            .map(|i| tone(i as f64 / source_rate as f64))
            .collect();
        mixer
            .insert_block(
                "t",
                block,
                SourceAudio {
                    sample_rate: source_rate,
                    channels: 1,
                    data: &data,
                    start_seconds: first as f64 / source_rate as f64,
                },
            )
            .unwrap();
    }
    // Across the block boundary the 48 kHz output is the ideal tone, give or
    // take a constant offset under half a sample (the resampler's delay is not
    // a whole number of samples).
    let out = mixer.mix(&plan(vec![clip("t", 0, 96_000, 0)]), 47_000, 2000);
    let worst_at = |shift: f64| {
        out.iter()
            .enumerate()
            .map(|(i, &value)| (value - tone((47_000.0 + i as f64 + shift) / 48_000.0)).abs())
            .fold(0.0f32, f32::max)
    };
    let best = (-10..=10)
        .map(|step| worst_at(step as f64 * 0.05))
        .fold(f32::MAX, f32::min);
    assert!(best < 1e-3, "worst error {best}");
}

#[test]
fn blocks_land_on_the_same_phase_whatever_packet_decoding_started_at() {
    let tone = |t: f64| (2.0 * std::f64::consts::PI * 440.0 * t).sin() as f32;
    let source_rate = 44_100;
    let block_from = |first: i64| {
        let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
        let data: Vec<f32> = (first..first + 60_000)
            .map(|i| tone(i as f64 / source_rate as f64))
            .collect();
        mixer
            .insert_block(
                "t",
                1,
                SourceAudio {
                    sample_rate: source_rate,
                    channels: 1,
                    data: &data,
                    start_seconds: first as f64 / source_rate as f64,
                },
            )
            .unwrap();
        mixer.mix(&plan(vec![clip("t", 0, 48_000, 48_000)]), 0, 48_000)
    };
    // Decoding started at two different AAC packets before the block.
    assert_eq!(block_from(36_864), block_from(38_912));
}

#[test]
fn the_budget_evicts_the_least_recently_used_blocks() {
    let one_block = 2 * 48_000 * 4;
    let mut mixer = Mixer::new(RATE, 2, one_block * 2);
    ramp(&mut mixer, "a", 0, RATE);
    ramp(&mut mixer, "a", 1, RATE);
    mixer.mix(&plan(vec![clip("a", 0, 1, 0)]), 0, 1);
    ramp(&mut mixer, "a", 2, RATE);
    assert_eq!(mixer.cached_blocks(), 2);
    assert_eq!(
        mixer.missing(&plan(vec![clip("a", 0, 1, 48_000)]), 0, 1),
        vec![("a".to_string(), 1)]
    );
    assert!(mixer.ready(&plan(vec![clip("a", 0, 1, 0)]), 0, 1));
    mixer.forget("a");
    assert_eq!((mixer.cached_blocks(), mixer.cached_bytes()), (0, 0));
}

#[test]
fn invalid_audio_is_refused() {
    let mut mixer = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
    let odd = [0.0f32; 3];
    let source = SourceAudio {
        sample_rate: RATE,
        channels: 2,
        data: &odd,
        start_seconds: 0.0,
    };
    assert!(mixer.insert_block("x", 0, source).is_err());
}

#[test]
fn noise_reduction_blends_the_cleaned_blocks_with_the_original() {
    let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    fill(&mut mixer, "v", 0..1, |_| 1.0);
    fill(&mut mixer, "v#nr", 0..1, |_| 0.2);
    let mut cleaned = clip("v", 0, 100, 0);
    cleaned.denoised = Some(("v#nr".into(), 0.75));
    let out = mixer.mix(&plan(vec![cleaned.clone()]), 0, 100);
    assert!((out[50] - (0.25 + 0.75 * 0.2)).abs() < 1e-6);
    // Fully cleaned, the original is not even needed.
    cleaned.denoised = Some(("v#nr".into(), 1.0));
    mixer.forget("x");
    assert_eq!(
        mixer.needed(&plan(vec![cleaned.clone()]), 0, 100),
        vec![("v#nr".to_string(), 0)]
    );
    assert!((mixer.mix(&plan(vec![cleaned]), 0, 100)[50] - 0.2).abs() < 1e-6);
    // Forgetting a medium drops its cleaned blocks too.
    mixer.forget("v");
    assert_eq!(mixer.cached_blocks(), 0);
}

fn effects() -> Vec<Settings> {
    vec![
        Settings::Equalizer(vec![EqBand {
            kind: FilterKind::Peak,
            frequency: 1000.0,
            gain_db: 6.0,
            q: 1.0,
        }]),
        Settings::Compressor(CompressorSettings {
            threshold_db: -20.0,
            ratio: 4.0,
            knee_db: 6.0,
            attack: 0.005,
            release: 0.1,
            makeup_db: 0.0,
        }),
    ]
}

#[test]
fn effects_sound_the_same_in_any_chunks_and_after_a_seek_they_warm_up() {
    let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    fill(&mut mixer, "v", 0..5, tone(997.0, 0.5));
    let mut processed = clip("v", 0, 4 * 48_000, 0);
    processed.effects = effects();
    processed.chain = 7;
    let plan = plan(vec![processed]);
    let whole = mixer.mix(&plan, 0, 3 * 48_000);
    // In playback's chunks, from the start, the result is identical.
    let mut fresh = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    fill(&mut fresh, "v", 0..5, tone(997.0, 0.5));
    let mut chunks = Vec::new();
    let mut at = 0;
    while at < 3 * 48_000 {
        chunks.extend(fresh.mix(&plan, at, 1024));
        at += 1024;
    }
    assert_eq!(&chunks[..3 * 48_000], &whole[..]);
    // A seek to 2 s needs the second before it, and then matches.
    let mut seeking = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    fill(&mut seeking, "v", 2..3, tone(997.0, 0.5));
    assert_eq!(
        seeking.missing(&plan, 96_000, 1024),
        vec![("v".to_string(), 1)]
    );
    fill(&mut seeking, "v", 1..2, tone(997.0, 0.5));
    let after = seeking.mix(&plan, 96_000, 4800);
    let worst = after
        .iter()
        .zip(&whole[96_000..])
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
    assert!(worst < 1e-4, "{worst}");
    // The effects did something.
    assert!((whole[100_000] - tone(997.0, 0.5)(100_000)).abs() > 0.01);
}

#[test]
fn a_seamless_cut_keeps_the_reverb_tail_running() {
    let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    fill(&mut mixer, "v", 0..2, |i| {
        if i < 4800 {
            tone(440.0, 0.5)(i)
        } else {
            0.0
        }
    });
    let reverb = vec![Settings::Reverb(ReverbSettings {
        room_size: 0.8,
        damping: 0.3,
        width: 1.0,
        mix: 1.0,
    })];
    let whole = AudioClip {
        effects: reverb.clone(),
        chain: 1,
        ..clip("v", 0, 96_000, 0)
    };
    let left = AudioClip {
        effects: reverb.clone(),
        chain: 1,
        ..clip("v", 0, 24_000, 0)
    };
    let right = AudioClip {
        effects: reverb,
        chain: 1,
        ..clip("v", 24_000, 96_000, 24_000)
    };
    let one = mixer.mix(&plan(vec![whole]), 0, 48_000);
    mixer.set_metering(false);
    let mut other = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    fill(&mut other, "v", 0..2, |i| {
        if i < 4800 {
            tone(440.0, 0.5)(i)
        } else {
            0.0
        }
    });
    let split = other.mix(&plan(vec![left, right]), 0, 48_000);
    assert_eq!(one, split);
    assert!(split[30_000].abs() > 0.0, "the tail rings past the cut");
}

fn ducking_plan(music_gain: f32) -> AudioPlan {
    let speech = AudioTrack {
        role: Role::Dialogue,
        ..AudioTrack::new(1, vec![clip("speech", 0, 5 * 48_000, 0)])
    };
    let music = AudioTrack {
        role: Role::Music,
        gain: music_gain,
        duck: Some(DuckSettings::default()),
        ..AudioTrack::new(2, vec![clip("music", 0, 5 * 48_000, 0)])
    };
    AudioPlan {
        tracks: vec![speech, music],
    }
}

/// Speech (a 1 kHz tone) from 1.5 s to 3 s over steady music.
fn ducking_mixer() -> Mixer {
    let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    fill(&mut mixer, "speech", 0..6, |i| {
        if (72_000..144_000).contains(&i) {
            tone(1000.0, 0.3)(i)
        } else {
            0.0
        }
    });
    fill(&mut mixer, "music", 0..6, |_| 0.5);
    mixer
}

#[test]
fn music_dips_under_dialogue_smoothly_and_the_same_in_any_chunks() {
    let mut mixer = ducking_mixer();
    let plan = ducking_plan(1.0);
    // Music alone: the music track's own output, read where speech is silent.
    let whole = mixer.mix(&plan, 0, 4 * 48_000);
    let music = |i: usize, out: &[f32]| {
        out[i] - tone(1000.0, 0.3)(i as i64) * f32::from((72_000..144_000).contains(&i))
    };
    assert!(
        (music(48_000, &whole) - 0.5).abs() < 1e-6,
        "full level before"
    );
    let ducked = 0.5 * db_to_gain(-12.0);
    assert!(
        (music(100_000, &whole) - ducked).abs() < 1e-4,
        "down 12 dB under speech"
    );
    assert!(
        (music(144_000 + 14_400, &whole) - ducked).abs() < 1e-4,
        "held 0.3 s after"
    );
    assert!(
        (music(190_000, &whole) - 0.5).abs() < 1e-4,
        "back up after the release"
    );
    // The fall ends as speech starts, and never jumps.
    assert!((music(72_000, &whole) - ducked).abs() < 1e-3);
    assert!(music(72_000 - 4800, &whole) > ducked + 0.05);
    let steepest = (0..whole.len() - 1)
        .map(|i| (music(i + 1, &whole) - music(i, &whole)).abs())
        .fold(0.0f32, f32::max);
    assert!(steepest < 2e-4, "{steepest}");
    // Playback's chunks give exactly the same samples.
    let mut chunked = ducking_mixer();
    let mut out = Vec::new();
    let mut at = 0;
    while at < 4 * 48_000 {
        out.extend(chunked.mix(&plan, at, 1024));
        at += 1024;
    }
    assert_eq!(&out[..4 * 48_000], &whole[..]);
    // Ducking reads dialogue ahead: its blocks are needed early.
    let mut fresh = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    fill(&mut fresh, "music", 0..6, |_| 0.5);
    fill(&mut fresh, "speech", 0..1, |_| 0.0);
    assert_eq!(
        fresh.missing(&plan, 47_000, 900),
        vec![("speech".to_string(), 1)]
    );
}

#[test]
fn meters_read_each_track_and_the_master() {
    let mut mixer = Mixer::new(RATE, 2, DEFAULT_BUDGET_BYTES);
    fill(&mut mixer, "t", 0..2, tone(997.0, 0.5));
    mixer.set_metering(true);
    let plan = AudioPlan {
        tracks: vec![
            AudioTrack::new(4, vec![clip("t", 0, 96_000, 0)]),
            AudioTrack {
                gain: 0.5,
                ..AudioTrack::new(9, vec![clip("t", 0, 96_000, 0)])
            },
        ],
    };
    let mut at = 0;
    while at < 48_000 {
        mixer.mix(&plan, at, 1024);
        at += 1024;
    }
    let readings = mixer.take_readings();
    assert_eq!(readings.len(), 100);
    assert_eq!(readings[0].sample, 480);
    let last = readings.last().unwrap();
    let db = |x: f32| 20.0 * x.log10();
    assert!((db(last.master.peak[0]) - db(0.75)).abs() < 0.01);
    assert!((db(last.master.rms[1]) - (db(0.75) - 3.0103)).abs() < 0.01);
    assert_eq!(last.tracks.len(), 2);
    assert!((db(last.tracks[1].1.peak[0]) - db(0.25)).abs() < 0.01);
    // A sine on both channels reads its peak level in LUFS (EBU Tech 3341).
    assert!(
        (last.momentary - db(0.75) as f64).abs() < 0.1,
        "{}",
        last.momentary
    );
    assert!((last.integrated - db(0.75) as f64).abs() < 0.1);
    assert!(mixer.take_readings().is_empty());
}

#[test]
fn mastering_applies_its_gain_on_time_and_limits_true_peaks() {
    let mut mixer = Mixer::new(RATE, 1, DEFAULT_BUDGET_BYTES);
    fill(&mut mixer, "t", 0..2, tone(440.0, 0.25));
    let plan = plan(vec![clip("t", 0, 96_000, 0)]);
    let plain = mixer.mix(&plan, 0, 48_000);
    mixer.set_mastering(Some((6.0, -1.0)));
    let mut mastered = Vec::new();
    let mut at = 0;
    while at < 48_000 {
        mastered.extend(mixer.mix(&plan, at, 4800));
        at += 4800;
    }
    // 6 dB up, no limiting needed, and not a sample late.
    for i in (100..48_000).step_by(37) {
        assert!(
            (mastered[i] - plain[i] * db_to_gain(6.0)).abs() < 1e-5,
            "{i}"
        );
    }
    // 20 dB up: the limiter holds the true peak at -1 dBTP.
    mixer.set_mastering(Some((20.0, -1.0)));
    let loud = mixer.mix(&plan, 0, 48_000);
    let mut meter = cgv_dsp::loudness::Loudness::new(RATE, 1, true);
    meter.add(&[&loud]);
    let peak = 20.0 * meter.true_peak().log10();
    assert!(peak <= -0.9 && peak > -1.5, "{peak}");
}

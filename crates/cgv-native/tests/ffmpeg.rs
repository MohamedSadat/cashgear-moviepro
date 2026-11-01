//! Runs the real LGPL FFmpeg against the test media. Skipped (with a message)
//! when FFmpeg or the clips are missing, unless CGV_REQUIRE_FFMPEG=1, as in CI.
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use cgv_native::export::Conversion;
use cgv_native::ffmpeg::{command, Tools};
use cgv_native::master::{MasterRequest, MasterWriter, Profile, Sound, SoundWriter};
use cgv_native::originals::{Original, OriginalDecoder};
use cgv_native::{ffmpeg, probe, proxy};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn setup() -> Option<(Tools, PathBuf)> {
    let required = std::env::var("CGV_REQUIRE_FFMPEG").as_deref() == Ok("1");
    let tools_dir = repo().join(".tools/ffmpeg/bin");
    if std::env::var_os("CGV_FFMPEG_DIR").is_none() && tools_dir.is_dir() {
        std::env::set_var("CGV_FFMPEG_DIR", &tools_dir);
    }
    let media = repo().join("tests/media");
    match Tools::locate(None) {
        Ok(tools) if media.join("prores-720p2997-pcm.mov").is_file() => Some((tools, media)),
        result => {
            let reason = match result {
                Err(error) => error,
                Ok(_) => "test media is missing (pnpm fetch-test-media)".into(),
            };
            assert!(!required, "FFmpeg integration tests are required: {reason}");
            eprintln!("skipping FFmpeg integration tests: {reason}");
            None
        }
    }
}

#[test]
fn the_build_is_lgpl() {
    let Some((tools, _)) = setup() else { return };
    tools.check_license().unwrap();
}

#[test]
fn probes_the_test_set() {
    let Some((tools, media)) = setup() else {
        return;
    };
    let prores = probe::probe(&tools, &media.join("prores-720p2997-pcm.mov")).unwrap();
    let video = prores.video.unwrap();
    assert_eq!(video.codec, "prores");
    assert_eq!(
        (video.display_width, video.display_height, video.frame_count),
        (1280, 720, 90)
    );
    assert_eq!(prores.audio.unwrap().codec, "pcm-s16");

    let hevc = probe::probe(&tools, &media.join("hevc-1080p23976-rot90.mov")).unwrap();
    let video = hevc.video.unwrap();
    assert_eq!((video.codec.as_str(), video.rotation), ("hevc", 90));
    assert_eq!((video.display_width, video.display_height), (1080, 1920));

    let wav = probe::probe(&tools, &media.join("tone-48k-stereo.wav")).unwrap();
    assert!(wav.video.is_none());
    assert_eq!(wav.audio.unwrap().sample_rate, 48_000);
}

#[test]
fn makes_a_720p_proxy_with_half_second_key_frames() {
    let Some((tools, media)) = setup() else {
        return;
    };
    let encoder = tools.h264_encoder().expect("no working H.264 encoder");
    let output = std::env::temp_dir().join("cgv-proxy-test.mp4");
    let _ = std::fs::remove_file(&output);
    let mut last = 0.0;
    proxy::run(
        &tools,
        &proxy::ProxyRequest {
            input: &media.join("prores-720p2997-pcm.mov"),
            output: &output,
            encoder,
            frame_rate: 30000.0 / 1001.0,
            duration_seconds: 3.003,
            has_audio: true,
        },
        &AtomicBool::new(false),
        |progress| last = progress,
    )
    .unwrap();
    assert_eq!(last, 1.0);
    let probed = probe::probe(&tools, &output).unwrap();
    let video = probed.video.unwrap();
    assert_eq!(video.codec, "avc", "encoder {encoder}");
    assert_eq!((video.coded_width, video.coded_height), (1280, 720));
    assert_eq!(video.frame_count, 90);
    assert_eq!(probed.audio.unwrap().codec, "aac");

    // Key frames every 15 frames (0.5 s at 29.97).
    let frames = command(&tools.ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=key_frame",
            "-of",
            "csv=p=0",
        ])
        .arg(&output)
        .output()
        .unwrap();
    let keys: Vec<usize> = String::from_utf8_lossy(&frames.stdout)
        .lines()
        .enumerate()
        .filter(|(_, line)| line.trim().starts_with('1'))
        .map(|(index, _)| index)
        .collect();
    assert_eq!(keys.first(), Some(&0));
    assert!(
        keys.windows(2).all(|pair| pair[1] - pair[0] <= 15),
        "key frames {keys:?} with {encoder}"
    );
    std::fs::remove_file(output).unwrap();
}

#[test]
fn converts_exports_to_gif_and_mp3() {
    let Some((tools, media)) = setup() else {
        return;
    };
    let dir = std::env::temp_dir().join("cgv-export-conversion-test");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    // What the webview writes for a GIF: a small H.264 MP4 at the GIF's size and rate.
    let encoder = tools.h264_encoder().expect("no working H.264 encoder");
    let intermediate = dir.join("intermediate.mp4");
    let made = command(&tools.ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
        .arg("testsrc2=size=320x180:rate=15")
        .args(["-frames:v", "15", "-pix_fmt"])
        .arg(if encoder == "libopenh264" {
            "yuv420p"
        } else {
            "nv12"
        })
        .args(["-c:v", encoder])
        .arg(&intermediate)
        .status()
        .unwrap();
    assert!(made.success());

    let gif = dir.join("clip.gif");
    let mut last = 0.0;
    ffmpeg::run_job(
        &tools,
        &Conversion::Gif.arguments(&intermediate, &gif, 0),
        1.0,
        &AtomicBool::new(false),
        |progress| last = progress,
        "make the GIF",
    )
    .unwrap();
    let probed = probe::probe(&tools, &gif).unwrap();
    let video = probed.video.unwrap();
    assert_eq!(video.codec, "gif");
    assert_eq!((video.display_width, video.display_height), (320, 180));
    assert!(last > 0.5, "progress {last}");

    let mp3 = dir.join("tone.mp3");
    ffmpeg::run_job(
        &tools,
        &Conversion::Mp3.arguments(&media.join("tone-48k-stereo.wav"), &mp3, 192_000),
        2.0,
        &AtomicBool::new(false),
        |_| {},
        "make the MP3",
    )
    .unwrap();
    let audio = probe::probe(&tools, &mp3).unwrap().audio.unwrap();
    assert_eq!((audio.codec.as_str(), audio.sample_rate), ("mp3", 48_000));

    // A cancelled conversion stops and says so.
    let cancelled = ffmpeg::run_job(
        &tools,
        &Conversion::Gif.arguments(&intermediate, &dir.join("never.gif"), 0),
        1.0,
        &AtomicBool::new(true),
        |_| {},
        "make the GIF",
    );
    assert_eq!(cancelled, Err("Cancelled".into()));
    std::fs::remove_dir_all(&dir).unwrap();
}

/// A 10-bit luma ramp through every limited-range level (64 to 940) on neutral
/// chroma, laid out as the engine reads masters back.
fn ramp(profile: Profile, width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    let level = |x: usize| 64 + (x * 877 / w).min(876) as u16;
    let mut samples: Vec<u16> = Vec::new();
    for _ in 0..h {
        samples.extend((0..w).map(level));
    }
    let chroma = match profile {
        Profile::Prores422Hq => w / 2 * h,
        Profile::Prores4444 => w * h,
    };
    samples.extend(std::iter::repeat_n(512, 2 * chroma));
    if profile == Profile::Prores4444 {
        // Alpha falls from opaque on the left to clear on the right.
        for _ in 0..h {
            samples.extend((0..w).map(|x| (1023 - x * 1023 / (w - 1)) as u16));
        }
    }
    samples
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect()
}

/// Distinct luma codes along the middle row of `file`'s first frame, decoded by FFmpeg.
fn luma_levels(tools: &Tools, file: &Path, width: u32, height: u32) -> usize {
    let output = command(&tools.ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(file)
        .args([
            "-frames:v",
            "1",
            "-vf",
            &format!("crop={width}:2:0:{},format=gray10le", height / 2),
            "-f",
            "rawvideo",
            "-",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let row: std::collections::BTreeSet<u16> = output.stdout[..2 * width as usize]
        .chunks(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    row.len()
}

#[test]
fn masters_keep_ten_bits_and_their_sound() {
    let Some((tools, _)) = setup() else { return };
    let dir = std::env::temp_dir().join(format!("cgv-master-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let (width, height) = (1920, 1080);
    for profile in [Profile::Prores422Hq, Profile::Prores4444] {
        let output = dir.join(format!("{profile:?}.mov"));
        let sound_path = dir.join("sound.f32");
        let sound = Sound {
            sample_rate: 48_000,
            channels: 2,
        };
        // A second of a 1 kHz tone, before the frames, as exports mix it.
        let mut writer = SoundWriter::create(&sound_path).unwrap();
        let tone: Vec<u8> = (0..48_000)
            .flat_map(|i| {
                let value = (i as f32 * std::f32::consts::TAU * 1000.0 / 48_000.0).sin() * 0.5;
                [value, value]
            })
            .flat_map(f32::to_le_bytes)
            .collect();
        writer.write(&tone).unwrap();
        writer.finish().unwrap();
        let request = MasterRequest {
            width,
            height,
            rate: (30, 1),
            profile,
            sound: Some((sound_path.clone(), sound)),
            output: output.clone(),
        };
        let mut master = MasterWriter::start(&tools, &request).unwrap();
        let frame = ramp(profile, width, height);
        assert_eq!(frame.len(), master.frame_bytes());
        for _ in 0..30 {
            master.write_frame(&frame).unwrap();
        }
        assert!(
            master.write_frame(&frame[1..]).is_err(),
            "a short frame is refused"
        );
        assert_eq!(master.finish().unwrap(), 30);

        let probed = probe::probe(&tools, &output).unwrap();
        let video = probed.video.unwrap();
        assert_eq!(video.codec, "prores");
        assert_eq!(
            (video.display_width, video.display_height, video.frame_count),
            (1920, 1080, 30)
        );
        let audio = probed.audio.unwrap();
        assert_eq!((audio.sample_rate, audio.channels), (48_000, 2));
        let streams = command(&tools.ffprobe)
            .args(["-v", "error", "-show_entries"])
            .arg("stream=codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries,color_range")
            .args(["-of", "compact"])
            .arg(&output)
            .output()
            .unwrap();
        let streams = String::from_utf8_lossy(&streams.stdout).to_string();
        let expected = match profile {
            Profile::Prores422Hq => "profile=HQ|pix_fmt=yuv422p10le",
            Profile::Prores4444 => "profile=4444|pix_fmt=yuva444p12le",
        };
        assert!(streams.contains(expected), "{streams}");
        assert!(
            streams.contains(
                "color_range=tv|color_space=bt709|color_transfer=bt709|color_primaries=bt709"
            ),
            "{streams}"
        );
        assert!(streams.contains("codec_name=pcm_s24le"), "{streams}");
        let levels = luma_levels(&tools, &output, width, height);
        assert!(levels >= 834, "{profile:?} kept {levels} of 877 levels");
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn originals_decode_every_frame_and_seek_to_any() {
    let Some((tools, media)) = setup() else {
        return;
    };
    let path = media.join("prores-720p2997-pcm.mov");
    let original = Original::probe(&tools, &path).unwrap();
    assert_eq!((original.width, original.height), (1280, 720));
    assert_eq!(original.layout.format, "I422P10");
    let frame_seconds = 1001.0 / 30000.0;
    let mut frames = Vec::new();
    let mut decoder = OriginalDecoder::start(&tools, &original, 0, 0.0, frame_seconds).unwrap();
    for _ in 0..90 {
        let mut frame = vec![0; original.frame_bytes as usize];
        decoder.read(&mut frame).unwrap();
        frames.push(frame);
    }
    let mut past = vec![0; original.frame_bytes as usize];
    assert!(decoder.read(&mut past).is_err(), "the clip has 90 frames");
    // A seek lands on exactly the frame asked for, whatever its time rounds to.
    for wanted in [1, 44, 45, 89] {
        let seconds = wanted as f64 * frame_seconds;
        let mut decoder =
            OriginalDecoder::start(&tools, &original, wanted, seconds, frame_seconds).unwrap();
        let mut frame = vec![0; original.frame_bytes as usize];
        decoder.read(&mut frame).unwrap();
        assert!(
            frame == frames[wanted as usize],
            "frame {wanted} after a seek differs"
        );
        assert_eq!(decoder.next, wanted + 1);
    }
}

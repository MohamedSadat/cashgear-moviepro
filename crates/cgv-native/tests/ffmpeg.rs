//! Runs the real LGPL FFmpeg against the test media. Skipped (with a message)
//! when FFmpeg or the clips are missing, unless CGV_REQUIRE_FFMPEG=1, as in CI.
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use cgv_native::ffmpeg::{command, Tools};
use cgv_native::{probe, proxy};

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

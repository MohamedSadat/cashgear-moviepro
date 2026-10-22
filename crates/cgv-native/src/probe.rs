//! `ffprobe` for every file the desktop app imports. When the engine's own
//! demuxer cannot read a container (AVI, MTS and so on), this probe still
//! describes it, and the file is edited through a proxy.
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::ffmpeg::{command, Tools};

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    format_name: Option<String>,
    duration: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    codec_tag_string: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    nb_frames: Option<String>,
    duration: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    color_primaries: Option<String>,
    color_transfer: Option<String>,
    color_space: Option<String>,
    color_range: Option<String>,
    #[serde(default)]
    side_data_list: Vec<SideData>,
    #[serde(default)]
    disposition: Disposition,
}

#[derive(Debug, Default, Deserialize)]
struct SideData {
    rotation: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
struct Disposition {
    #[serde(default)]
    attached_pic: u8,
}

/// The same shape as the engine's `MediaProbe` fields, so the worker can use it
/// directly when Mediabunny cannot read a file. Everything is marked
/// undecodable: such files are only ever edited through their proxy.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProbe {
    pub container: String,
    pub duration_seconds: f64,
    pub video: Option<NativeVideo>,
    pub audio: Option<NativeAudio>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeVideo {
    pub codec: String,
    pub codec_string: Option<String>,
    pub coded_width: u32,
    pub coded_height: u32,
    pub display_width: u32,
    pub display_height: u32,
    pub rotation: u16,
    pub frame_count: u64,
    pub frame_rate: f64,
    pub constant_frame_rate: bool,
    pub color: NativeColor,
    pub hdr: bool,
    pub decodable: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeColor {
    pub primaries: Option<String>,
    pub transfer: Option<String>,
    pub matrix: Option<String>,
    pub full_range: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudio {
    pub codec: String,
    pub codec_string: Option<String>,
    pub sample_rate: u32,
    pub channels: u32,
    pub decodable: bool,
}

fn rate(text: Option<&str>) -> f64 {
    let Some(text) = text else { return 0.0 };
    match text.split_once('/') {
        Some((num, den)) => {
            let (num, den) = (
                num.parse::<f64>().unwrap_or(0.0),
                den.parse::<f64>().unwrap_or(0.0),
            );
            if den > 0.0 {
                num / den
            } else {
                0.0
            }
        }
        None => text.parse().unwrap_or(0.0),
    }
}

/// FFmpeg codec names in the engine's (Mediabunny's) vocabulary.
fn video_codec(name: &str) -> String {
    match name {
        "h264" => "avc",
        "hevc" => "hevc",
        "vp8" => "vp8",
        "vp9" => "vp9",
        "av1" => "av1",
        "prores" => "prores",
        other => other,
    }
    .into()
}

fn audio_codec(name: &str) -> String {
    match name {
        "pcm_u8" => "pcm-u8".into(),
        "pcm_s16le" => "pcm-s16".into(),
        "pcm_s16be" => "pcm-s16be".into(),
        "pcm_s24le" => "pcm-s24".into(),
        "pcm_s24be" => "pcm-s24be".into(),
        "pcm_s32le" => "pcm-s32".into(),
        "pcm_s32be" => "pcm-s32be".into(),
        "pcm_f32le" => "pcm-f32".into(),
        "pcm_f32be" => "pcm-f32be".into(),
        "pcm_mulaw" => "ulaw".into(),
        "pcm_alaw" => "alaw".into(),
        other => other.into(),
    }
}

/// Parses `ffprobe -print_format json -show_format -show_streams` output.
pub fn parse(json: &str) -> Result<NativeProbe, String> {
    let output: FfprobeOutput = serde_json::from_str(json)
        .map_err(|error| format!("Unreadable ffprobe output: {error}"))?;
    let format = output.format.unwrap_or(FfprobeFormat {
        format_name: None,
        duration: None,
    });
    let video = output
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video") && s.disposition.attached_pic == 0);
    let audio = output
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));
    let duration = format
        .duration
        .as_deref()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    let video = video.map(|v| {
        let (width, height) = (v.width.unwrap_or(0), v.height.unwrap_or(0));
        // ffprobe reports counter-clockwise rotation; the engine uses clockwise.
        let ccw = v
            .side_data_list
            .iter()
            .find_map(|d| d.rotation)
            .unwrap_or(0.0)
            .round() as i64;
        let rotation = (360 - ccw.rem_euclid(360)).rem_euclid(360) as u16;
        let turned = !rotation.is_multiple_of(180);
        let frame_rate = match rate(v.avg_frame_rate.as_deref()) {
            fps if fps > 0.0 => fps,
            _ => rate(v.r_frame_rate.as_deref()),
        };
        let stream_duration = v
            .duration
            .as_deref()
            .and_then(|d| d.parse::<f64>().ok())
            .unwrap_or(duration);
        let frame_count = v
            .nb_frames
            .as_deref()
            .and_then(|n| n.parse().ok())
            .unwrap_or_else(|| (stream_duration * frame_rate).round().max(0.0) as u64);
        let transfer = v.color_transfer.clone();
        NativeVideo {
            codec: video_codec(v.codec_name.as_deref().unwrap_or("")),
            codec_string: v
                .codec_tag_string
                .clone()
                .filter(|tag| !tag.starts_with('[')),
            coded_width: width,
            coded_height: height,
            display_width: if turned { height } else { width },
            display_height: if turned { width } else { height },
            rotation,
            frame_count,
            frame_rate,
            constant_frame_rate: v.avg_frame_rate == v.r_frame_rate,
            hdr: matches!(
                transfer.as_deref(),
                Some("smpte2084") | Some("arib-std-b67")
            ),
            color: NativeColor {
                primaries: v.color_primaries.clone(),
                transfer,
                matrix: v.color_space.clone(),
                full_range: v.color_range.as_deref().map(|r| r == "pc"),
            },
            decodable: false,
        }
    });
    let audio = audio.map(|a| NativeAudio {
        codec: audio_codec(a.codec_name.as_deref().unwrap_or("")),
        codec_string: None,
        sample_rate: a
            .sample_rate
            .as_deref()
            .and_then(|r| r.parse().ok())
            .unwrap_or(0),
        channels: a.channels.unwrap_or(0),
        decodable: false,
    });
    if video.is_none() && audio.is_none() {
        return Err("The file has no audio or video stream".into());
    }
    Ok(NativeProbe {
        container: format
            .format_name
            .as_deref()
            .and_then(|names| names.split(',').next())
            .unwrap_or("unknown")
            .to_string(),
        duration_seconds: duration,
        video,
        audio,
    })
}

/// Runs ffprobe on a file.
pub fn probe(tools: &Tools, path: &Path) -> Result<NativeProbe, String> {
    let output = command(&tools.ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .map_err(|error| format!("ffprobe could not start: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffprobe could not read {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRORES: &str = r#"{
      "streams": [
        { "codec_type": "video", "codec_name": "prores", "codec_tag_string": "apco", "width": 1280,
          "height": 720, "avg_frame_rate": "30000/1001", "r_frame_rate": "30000/1001", "nb_frames": "90",
          "color_primaries": "bt709", "color_transfer": "bt709", "color_space": "bt709", "color_range": "tv",
          "disposition": { "attached_pic": 0 } },
        { "codec_type": "audio", "codec_name": "pcm_s16le", "sample_rate": "48000", "channels": 2 }
      ],
      "format": { "format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "3.003000" }
    }"#;

    #[test]
    fn parses_a_prores_mov() {
        let probe = parse(PRORES).unwrap();
        assert_eq!(probe.container, "mov");
        assert!((probe.duration_seconds - 3.003).abs() < 1e-9);
        let video = probe.video.unwrap();
        assert_eq!(video.codec, "prores");
        assert_eq!(video.codec_string.as_deref(), Some("apco"));
        assert_eq!((video.display_width, video.display_height), (1280, 720));
        assert_eq!(video.frame_count, 90);
        assert!((video.frame_rate - 29.97).abs() < 0.001);
        assert!(video.constant_frame_rate);
        assert_eq!(video.color.full_range, Some(false));
        assert!(!video.decodable);
        let audio = probe.audio.unwrap();
        assert_eq!(
            (audio.codec.as_str(), audio.sample_rate, audio.channels),
            ("pcm-s16", 48_000, 2)
        );
    }

    #[test]
    fn rotation_is_reported_clockwise() {
        let json = r#"{ "streams": [ { "codec_type": "video", "codec_name": "hevc", "width": 1920, "height": 1080,
            "avg_frame_rate": "24000/1001", "r_frame_rate": "24000/1001",
            "side_data_list": [ { "rotation": -90 } ] } ], "format": { "duration": "8.0" } }"#;
        let video = parse(json).unwrap().video.unwrap();
        assert_eq!(video.rotation, 90);
        assert_eq!((video.display_width, video.display_height), (1080, 1920));
        assert_eq!(video.frame_count, 192);
    }

    #[test]
    fn ignores_cover_art_and_rejects_empty_files() {
        let json = r#"{ "streams": [
            { "codec_type": "video", "codec_name": "mjpeg", "width": 600, "height": 600, "disposition": { "attached_pic": 1 } },
            { "codec_type": "audio", "codec_name": "mp3", "sample_rate": "44100", "channels": 2 } ],
          "format": { "format_name": "mp3", "duration": "10.0" } }"#;
        let probe = parse(json).unwrap();
        assert!(probe.video.is_none());
        assert_eq!(probe.audio.unwrap().codec, "mp3");
        assert!(parse(r#"{ "streams": [], "format": {} }"#).is_err());
        assert!(parse("not json").is_err());
    }
}

//! Human-readable codec names for the media library.

fn hex_byte(text: &str) -> Option<u8> {
    u8::from_str_radix(text.get(0..2)?, 16).ok()
}

/// "H.264 High", "HEVC Main 10", "VP9 Profile 0", "ProRes 422 HQ" and so on.
/// `codec` is Mediabunny's short name; `codec_string` the RFC 6381 string when known.
pub fn video_codec_label(codec: &str, codec_string: Option<&str>) -> String {
    let detail = codec_string.unwrap_or("");
    match codec {
        "avc" => {
            let profile = detail
                .split('.')
                .nth(1)
                .and_then(hex_byte)
                .map(|idc| match idc {
                    66 => "Baseline",
                    77 => "Main",
                    88 => "Extended",
                    100 => "High",
                    110 => "High 10",
                    122 => "High 4:2:2",
                    244 => "High 4:4:4",
                    _ => "",
                })
                .unwrap_or("");
            join("H.264", profile)
        }
        "hevc" => {
            let profile = detail
                .split('.')
                .nth(1)
                .map(|part| part.trim_start_matches(|c: char| c.is_ascii_alphabetic()))
                .and_then(|idc| idc.parse::<u8>().ok())
                .map(|idc| match idc {
                    1 => "Main",
                    2 => "Main 10",
                    3 => "Main Still Picture",
                    4 => "Range Extensions",
                    _ => "",
                })
                .unwrap_or("");
            join("HEVC", profile)
        }
        "vp9" => match detail.split('.').nth(1).and_then(|p| p.parse::<u8>().ok()) {
            Some(profile) => format!("VP9 Profile {profile}"),
            None => "VP9".into(),
        },
        "av1" => {
            let profile = match detail.split('.').nth(1) {
                Some("0") => "Main",
                Some("1") => "High",
                Some("2") => "Professional",
                _ => "",
            };
            join("AV1", profile)
        }
        "vp8" => "VP8".into(),
        "prores" => {
            let flavour = match detail.get(0..4) {
                Some("apco") => "422 Proxy",
                Some("apcs") => "422 LT",
                Some("apcn") => "422",
                Some("apch") => "422 HQ",
                Some("ap4h") => "4444",
                Some("ap4x") => "4444 XQ",
                _ => "",
            };
            join("ProRes", flavour)
        }
        "" => "Unknown".into(),
        other => other.to_uppercase(),
    }
}

pub fn audio_codec_label(codec: &str, codec_string: Option<&str>) -> String {
    match codec {
        "aac" => match codec_string.and_then(|s| s.rsplit('.').next()) {
            Some("5") => "HE-AAC".into(),
            Some("29") => "HE-AAC v2".into(),
            _ => "AAC-LC".into(),
        },
        "opus" => "Opus".into(),
        "mp3" => "MP3".into(),
        "vorbis" => "Vorbis".into(),
        "flac" => "FLAC".into(),
        "ac3" => "AC-3".into(),
        "eac3" => "E-AC-3".into(),
        "dts" => "DTS".into(),
        "ulaw" => "G.711 µ-law".into(),
        "alaw" => "G.711 A-law".into(),
        pcm if pcm.starts_with("pcm-") => {
            let kind = pcm.trim_start_matches("pcm-").trim_end_matches("be");
            match kind {
                "u8" => "PCM 8-bit".into(),
                "s8" => "PCM 8-bit signed".into(),
                "s16" => "PCM 16-bit".into(),
                "s24" => "PCM 24-bit".into(),
                "s32" => "PCM 32-bit".into(),
                "f32" => "PCM 32-bit float".into(),
                "f64" => "PCM 64-bit float".into(),
                _ => "PCM".into(),
            }
        }
        "" => "Unknown".into(),
        other => other.to_uppercase(),
    }
}

pub fn image_codec_label(codec: &str) -> String {
    match codec {
        "png" => "PNG".into(),
        "jpeg" => "JPEG".into(),
        "webp" => "WebP".into(),
        "gif" => "GIF".into(),
        other => other.to_uppercase(),
    }
}

pub fn channel_label(channels: u32) -> String {
    match channels {
        1 => "Mono".into(),
        2 => "Stereo".into(),
        6 => "5.1".into(),
        8 => "7.1".into(),
        n => format!("{n} channels"),
    }
}

fn join(name: &str, detail: &str) -> String {
    if detail.is_empty() {
        name.into()
    } else {
        format!("{name} {detail}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_labels() {
        assert_eq!(video_codec_label("avc", Some("avc1.640028")), "H.264 High");
        assert_eq!(
            video_codec_label("avc", Some("avc1.42E01E")),
            "H.264 Baseline"
        );
        assert_eq!(video_codec_label("avc", None), "H.264");
        assert_eq!(
            video_codec_label("hevc", Some("hvc1.1.6.L120.B0")),
            "HEVC Main"
        );
        assert_eq!(
            video_codec_label("hevc", Some("hev1.A2.4.L150")),
            "HEVC Main 10"
        );
        assert_eq!(
            video_codec_label("vp9", Some("vp09.00.10.08")),
            "VP9 Profile 0"
        );
        assert_eq!(video_codec_label("av1", Some("av01.0.08M.08")), "AV1 Main");
        assert_eq!(video_codec_label("prores", Some("apch")), "ProRes 422 HQ");
        assert_eq!(video_codec_label("prores", None), "ProRes");
        assert_eq!(video_codec_label("", None), "Unknown");
    }

    #[test]
    fn audio_and_image_labels() {
        assert_eq!(audio_codec_label("aac", Some("mp4a.40.2")), "AAC-LC");
        assert_eq!(audio_codec_label("aac", Some("mp4a.40.5")), "HE-AAC");
        assert_eq!(audio_codec_label("pcm-s16", None), "PCM 16-bit");
        assert_eq!(audio_codec_label("pcm-s24be", None), "PCM 24-bit");
        assert_eq!(audio_codec_label("pcm-f32", None), "PCM 32-bit float");
        assert_eq!(audio_codec_label("opus", None), "Opus");
        assert_eq!(image_codec_label("webp"), "WebP");
        assert_eq!(channel_label(2), "Stereo");
        assert_eq!(channel_label(6), "5.1");
        assert_eq!(channel_label(3), "3 channels");
    }
}

//! Proxies for media WebCodecs cannot decode, and for media too big to play
//! smoothly: H.264 MP4 at most `height` rows high (720 by default), a key frame every
//! 0.5 s, AAC audio, same frame timing and orientation as the original so
//! frame N of the proxy is frame N of the source.
use std::path::Path;
use std::sync::atomic::AtomicBool;

use crate::ffmpeg::{run_job, Tools};

pub struct ProxyRequest<'a> {
    pub input: &'a Path,
    pub output: &'a Path,
    pub encoder: &'a str,
    pub frame_rate: f64,
    pub duration_seconds: f64,
    pub has_audio: bool,
    /// The proxy's largest height in rows; never more than the original's.
    pub height: u32,
}

/// A proxy's height for an original `source` rows high at `size` (`full`,
/// `half` or `quarter`): never under 720 rows unless the original is, and even.
pub fn proxy_height(source: u32, size: &str) -> u32 {
    let divisor = match size {
        "full" => 1,
        "quarter" => 4,
        _ => 2,
    };
    ((source / divisor).max(source.min(720)) / 2 * 2).max(2)
}

/// FFmpeg arguments for one proxy (without the program name).
pub fn arguments(request: &ProxyRequest) -> Vec<String> {
    let gop = ((request.frame_rate * 0.5).round() as u32)
        .max(1)
        .to_string();
    let pixel_format = if request.encoder == "libopenh264" {
        "yuv420p"
    } else {
        "nv12"
    };
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-y",
        // Keep the coded orientation; rotation stays metadata, as in the original.
        "-noautorotate",
        "-i",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    args.push(request.input.display().to_string());
    for arg in [
        "-map",
        "0:v:0",
        "-vf",
        // `height` at most (never upscaled), even width, square pixels.
        &format!(
            "scale=w=-2:h='min({},ih)':flags=bicubic,setsar=1",
            request.height
        ),
        "-fps_mode",
        "passthrough",
        "-pix_fmt",
        pixel_format,
        "-c:v",
        request.encoder,
        "-b:v",
        // 6 Mbit/s at 720p, more for bigger proxies.
        &format!(
            "{}k",
            6000 * request.height.max(720) / 720 * request.height.max(720) / 720
        ),
        "-g",
        &gop,
        "-keyint_min",
        &gop,
        "-bf",
        "0",
    ] {
        args.push(arg.to_string());
    }
    if request.has_audio {
        for arg in ["-map", "0:a:0", "-c:a", "aac", "-b:a", "160k"] {
            args.push(arg.to_string());
        }
    }
    for arg in [
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        "-progress",
        "pipe:1",
    ] {
        args.push(arg.to_string());
    }
    args.push(request.output.display().to_string());
    args
}

/// Transcodes a proxy, calling `on_progress` as it goes. Writes to a `.part`
/// file and renames it only when FFmpeg succeeds; `cancel` stops it.
pub fn run(
    tools: &Tools,
    request: &ProxyRequest,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f32),
) -> Result<(), String> {
    let partial = request.output.with_extension("part.mp4");
    let job = ProxyRequest {
        output: &partial,
        ..*request
    };
    if let Some(parent) = request.output.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("Proxy folder: {error}"))?;
    }
    if let Err(error) = run_job(
        tools,
        &arguments(&job),
        request.duration_seconds,
        cancel,
        &mut on_progress,
        "make the proxy",
    ) {
        let _ = std::fs::remove_file(&partial);
        return Err(if error == "Cancelled" {
            "The proxy was cancelled".into()
        } else {
            error
        });
    }
    std::fs::rename(&partial, request.output).map_err(|error| format!("Proxy file: {error}"))?;
    on_progress(1.0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn request<'a>(input: &'a Path, output: &'a Path, encoder: &'a str) -> ProxyRequest<'a> {
        ProxyRequest {
            input,
            output,
            encoder,
            frame_rate: 30000.0 / 1001.0,
            duration_seconds: 3.003,
            has_audio: true,
            height: 720,
        }
    }

    #[test]
    fn proxies_are_half_size_but_never_under_720_rows() {
        assert_eq!(proxy_height(2160, "half"), 1080);
        assert_eq!(proxy_height(2160, "quarter"), 720);
        assert_eq!(proxy_height(2160, "full"), 2160);
        assert_eq!(proxy_height(1080, "half"), 720);
        assert_eq!(proxy_height(720, "half"), 720);
        assert_eq!(proxy_height(480, "quarter"), 480);
        assert_eq!(proxy_height(4320, "half"), 2160);
    }

    #[test]
    fn arguments_keep_timing_and_set_a_half_second_gop() {
        let (input, output) = (PathBuf::from("in.mov"), PathBuf::from("out.mp4"));
        let args = arguments(&request(&input, &output, "h264_mf"));
        let joined = args.join(" ");
        assert!(joined.contains("-noautorotate -i in.mov"));
        assert!(joined.contains("-fps_mode passthrough"));
        assert!(joined.contains("-g 15 -keyint_min 15"));
        assert!(joined.contains("-pix_fmt nv12 -c:v h264_mf"));
        assert!(joined.contains("-map 0:a:0 -c:a aac"));
        assert!(joined.ends_with("-progress pipe:1 out.mp4"));
        let openh264 = arguments(&request(&input, &output, "libopenh264")).join(" ");
        assert!(openh264.contains("-pix_fmt yuv420p -c:v libopenh264"));
        let mut silent = request(&input, &output, "h264_mf");
        silent.has_audio = false;
        assert!(!arguments(&silent).join(" ").contains("0:a:0"));
    }
}

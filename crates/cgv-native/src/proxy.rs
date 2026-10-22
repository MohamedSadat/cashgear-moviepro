//! Proxies for media WebCodecs cannot decode: 720p H.264 MP4, a key frame every
//! 0.5 s, AAC audio, same frame timing and orientation as the original so
//! frame N of the proxy is frame N of the source.
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::ffmpeg::{command, Tools};

pub struct ProxyRequest<'a> {
    pub input: &'a Path,
    pub output: &'a Path,
    pub encoder: &'a str,
    pub frame_rate: f64,
    pub duration_seconds: f64,
    pub has_audio: bool,
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
        // 720p at most (never upscaled), even width, square pixels.
        "scale=w=-2:h='min(720,ih)':flags=bicubic,setsar=1",
        "-fps_mode",
        "passthrough",
        "-pix_fmt",
        pixel_format,
        "-c:v",
        request.encoder,
        "-b:v",
        "6M",
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

/// Progress from one `-progress` line (`out_time_us=…`), as a fraction of the duration.
pub fn progress_from_line(line: &str, duration_seconds: f64) -> Option<f32> {
    let micros: f64 = line.strip_prefix("out_time_us=")?.trim().parse().ok()?;
    if duration_seconds <= 0.0 {
        return None;
    }
    Some((micros / 1e6 / duration_seconds).clamp(0.0, 1.0) as f32)
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
    let mut child = command(&tools.ffmpeg)
        .args(arguments(&job))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("ffmpeg could not start: {error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    for line in BufReader::new(stdout).lines() {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&partial);
            return Err("The proxy was cancelled".into());
        }
        if let Some(progress) = line
            .ok()
            .and_then(|l| progress_from_line(&l, request.duration_seconds))
        {
            on_progress(progress);
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("ffmpeg failed: {error}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(format!(
            "ffmpeg could not make the proxy: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
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
        }
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

    #[test]
    fn progress_lines() {
        assert_eq!(progress_from_line("out_time_us=1501500", 3.003), Some(0.5));
        assert_eq!(progress_from_line("out_time_us=9000000", 3.003), Some(1.0));
        assert_eq!(progress_from_line("frame=10", 3.003), None);
        assert_eq!(progress_from_line("out_time_us=N/A", 3.003), None);
        assert_eq!(progress_from_line("out_time_us=10", 0.0), None);
    }
}

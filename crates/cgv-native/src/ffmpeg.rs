//! Finds the LGPL FFmpeg build. The app runs `ffmpeg` and `ffprobe` as child
//! processes; it never links libav* into its own process.
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// A command that never opens a console window on Windows.
pub fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.stdin(Stdio::null());
    command
}

impl Tools {
    pub fn in_dir(dir: &Path) -> Tools {
        Tools {
            ffmpeg: dir.join(exe("ffmpeg")),
            ffprobe: dir.join(exe("ffprobe")),
        }
    }

    /// `CGV_FFMPEG_DIR`, then an `ffmpeg` folder next to the app, then PATH.
    pub fn locate(app_dir: Option<&Path>) -> Result<Tools, String> {
        let mut candidates = Vec::new();
        if let Some(dir) = std::env::var_os("CGV_FFMPEG_DIR") {
            candidates.push(PathBuf::from(dir));
        }
        if let Some(dir) = app_dir {
            candidates.push(dir.join("ffmpeg"));
        }
        for dir in candidates {
            let tools = Tools::in_dir(&dir);
            if tools.ffmpeg.is_file() && tools.ffprobe.is_file() {
                return Ok(tools);
            }
        }
        let on_path = Tools {
            ffmpeg: PathBuf::from(exe("ffmpeg")),
            ffprobe: PathBuf::from(exe("ffprobe")),
        };
        let runs = command(&on_path.ffprobe)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if runs {
            Ok(on_path)
        } else {
            Err("FFmpeg was not found. Run `pnpm setup:ffmpeg` or set CGV_FFMPEG_DIR.".into())
        }
    }

    /// Fails if this build was configured with `--enable-gpl` or `--enable-nonfree`.
    pub fn check_license(&self) -> Result<(), String> {
        let output = command(&self.ffmpeg)
            .args(["-hide_banner", "-version"])
            .output()
            .map_err(|error| format!("ffmpeg could not start: {error}"))?;
        let text = String::from_utf8_lossy(&output.stdout);
        let configuration = text
            .lines()
            .find(|line| line.starts_with("configuration:"))
            .unwrap_or("");
        if configuration.contains("--enable-gpl") || configuration.contains("--enable-nonfree") {
            return Err(
                "This FFmpeg build includes GPL or nonfree code and cannot be used.".into(),
            );
        }
        Ok(())
    }

    /// The best working H.264 encoder: GPU, then the OS encoder, then OpenH264.
    /// Probed once per process by encoding two frames.
    pub fn h264_encoder(&self) -> Option<&'static str> {
        static CHOSEN: OnceLock<Option<&'static str>> = OnceLock::new();
        *CHOSEN.get_or_init(|| {
            let mut order = vec!["h264_nvenc"];
            if cfg!(windows) {
                order.push("h264_mf");
            }
            if cfg!(target_os = "macos") {
                order.push("h264_videotoolbox");
            }
            order.push("libopenh264");
            order
                .into_iter()
                .find(|encoder| self.encoder_works(encoder))
        })
    }

    fn encoder_works(&self, encoder: &str) -> bool {
        command(&self.ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=30",
                "-frames:v",
                "2",
                "-pix_fmt",
                if encoder == "libopenh264" {
                    "yuv420p"
                } else {
                    "nv12"
                },
                "-c:v",
                encoder,
                "-f",
                "null",
                "-",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

/// Progress from one `-progress` line (`out_time_us=…`), as a fraction of the duration.
pub fn progress_from_line(line: &str, duration_seconds: f64) -> Option<f32> {
    let micros: f64 = line.strip_prefix("out_time_us=")?.trim().parse().ok()?;
    if duration_seconds <= 0.0 {
        return None;
    }
    Some((micros / 1e6 / duration_seconds).clamp(0.0, 1.0) as f32)
}

/// Runs one FFmpeg job whose arguments end with `-progress pipe:1` and the
/// output, reporting progress against `duration_seconds`. `cancel` kills it.
/// `what` names the job in errors ("make the proxy").
pub fn run_job(
    tools: &Tools,
    args: &[String],
    duration_seconds: f64,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f32),
    what: &str,
) -> Result<(), String> {
    let mut child = command(&tools.ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("ffmpeg could not start: {error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    for line in BufReader::new(stdout).lines() {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cancelled".into());
        }
        if let Some(progress) = line
            .ok()
            .and_then(|l| progress_from_line(&l, duration_seconds))
        {
            on_progress(progress);
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("ffmpeg failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ffmpeg could not {what}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_live_side_by_side() {
        let tools = Tools::in_dir(Path::new("bin"));
        assert_eq!(tools.ffmpeg, Path::new("bin").join(exe("ffmpeg")));
        assert_eq!(tools.ffprobe, Path::new("bin").join(exe("ffprobe")));
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

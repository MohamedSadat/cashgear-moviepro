//! Finds the LGPL FFmpeg build. The app runs `ffmpeg` and `ffprobe` as child
//! processes; it never links libav* into its own process.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_live_side_by_side() {
        let tools = Tools::in_dir(Path::new("bin"));
        assert_eq!(tools.ffmpeg, Path::new("bin").join(exe("ffmpeg")));
        assert_eq!(tools.ffprobe, Path::new("bin").join(exe("ffprobe")));
    }
}

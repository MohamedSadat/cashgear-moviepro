//! Originals for exports. Media the webview plays only through a proxy (ProRes,
//! DNxHR, HEVC where WebView2 lacks it) is decoded by FFmpeg into raw planar
//! frames at its own size and bit depth, so an export never reads a proxy.
//! Proxies keep every frame of their original (`-fps_mode passthrough`), so
//! frame `n` of one is frame `n` of the other.
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Stdio};

use serde::Serialize;

use crate::ffmpeg::{command, Tools};

/// How FFmpeg hands an original's frames over: its pixel format, and the
/// WebCodecs name the engine reads them by.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Layout {
    #[serde(skip)]
    pub pixel_format: &'static str,
    /// `I420`, `I420P10`, `I422P10`, `I422P12`, `I444P10` or `I444P12`.
    pub format: &'static str,
    /// Chroma is subsampled this many times across and down.
    #[serde(skip)]
    pub chroma: (u32, u32),
    /// Bytes a sample takes: 1 for 8-bit, 2 for deeper.
    #[serde(skip)]
    pub sample_bytes: u32,
}

impl Layout {
    /// The layout that keeps all of `source`'s precision (an FFmpeg pixel format):
    /// 8-bit 4:2:0 stays as it is; deeper or less subsampled pictures go to 10 or
    /// 12 bits at their own chroma. Alpha is dropped: layers from originals are opaque.
    pub fn for_source(source: &str) -> Layout {
        let depth = source
            .trim_end_matches("le")
            .trim_end_matches("be")
            .rsplit('p')
            .next()
            .and_then(|digits| digits.parse::<u32>().ok())
            .unwrap_or(8);
        let deep = |pixel_format, format, chroma| Layout {
            pixel_format,
            format,
            chroma,
            sample_bytes: 2,
        };
        if source.contains("420") || source.starts_with("nv12") || source.starts_with("p010") {
            if depth > 8 || source.starts_with("p010") {
                return deep("yuv420p10le", "I420P10", (2, 2));
            }
            return Layout {
                pixel_format: "yuv420p",
                format: "I420",
                chroma: (2, 2),
                sample_bytes: 1,
            };
        }
        if source.contains("422") {
            return if depth > 10 {
                deep("yuv422p12le", "I422P12", (2, 1))
            } else {
                deep("yuv422p10le", "I422P10", (2, 1))
            };
        }
        if source.contains("444") || source.starts_with("gbr") || source.starts_with("rgb") {
            return if depth > 10 {
                deep("yuv444p12le", "I444P12", (1, 1))
            } else {
                deep("yuv444p10le", "I444P10", (1, 1))
            };
        }
        deep("yuv422p10le", "I422P10", (2, 1))
    }

    /// Offset and stride in bytes of each plane of a `width` × `height` frame,
    /// tightly packed as FFmpeg writes raw video.
    pub fn planes(&self, width: u32, height: u32) -> [(u64, u64); 3] {
        let (w, h) = (u64::from(width), u64::from(height));
        let bytes = u64::from(self.sample_bytes);
        let cw = w.div_ceil(u64::from(self.chroma.0));
        let ch = h.div_ceil(u64::from(self.chroma.1));
        let luma = w * h * bytes;
        let chroma = cw * ch * bytes;
        [
            (0, w * bytes),
            (luma, cw * bytes),
            (luma + chroma, cw * bytes),
        ]
    }

    pub fn frame_bytes(&self, width: u32, height: u32) -> u64 {
        let [_, _, (offset, stride)] = self.planes(width, height);
        offset + stride * u64::from(height).div_ceil(u64::from(self.chroma.1))
    }
}

/// An original's first video stream: its frame size, before rotation, and layout.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Original {
    #[serde(skip)]
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
    #[serde(flatten)]
    pub layout: Layout,
    pub frame_bytes: u64,
}

impl Original {
    /// Asks ffprobe for `path`'s video size and pixel format.
    pub fn probe(tools: &Tools, path: &Path) -> Result<Original, String> {
        let output = command(&tools.ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,pix_fmt",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .map_err(|error| format!("ffprobe could not start: {error}"))?;
        let text = String::from_utf8_lossy(&output.stdout);
        let fields: Vec<&str> = text.trim().split(',').collect();
        let [width, height, pixel_format] = fields[..] else {
            return Err(format!("{} has no video ffprobe can read", path.display()));
        };
        let (width, height) = (
            width.parse().map_err(|_| "ffprobe gave no width")?,
            height.parse().map_err(|_| "ffprobe gave no height")?,
        );
        let layout = Layout::for_source(pixel_format);
        Ok(Original {
            path: path.to_path_buf(),
            width,
            height,
            layout,
            frame_bytes: layout.frame_bytes(width, height),
        })
    }

    /// FFmpeg arguments (without the program name) that decode from `seconds` on,
    /// every frame as it is coded (no rotation), as raw frames on standard output.
    pub fn arguments(&self, seconds: f64) -> Vec<String> {
        let mut args: Vec<String> = ["-hide_banner", "-nostats", "-loglevel", "error"]
            .map(String::from)
            .to_vec();
        if seconds > 0.0 {
            args.extend(["-ss".into(), format!("{seconds:.6}")]);
        }
        args.extend(["-noautorotate", "-i"].map(String::from));
        args.push(self.path.display().to_string());
        args.extend(
            [
                "-map",
                "0:v:0",
                "-fps_mode",
                "passthrough",
                "-f",
                "rawvideo",
                "-pix_fmt",
                self.layout.pixel_format,
                "pipe:1",
            ]
            .map(String::from),
        );
        args
    }
}

/// FFmpeg decoding an original from some frame on, read one frame at a time.
pub struct OriginalDecoder {
    child: Child,
    stdout: BufReader<ChildStdout>,
    /// The frame the next read gives.
    pub next: u64,
}

impl OriginalDecoder {
    /// Starts decoding at frame `frame`, which begins at `seconds`. FFmpeg seeks
    /// exactly, giving the first frame at or after the time it is asked for: half
    /// a frame before `seconds` lands on `frame` whatever the rounding.
    pub fn start(
        tools: &Tools,
        original: &Original,
        frame: u64,
        seconds: f64,
        frame_seconds: f64,
    ) -> Result<OriginalDecoder, String> {
        let from = if frame == 0 {
            0.0
        } else {
            (seconds - frame_seconds / 2.0).max(0.0)
        };
        let mut child = command(&tools.ffmpeg)
            .args(original.arguments(from))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("ffmpeg could not start: {error}"))?;
        let stdout = child.stdout.take().ok_or("ffmpeg gave no output")?;
        Ok(OriginalDecoder {
            child,
            stdout: BufReader::with_capacity(1 << 22, stdout),
            next: frame,
        })
    }

    /// Reads the next frame into `frame`, which must be exactly one frame long.
    pub fn read(&mut self, frame: &mut [u8]) -> Result<(), String> {
        self.stdout
            .read_exact(frame)
            .map_err(|_| format!("The original has no frame {}", self.next))?;
        self.next += 1;
        Ok(())
    }
}

impl Drop for OriginalDecoder {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_keep_each_sources_precision() {
        assert_eq!(Layout::for_source("yuv420p").format, "I420");
        assert_eq!(Layout::for_source("yuvj420p").format, "I420");
        assert_eq!(Layout::for_source("yuv420p10le").format, "I420P10");
        assert_eq!(Layout::for_source("p010le").format, "I420P10");
        assert_eq!(Layout::for_source("yuv422p10le").format, "I422P10");
        assert_eq!(Layout::for_source("yuv422p").format, "I422P10");
        assert_eq!(Layout::for_source("yuv422p12le").format, "I422P12");
        assert_eq!(Layout::for_source("yuva444p12le").format, "I444P12");
        assert_eq!(Layout::for_source("yuv444p10le").format, "I444P10");
        assert_eq!(Layout::for_source("gbrp10le").format, "I444P10");
    }

    #[test]
    fn frames_are_tightly_packed_planes() {
        let layout = Layout::for_source("yuv422p10le");
        assert_eq!(
            layout.planes(1920, 1080),
            [(0, 3840), (4_147_200, 1920), (6_220_800, 1920)]
        );
        assert_eq!(layout.frame_bytes(1920, 1080), 8_294_400);
        let eight = Layout::for_source("yuv420p");
        assert_eq!(eight.frame_bytes(1280, 720), 1_382_400);
    }
}

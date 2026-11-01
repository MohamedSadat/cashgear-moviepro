//! Masters: ProRes files that FFmpeg encodes from the engine's 10-bit frames.
//! The webview renders each frame and reads it back as planar 10-bit Y'CbCr;
//! the frames reach FFmpeg's standard input through shared memory, and only
//! they cross: browsers cannot encode ProRes. The sound is mixed first, into a
//! raw file beside the export, which FFmpeg reads as its second input.
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};

use serde::Deserialize;

use crate::ffmpeg::{command, Tools};

/// The ProRes flavours a master can be.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum Profile {
    /// 10-bit 4:2:2, about 220 Mbit/s at 1080p30.
    #[serde(rename = "prores-422-hq")]
    Prores422Hq,
    /// 10-bit 4:4:4 with a 16-bit alpha channel.
    #[serde(rename = "prores-4444")]
    Prores4444,
}

impl Profile {
    /// The frames' layout as FFmpeg names it: what the engine reads back.
    pub fn pixel_format(self) -> &'static str {
        match self {
            Profile::Prores422Hq => "yuv422p10le",
            Profile::Prores4444 => "yuva444p10le",
        }
    }

    /// The bytes one frame of `width` × `height` takes.
    pub fn frame_bytes(self, width: u32, height: u32) -> u64 {
        let pixels = u64::from(width) * u64::from(height);
        match self {
            // Luma, then Cb and Cr at half width: two bytes a sample.
            Profile::Prores422Hq => 2 * (pixels + pixels),
            // Luma, Cb, Cr and alpha at full size.
            Profile::Prores4444 => 2 * 4 * pixels,
        }
    }
}

/// The sound FFmpeg reads beside the frames: 32-bit float samples, interleaved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sound {
    pub sample_rate: u32,
    pub channels: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MasterRequest {
    pub width: u32,
    pub height: u32,
    /// Frames a second as `num / den`.
    pub rate: (u32, u32),
    pub profile: Profile,
    /// The raw sound file and its layout, when the master has sound.
    pub sound: Option<(PathBuf, Sound)>,
    pub output: PathBuf,
}

/// FFmpeg arguments (without the program name) for a master: frames on standard
/// input, tagged BT.709 limited range (encoders take the frames' tags), and the
/// sound as 24-bit PCM.
pub fn arguments(request: &MasterRequest) -> Vec<String> {
    let mut args: Vec<String> = [
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        request.profile.pixel_format(),
        "-s",
        &format!("{}x{}", request.width, request.height),
        "-framerate",
        &format!("{}/{}", request.rate.0, request.rate.1),
        "-i",
        "pipe:0",
    ]
    .map(String::from)
    .to_vec();
    if let Some((path, sound)) = &request.sound {
        args.extend(
            [
                "-f",
                "f32le",
                "-ar",
                &sound.sample_rate.to_string(),
                "-ac",
                &sound.channels.to_string(),
                "-i",
            ]
            .map(String::from),
        );
        args.push(path.display().to_string());
    }
    args.extend(["-map", "0:v:0"].map(String::from));
    if request.sound.is_some() {
        args.extend(["-map", "1:a:0", "-c:a", "pcm_s24le"].map(String::from));
    }
    args.extend(
        [
            "-vf",
            "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
            "-c:v",
            "prores_ks",
            "-vendor",
            "apl0",
            "-pix_fmt",
            request.profile.pixel_format(),
        ]
        .map(String::from),
    );
    match request.profile {
        Profile::Prores422Hq => args.extend(["-profile:v", "3"].map(String::from)),
        Profile::Prores4444 => {
            args.extend(["-profile:v", "4", "-alpha_bits", "16"].map(String::from))
        }
    }
    args.extend(["-f", "mov"].map(String::from));
    args.push(request.output.display().to_string());
    args
}

/// Collects a master's sound before its frames start.
pub struct SoundWriter {
    file: BufWriter<File>,
}

impl SoundWriter {
    pub fn create(path: &Path) -> Result<SoundWriter, String> {
        let file = File::create(path)
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        Ok(SoundWriter {
            file: BufWriter::with_capacity(1 << 20, file),
        })
    }

    /// Appends interleaved 32-bit float samples, little-endian.
    pub fn write(&mut self, samples: &[u8]) -> Result<(), String> {
        if !samples.len().is_multiple_of(4) {
            return Err("Sound must be whole 32-bit samples".into());
        }
        self.file
            .write_all(samples)
            .map_err(|error| format!("Could not write the sound: {error}"))
    }

    pub fn finish(mut self) -> Result<(), String> {
        self.file
            .flush()
            .map_err(|error| format!("Could not write the sound: {error}"))
    }
}

/// FFmpeg encoding a master, fed one frame at a time.
pub struct MasterWriter {
    child: Child,
    stdin: Option<ChildStdin>,
    frame_bytes: usize,
    frames: u64,
}

impl MasterWriter {
    pub fn start(tools: &Tools, request: &MasterRequest) -> Result<MasterWriter, String> {
        let mut child = command(&tools.ffmpeg)
            .args(arguments(request))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("ffmpeg could not start: {error}"))?;
        let stdin = child.stdin.take();
        Ok(MasterWriter {
            child,
            stdin,
            frame_bytes: request.profile.frame_bytes(request.width, request.height) as usize,
            frames: 0,
        })
    }

    /// The bytes each frame must have.
    pub fn frame_bytes(&self) -> usize {
        self.frame_bytes
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Hands FFmpeg the next frame; blocks while it encodes the ones before.
    pub fn write_frame(&mut self, frame: &[u8]) -> Result<(), String> {
        if frame.len() != self.frame_bytes {
            return Err(format!(
                "A frame has {} bytes where {} were expected",
                frame.len(),
                self.frame_bytes
            ));
        }
        let stdin = self.stdin.as_mut().ok_or("This master is finished")?;
        if let Err(error) = stdin.write_all(frame) {
            // FFmpeg stopped: what it said is the better message.
            return Err(self
                .failure()
                .unwrap_or_else(|| format!("ffmpeg stopped: {error}")));
        }
        self.frames += 1;
        Ok(())
    }

    /// Ends the frames and waits for FFmpeg to write the file.
    pub fn finish(mut self) -> Result<u64, String> {
        drop(self.stdin.take());
        let output = self
            .child
            .wait_with_output()
            .map_err(|error| format!("ffmpeg failed: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "ffmpeg could not write the master: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(self.frames)
    }

    /// Stops FFmpeg; the caller removes the partial file.
    pub fn cancel(mut self) {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// FFmpeg's error after it stopped early.
    fn failure(&mut self) -> Option<String> {
        drop(self.stdin.take());
        let _ = self.child.kill();
        let mut stderr = self.child.stderr.take()?;
        let mut text = String::new();
        std::io::Read::read_to_string(&mut stderr, &mut text).ok()?;
        let text = text.trim();
        (!text.is_empty()).then(|| format!("ffmpeg could not write the master: {text}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(profile: Profile, sound: bool) -> MasterRequest {
        MasterRequest {
            width: 1920,
            height: 1080,
            rate: (30000, 1001),
            profile,
            sound: sound.then(|| {
                (
                    PathBuf::from("sound.f32"),
                    Sound {
                        sample_rate: 48000,
                        channels: 2,
                    },
                )
            }),
            output: PathBuf::from("out.mov"),
        }
    }

    #[test]
    fn frames_have_the_engine_layouts_sizes() {
        assert_eq!(Profile::Prores422Hq.frame_bytes(1920, 1080), 8_294_400);
        assert_eq!(Profile::Prores4444.frame_bytes(1920, 1080), 16_588_800);
    }

    #[test]
    fn hq_masters_read_422_frames_and_sound() {
        let args = arguments(&request(Profile::Prores422Hq, true)).join(" ");
        assert!(args.contains(
            "-f rawvideo -pix_fmt yuv422p10le -s 1920x1080 -framerate 30000/1001 -i pipe:0"
        ));
        assert!(args.contains("-f f32le -ar 48000 -ac 2 -i sound.f32"));
        assert!(args.contains("-map 0:v:0 -map 1:a:0 -c:a pcm_s24le"));
        assert!(args.contains("-c:v prores_ks -vendor apl0 -pix_fmt yuv422p10le -profile:v 3"));
        assert!(args
            .contains("setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"));
        assert!(args.ends_with("-f mov out.mov"));
    }

    #[test]
    fn masters_with_alpha_keep_it() {
        let args = arguments(&request(Profile::Prores4444, false)).join(" ");
        assert!(args.contains("-pix_fmt yuva444p10le -profile:v 4 -alpha_bits 16"));
        assert!(!args.contains("-map 1:a:0"));
    }
}

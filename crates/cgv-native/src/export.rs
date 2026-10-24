//! Export files on the desktop. The engine renders, encodes and muxes in the
//! webview; the native side writes the bytes it is given (never raw frames)
//! where the user chose, and converts the finished file with FFmpeg into the
//! formats browsers cannot write: GIF and MP3.
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Formats FFmpeg makes from an intermediate export.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Conversion {
    Gif,
    Mp3,
}

impl Conversion {
    /// What the webview writes first: H.264 MP4 for a GIF, 16-bit WAV for an MP3.
    pub fn intermediate_extension(self) -> &'static str {
        match self {
            Conversion::Gif => "mp4",
            Conversion::Mp3 => "wav",
        }
    }

    /// FFmpeg arguments (without the program name) from `input` to `output`.
    /// The intermediate already has the GIF's size and frame rate.
    pub fn arguments(self, input: &Path, output: &Path, audio_bitrate: u32) -> Vec<String> {
        let mut args: Vec<String> = ["-hide_banner", "-nostats", "-loglevel", "error", "-y", "-i"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        args.push(input.display().to_string());
        match self {
            Conversion::Gif => {
                // One palette for the whole clip, built from what changes between frames.
                args.extend(
                    [
                        "-filter_complex",
                        "[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];\
                         [b][p]paletteuse=dither=sierra2_4a",
                        "-loop",
                        "0",
                        "-f",
                        "gif",
                    ]
                    .map(String::from),
                );
            }
            Conversion::Mp3 => {
                let bitrate = format!("{}k", (audio_bitrate / 1000).clamp(64, 320));
                args.extend(
                    ["-c:a", "libmp3lame", "-b:a", &bitrate, "-f", "mp3"].map(String::from),
                );
            }
        }
        args.extend(["-progress", "pipe:1"].map(String::from));
        args.push(output.display().to_string());
        args
    }
}

/// Where a file is written until it is complete: beside it, so finishing is a
/// rename and a failed export never touches a file that was already there.
pub fn part_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    path.with_file_name(name)
}

/// A file written at the positions the muxer chooses (it goes back to fill in
/// headers and indexes).
pub struct ExportWriter {
    file: File,
    path: PathBuf,
    size: u64,
}

impl ExportWriter {
    pub fn create(path: &Path) -> Result<ExportWriter, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("Export folder: {error}"))?;
        }
        let file =
            File::create(path).map_err(|error| format!("Could not create the file: {error}"))?;
        Ok(ExportWriter {
            file,
            path: path.to_path_buf(),
            size: 0,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The file's size so far.
    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn write_at(&mut self, position: u64, data: &[u8]) -> Result<(), String> {
        self.file
            .seek(SeekFrom::Start(position))
            .and_then(|_| self.file.write_all(data))
            .map_err(|error| format!("Could not write the export: {error}"))?;
        self.size = self.size.max(position + data.len() as u64);
        Ok(())
    }

    /// Flushes everything to disk and closes the file.
    pub fn finish(mut self) -> Result<PathBuf, String> {
        self.file
            .flush()
            .and_then(|_| self.file.sync_all())
            .map_err(|error| format!("Could not finish the export: {error}"))?;
        Ok(self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_land_where_the_muxer_puts_them() {
        let dir = std::env::temp_dir().join(format!("cgv-export-test-{}", std::process::id()));
        let path = dir.join("clip.mp4.part");
        let mut writer = ExportWriter::create(&path).unwrap();
        writer.write_at(0, b"head....").unwrap();
        writer.write_at(8, b"body").unwrap();
        // The header is filled in at the end, as an MP4 muxer does.
        writer.write_at(4, b"SIZE").unwrap();
        assert_eq!(writer.size(), 12);
        let written = writer.finish().unwrap();
        assert_eq!(std::fs::read(&written).unwrap(), b"headSIZEbody");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn part_files_sit_beside_the_export() {
        assert_eq!(
            part_path(Path::new("videos/Trip.mp4")),
            Path::new("videos/Trip.mp4.part")
        );
    }

    #[test]
    fn conversions_make_gif_and_mp3() {
        let (input, output) = (Path::new("in.mp4"), Path::new("out.gif.part"));
        let gif = Conversion::Gif.arguments(input, output, 0).join(" ");
        assert!(gif.contains("-i in.mp4 -filter_complex [0:v]split[a][b];[a]palettegen"));
        assert!(gif.contains("paletteuse=dither=sierra2_4a -loop 0 -f gif"));
        assert!(gif.ends_with("-progress pipe:1 out.gif.part"));
        let mp3 = Conversion::Mp3
            .arguments(Path::new("in.wav"), Path::new("out.mp3"), 256_000)
            .join(" ");
        assert!(mp3.contains("-i in.wav -c:a libmp3lame -b:a 256k -f mp3"));
        let low = Conversion::Mp3.arguments(input, output, 8_000).join(" ");
        assert!(low.contains("-b:a 64k"));
        assert_eq!(Conversion::Gif.intermediate_extension(), "mp4");
        assert_eq!(Conversion::Mp3.intermediate_extension(), "wav");
    }
}

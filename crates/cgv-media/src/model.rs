use cgv_time::{Flicks, FrameRate};
use serde::{Deserialize, Serialize};

/// Where a media item's bytes come from. The engine worker keeps the actual
/// handle, file or URL; the model only records which kind it is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MediaSource {
    /// A File System Access handle (web: Chrome, Edge).
    Handle,
    /// A copy in the origin-private file system (web, other browsers).
    Opfs { path: String },
    /// A local file streamed through the `cgv-media://` protocol (desktop).
    Path { path: String },
    /// A file of the app's own pack (a sticker), by its path under `assets`.
    Pack { path: String },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorInfo {
    pub primaries: Option<String>,
    pub transfer: Option<String>,
    pub matrix: Option<String>,
    pub full_range: Option<bool>,
}

/// What the worker measured for a file. Input to [`crate::MediaLibrary::add`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub source: MediaSource,
    /// Container short name: mp4, mov, webm, matroska, mp3, wav, adts, ogg, flac, png, jpeg, webp.
    pub container: String,
    pub duration_seconds: f64,
    pub video: Option<VideoProbe>,
    pub audio: Option<AudioProbe>,
    pub image: Option<ImageProbe>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProbe {
    /// Mediabunny codec name: avc, hevc, vp9, av1, vp8, prores.
    pub codec: String,
    /// Full codec string such as `avc1.640028`, when known.
    pub codec_string: Option<String>,
    pub coded_width: u32,
    pub coded_height: u32,
    /// Display size after pixel aspect ratio and rotation.
    pub display_width: u32,
    pub display_height: u32,
    pub rotation: u16,
    pub frame_count: u64,
    /// Best-guess frames per second from packet timing.
    pub frame_rate: f64,
    pub constant_frame_rate: bool,
    pub color: ColorInfo,
    pub hdr: bool,
    /// Whether WebCodecs in this browser or webview accepted the decoder config.
    pub decodable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProbe {
    pub codec: String,
    pub codec_string: Option<String>,
    pub sample_rate: u32,
    pub channels: u32,
    pub decodable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageProbe {
    /// png, jpeg or webp.
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub frame_count: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub codec: String,
    pub codec_label: String,
    pub coded_width: u32,
    pub coded_height: u32,
    pub width: u32,
    pub height: u32,
    pub rotation: u16,
    pub frame_rate: FrameRate,
    pub frame_rate_label: String,
    pub constant_frame_rate: bool,
    pub frame_count: u64,
    pub color: ColorInfo,
    pub hdr: bool,
    pub decodable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub codec: String,
    pub codec_label: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub channel_label: String,
    pub decodable: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub codec: String,
    pub codec_label: String,
    pub width: u32,
    pub height: u32,
    pub animated: bool,
}

/// Whether an item can be used, and if not, what is happening about it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum MediaStatus {
    /// Decodable as it is.
    Ready,
    /// The desktop app will transcode it to an H.264 proxy.
    ProxyNeeded,
    ProxyRunning {
        progress: f32,
    },
    /// Edited and played through its proxy.
    ProxyReady,
    ProxyFailed {
        message: String,
    },
    /// Cannot be used here; `message` says why and what to do instead.
    Unsupported {
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub source: MediaSource,
    pub container: String,
    pub kind: MediaKind,
    pub duration: Flicks,
    pub duration_label: String,
    pub video: Option<VideoInfo>,
    pub audio: Option<AudioInfo>,
    pub image: Option<ImageInfo>,
    pub status: MediaStatus,
}

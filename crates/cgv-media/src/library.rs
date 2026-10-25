use cgv_time::{format_clock, timecode, Flicks, FrameRate};

use crate::codec::{audio_codec_label, channel_label, image_codec_label, video_codec_label};
use crate::model::*;

/// Where the engine runs, which decides what happens to undecodable media.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Web,
    Desktop,
}

/// The imported media, in import order.
#[derive(Debug)]
pub struct MediaLibrary {
    platform: Platform,
    items: Vec<MediaItem>,
}

impl MediaLibrary {
    pub fn new(platform: Platform) -> Self {
        Self {
            platform,
            items: Vec::new(),
        }
    }

    pub fn items(&self) -> &[MediaItem] {
        &self.items
    }

    pub fn get(&self, id: &str) -> Option<&MediaItem> {
        self.items.iter().find(|item| item.id == id)
    }

    /// Normalizes a probe into a library item and appends it.
    pub fn add(&mut self, probe: MediaProbe) -> Result<&MediaItem, String> {
        if probe.id.is_empty() {
            return Err("Media id is empty".into());
        }
        if self.get(&probe.id).is_some() {
            return Err(format!("Media {} is already in the library", probe.id));
        }
        let item = self.normalize(probe)?;
        self.items.push(item);
        Ok(self.items.last().expect("just pushed"))
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.id != id);
        self.items.len() != before
    }

    pub fn set_status(&mut self, id: &str, status: MediaStatus) -> Result<&MediaItem, String> {
        let item = self
            .items
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| format!("No media with id {id}"))?;
        item.status = status;
        Ok(item)
    }

    fn normalize(&self, probe: MediaProbe) -> Result<MediaItem, String> {
        let duration = Flicks::from_seconds(probe.duration_seconds.max(0.0));
        let video = probe.video.map(|v| {
            let frame_rate = FrameRate::from_measured(v.frame_rate).unwrap_or(FrameRate::FPS_30);
            VideoInfo {
                codec_label: video_codec_label(&v.codec, v.codec_string.as_deref()),
                codec: v.codec,
                coded_width: v.coded_width,
                coded_height: v.coded_height,
                width: v.display_width,
                height: v.display_height,
                rotation: v.rotation,
                frame_rate_label: frame_rate.label(),
                frame_rate,
                constant_frame_rate: v.constant_frame_rate,
                frame_count: v.frame_count,
                color: v.color,
                hdr: v.hdr,
                decodable: v.decodable,
            }
        });
        let audio = probe.audio.map(|a| AudioInfo {
            codec_label: audio_codec_label(&a.codec, a.codec_string.as_deref()),
            codec: a.codec,
            sample_rate: a.sample_rate,
            channels: a.channels,
            channel_label: channel_label(a.channels),
            decodable: a.decodable,
        });
        let image = probe.image.map(|i| ImageInfo {
            codec_label: image_codec_label(&i.codec),
            codec: i.codec,
            width: i.width,
            height: i.height,
            animated: i.frame_count > 1,
        });
        let kind = if image.is_some() {
            MediaKind::Image
        } else if video.is_some() {
            MediaKind::Video
        } else if audio.is_some() {
            MediaKind::Audio
        } else {
            return Err(format!(
                "{} has no video, audio or image stream",
                probe.name
            ));
        };
        let duration_label = match (&video, kind) {
            (Some(v), MediaKind::Video) => {
                timecode(v.frame_rate.frame_at(duration), v.frame_rate, false)
            }
            (_, MediaKind::Image) if duration == Flicks::ZERO => String::new(),
            _ => format_clock(duration),
        };
        let status = self.status_for(&video, &audio);
        Ok(MediaItem {
            id: probe.id,
            name: probe.name,
            size: probe.size,
            source: probe.source,
            container: probe.container,
            kind,
            duration,
            duration_label,
            video,
            audio,
            image,
            status,
        })
    }

    fn status_for(&self, video: &Option<VideoInfo>, audio: &Option<AudioInfo>) -> MediaStatus {
        let undecodable = match (video, audio) {
            (Some(v), _) if !v.decodable => Some(v.codec_label.clone()),
            (None, Some(a)) if !a.decodable => Some(a.codec_label.clone()),
            _ => None,
        };
        match (undecodable, self.platform) {
            (None, _) => MediaStatus::Ready,
            (Some(_), Platform::Desktop) if video.is_some() => MediaStatus::ProxyNeeded,
            (Some(codec), Platform::Desktop) => MediaStatus::Unsupported {
                message: format!("{codec} audio can't be decoded on this computer."),
            },
            (Some(codec), Platform::Web) => MediaStatus::Unsupported {
                message: format!(
                    "{codec} can't be decoded in this browser. Open the file in the \
                     CashGear Video desktop app, which converts it to a playable proxy."
                ),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video_probe(codec: &str, codec_string: &str, decodable: bool) -> MediaProbe {
        MediaProbe {
            id: format!("{codec}-1"),
            name: format!("clip.{codec}"),
            size: 1_000_000,
            source: MediaSource::Handle,
            container: "mov".into(),
            duration_seconds: 10.01,
            video: Some(VideoProbe {
                codec: codec.into(),
                codec_string: Some(codec_string.into()),
                coded_width: 1920,
                coded_height: 1080,
                display_width: 1080,
                display_height: 1920,
                rotation: 90,
                frame_count: 300,
                frame_rate: 29.97,
                constant_frame_rate: true,
                color: ColorInfo {
                    primaries: Some("bt709".into()),
                    transfer: Some("bt709".into()),
                    matrix: Some("bt709".into()),
                    full_range: Some(false),
                },
                hdr: false,
                decodable,
            }),
            audio: Some(AudioProbe {
                codec: "aac".into(),
                codec_string: Some("mp4a.40.2".into()),
                sample_rate: 48_000,
                channels: 2,
                decodable: true,
            }),
            image: None,
        }
    }

    #[test]
    fn decodable_video_is_ready_with_labels() {
        let mut library = MediaLibrary::new(Platform::Web);
        let item = library
            .add(video_probe("avc", "avc1.640028", true))
            .unwrap();
        assert_eq!(item.kind, MediaKind::Video);
        assert_eq!(item.status, MediaStatus::Ready);
        let video = item.video.as_ref().unwrap();
        assert_eq!(video.codec_label, "H.264 High");
        assert_eq!(video.frame_rate, FrameRate::FPS_29_97);
        assert_eq!(video.frame_rate_label, "29.97");
        assert_eq!(
            (video.width, video.height, video.rotation),
            (1080, 1920, 90)
        );
        assert_eq!(item.duration_label, "00:00:10:00");
        assert_eq!(item.audio.as_ref().unwrap().channel_label, "Stereo");
    }

    #[test]
    fn undecodable_video_needs_a_proxy_on_desktop() {
        let mut library = MediaLibrary::new(Platform::Desktop);
        let item = library.add(video_probe("prores", "apch", false)).unwrap();
        assert_eq!(item.status, MediaStatus::ProxyNeeded);
    }

    #[test]
    fn undecodable_video_is_rejected_with_a_message_on_the_web() {
        let mut library = MediaLibrary::new(Platform::Web);
        let item = library.add(video_probe("prores", "apch", false)).unwrap();
        match &item.status {
            MediaStatus::Unsupported { message } => {
                assert!(message.starts_with("ProRes 422 HQ can't be decoded in this browser"));
                assert!(message.contains("desktop app"));
            }
            other => panic!("unexpected status {other:?}"),
        }
    }

    #[test]
    fn audio_only_and_images() {
        let mut library = MediaLibrary::new(Platform::Web);
        let mut audio = video_probe("avc", "avc1.640028", true);
        audio.id = "a1".into();
        audio.video = None;
        audio.duration_seconds = 61.5;
        let item = library.add(audio).unwrap();
        assert_eq!(item.kind, MediaKind::Audio);
        assert_eq!(item.duration_label, "1:01.500");

        let image = MediaProbe {
            id: "i1".into(),
            name: "still.png".into(),
            size: 10,
            source: MediaSource::Opfs {
                path: "media/i1.png".into(),
            },
            container: "png".into(),
            duration_seconds: 0.0,
            video: None,
            audio: None,
            image: Some(ImageProbe {
                codec: "png".into(),
                width: 1920,
                height: 1080,
                frame_count: 1,
            }),
        };
        let item = library.add(image).unwrap();
        assert_eq!(item.kind, MediaKind::Image);
        assert_eq!(item.image.as_ref().unwrap().codec_label, "PNG");
        assert!(!item.image.as_ref().unwrap().animated);
        assert_eq!(item.duration_label, "");
    }

    #[test]
    fn rejects_duplicates_and_empty_media() {
        let mut library = MediaLibrary::new(Platform::Web);
        library
            .add(video_probe("avc", "avc1.640028", true))
            .unwrap();
        assert!(library
            .add(video_probe("avc", "avc1.640028", true))
            .is_err());
        let mut empty = video_probe("vp9", "vp09.00.10.08", true);
        empty.video = None;
        empty.audio = None;
        assert!(library.add(empty).is_err());
    }

    #[test]
    fn status_updates_and_removal() {
        let mut library = MediaLibrary::new(Platform::Desktop);
        library.add(video_probe("prores", "apch", false)).unwrap();
        let item = library
            .set_status("prores-1", MediaStatus::ProxyRunning { progress: 0.5 })
            .unwrap();
        assert_eq!(item.status, MediaStatus::ProxyRunning { progress: 0.5 });
        assert!(library.set_status("missing", MediaStatus::Ready).is_err());
        assert!(library.remove("prores-1"));
        assert!(!library.remove("prores-1"));
        assert!(library.items().is_empty());
    }

    #[test]
    fn json_shape_matches_the_typescript_client() {
        let mut library = MediaLibrary::new(Platform::Desktop);
        library.add(video_probe("prores", "apch", false)).unwrap();
        let json = serde_json::to_value(&library.items()[0]).unwrap();
        assert_eq!(
            json["status"],
            serde_json::json!({ "state": "proxyNeeded" })
        );
        assert_eq!(json["kind"], "video");
        assert_eq!(json["source"], serde_json::json!({ "kind": "handle" }));
        assert_eq!(
            json["video"]["frameRate"],
            serde_json::json!({ "num": 30000, "den": 1001 })
        );
        assert_eq!(json["video"]["codecLabel"], "ProRes 422 HQ");
        assert_eq!(json["duration"], 7_063_056_000i64);
        let probe: MediaProbe = serde_json::from_value(serde_json::json!({
            "id": "x", "name": "x.wav", "size": 4, "source": { "kind": "path", "path": "C:/x.wav" },
            "container": "wav", "durationSeconds": 1.0, "video": null, "image": null,
            "audio": { "codec": "pcm-s16", "codecString": null, "sampleRate": 48000, "channels": 1, "decodable": true }
        }))
        .unwrap();
        assert_eq!(probe.audio.unwrap().channels, 1);
    }
}

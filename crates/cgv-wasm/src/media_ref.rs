//! Turns a media library item into the reference a project keeps.
use cgv_media::{MediaItem, MediaKind as ItemKind, MediaSource};
use cgv_model::{MediaKind, MediaLocation, MediaRef};
use cgv_time::Flicks;

/// The project's record of `item`: what relinking and the timeline need.
/// `modified` is the file's last-modified time in milliseconds, when known.
pub fn media_ref(item: &MediaItem, modified: Option<i64>) -> MediaRef {
    let (width, height) = match (&item.video, &item.image) {
        (Some(video), _) => (video.width, video.height),
        (None, Some(image)) => (image.width, image.height),
        (None, None) => (0, 0),
    };
    let kind = match item.kind {
        ItemKind::Video => MediaKind::Video,
        ItemKind::Audio => MediaKind::Audio,
        ItemKind::Image => MediaKind::Image,
    };
    MediaRef {
        id: item.id.clone(),
        name: item.name.clone(),
        kind,
        // A still image has no length of its own; an animated one lasts a loop.
        duration: if kind == MediaKind::Image && !item.image.as_ref().is_some_and(|i| i.animated) {
            Flicks::ZERO
        } else {
            item.duration
        },
        has_video: item.video.is_some() || item.image.is_some(),
        has_audio: item.audio.is_some() && kind != MediaKind::Image,
        width,
        height,
        frame_rate: item.video.as_ref().map(|video| video.frame_rate),
        size: item.size,
        modified,
        location: match &item.source {
            MediaSource::Path { path } => MediaLocation::Path { path: path.clone() },
            MediaSource::Pack { path } => MediaLocation::Pack { path: path.clone() },
            MediaSource::Handle | MediaSource::Opfs { .. } => MediaLocation::Browser,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cgv_media::{AudioProbe, MediaLibrary, MediaProbe, Platform, VideoProbe};

    fn probe(id: &str, source: MediaSource) -> MediaProbe {
        MediaProbe {
            id: id.into(),
            name: "clip.mp4".into(),
            size: 1234,
            source,
            container: "mp4".into(),
            duration_seconds: 2.0,
            video: Some(VideoProbe {
                codec: "avc".into(),
                codec_string: Some("avc1.640028".into()),
                coded_width: 1920,
                coded_height: 1088,
                display_width: 1920,
                display_height: 1080,
                rotation: 0,
                frame_count: 60,
                frame_rate: 30.0,
                constant_frame_rate: true,
                color: Default::default(),
                hdr: false,
                decodable: true,
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
    fn video_items_become_valid_media_refs() {
        let mut library = MediaLibrary::new(Platform::Desktop);
        let path = MediaSource::Path {
            path: "C:\\clips\\clip.mp4".into(),
        };
        let item = library.add(probe("a-1", path)).unwrap();
        let media = media_ref(item, Some(1_700_000_000_000));
        assert!(media.validate().is_ok());
        assert_eq!(media.kind, MediaKind::Video);
        assert_eq!((media.width, media.height), (1920, 1080));
        assert_eq!(media.duration, Flicks::ONE_SECOND + Flicks::ONE_SECOND);
        assert!(media.has_video && media.has_audio);
        assert_eq!(media.modified, Some(1_700_000_000_000));
        assert_eq!(
            media.location,
            MediaLocation::Path {
                path: "C:\\clips\\clip.mp4".into()
            }
        );

        let mut web = MediaLibrary::new(Platform::Web);
        let item = web.add(probe("b-2", MediaSource::Handle)).unwrap();
        assert_eq!(media_ref(item, None).location, MediaLocation::Browser);
    }
}

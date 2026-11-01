//! OpenTimelineIO's JSON: `Timeline.1`, a stack of `Track.1`s of `Clip.2`s,
//! `Gap.1`s and `Transition.1`s, with `LinearTimeWarp.1` and `FreezeFrame.1`
//! effects and `Marker.2`s. Nested timelines are stacks inside tracks. Opacity
//! and volume have no place in the schema, so they travel as metadata.
use std::collections::BTreeMap;
use std::rc::Rc;

use cgv_model::MarkerColor;
use cgv_time::{Flicks, FrameRate};
use serde_json::{json, Value};

use crate::cut::{
    from_frames, to_frames, Cut, CutMarker, CutTrack, Dissolve, Item, MediaFile, Source,
};

fn rational(time: Flicks, rate: f64) -> Value {
    json!({
        "OTIO_SCHEMA": "RationalTime.1",
        "rate": rate,
        "value": to_frames(time, rate),
    })
}

fn range(start: Flicks, duration: Flicks, rate: f64) -> Value {
    json!({
        "OTIO_SCHEMA": "TimeRange.1",
        "duration": rational(duration, rate),
        "start_time": rational(start, rate),
    })
}

fn color_name(color: MarkerColor) -> &'static str {
    match color {
        MarkerColor::Red => "RED",
        MarkerColor::Orange => "ORANGE",
        MarkerColor::Yellow => "YELLOW",
        MarkerColor::Green => "GREEN",
        MarkerColor::Blue => "BLUE",
        MarkerColor::Purple => "PURPLE",
    }
}

fn color_of(name: &str) -> MarkerColor {
    match name.to_ascii_uppercase().as_str() {
        "RED" | "PINK" => MarkerColor::Red,
        "ORANGE" => MarkerColor::Orange,
        "YELLOW" => MarkerColor::Yellow,
        "GREEN" | "CYAN" => MarkerColor::Green,
        "PURPLE" | "MAGENTA" => MarkerColor::Purple,
        _ => MarkerColor::Blue,
    }
}

/// `file://` URL of a path, with the characters URLs reserve escaped.
pub(crate) fn file_url(path: &str) -> String {
    let path = path.replace('\\', "/");
    let mut url = String::from(if path.starts_with('/') {
        "file://"
    } else {
        "file:///"
    });
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                url.push(byte as char)
            }
            _ => url.push_str(&format!("%{byte:02X}")),
        }
    }
    url
}

/// The local path a `file://` URL names (`file://localhost/C%3a/a.mov` too); None
/// for other URLs and bare names.
pub(crate) fn url_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let mut bytes = Vec::with_capacity(rest.len());
    let raw = rest.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        let hex = (raw[index] == b'%')
            .then(|| rest.get(index + 1..index + 3))
            .flatten()
            .and_then(|digits| u8::from_str_radix(digits, 16).ok());
        match hex {
            Some(byte) => {
                bytes.push(byte);
                index += 3;
            }
            None => {
                bytes.push(raw[index]);
                index += 1;
            }
        }
    }
    let path = String::from_utf8_lossy(&bytes).into_owned();
    // A Windows drive reads `/C:/path`.
    let windows = path.as_bytes().get(2) == Some(&b':') && path.starts_with('/');
    Some(if windows { path[1..].to_string() } else { path })
}

/// The last part of a path or URL.
pub(crate) fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

fn write_item(item: &Item, rate: f64) -> Value {
    let mut effects = Vec::new();
    if item.freeze {
        effects.push(json!({
            "OTIO_SCHEMA": "FreezeFrame.1",
            "effect_name": "FreezeFrame",
            "metadata": {},
            "name": "",
            "time_scalar": 0.0,
        }));
    } else if (item.speed - 1.0).abs() > 1e-9 {
        effects.push(json!({
            "OTIO_SCHEMA": "LinearTimeWarp.1",
            "effect_name": "LinearTimeWarp",
            "metadata": {},
            "name": "",
            "time_scalar": item.speed,
        }));
    }
    let metadata = json!({
        "cashgear": { "opacity": item.opacity, "volumeDb": item.volume_db },
    });
    let source_range = range(item.source_in, item.duration, rate);
    match &item.source {
        Source::Media(file) => {
            let available = file
                .duration
                .map(|duration| range(Flicks::ZERO, duration, rate));
            json!({
                "OTIO_SCHEMA": "Clip.2",
                "metadata": metadata,
                "name": file.name,
                "source_range": source_range,
                "effects": effects,
                "markers": [],
                "enabled": true,
                "media_references": {
                    "DEFAULT_MEDIA": {
                        "OTIO_SCHEMA": "ExternalReference.1",
                        "metadata": {},
                        "name": file.name,
                        "available_range": available,
                        "available_image_bounds": null,
                        "target_url": file.path.as_deref().map_or_else(|| file.name.clone(), file_url),
                    },
                },
                "active_media_reference_key": "DEFAULT_MEDIA",
            })
        }
        Source::Nest(cut) => {
            let mut stack = write_stack(cut, cut.name.clone());
            stack["source_range"] = source_range;
            stack["effects"] = json!(effects);
            stack["metadata"] = metadata;
            stack
        }
    }
}

fn write_track(track: &CutTrack, kind: &str, rate: f64) -> Value {
    let mut children = Vec::new();
    let mut at = Flicks::ZERO;
    let mut dissolves = track.dissolves.iter().peekable();
    for item in &track.items {
        if item.start > at {
            children.push(json!({
                "OTIO_SCHEMA": "Gap.1",
                "metadata": {},
                "name": "",
                "source_range": range(Flicks::ZERO, item.start - at, rate),
                "effects": [],
                "markers": [],
                "enabled": true,
            }));
        }
        while let Some(dissolve) = dissolves.next_if(|dissolve| dissolve.cut <= item.start) {
            children.push(json!({
                "OTIO_SCHEMA": "Transition.1",
                "metadata": {},
                "name": "",
                "transition_type": "SMPTE_Dissolve",
                "in_offset": rational(dissolve.before, rate),
                "out_offset": rational(dissolve.after, rate),
            }));
        }
        children.push(write_item(item, rate));
        at = item.end();
    }
    json!({
        "OTIO_SCHEMA": "Track.1",
        "metadata": {},
        "name": track.name,
        "source_range": null,
        "effects": [],
        "markers": [],
        "enabled": true,
        "kind": kind,
        "children": children,
    })
}

fn write_stack(cut: &Cut, name: String) -> Value {
    let rate = cut.rate.as_f64();
    let picture = cut
        .picture
        .iter()
        .map(|track| write_track(track, "Video", rate));
    let sound = cut
        .sound
        .iter()
        .map(|track| write_track(track, "Audio", rate));
    let markers: Vec<Value> = cut
        .markers
        .iter()
        .map(|marker| {
            json!({
                "OTIO_SCHEMA": "Marker.2",
                "metadata": {},
                "name": marker.name,
                "color": color_name(marker.color),
                "marked_range": range(marker.time, Flicks::ZERO, rate),
                "comment": "",
            })
        })
        .collect();
    json!({
        "OTIO_SCHEMA": "Stack.1",
        "metadata": {},
        "name": name,
        "source_range": null,
        "effects": [],
        "markers": markers,
        "enabled": true,
        "children": picture.chain(sound).collect::<Vec<Value>>(),
    })
}

/// The `.otio` text of `cut`.
pub fn write(cut: &Cut) -> String {
    let file = json!({
        "OTIO_SCHEMA": "Timeline.1",
        "metadata": {
            "cashgear": {
                "width": cut.size.0,
                "height": cut.size.1,
                "sampleRate": cut.sample_rate,
            },
        },
        "name": cut.name,
        "global_start_time": null,
        "tracks": write_stack(cut, "tracks".into()),
    });
    let mut text = serde_json::to_string_pretty(&file).expect("JSON values serialize");
    text.push('\n');
    text
}

fn schema(value: &Value) -> &str {
    value
        .get("OTIO_SCHEMA")
        .and_then(Value::as_str)
        .and_then(|name| name.split('.').next())
        .unwrap_or_default()
}

/// A `RationalTime`'s flicks, and its rate.
fn read_time(value: &Value) -> Option<(Flicks, f64)> {
    let rate = value.get("rate")?.as_f64().filter(|rate| *rate > 0.0)?;
    let frames = value.get("value")?.as_f64()?;
    Some((from_frames(frames, rate), rate))
}

/// A `TimeRange`'s start and duration, and its rate.
fn read_range(value: &Value) -> Option<(Flicks, Flicks, f64)> {
    let (start, rate) = read_time(value.get("start_time")?)?;
    let (duration, _) = read_time(value.get("duration")?)?;
    Some((start, duration, rate))
}

fn read_name(value: &Value) -> String {
    value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

struct Reader {
    left_out: Vec<String>,
    /// The first rate any time came at: the timeline's.
    rate: Option<f64>,
    size: Option<(u32, u32)>,
    sample_rate: Option<u32>,
}

impl Reader {
    fn note_rate(&mut self, rate: f64) {
        self.rate.get_or_insert(rate);
    }

    fn markers(
        &mut self,
        value: &Value,
        into: &mut Vec<CutMarker>,
        map: impl Fn(Flicks) -> Flicks,
    ) {
        for marker in value
            .get("markers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some((start, _, _)) = marker.get("marked_range").and_then(read_range) else {
                continue;
            };
            into.push(CutMarker {
                time: map(start).max(Flicks::ZERO),
                name: read_name(marker),
                color: marker
                    .get("color")
                    .and_then(Value::as_str)
                    .map_or(MarkerColor::Blue, color_of),
            });
        }
    }

    /// The speed and freeze of an item's effects; others are listed as left out.
    fn timing(&mut self, value: &Value) -> (f64, bool) {
        let (mut speed, mut freeze) = (1.0, false);
        for effect in value
            .get("effects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match schema(effect) {
                "LinearTimeWarp" => {
                    speed *= effect
                        .get("time_scalar")
                        .and_then(Value::as_f64)
                        .unwrap_or(1.0);
                }
                "FreezeFrame" => freeze = true,
                _ => {
                    let name = effect
                        .get("effect_name")
                        .and_then(Value::as_str)
                        .filter(|name| !name.is_empty())
                        .map_or_else(|| read_name(effect), str::to_string);
                    self.left_out
                        .push(format!("The effect {name} on {}", read_name(value)));
                }
            }
        }
        (speed, freeze)
    }

    fn media(&mut self, clip: &Value) -> Option<MediaFile> {
        let reference = match clip.get("media_references") {
            Some(references) => {
                let key = clip
                    .get("active_media_reference_key")
                    .and_then(Value::as_str)
                    .unwrap_or("DEFAULT_MEDIA");
                references.get(key)
            }
            None => clip.get("media_reference"),
        };
        let name = read_name(clip);
        let Some(reference) = reference else {
            return Some(MediaFile {
                name,
                ..MediaFile::default()
            });
        };
        let available = reference.get("available_range").and_then(read_range);
        let duration = available.map(|(start, duration, _)| start + duration);
        match schema(reference) {
            "ExternalReference" => {
                let url = reference
                    .get("target_url")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let path = url_path(url).or_else(|| {
                    // A bare absolute path, as some tools write.
                    let drive = url.as_bytes().get(1) == Some(&b':');
                    (url.starts_with('/') || drive).then(|| url.to_string())
                });
                Some(MediaFile {
                    name: file_name(path.as_deref().unwrap_or(url)),
                    path,
                    duration,
                })
            }
            "MissingReference" | "" => Some(MediaFile {
                name,
                path: None,
                duration,
            }),
            other => {
                self.left_out
                    .push(format!("{name}: its {other} media can't be shown"));
                None
            }
        }
    }

    fn item(
        &mut self,
        value: &Value,
        start: Flicks,
        duration: Flicks,
        source_in: Flicks,
    ) -> Option<Item> {
        let (speed, freeze) = self.timing(value);
        let settings = value.get("metadata").and_then(|m| m.get("cashgear"));
        let number = |name: &str, default: f64| {
            settings
                .and_then(|s| s.get(name))
                .and_then(Value::as_f64)
                .unwrap_or(default)
        };
        let source = match schema(value) {
            "Stack" => Source::Nest(Rc::new(self.stack(value, read_name(value))?)),
            "Track" => {
                // A track on its own is a timeline of one track.
                let mut cut = self.empty_cut(read_name(value));
                self.track(value, &mut cut);
                Source::Nest(Rc::new(cut))
            }
            _ => Source::Media(self.media(value)?),
        };
        Some(Item {
            start,
            duration,
            source,
            source_in,
            speed,
            freeze,
            opacity: number("opacity", 1.0),
            volume_db: number("volumeDb", 0.0),
        })
    }

    fn empty_cut(&self, name: String) -> Cut {
        Cut {
            name,
            rate: FrameRate::FPS_30,
            size: (1920, 1080),
            sample_rate: 48_000,
            picture: Vec::new(),
            sound: Vec::new(),
            markers: Vec::new(),
            left_out: Vec::new(),
        }
    }

    /// How long a child lasts: its source range, or its media or tracks' length.
    fn length(&mut self, child: &Value) -> Option<(Flicks, Flicks)> {
        if let Some((start, duration, rate)) = child.get("source_range").and_then(read_range) {
            self.note_rate(rate);
            return Some((start, duration));
        }
        match schema(child) {
            "Stack" | "Track" => {
                let cut = match schema(child) {
                    "Stack" => self.stack(child, String::new())?,
                    _ => {
                        let mut cut = self.empty_cut(String::new());
                        self.track(child, &mut cut);
                        cut
                    }
                };
                Some((Flicks::ZERO, cut.duration()))
            }
            _ => {
                let media = self.media(child)?;
                Some((Flicks::ZERO, media.duration?))
            }
        }
    }

    fn track(&mut self, value: &Value, cut: &mut Cut) {
        let mut track = CutTrack {
            name: read_name(value),
            ..CutTrack::default()
        };
        let mut at = Flicks::ZERO;
        let children = value.get("children").and_then(Value::as_array);
        for child in children.into_iter().flatten() {
            match schema(child) {
                "Transition" => {
                    let time = |name: &str| {
                        child
                            .get(name)
                            .and_then(read_time)
                            .map_or(Flicks::ZERO, |(time, _)| time)
                    };
                    track.dissolves.push(Dissolve {
                        cut: at,
                        before: time("in_offset"),
                        after: time("out_offset"),
                    });
                    let kind = child
                        .get("transition_type")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if kind != "SMPTE_Dissolve" {
                        self.left_out
                            .push(format!("The {kind} transition goes as a dissolve"));
                    }
                }
                _ => {
                    let Some((source_in, duration)) = self.length(child) else {
                        self.left_out.push(format!(
                            "{} has no length: it is left out",
                            read_name(child)
                        ));
                        continue;
                    };
                    let enabled = child
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                    if schema(child) != "Gap" {
                        if enabled {
                            if let Some(item) = self.item(child, at, duration, source_in) {
                                track.items.push(item);
                            }
                        } else {
                            self.left_out
                                .push(format!("{} is turned off", read_name(child)));
                        }
                        let mut markers = Vec::new();
                        self.markers(child, &mut markers, |time| at + (time - source_in));
                        cut.markers.append(&mut markers);
                    }
                    at += duration;
                }
            }
        }
        let audio = value.get("kind").and_then(Value::as_str) == Some("Audio");
        if audio {
            cut.sound.push(track);
        } else {
            cut.picture.push(track);
        }
    }

    fn stack(&mut self, value: &Value, name: String) -> Option<Cut> {
        let mut cut = self.empty_cut(name);
        self.markers(value, &mut cut.markers, |time| time);
        for child in value.get("children").and_then(Value::as_array)? {
            if schema(child) == "Track" {
                self.track(child, &mut cut);
            } else {
                self.left_out.push(format!(
                    "{}: a stack holds tracks, so this is left out",
                    read_name(child)
                ));
            }
        }
        cut.markers.sort_by_key(|marker| marker.time);
        Some(cut)
    }
}

/// Sets every level of `cut` to what the file says the timeline runs at.
fn settle(
    cut: &mut Cut,
    rate: FrameRate,
    size: (u32, u32),
    sample_rate: u32,
    cache: &mut BTreeMap<*const Cut, Rc<Cut>>,
) {
    cut.rate = rate;
    cut.size = size;
    cut.sample_rate = sample_rate;
    for track in cut.picture.iter_mut().chain(cut.sound.iter_mut()) {
        for item in &mut track.items {
            if let Source::Nest(inner) = &mut item.source {
                let key = Rc::as_ptr(inner);
                if let Some(done) = cache.get(&key) {
                    *inner = done.clone();
                    continue;
                }
                let mut copy = (**inner).clone();
                settle(&mut copy, rate, size, sample_rate, cache);
                let done = Rc::new(copy);
                cache.insert(key, done.clone());
                *inner = done;
            }
        }
    }
}

/// The rate `rate` frames a second names: `30000/1001`-style rates stay exact.
pub(crate) fn frame_rate(rate: f64) -> FrameRate {
    let rounded = rate.round();
    if (rate - rounded).abs() < 1e-3 {
        return FrameRate::new(rounded as u32, 1).unwrap_or(FrameRate::FPS_30);
    }
    let ntsc = (rate * 1.001).round();
    if (rate - ntsc * 1000.0 / 1001.0).abs() < 1e-2 {
        return FrameRate::new(ntsc as u32 * 1000, 1001).unwrap_or(FrameRate::FPS_30);
    }
    FrameRate::new((rate * 1000.0).round() as u32, 1000).unwrap_or(FrameRate::FPS_30)
}

/// Reads `.otio` text: a timeline, or a stack or track on its own.
pub fn read(text: &str) -> Result<Cut, String> {
    let file: Value =
        serde_json::from_str(text).map_err(|error| format!("This is not an OTIO file: {error}"))?;
    let mut reader = Reader {
        left_out: Vec::new(),
        rate: None,
        size: None,
        sample_rate: None,
    };
    let settings = file.get("metadata").and_then(|m| m.get("cashgear"));
    let dimension = |name: &str| {
        settings
            .and_then(|s| s.get(name))
            .and_then(Value::as_u64)
            .map(|value| value as u32)
    };
    if let (Some(width), Some(height)) = (dimension("width"), dimension("height")) {
        reader.size = Some((width, height));
    }
    reader.sample_rate = dimension("sampleRate");
    let mut cut = match schema(&file) {
        "Timeline" => {
            let tracks = file.get("tracks").ok_or("This timeline has no tracks")?;
            reader
                .stack(tracks, read_name(&file))
                .ok_or("This timeline's tracks can't be read")?
        }
        "Stack" => reader
            .stack(&file, read_name(&file))
            .ok_or("This stack can't be read")?,
        "Track" => {
            let mut cut = reader.empty_cut(read_name(&file));
            reader.track(&file, &mut cut);
            cut
        }
        other => return Err(format!("An OTIO {other} is not a timeline")),
    };
    let rate = frame_rate(reader.rate.unwrap_or(30.0));
    let (size, sample_rate) = (
        reader.size.unwrap_or((1920, 1080)),
        reader.sample_rate.unwrap_or(48_000),
    );
    settle(&mut cut, rate, size, sample_rate, &mut BTreeMap::new());
    cut.left_out = reader.left_out;
    if cut.name.trim().is_empty() {
        cut.name = "Imported timeline".into();
    }
    Ok(cut)
}

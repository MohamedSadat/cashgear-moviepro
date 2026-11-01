//! FCP7 XML (`xmeml`), which Premiere Pro and DaVinci Resolve read and write. A
//! `sequence` holds `video` and `audio` tracks of `clipitem`s and
//! `transitionitem`s. Times are whole frames; a clip beside a transition gives
//! -1 for that edge, and the transition's alignment says where the cut is; its
//! `in` and `out` then reach to the transition's start and end. They count frames
//! of the media after its speed change.
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::rc::Rc;

use cgv_model::MarkerColor;
use cgv_time::{Flicks, FrameRate};
use quick_xml::events::Event;
use quick_xml::Reader;

use crate::cut::{
    from_frames, to_frames, Cut, CutMarker, CutTrack, Dissolve, Item, MediaFile, Source,
};
use crate::otio::{file_name, frame_rate, url_path};

/// Premiere's ticks a second, for source times finer than a frame.
const TICKS_PER_FLICK: i64 = 360;

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `file://localhost/` URL of a path, as Premiere writes them.
fn path_url(path: &str) -> String {
    let path = path.replace('\\', "/");
    let mut url = String::from("file://localhost");
    if !path.starts_with('/') {
        url.push('/');
    }
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                url.push(byte as char)
            }
            _ => {
                let _ = write!(url, "%{byte:02x}");
            }
        }
    }
    url
}

/// The timebase and NTSC flag of a rate.
fn timebase(rate: FrameRate) -> (u32, bool) {
    if rate.den == 1001 {
        (rate.num / 1000, true)
    } else {
        ((rate.as_f64().round() as u32).max(1), false)
    }
}

struct Writer {
    out: String,
    depth: usize,
    next_id: u32,
    files: BTreeMap<String, u32>,
    sequences: BTreeMap<*const Cut, u32>,
}

impl Writer {
    fn line(&mut self, text: &str) {
        for _ in 0..self.depth {
            self.out.push('\t');
        }
        self.out.push_str(text);
        self.out.push('\n');
    }

    fn open(&mut self, tag: &str) {
        self.line(&format!("<{tag}>"));
        self.depth += 1;
    }

    fn close(&mut self, tag: &str) {
        self.depth -= 1;
        self.line(&format!("</{tag}>"));
    }

    fn value(&mut self, tag: &str, value: impl std::fmt::Display) {
        let value = escape(&value.to_string());
        self.line(&format!("<{tag}>{value}</{tag}>"));
    }

    fn id(&mut self) -> u32 {
        self.next_id += 1;
        self.next_id
    }

    fn rate(&mut self, rate: FrameRate) {
        let (base, ntsc) = timebase(rate);
        self.open("rate");
        self.value("timebase", base);
        self.value("ntsc", if ntsc { "TRUE" } else { "FALSE" });
        self.close("rate");
    }

    fn file(&mut self, file: &MediaFile, cut: &Cut, picture: bool) {
        let rate = cut.rate.as_f64();
        let key = file.path.clone().unwrap_or_else(|| file.name.clone());
        if let Some(id) = self.files.get(&key) {
            let id = *id;
            self.line(&format!("<file id=\"file-{id}\"/>"));
            return;
        }
        let id = self.id();
        self.files.insert(key, id);
        self.line(&format!("<file id=\"file-{id}\">"));
        self.depth += 1;
        self.value("name", &file.name);
        let url = file
            .path
            .as_deref()
            .map_or_else(|| file.name.clone(), path_url);
        self.value("pathurl", url);
        self.rate(cut.rate);
        if let Some(duration) = file.duration {
            self.value("duration", to_frames(duration, rate).round() as i64);
        }
        self.open("timecode");
        self.rate(cut.rate);
        self.value("string", "00:00:00:00");
        self.value("frame", 0);
        self.value("displayformat", "NDF");
        self.close("timecode");
        self.open("media");
        if picture {
            self.open("video");
            self.open("samplecharacteristics");
            self.rate(cut.rate);
            self.value("width", cut.size.0);
            self.value("height", cut.size.1);
            self.value("anamorphic", "FALSE");
            self.value("pixelaspectratio", "square");
            self.value("fielddominance", "none");
            self.close("samplecharacteristics");
            self.close("video");
        }
        self.open("audio");
        self.open("samplecharacteristics");
        self.value("depth", 16);
        self.value("samplerate", cut.sample_rate);
        self.close("samplecharacteristics");
        self.value("channelcount", 2);
        self.close("audio");
        self.close("media");
        self.depth -= 1;
        self.line("</file>");
    }

    fn parameter(&mut self, id: &str, value: impl std::fmt::Display, range: Option<(f64, f64)>) {
        self.open("parameter");
        self.value("parameterid", id);
        self.value("name", id);
        if let Some((low, high)) = range {
            self.value("valuemin", low);
            self.value("valuemax", high);
        }
        self.value("value", value);
        self.close("parameter");
    }

    fn effect(
        &mut self,
        name: &str,
        id: &str,
        kind: &str,
        media: &str,
        parameters: impl FnOnce(&mut Writer),
    ) {
        self.open("filter");
        self.open("effect");
        self.value("name", name);
        self.value("effectid", id);
        self.value("effectcategory", kind);
        self.value("effecttype", kind);
        self.value("mediatype", media);
        parameters(self);
        self.close("effect");
        self.close("filter");
    }

    /// A transition's start and end frames, and its alignment's name.
    fn dissolve(&mut self, dissolve: &Dissolve, rate: f64, picture: bool) {
        let start = to_frames(dissolve.cut - dissolve.before, rate).round() as i64;
        let end = to_frames(dissolve.cut + dissolve.after, rate).round() as i64;
        let alignment = if dissolve.before == Flicks::ZERO {
            "start"
        } else if dissolve.after == Flicks::ZERO {
            "end"
        } else {
            "center"
        };
        self.open("transitionitem");
        self.value("start", start);
        self.value("end", end);
        self.value("alignment", alignment);
        self.open("effect");
        if picture {
            self.value("name", "Cross Dissolve");
            self.value("effectid", "Cross Dissolve");
            self.value("effectcategory", "Dissolve");
            self.value("effecttype", "transition");
            self.value("mediatype", "video");
        } else {
            self.value("name", "Cross Fade (+3dB)");
            self.value("effectid", "KGAudioTransCrossFade3dB");
            self.value("effectcategory", "Crossfade");
            self.value("effecttype", "transition");
            self.value("mediatype", "audio");
        }
        self.close("effect");
        self.close("transitionitem");
    }

    fn item(
        &mut self,
        item: &Item,
        cut: &Cut,
        track: usize,
        picture: bool,
        dissolves: &[Dissolve],
    ) {
        let rate = cut.rate.as_f64();
        let frames = |time: Flicks| to_frames(time, rate).round() as i64;
        let speed = item.speed.abs().max(1e-3);
        let name = match &item.source {
            Source::Media(file) => file.name.clone(),
            Source::Nest(inner) => inner.name.clone(),
        };
        let id = self.id();
        self.line(&format!("<clipitem id=\"clipitem-{id}\">"));
        self.depth += 1;
        self.value("name", &name);
        self.value("enabled", "TRUE");
        let media_length = match &item.source {
            Source::Media(file) => file.duration.unwrap_or(item.duration),
            Source::Nest(inner) => inner.duration(),
        };
        let scaled = |time: Flicks| Flicks((time.0 as f64 / speed).round() as i64);
        self.value("duration", frames(scaled(media_length)));
        self.rate(cut.rate);
        let at = |edge: Flicks| dissolves.iter().find(|dissolve| dissolve.cut == edge);
        let (head, tail) = (at(item.start), at(item.end()));
        let start = if head.is_some() {
            -1
        } else {
            frames(item.start)
        };
        let end = if tail.is_some() {
            -1
        } else {
            frames(item.end())
        };
        self.value("start", start);
        self.value("end", end);
        // The lowest source time of the range, in frames after the speed change.
        let span = Flicks((item.duration.0 as f64 * speed).round() as i64);
        let low = if item.speed < 0.0 {
            item.source_in - span
        } else {
            item.source_in
        };
        // Beside a transition they reach to its start and end.
        let before = head.map_or(Flicks::ZERO, |dissolve| dissolve.before);
        let after = tail.map_or(Flicks::ZERO, |dissolve| dissolve.after);
        let first = frames(scaled(low)) - frames(before);
        self.value("in", first);
        self.value("out", first + frames(before + item.duration + after));
        if !item.freeze && (speed - 1.0).abs() < 1e-9 {
            self.value("pproTicksIn", (low - before).0 * TICKS_PER_FLICK);
            self.value(
                "pproTicksOut",
                (low + item.duration + after).0 * TICKS_PER_FLICK,
            );
        }
        match &item.source {
            Source::Media(file) => self.file(file, cut, picture),
            Source::Nest(inner) => self.sequence(inner),
        }
        if picture {
            self.value("compositemode", "normal");
        }
        let media = if picture { "video" } else { "audio" };
        if item.freeze || (item.speed - 1.0).abs() > 1e-9 {
            let shown = if item.freeze { 0.0 } else { speed * 100.0 };
            let reverse = item.speed < 0.0;
            self.effect("Time Remap", "timeremap", "motion", media, |writer| {
                writer.parameter("variablespeed", 0, None);
                writer.parameter("speed", shown, Some((-100_000.0, 100_000.0)));
                writer.parameter("reverse", if reverse { "TRUE" } else { "FALSE" }, None);
                writer.parameter("frameblending", "FALSE", None);
            });
        }
        if picture && item.opacity < 1.0 {
            let opacity = item.opacity * 100.0;
            self.effect("Opacity", "opacity", "motion", "video", |writer| {
                writer.parameter("opacity", opacity, Some((0.0, 100.0)));
            });
        }
        if !picture && item.volume_db != 0.0 {
            let level = 10f64.powf(item.volume_db / 20.0);
            self.effect(
                "Audio Levels",
                "audiolevels",
                "audiolevels",
                "audio",
                |writer| {
                    writer.parameter("level", level, Some((0.0, 3.98109)));
                },
            );
        }
        self.open("sourcetrack");
        self.value("mediatype", media);
        self.value("trackindex", track + 1);
        self.close("sourcetrack");
        self.depth -= 1;
        self.line("</clipitem>");
    }

    fn track(&mut self, track: &CutTrack, cut: &Cut, index: usize, picture: bool) {
        let rate = cut.rate.as_f64();
        self.open("track");
        let mut dissolves = track.dissolves.iter().peekable();
        for item in &track.items {
            while let Some(dissolve) = dissolves.next_if(|dissolve| dissolve.cut <= item.start) {
                self.dissolve(dissolve, rate, picture);
            }
            self.item(item, cut, index, picture, &track.dissolves);
        }
        self.close("track");
    }

    fn sequence(&mut self, cut: &Rc<Cut>) {
        let key = Rc::as_ptr(cut);
        if let Some(id) = self.sequences.get(&key) {
            let id = *id;
            self.line(&format!("<sequence id=\"sequence-{id}\"/>"));
            return;
        }
        let id = self.id();
        self.sequences.insert(key, id);
        self.sequence_body(cut, id);
    }

    fn sequence_body(&mut self, cut: &Cut, id: u32) {
        let rate = cut.rate.as_f64();
        self.line(&format!("<sequence id=\"sequence-{id}\">"));
        self.depth += 1;
        self.value("name", &cut.name);
        self.value("duration", to_frames(cut.duration(), rate).round() as i64);
        self.rate(cut.rate);
        self.open("media");
        self.open("video");
        self.open("format");
        self.open("samplecharacteristics");
        self.rate(cut.rate);
        self.value("width", cut.size.0);
        self.value("height", cut.size.1);
        self.value("anamorphic", "FALSE");
        self.value("pixelaspectratio", "square");
        self.value("fielddominance", "none");
        self.close("samplecharacteristics");
        self.close("format");
        for (index, track) in cut.picture.iter().enumerate() {
            self.track(track, cut, index, true);
        }
        self.close("video");
        self.open("audio");
        self.value("numOutputChannels", 2);
        self.open("format");
        self.open("samplecharacteristics");
        self.value("depth", 16);
        self.value("samplerate", cut.sample_rate);
        self.close("samplecharacteristics");
        self.close("format");
        for (index, track) in cut.sound.iter().enumerate() {
            self.track(track, cut, index, false);
        }
        self.close("audio");
        self.close("media");
        for marker in &cut.markers {
            self.open("marker");
            self.value("comment", "");
            self.value("name", &marker.name);
            self.value("in", to_frames(marker.time, rate).round() as i64);
            self.value("out", -1);
            self.close("marker");
        }
        self.open("timecode");
        self.rate(cut.rate);
        self.value("string", "00:00:00:00");
        self.value("frame", 0);
        self.value("displayformat", "NDF");
        self.close("timecode");
        self.depth -= 1;
        self.line("</sequence>");
    }
}

/// The `.xml` text of `cut`.
pub fn write(cut: &Cut) -> String {
    let mut writer = Writer {
        out: String::new(),
        depth: 0,
        next_id: 0,
        files: BTreeMap::new(),
        sequences: BTreeMap::new(),
    };
    writer.line("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    writer.line("<!DOCTYPE xmeml>");
    writer.line("<xmeml version=\"5\">");
    writer.depth = 1;
    let id = writer.id();
    writer.sequence_body(cut, id);
    writer.depth = 0;
    writer.line("</xmeml>");
    writer.out
}

/// An XML element, read whole.
#[derive(Debug, Default)]
struct Element {
    name: String,
    id: Option<String>,
    /// A track holding a later channel of a stereo pair Premiere split in two.
    later_channel: bool,
    text: String,
    children: Vec<Rc<Element>>,
}

impl Element {
    fn child(&self, name: &str) -> Option<&Rc<Element>> {
        self.children.iter().find(|child| child.name == name)
    }

    fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Rc<Element>> + 'a {
        self.children.iter().filter(move |child| child.name == name)
    }

    fn text_of(&self, name: &str) -> Option<&str> {
        self.child(name).map(|child| child.text.trim())
    }

    fn number(&self, name: &str) -> Option<f64> {
        self.text_of(name)?.parse().ok()
    }

    /// Every element named `name` below this one, itself excluded.
    fn collect<'a>(&'a self, name: &str, into: &mut Vec<&'a Rc<Element>>) {
        for child in &self.children {
            if child.name == name {
                into.push(child);
            }
            child.collect(name, into);
        }
    }
}

fn parse(text: &str) -> Result<Rc<Element>, String> {
    let mut reader = Reader::from_str(text);
    let mut stack: Vec<Element> = vec![Element::default()];
    let attributes = |start: &quick_xml::events::BytesStart| {
        start
            .attributes()
            .flatten()
            .find(|attribute| attribute.key.as_ref() == b"id")
            .and_then(|attribute| attribute.unescape_value().ok().map(|v| v.into_owned()))
    };
    let name = |start: &quick_xml::events::BytesStart| {
        String::from_utf8_lossy(start.name().as_ref()).into_owned()
    };
    let later_channel = |start: &quick_xml::events::BytesStart| {
        start.attributes().flatten().any(|attribute| {
            attribute.key.as_ref() == b"currentExplodedTrackIndex"
                && attribute.value.as_ref() != b"0"
        })
    };
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => stack.push(Element {
                name: name(&start),
                id: attributes(&start),
                later_channel: later_channel(&start),
                ..Element::default()
            }),
            Ok(Event::Empty(start)) => {
                let element = Element {
                    name: name(&start),
                    id: attributes(&start),
                    ..Element::default()
                };
                let parent = stack.last_mut().ok_or("The XML is damaged")?;
                parent.children.push(Rc::new(element));
            }
            Ok(Event::End(_)) => {
                let element = stack.pop().ok_or("The XML is damaged")?;
                let parent = stack.last_mut().ok_or("The XML is damaged")?;
                parent.children.push(Rc::new(element));
            }
            Ok(Event::Text(text)) => {
                let decoded = text
                    .decode()
                    .map_err(|error| format!("The XML is damaged: {error}"))?;
                let parent = stack.last_mut().ok_or("The XML is damaged")?;
                parent.text.push_str(&decoded);
            }
            Ok(Event::GeneralRef(reference)) => {
                let name = String::from_utf8_lossy(&reference).into_owned();
                let character = match name.as_str() {
                    "amp" => "&".to_string(),
                    "lt" => "<".to_string(),
                    "gt" => ">".to_string(),
                    "quot" => "\"".to_string(),
                    "apos" => "'".to_string(),
                    other => other
                        .strip_prefix('#')
                        .and_then(|code| match code.strip_prefix('x') {
                            Some(hex) => u32::from_str_radix(hex, 16).ok(),
                            None => code.parse().ok(),
                        })
                        .and_then(char::from_u32)
                        .map(String::from)
                        .unwrap_or_default(),
                };
                let parent = stack.last_mut().ok_or("The XML is damaged")?;
                parent.text.push_str(&character);
            }
            Ok(Event::CData(data)) => {
                let parent = stack.last_mut().ok_or("The XML is damaged")?;
                parent.text.push_str(&String::from_utf8_lossy(&data));
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(error) => return Err(format!("The XML is damaged: {error}")),
        }
    }
    let root = stack.pop().ok_or("The XML is damaged")?;
    if !stack.is_empty() {
        return Err("The XML ends too early".into());
    }
    Ok(Rc::new(root))
}

/// A `rate` element's frames a second.
fn read_rate(element: &Element) -> Option<f64> {
    let rate = element.child("rate")?;
    let base = rate.number("timebase")?;
    let ntsc = rate
        .text_of("ntsc")
        .is_some_and(|flag| flag.eq_ignore_ascii_case("TRUE"));
    Some(if ntsc { base * 1000.0 / 1001.0 } else { base })
}

/// A transition's cut, from its span and alignment, in frames.
fn cut_point(transition: &Element) -> Option<f64> {
    let (start, end) = (transition.number("start")?, transition.number("end")?);
    Some(match transition.text_of("alignment").unwrap_or("center") {
        "end" | "end-black" => end,
        "start" | "start-black" => start,
        _ => ((start + end) / 2.0).floor(),
    })
}

struct XmlReader {
    /// `file` and `sequence` elements that hold their content, by id.
    files: BTreeMap<String, Rc<Element>>,
    sequences: BTreeMap<String, Rc<Element>>,
    /// Cuts made of sequences so far, shared by the items that show them.
    cuts: BTreeMap<String, Rc<Cut>>,
    left_out: Vec<String>,
    depth: usize,
}

impl XmlReader {
    fn media(&mut self, element: &Element, fallback: &str, rate: f64) -> MediaFile {
        let full = element
            .id
            .as_ref()
            .and_then(|id| self.files.get(id))
            .cloned();
        let file: &Element = full.as_deref().unwrap_or(element);
        let url = file.text_of("pathurl").unwrap_or_default();
        let path = url_path(url);
        let name = file
            .text_of("name")
            .filter(|name| !name.is_empty())
            .map_or_else(
                || {
                    let from = path.as_deref().unwrap_or(url);
                    if from.is_empty() {
                        fallback.to_string()
                    } else {
                        file_name(from)
                    }
                },
                str::to_string,
            );
        let file_rate = read_rate(file).unwrap_or(rate);
        MediaFile {
            name,
            path,
            duration: file
                .number("duration")
                .map(|frames| from_frames(frames, file_rate)),
        }
    }

    /// The speed, reverse, opacity and volume its filters set; others are listed.
    fn filters(&mut self, clip: &Element, name: &str) -> (f64, bool, f64, f64) {
        let (mut speed, mut reverse, mut opacity, mut volume_db) = (1.0, false, 1.0, 0.0);
        for filter in clip.all("filter") {
            let Some(effect) = filter.child("effect") else {
                continue;
            };
            let id = effect.text_of("effectid").unwrap_or_default();
            let parameter = |wanted: &str| {
                effect.all("parameter").find(|parameter| {
                    parameter
                        .text_of("parameterid")
                        .is_some_and(|id| id.eq_ignore_ascii_case(wanted))
                })
            };
            let keyed = |parameter: &Element| parameter.child("keyframe").is_some();
            match id {
                "timeremap" => {
                    if let Some(found) = parameter("speed") {
                        speed = found.number("value").unwrap_or(100.0) / 100.0;
                    }
                    if parameter("variablespeed").and_then(|found| found.number("value"))
                        == Some(1.0)
                    {
                        self.left_out.push(format!(
                            "The speed ramp of {name} goes as its constant speed"
                        ));
                    }
                    reverse = parameter("reverse")
                        .and_then(|found| found.text_of("value").map(str::to_string))
                        .is_some_and(|value| value.eq_ignore_ascii_case("TRUE"));
                }
                "opacity" => {
                    if let Some(found) = parameter("opacity") {
                        if keyed(found) {
                            self.left_out
                                .push(format!("The opacity keyframes of {name}"));
                        }
                        opacity = found.number("value").unwrap_or(100.0) / 100.0;
                    }
                }
                "audiolevels" => {
                    if let Some(found) = parameter("level") {
                        if keyed(found) {
                            self.left_out
                                .push(format!("The volume keyframes of {name}"));
                        }
                        let level = found.number("value").unwrap_or(1.0);
                        volume_db = 20.0 * level.max(1e-5).log10();
                    }
                }
                _ => {
                    let label = effect.text_of("name").unwrap_or(id);
                    self.left_out.push(format!("The effect {label} on {name}"));
                }
            }
        }
        (speed, reverse, opacity, volume_db)
    }

    fn track(&mut self, track: &Element, seq_rate: f64, into: &mut Vec<CutTrack>, index: usize) {
        let mut result = CutTrack {
            name: format!("Track {}", index + 1),
            ..CutTrack::default()
        };
        let children: Vec<&Rc<Element>> = track
            .children
            .iter()
            .filter(|child| {
                matches!(
                    child.name.as_str(),
                    "clipitem" | "transitionitem" | "generatoritem"
                )
            })
            .collect();
        let frames = |value: f64| from_frames(value, seq_rate);
        for (position, child) in children.iter().enumerate() {
            match child.name.as_str() {
                "transitionitem" => {
                    let (Some(start), Some(end), Some(cut)) =
                        (child.number("start"), child.number("end"), cut_point(child))
                    else {
                        continue;
                    };
                    result.dissolves.push(Dissolve {
                        cut: frames(cut),
                        before: frames(cut - start),
                        after: frames(end - cut),
                    });
                    let kind = child
                        .child("effect")
                        .and_then(|effect| effect.text_of("effectcategory"))
                        .unwrap_or_default();
                    if !kind.eq_ignore_ascii_case("dissolve")
                        && !kind.eq_ignore_ascii_case("crossfade")
                    {
                        let name = child
                            .child("effect")
                            .and_then(|effect| effect.text_of("name"))
                            .unwrap_or(kind);
                        self.left_out
                            .push(format!("The {name} transition goes as a dissolve"));
                    }
                }
                "generatoritem" => {
                    let name = child.text_of("name").unwrap_or("A generator");
                    self.left_out
                        .push(format!("{name}: generators can't be shown"));
                }
                _ => {
                    let name = child.text_of("name").unwrap_or_default().to_string();
                    if child
                        .text_of("enabled")
                        .is_some_and(|flag| flag.eq_ignore_ascii_case("FALSE"))
                    {
                        self.left_out.push(format!("{name} is turned off"));
                        continue;
                    }
                    // An edge of -1 is the cut of the transition beside it.
                    let neighbour = |offset: isize| {
                        position
                            .checked_add_signed(offset)
                            .and_then(|at| children.get(at))
                            .filter(|other| other.name == "transitionitem")
                            .and_then(|other| cut_point(other))
                    };
                    let edge = |value: Option<f64>, offset: isize| match value {
                        Some(value) if value >= 0.0 => Some(value),
                        _ => neighbour(offset),
                    };
                    // Beside a transition, `in` is where the media is at its start:
                    // the cut comes that much later.
                    let head = child
                        .number("start")
                        .filter(|start| *start < 0.0)
                        .and_then(|_| position.checked_sub(1))
                        .and_then(|at| children.get(at))
                        .filter(|other| other.name == "transitionitem")
                        .and_then(|other| Some(cut_point(other)? - other.number("start")?))
                        .unwrap_or(0.0);
                    let (Some(start), Some(end)) = (
                        edge(child.number("start"), -1),
                        edge(child.number("end"), 1),
                    ) else {
                        self.left_out
                            .push(format!("{name} has no place on the timeline"));
                        continue;
                    };
                    let clip_rate = read_rate(child).unwrap_or(seq_rate);
                    let (speed, reverse, opacity, volume_db) = self.filters(child, &name);
                    let magnitude = speed.abs();
                    let freeze = magnitude == 0.0;
                    let step = if freeze { 1.0 } else { magnitude };
                    let source = if let Some(nested) = child.child("sequence") {
                        let Some(cut) = self.nested(nested) else {
                            self.left_out
                                .push(format!("{name}: its nested sequence can't be read"));
                            continue;
                        };
                        Source::Nest(cut)
                    } else if let Some(file) = child.child("file") {
                        Source::Media(self.media(file, &name, clip_rate))
                    } else {
                        self.left_out.push(format!("{name} has no media"));
                        continue;
                    };
                    let duration = frames(end - start);
                    let ticks = child
                        .number("pproTicksIn")
                        .filter(|_| step == 1.0 && !freeze)
                        .map(|ticks| Flicks((ticks / TICKS_PER_FLICK as f64).round() as i64));
                    let head = from_frames(head, seq_rate);
                    let low = ticks.map_or_else(
                        || {
                            let first = child.number("in").unwrap_or(0.0);
                            from_frames(first * step, clip_rate)
                                + Flicks((head.0 as f64 * step).round() as i64)
                        },
                        |ticks| ticks + head,
                    );
                    let span = Flicks((duration.0 as f64 * step).round() as i64);
                    result.items.push(Item {
                        start: frames(start),
                        duration,
                        source,
                        source_in: if reverse { low + span } else { low },
                        speed: if reverse { -step } else { step },
                        freeze,
                        opacity,
                        volume_db,
                    });
                }
            }
        }
        result.items.sort_by_key(|item| item.start);
        if !result.items.is_empty() {
            into.push(result);
        }
    }

    fn nested(&mut self, element: &Element) -> Option<Rc<Cut>> {
        let id = element.id.clone()?;
        if let Some(cut) = self.cuts.get(&id) {
            return Some(cut.clone());
        }
        if self.depth >= cgv_model::MAX_NESTING {
            return None;
        }
        let full = self.sequences.get(&id)?.clone();
        self.depth += 1;
        let cut = Rc::new(self.sequence(&full));
        self.depth -= 1;
        self.cuts.insert(id, cut.clone());
        Some(cut)
    }

    fn sequence(&mut self, sequence: &Element) -> Cut {
        let seq_rate = read_rate(sequence).unwrap_or(30.0);
        let mut cut = Cut {
            name: sequence.text_of("name").unwrap_or("Sequence").to_string(),
            rate: frame_rate(seq_rate),
            size: (1920, 1080),
            sample_rate: 48_000,
            picture: Vec::new(),
            sound: Vec::new(),
            markers: Vec::new(),
            left_out: Vec::new(),
        };
        if let Some(media) = sequence.child("media") {
            if let Some(video) = media.child("video") {
                let format = video
                    .child("format")
                    .and_then(|f| f.child("samplecharacteristics"));
                if let Some(format) = format {
                    if let (Some(width), Some(height)) =
                        (format.number("width"), format.number("height"))
                    {
                        cut.size = (width as u32, height as u32);
                    }
                }
                for (index, track) in video.all("track").enumerate() {
                    self.track(track, seq_rate, &mut cut.picture, index);
                }
            }
            if let Some(audio) = media.child("audio") {
                let format = audio
                    .child("format")
                    .and_then(|f| f.child("samplecharacteristics"));
                if let Some(rate) = format.and_then(|format| format.number("samplerate")) {
                    cut.sample_rate = rate as u32;
                }
                let tracks = audio.all("track").filter(|track| !track.later_channel);
                for (index, track) in tracks.enumerate() {
                    self.track(track, seq_rate, &mut cut.sound, index);
                }
            }
        }
        for marker in sequence.all("marker") {
            let Some(frame) = marker.number("in") else {
                continue;
            };
            cut.markers.push(CutMarker {
                time: from_frames(frame.max(0.0), seq_rate),
                name: marker.text_of("name").unwrap_or_default().to_string(),
                color: MarkerColor::Blue,
            });
        }
        cut.markers.sort_by_key(|marker| marker.time);
        cut
    }
}

/// Reads FCP7 XML: the first sequence in the file, with the sequences it nests.
pub fn read(text: &str) -> Result<Cut, String> {
    let root = parse(text)?;
    let xmeml = root.child("xmeml").ok_or("This is not an FCP7 XML file")?;
    let (mut files, mut sequences) = (Vec::new(), Vec::new());
    xmeml.collect("file", &mut files);
    xmeml.collect("sequence", &mut sequences);
    let holds = |element: &&Rc<Element>| !element.children.is_empty();
    let by_id = |elements: Vec<&Rc<Element>>| {
        let mut map = BTreeMap::new();
        for element in elements.into_iter().filter(holds) {
            if let Some(id) = &element.id {
                map.entry(id.clone()).or_insert_with(|| element.clone());
            }
        }
        map
    };
    let first = sequences
        .iter()
        .find(|sequence| holds(sequence))
        .map(|sequence| (*sequence).clone())
        .ok_or("This file holds no sequence")?;
    let mut reader = XmlReader {
        files: by_id(files),
        sequences: by_id(sequences),
        cuts: BTreeMap::new(),
        left_out: Vec::new(),
        depth: 0,
    };
    let mut cut = reader.sequence(&first);
    cut.left_out = reader.left_out;
    cut.left_out.sort();
    cut.left_out.dedup();
    if cut.name.trim().is_empty() {
        cut.name = "Imported timeline".into();
    }
    Ok(cut)
}

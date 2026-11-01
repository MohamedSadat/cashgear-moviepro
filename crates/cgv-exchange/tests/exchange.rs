//! Timelines to and from OTIO and FCP7 XML: the interchange fixture goes out and
//! comes back the same, sample timelines other editors wrote read with every clip
//! and range, and (where its Python package is set up) OpenTimelineIO itself reads
//! what we write.
use std::path::{Path, PathBuf};
use std::process::Command as Process;
use std::rc::Rc;

use cgv_exchange::cut::{from_project, to_project, Cut, CutTrack, Dissolve, Item, Source};
use cgv_exchange::{export_project, fcp7, otio, Format};
use cgv_model::*;
use cgv_time::{Flicks, FrameRate, FLICKS_PER_SECOND};
use serde_json::{json, Value};

const FRAME: i64 = 23_520_000;

fn f(frames: i64) -> Flicks {
    Flicks(frames * FRAME)
}

fn media(id: &str, kind: MediaKind, seconds: i64) -> MediaRef {
    let picture = kind == MediaKind::Video;
    MediaRef {
        id: id.into(),
        name: format!("{id}.{}", if picture { "mov" } else { "wav" }),
        kind,
        duration: Flicks(FLICKS_PER_SECOND * seconds),
        has_video: picture,
        has_audio: true,
        width: if picture { 1920 } else { 0 },
        height: if picture { 1080 } else { 0 },
        frame_rate: picture.then_some(FrameRate::FPS_30),
        size: 1000,
        modified: None,
        location: MediaLocation::Path {
            path: format!(
                "D:/footage/day one/{id}.{}",
                if picture { "mov" } else { "wav" }
            ),
        },
    }
}

struct Fixture {
    session: Session,
}

impl Fixture {
    fn run(&mut self, command: Command) -> Vec<u64> {
        self.session
            .execute(&command)
            .unwrap_or_else(|error| panic!("{command:?}: {error}"))
            .created
    }

    fn clip(&mut self, track: TrackId, at: i64, spec: ClipSpec) -> ClipId {
        ClipId(
            self.run(Command::Overwrite {
                track,
                at: f(at),
                clip: spec,
            })[0],
        )
    }
}

fn spec(media: &str, source_in: i64, frames: i64) -> ClipSpec {
    ClipSpec {
        media: media.into(),
        source_in: f(source_in),
        duration: f(frames),
        ..ClipSpec::default()
    }
}

/// Three video tracks and two sound tracks, with cuts, a dissolve, speed changes,
/// a freeze frame, opacity, volume, markers, a nested sequence and a multicam clip.
fn fixture() -> Project {
    let mut fx = Fixture {
        session: Session::new(Project::new("fixture", "Interchange fixture")),
    };
    fx.run(Command::SetMagnetic { magnetic: false });
    for item in [
        media("a", MediaKind::Video, 40),
        media("b", MediaKind::Video, 40),
        media("c", MediaKind::Video, 40),
        media("music", MediaKind::Audio, 60),
        media("voice", MediaKind::Audio, 60),
    ] {
        fx.run(Command::AddMedia { media: item });
    }
    for index in 2..5 {
        fx.run(Command::AddTrack { index, name: None });
    }
    let tracks: Vec<TrackId> = fx.session.project().tracks.iter().map(|t| t.id).collect();
    let [music, voice, v1, v2, v3] = tracks[..] else {
        panic!("five tracks")
    };
    // Sound only.
    let properties = ClipProperties {
        volume_db: Some(-6.0),
        ..ClipProperties::default()
    };
    fx.clip(
        music,
        0,
        ClipSpec {
            properties: Some(properties),
            ..spec("music", 30, 300)
        },
    );
    fx.clip(voice, 45, spec("voice", 0, 75));
    // V1: picture and sound, a dissolve, a freeze frame after a gap.
    let first = fx.clip(v1, 0, spec("a", 0, 60));
    let second = fx.clip(v1, 60, spec("b", 30, 60));
    fx.run(Command::AddTransition {
        track: v1,
        from: Some(first),
        to: Some(second),
        transition: TransitionSpec {
            kind: "cross-dissolve".into(),
            pack: BUILTIN_PACK.into(),
            version: 1,
            duration: f(10),
            alignment: Some(Alignment::Center),
            params: Params::new(),
        },
    });
    fx.clip(
        v1,
        130,
        ClipSpec {
            freeze: true,
            video: Some(true),
            audio: Some(false),
            ..spec("c", 45, 20)
        },
    );
    // V2: double speed at 70% opacity, then half speed, then backwards.
    let properties = ClipProperties {
        opacity: Some(0.7),
        ..ClipProperties::default()
    };
    fx.clip(
        v2,
        30,
        ClipSpec {
            speed: Speed::new(2, 1),
            video: Some(true),
            audio: Some(false),
            properties: Some(properties),
            ..spec("c", 30, 60)
        },
    );
    fx.clip(
        v2,
        90,
        ClipSpec {
            speed: Speed::new(1, 2),
            video: Some(true),
            audio: Some(false),
            ..spec("a", 100, 60)
        },
    );
    fx.clip(
        v2,
        150,
        ClipSpec {
            reverse: true,
            video: Some(true),
            audio: Some(false),
            ..spec("b", 200, 30)
        },
    );
    // V3: a nested sequence, shown twice.
    let inner_a = fx.clip(v3, 200, spec("a", 300, 40));
    let inner_b = fx.clip(v3, 240, spec("b", 300, 20));
    let nested = fx.run(Command::Nest {
        clips: vec![inner_a, inner_b],
        name: Some("Nested".into()),
    });
    let sequence = SequenceId(nested[1]);
    fx.clip(
        v3,
        300,
        ClipSpec {
            kind: ClipKind::Sequence,
            sequence: Some(sequence),
            source_in: f(10),
            duration: f(30),
            ..ClipSpec::default()
        },
    );
    // A multicam clip on the free part of V1, cut once: it goes as what it shows.
    let angle_a = fx.clip(v1, 400, spec("a", 0, 90));
    let angle_b = fx.clip(v2, 400, spec("b", 0, 90));
    let made = fx.run(Command::MakeMulticam {
        clips: vec![angle_a, angle_b],
        sync: vec![f(0), f(15)],
        name: Some("Interview".into()),
    });
    fx.run(Command::SwitchAngle {
        clip: ClipId(made[0]),
        at: f(450),
        angle: 1,
    });
    // Markers.
    fx.run(Command::AddMarker {
        at: f(15),
        name: "Open".into(),
        color: MarkerColor::Green,
    });
    fx.run(Command::AddMarker {
        at: f(90),
        name: "Middle".into(),
        color: MarkerColor::Blue,
    });
    fx.session.project().clone()
}

fn source_key(item: &Item) -> String {
    match &item.source {
        Source::Media(file) => format!("media {}", file.name),
        Source::Nest(cut) => format!("sequence {}", cut.name),
    }
}

/// What a track says, in a form to compare: `slack` is how far a source time may
/// differ (FCP7's frames after a speed change round it).
#[derive(Debug, PartialEq)]
struct ItemView {
    source: String,
    start: i64,
    duration: i64,
    source_frames: i64,
    speed_percent: i64,
    freeze: bool,
    opacity_percent: i64,
    volume_tenths: i64,
}

fn view_item(item: &Item) -> ItemView {
    ItemView {
        source: source_key(item),
        start: item.start.0 / FRAME,
        duration: item.duration.0 / FRAME,
        source_frames: (item.source_in.0 as f64 / FRAME as f64).round() as i64,
        speed_percent: (item.speed * 100.0).round() as i64,
        freeze: item.freeze,
        opacity_percent: (item.opacity * 100.0).round() as i64,
        volume_tenths: (item.volume_db * 10.0).round() as i64,
    }
}

fn view_tracks(tracks: &[CutTrack]) -> Vec<(Vec<ItemView>, Vec<Dissolve>)> {
    let mut views: Vec<_> = tracks
        .iter()
        .map(|track| {
            (
                track.items.iter().map(view_item).collect::<Vec<_>>(),
                track.dissolves.clone(),
            )
        })
        .collect();
    views.sort_by_key(|(items, _)| (items[0].start, items[0].source.clone(), items.len()));
    views
}

/// Sound's items and dissolves, whichever tracks they are on: sound that plays
/// with a picture comes back on that picture's clip, and the rest on tracks of
/// its own.
fn view_sound(tracks: &[CutTrack]) -> (Vec<ItemView>, Vec<Dissolve>) {
    let mut items: Vec<ItemView> = tracks
        .iter()
        .flat_map(|track| track.items.iter().map(view_item))
        .collect();
    items.sort_by_key(|item| (item.start, item.source.clone()));
    let mut dissolves: Vec<Dissolve> = tracks
        .iter()
        .flat_map(|track| track.dissolves.iter().copied())
        .collect();
    dissolves.sort_by_key(|dissolve| dissolve.cut);
    (items, dissolves)
}

fn assert_same_cut(actual: &Cut, expected: &Cut) {
    assert_eq!(
        view_tracks(&actual.picture),
        view_tracks(&expected.picture),
        "picture tracks of {}",
        expected.name
    );
    assert_eq!(
        view_sound(&actual.sound),
        view_sound(&expected.sound),
        "sound of {}",
        expected.name
    );
    let markers = |cut: &Cut| -> Vec<(Flicks, String)> {
        cut.markers
            .iter()
            .map(|marker| (marker.time, marker.name.clone()))
            .collect()
    };
    assert_eq!(markers(actual), markers(expected));
    // Nested timelines the same way, each once.
    let nests = |cut: &Cut| -> Vec<Rc<Cut>> {
        let mut found: Vec<Rc<Cut>> = Vec::new();
        for item in cut.picture.iter().flat_map(|track| &track.items) {
            if let Source::Nest(inner) = &item.source {
                if !found.iter().any(|other| other.name == inner.name) {
                    found.push(inner.clone());
                }
            }
        }
        found
    };
    let (ours, theirs) = (nests(actual), nests(expected));
    assert_eq!(ours.len(), theirs.len());
    for (a, b) in ours.iter().zip(&theirs) {
        assert_same_cut(a, b);
    }
}

fn round_trip(write: fn(&Cut) -> String, read: fn(&str) -> Result<Cut, String>) -> (Cut, Cut) {
    let project = fixture();
    validate(&project).unwrap();
    let cut = from_project(&project, Node::Main).unwrap();
    let text = write(&cut);
    let parsed = read(&text).unwrap();
    let imported = to_project(&parsed, "imported", None).unwrap();
    validate(&imported.project).unwrap();
    assert!(
        imported.left_out.is_empty(),
        "left out: {:?}",
        imported.left_out
    );
    let back = from_project(&imported.project, Node::Main).unwrap();
    (cut, back)
}

#[test]
fn the_fixture_goes_out_and_comes_back_through_otio() {
    let (cut, back) = round_trip(otio::write, otio::read);
    assert_same_cut(&back, &cut);
    assert_eq!(back.size, (1920, 1080));
    assert_eq!(back.rate, FrameRate::FPS_30);
    // OTIO keeps marker colours; both sequence clips show one sequence.
    let colours: Vec<MarkerColor> = back.markers.iter().map(|marker| marker.color).collect();
    assert_eq!(colours, [MarkerColor::Green, MarkerColor::Blue]);
    let imported = to_project(&otio::read(&otio::write(&cut)).unwrap(), "x", None).unwrap();
    assert_eq!(imported.project.sequences.len(), 1);
}

#[test]
fn the_fixture_goes_out_and_comes_back_through_fcp7_xml() {
    let (cut, back) = round_trip(fcp7::write, fcp7::read);
    assert_same_cut(&back, &cut);
    let imported = to_project(&fcp7::read(&fcp7::write(&cut)).unwrap(), "x", None).unwrap();
    assert_eq!(imported.project.sequences.len(), 1);
    // Paths come back as they went.
    let paths: Vec<&MediaLocation> = imported.project.media.iter().map(|m| &m.location).collect();
    assert!(paths.iter().all(|location| matches!(
        location,
        MediaLocation::Path { path } if path.starts_with("D:/footage/day one/")
    )));
}

#[test]
fn multicam_clips_go_as_the_angles_they_show_and_exports_say_what_stays_behind() {
    let mut project = fixture();
    let v1 = project.tracks[2].id;
    let (next, created) = project
        .apply(&Command::Overwrite {
            track: v1,
            at: f(600),
            clip: ClipSpec {
                kind: ClipKind::Title,
                duration: f(30),
                title: Some(Title::default()),
                ..ClipSpec::default()
            },
        })
        .unwrap();
    project = next;
    let (next, _) = project
        .apply(&Command::AddEffect {
            clip: ClipId(created.created[0]),
            effect: EffectSpec {
                id: None,
                kind: "sepia".into(),
                pack: BUILTIN_PACK.into(),
                version: 1,
                enabled: true,
                params: Params::new(),
                masks: Vec::new(),
            },
            index: None,
            audio: false,
        })
        .unwrap();
    project = next;
    let exported = export_project(&project, Node::Main, Format::Otio).unwrap();
    assert!(
        exported
            .left_out
            .iter()
            .any(|text| text.contains("The title at")),
        "{:?}",
        exported.left_out
    );
    let cut = from_project(&project, Node::Main).unwrap();
    // The multicam clip: frames 400 to 450 of angle A, then angle B from there.
    let parts: Vec<&Item> = cut
        .picture
        .iter()
        .flat_map(|track| &track.items)
        .filter(|item| item.start >= f(400) && item.start < f(600))
        .collect();
    assert_eq!(parts.len(), 2);
    assert_eq!(source_key(parts[0]), "media a.mov");
    assert_eq!(source_key(parts[1]), "media b.mov");
    assert_eq!(parts[1].start, f(450));
}

fn sample(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/exchange")
        .join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn items(tracks: &[CutTrack]) -> usize {
    tracks.iter().map(|track| track.items.len()).sum()
}

#[test]
fn premieres_own_xml_reads_with_its_clips_nesting_and_markers() {
    let cut = fcp7::read(&sample("premiere_example.xml")).unwrap();
    assert_eq!(cut.name, "sc01_sh010_layerA");
    assert_eq!(cut.rate, FrameRate::FPS_30);
    assert_eq!(cut.picture.len(), 4, "video tracks");
    // One clip of the top track: at frame 13, 100 frames from its first frame.
    let first = cut.picture.iter().flat_map(|t| &t.items).find(|item| {
        item.start == f(13)
            && matches!(&item.source, Source::Media(file) if file.name == "sc01_sh010_anim.mov")
    });
    let first = first.expect("the first clip");
    assert_eq!(
        (first.start, first.duration, first.source_in),
        (f(13), f(100), f(0))
    );
    let path = match &first.source {
        Source::Media(file) => file.path.clone(),
        _ => None,
    };
    assert_eq!(path.as_deref(), Some("D:/media/sc01_sh010_anim.mov"));
    // Dissolves sit on the cuts their clips leave with -1.
    assert!(cut.picture.iter().any(|track| !track.dissolves.is_empty()));
    // The sequence markers, and the nested sequence.
    assert_eq!(cut.markers.len(), 3);
    let nested = cut
        .picture
        .iter()
        .flat_map(|t| &t.items)
        .find_map(|item| match &item.source {
            Source::Nest(inner) => Some(inner.clone()),
            _ => None,
        });
    assert!(nested.is_some(), "a nested sequence");
    // It becomes a valid project, with its media waiting to be relinked.
    let imported = to_project(&cut, "premiere", None).unwrap();
    validate(&imported.project).unwrap();
    assert_eq!(imported.project.sequences.len(), 1);
    let names: Vec<&str> = imported
        .project
        .media
        .iter()
        .map(|m| m.name.as_str())
        .collect();
    for name in [
        "sc01_sh010_anim.mov",
        "sc01_sh020_anim.mov",
        "sc01_sh030_anim.mov",
        "sc01_master_layerA_sh030_temp.mov",
        "sc01_placeholder.wav",
        "track_08.wav",
    ] {
        assert!(names.contains(&name), "{name} in {names:?}");
    }
    println!("left out: {:#?}", imported.left_out);
}

#[test]
fn opentimelineio_samples_read_as_projects() {
    for (name, picture, sound) in [
        ("premiere_example.otio", 4, 4),
        ("transition_test.otio", 1, 0),
        ("multitrack.otio", 3, 0),
        ("nested_example.otio", 1, 0),
    ] {
        let cut = otio::read(&sample(name)).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(cut.picture.len(), picture, "{name}: picture tracks");
        println!("{name}: {} clips", items(&cut.picture) + items(&cut.sound));
        assert_eq!(cut.sound.len(), sound, "{name}: sound tracks");
        assert!(items(&cut.picture) + items(&cut.sound) > 0, "{name}");
        let imported =
            to_project(&cut, "sample", None).unwrap_or_else(|error| panic!("{name}: {error}"));
        validate(&imported.project).unwrap_or_else(|error| panic!("{name}: {error}"));
    }
    // A timeline with odd source data: Hiero's FCP7 export.
    let cut = fcp7::read(&sample("hiero_xml_export.xml")).unwrap();
    assert!(items(&cut.picture) + items(&cut.sound) > 0);
    validate(&to_project(&cut, "hiero", None).unwrap().project).unwrap();
}

/// The Python that has OpenTimelineIO, when the test tools are set up:
/// `CGV_OTIO_PYTHON`, or `.tools/otio/Scripts/python.exe` (`pnpm setup:otio`).
fn otio_python() -> Option<PathBuf> {
    if let Some(python) = std::env::var_os("CGV_OTIO_PYTHON") {
        return Some(PathBuf::from(python));
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    [".tools/otio/Scripts/python.exe", ".tools/otio/bin/python"]
        .iter()
        .map(|path| root.join(path))
        .find(|path| path.exists())
}

/// What OpenTimelineIO itself reads from `file`.
fn otio_reads(python: &Path, file: &Path, rate: FrameRate) -> Value {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/otio_dump.py");
    let output = Process::new(python)
        .arg(script)
        .arg(file)
        .arg(rate.as_f64().to_string())
        .output()
        .expect("running Python");
    assert!(
        output.status.success(),
        "OpenTimelineIO could not read {}: {}",
        file.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("its JSON")
}

/// What a cut should read as: for FCP7, `in` counts frames after the speed
/// change, and OpenTimelineIO hands that over as it is.
fn expected_dump(cut: &Cut, fcp: bool) -> Value {
    let rate = cut.rate.as_f64();
    let frames =
        |time: Flicks| (time.0 as f64 * rate / FLICKS_PER_SECOND as f64 * 1000.0).round() / 1000.0;
    let tracks = |tracks: &[CutTrack], kind: &str| -> Vec<Value> {
        tracks
            .iter()
            .map(|track| {
                let items: Vec<Value> = track
                    .items
                    .iter()
                    .map(|item| {
                        let speed = item.speed.abs();
                        let span = Flicks((item.duration.0 as f64 * speed).round() as i64);
                        let low = if item.speed < 0.0 {
                            item.source_in - span
                        } else {
                            item.source_in
                        };
                        let shown = if fcp {
                            let scale = if item.freeze { 1.0 } else { speed };
                            frames(Flicks((low.0 as f64 / scale).round() as i64)).round()
                        } else {
                            frames(item.source_in)
                        };
                        let warp = if item.freeze { 0.0 } else { item.speed };
                        let name = match &item.source {
                            Source::Media(file) => file.name.clone(),
                            Source::Nest(inner) => inner.name.clone(),
                        };
                        json!({
                            "name": name,
                            "start": frames(item.start),
                            "duration": frames(item.duration),
                            "sourceStart": shown,
                            "speed": (warp * 100.0_f64).round() / 100.0,
                        })
                    })
                    .collect();
                let dissolves: Vec<Value> = track
                    .dissolves
                    .iter()
                    .map(|dissolve| {
                        json!({
                            "cut": frames(dissolve.cut),
                            "before": frames(dissolve.before),
                            "after": frames(dissolve.after),
                        })
                    })
                    .collect();
                json!({ "kind": kind, "items": items, "dissolves": dissolves })
            })
            .collect()
    };
    let mut all = tracks(&cut.picture, "Video");
    all.extend(tracks(&cut.sound, "Audio"));
    let markers: Vec<Value> = cut
        .markers
        .iter()
        .map(|marker| json!({ "name": marker.name, "time": frames(marker.time) }))
        .collect();
    json!({ "tracks": all, "markers": markers })
}

#[test]
fn opentimelineio_reads_what_we_write_exact_to_the_frame() {
    let required = std::env::var_os("CGV_REQUIRE_OTIO").is_some_and(|value| value == "1");
    let Some(python) = otio_python() else {
        assert!(!required, "OpenTimelineIO is required: run pnpm setup:otio");
        eprintln!("OpenTimelineIO is not set up (pnpm setup:otio): skipped");
        return;
    };
    let project = fixture();
    let cut = from_project(&project, Node::Main).unwrap();
    let dir = std::env::temp_dir().join(format!("cgv-exchange-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let otio_file = dir.join("fixture.otio");
    let xml_file = dir.join("fixture.xml");
    std::fs::write(&otio_file, otio::write(&cut)).unwrap();
    std::fs::write(&xml_file, fcp7::write(&cut)).unwrap();
    let read = otio_reads(&python, &otio_file, cut.rate);
    assert_eq!(
        read,
        expected_dump(&cut, false),
        "OTIO, as OpenTimelineIO reads it"
    );
    let read = otio_reads(&python, &xml_file, cut.rate);
    assert_eq!(
        read,
        expected_dump(&cut, true),
        "FCP7 XML, as OpenTimelineIO reads it"
    );
    std::fs::remove_dir_all(&dir).ok();
    // And it agrees with us on what Premiere wrote.
    let sample_file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/exchange/premiere_example.xml");
    let ours = fcp7::read(&sample("premiere_example.xml")).unwrap();
    let theirs = otio_reads(&python, &sample_file, ours.rate);
    let spans = |dump: &Value, kind: &str| -> Vec<(i64, i64)> {
        let mut spans: Vec<(i64, i64)> = dump["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|track| track["kind"] == kind)
            .flat_map(|track| track["items"].as_array().unwrap())
            .map(|item| {
                (
                    item["start"].as_f64().unwrap() as i64,
                    item["duration"].as_f64().unwrap() as i64,
                )
            })
            .collect();
        spans.sort();
        // Stereo split over two mono tracks is one clip of sound.
        spans.dedup();
        spans
    };
    // One sound clip overlaps the one before it. OpenTimelineIO's tracks can't
    // hold that, so it pushes the clip along; we keep the time the file gives.
    let mut ours = ours;
    for track in &mut ours.sound {
        let mut end = Flicks::ZERO;
        for item in &mut track.items {
            item.start = item.start.max(end);
            end = item.end();
        }
    }
    let ours_dump = expected_dump(&ours, true);
    assert_eq!(spans(&theirs, "Video"), spans(&ours_dump, "Video"));
    assert_eq!(spans(&theirs, "Audio"), spans(&ours_dump, "Audio"));
    assert_eq!(
        theirs["markers"].as_array().unwrap().len(),
        ours.markers.len()
    );
}

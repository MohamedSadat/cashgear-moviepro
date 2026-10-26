//! The `.cgvproj` file: versioned JSON around a [`Project`].
use serde::Serialize;
use serde_json::Value;

use crate::project::Project;
use crate::validate::validate;

pub const FORMAT: &str = "cashgear-video-project";
/// The format version this build writes. Older files are migrated when opened.
pub const VERSION: u32 = 6;
pub const EXTENSION: &str = "cgvproj";

/// Upgrades the `project` object of a file from one version to the next.
type Migration = fn(Value) -> Result<Value, String>;

/// `MIGRATIONS[n - 1]` upgrades version `n` to `n + 1`. Version 1 is the first.
const MIGRATIONS: &[Migration] = &[main_track, effect_ids, titles, sound, creative];

/// Format 2 adds the main track. A format 1 project's bottom track becomes its main
/// track, with magnetism off, so the edit stays exactly as it was.
fn main_track(mut project: Value) -> Result<Value, String> {
    let bottom = project
        .get("tracks")
        .and_then(Value::as_array)
        .and_then(|tracks| tracks.first())
        .and_then(|track| track.get("id"))
        .cloned()
        .ok_or("it has no tracks")?;
    let object = project
        .as_object_mut()
        .ok_or("the project is not an object")?;
    object.insert("mainTrack".into(), bottom);
    object.insert("magnetic".into(), Value::Bool(false));
    Ok(project)
}

/// Format 4 adds title clips. Nothing a format 3 project holds changes.
fn titles(project: Value) -> Result<Value, String> {
    Ok(project)
}

/// Format 5 adds track volume, pan, solo, roles and ducking, and sound fades,
/// noise reduction and sound effects on clips. Their defaults change nothing.
fn sound(project: Value) -> Result<Value, String> {
    Ok(project)
}

/// Format 6 adds speed ramps, reverse, freeze frames, frame blending, pitch,
/// blend modes and masks on clips. Their defaults change nothing.
fn creative(project: Value) -> Result<Value, String> {
    Ok(project)
}

/// Format 3 gives effects an id, a pack and a version, and adds transitions,
/// adjustment layers and LUTs. Format 2 effects (no command made them) get ids
/// from the project's counter and the built-in pack.
fn effect_ids(mut project: Value) -> Result<Value, String> {
    let mut next = project
        .get("nextId")
        .and_then(Value::as_u64)
        .ok_or("it has no id counter")?;
    let tracks = project
        .get_mut("tracks")
        .and_then(Value::as_array_mut)
        .ok_or("it has no tracks")?;
    for track in tracks {
        let Some(clips) = track.get_mut("clips").and_then(Value::as_array_mut) else {
            continue;
        };
        for clip in clips {
            let Some(effects) = clip.get_mut("effects").and_then(Value::as_array_mut) else {
                continue;
            };
            for effect in effects {
                let object = effect.as_object_mut().ok_or("an effect is not an object")?;
                object.insert("id".into(), next.into());
                object.insert("pack".into(), crate::effects::BUILTIN_PACK.into());
                object.insert("version".into(), 1.into());
                next += 1;
            }
        }
    }
    project["nextId"] = next.into();
    Ok(project)
}

#[derive(Serialize)]
struct Envelope<'a> {
    format: &'static str,
    version: u32,
    project: &'a Project,
}

/// The file's text: pretty-printed so projects compare and diff easily.
pub fn to_json(project: &Project) -> String {
    let envelope = Envelope {
        format: FORMAT,
        version: VERSION,
        project,
    };
    let mut text = serde_json::to_string_pretty(&envelope).expect("projects serialize");
    text.push('\n');
    text
}

/// Reads a project file, migrating older versions, and checks the result.
pub fn from_json(text: &str) -> Result<Project, String> {
    from_json_with(text, VERSION, MIGRATIONS)
}

fn from_json_with(text: &str, current: u32, migrations: &[Migration]) -> Result<Project, String> {
    let mut file: Value = serde_json::from_str(text)
        .map_err(|error| format!("The project file is damaged: {error}"))?;
    if file.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err("This is not a CashGear Video project".into());
    }
    let version = file
        .get("version")
        .and_then(Value::as_u64)
        .ok_or("The project file has no version")?;
    if version == 0 {
        return Err("The project file has an invalid version".into());
    }
    if version > current as u64 {
        return Err(format!(
            "This project was saved by a newer version of CashGear Video (format {version}). Update the app to open it."
        ));
    }
    let mut project = file
        .get_mut("project")
        .map(Value::take)
        .ok_or("The project file has no project")?;
    for step in version as u32..current {
        let migrate = migrations
            .get(step as usize - 1)
            .ok_or_else(|| format!("No migration from format {step}"))?;
        project = migrate(project).map_err(|error| {
            format!("Could not upgrade the project from format {step}: {error}")
        })?;
    }
    let project: Project = serde_json::from_value(project)
        .map_err(|error| format!("The project file is damaged: {error}"))?;
    validate(&project).map_err(|error| format!("The project file is damaged: {error}"))?;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_a_new_project() {
        let project = Project::new("p-1", "Holiday");
        let text = to_json(&project);
        assert!(text.starts_with("{\n  \"format\": \"cashgear-video-project\",\n  \"version\": 6,"));
        let loaded = from_json(&text).unwrap();
        assert_eq!(loaded, project);
        assert_eq!(to_json(&loaded), text);
    }

    #[test]
    fn format_1_projects_open_with_their_bottom_track_as_a_main_track_that_is_not_magnetic() {
        let mut project = Project::new("p-1", "Holiday");
        project.tracks.swap(0, 1);
        let mut old = serde_json::to_value(&project).unwrap();
        let object = old.as_object_mut().unwrap();
        object.remove("mainTrack");
        object.remove("magnetic");
        let file = json!({ "format": FORMAT, "version": 1, "project": old });
        let opened = from_json(&file.to_string()).unwrap();
        assert_eq!(opened.main_track, project.tracks[0].id);
        assert!(!opened.magnetic);
        assert_eq!(
            Project {
                main_track: project.main_track,
                magnetic: true,
                ..opened
            },
            project
        );
    }

    #[test]
    fn format_2_effects_get_ids_from_the_counter() {
        let mut project = Project::new("p-1", "Holiday");
        project.media.push(crate::MediaRef {
            id: "v".into(),
            name: "v.mp4".into(),
            kind: crate::MediaKind::Video,
            duration: cgv_time::Flicks::ONE_SECOND,
            has_video: true,
            has_audio: false,
            width: 16,
            height: 16,
            frame_rate: None,
            size: 1,
            modified: None,
            location: crate::MediaLocation::Browser,
        });
        let mut old = serde_json::to_value(&project).unwrap();
        old["tracks"][0]["clips"] = json!([{
            "id": 3, "media": "v", "start": 0, "duration": 23520000, "sourceIn": 0,
            "speed": { "num": 1, "den": 1 }, "video": true, "audio": false, "link": null,
            "transform": serde_json::to_value(crate::Transform::default()).unwrap(),
            "crop": { "left": 0, "top": 0, "right": 0, "bottom": 0 },
            "opacity": 1, "volumeDb": 0,
            "effects": [{ "kind": "gaussian-blur", "enabled": true, "params": { "radius": 0.5 } }],
            "keyframes": {
                "opacity": [{ "time": 0, "value": 0.5, "interpolation": { "kind": "hold" } }]
            }
        }]);
        old["nextId"] = json!(4);
        let file = json!({ "format": FORMAT, "version": 2, "project": old });
        let opened = from_json(&file.to_string()).unwrap();
        let clip = &opened.tracks[0].clips[0];
        assert_eq!(clip.effects[0].id, crate::EffectId(4));
        assert_eq!(clip.effects[0].pack, "builtin");
        assert_eq!(clip.effects[0].version, 1);
        assert_eq!(opened.next_id, 5);
        assert_eq!(clip.opacity_at(cgv_time::Flicks::ZERO), 0.5);
    }

    #[test]
    fn refuses_other_files_and_newer_versions() {
        assert!(from_json("not json").unwrap_err().contains("damaged"));
        assert!(from_json("{}")
            .unwrap_err()
            .contains("not a CashGear Video project"));
        let newer = json!({ "format": FORMAT, "version": VERSION + 1, "project": {} });
        assert!(from_json(&newer.to_string())
            .unwrap_err()
            .contains("newer version"));
        let zero = json!({ "format": FORMAT, "version": 0, "project": {} });
        assert!(from_json(&zero.to_string()).is_err());
        let missing = json!({ "format": FORMAT, "version": 1 });
        assert!(from_json(&missing.to_string())
            .unwrap_err()
            .contains("no project"));
    }

    #[test]
    fn refuses_projects_that_break_the_rules() {
        let mut project = Project::new("p-1", "Holiday");
        project.next_id = 1;
        let text = to_json(&project);
        assert!(from_json(&text)
            .unwrap_err()
            .contains("outside the id range"));
    }

    #[test]
    fn migrations_run_in_order_from_the_file_version() {
        fn one_to_two(mut project: Value) -> Result<Value, String> {
            // Format 1 called the project's name "title".
            let title = project["title"].take();
            let object = project.as_object_mut().ok_or("not an object")?;
            object.remove("title");
            object.insert("name".into(), title);
            Ok(project)
        }
        fn two_to_three(mut project: Value) -> Result<Value, String> {
            // Format 2 had no markers.
            project["markers"] = json!([]);
            Ok(project)
        }
        let current = serde_json::to_value(Project::new("p-1", "Holiday")).unwrap();
        let mut old = current.clone();
        let object = old.as_object_mut().unwrap();
        let name = object.remove("name").unwrap();
        object.insert("title".into(), name);
        object.remove("markers");
        let file = json!({ "format": FORMAT, "version": 1, "project": old });
        let migrations: &[Migration] = &[one_to_two, two_to_three];
        let migrated = from_json_with(&file.to_string(), 3, migrations).unwrap();
        assert_eq!(serde_json::to_value(migrated).unwrap(), current);

        let failing: &[Migration] = &[|_| Err("broken".into())];
        let error = from_json_with(&file.to_string(), 2, failing).unwrap_err();
        assert!(error.contains("from format 1: broken"), "{error}");
        assert!(from_json_with(&file.to_string(), 2, &[]).is_err());
    }
}

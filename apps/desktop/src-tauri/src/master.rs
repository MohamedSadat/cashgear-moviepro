//! ProRes master commands. The page mixes the sound and hands it over first,
//! then each frame the engine reads back as planar 10-bit Y'CbCr. Both come
//! through a frame channel (`frames.rs`): only slot numbers cross the IPC.
//! FFmpeg encodes the frames as they arrive into a file beside the destination,
//! which is moved into place once FFmpeg has finished it.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use cgv_native::export::part_path;
use cgv_native::ffmpeg::Tools;
use cgv_native::master::{MasterRequest, MasterWriter, Profile, Sound, SoundWriter};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::export::{check_room, destination, ExportState};
use crate::frames::FrameState;
use crate::media::MediaState;

pub struct Master {
    destination: PathBuf,
    request: MasterRequest,
    tools: Tools,
    /// The sound until the first frame; then FFmpeg reads the file.
    sound: Mutex<Option<SoundWriter>>,
    writer: Mutex<Option<MasterWriter>>,
}

impl Master {
    /// Stops FFmpeg and removes what this master wrote.
    pub(crate) fn cancel(&self) {
        if let Some(writer) = self.writer.lock().expect("master writer").take() {
            writer.cancel();
        }
        drop(self.sound.lock().expect("master sound").take());
        self.remove_files(true);
    }

    fn remove_files(&self, partial: bool) {
        if partial {
            let _ = std::fs::remove_file(&self.request.output);
        }
        if let Some((sound, _)) = &self.request.sound {
            let _ = std::fs::remove_file(sound);
        }
    }

    /// Hands FFmpeg `frame`, starting it at the first one.
    fn write_frame(&self, frame: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock().expect("master writer");
        if writer.is_none() {
            if let Some(sound) = self.sound.lock().expect("master sound").take() {
                sound.finish()?;
            }
            *writer = Some(MasterWriter::start(&self.tools, &self.request)?);
        }
        writer.as_mut().unwrap().write_frame(frame)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterFile {
    id: String,
    path: String,
    /// The bytes each frame must have.
    frame_bytes: u64,
}

/// A finished master.
#[derive(Serialize)]
pub struct MasterDone {
    path: String,
    bytes: u64,
}

impl ExportState {
    fn master(&self, id: &str) -> Result<Arc<Master>, String> {
        self.masters
            .lock()
            .expect("masters")
            .get(id)
            .cloned()
            .ok_or_else(|| format!("No master with id {id}"))
    }
}

/// Asks where to save a master (or takes `path`, for tests). Null when the user
/// cancels, and an error when the disk lacks room for `needs` bytes.
#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri passes the page's fields one by one"
)]
pub async fn master_open(
    app: AppHandle,
    media: State<'_, MediaState>,
    state: State<'_, ExportState>,
    name: String,
    path: Option<String>,
    width: u32,
    height: u32,
    rate: (u32, u32),
    profile: Profile,
    sound: Option<Sound>,
    needs: Option<u64>,
) -> Result<Option<MasterFile>, String> {
    if width < 2 || height < 2 || width % 2 == 1 || height % 2 == 1 || rate.0 == 0 || rate.1 == 0 {
        return Err(format!(
            "Cannot make a {width}×{height} master at {}/{} fps",
            rate.0, rate.1
        ));
    }
    let tools = media.tools()?.clone();
    let Some(destination) = destination(&app, &name, "mov", path) else {
        return Ok(None);
    };
    let output = part_path(&destination);
    check_room(&output, needs)?;
    let id = uuid::Uuid::new_v4().to_string();
    let sound = match sound {
        Some(layout) => {
            let folder = media.cache_root().join("exports");
            std::fs::create_dir_all(&folder)
                .map_err(|error| format!("Could not make {}: {error}", folder.display()))?;
            Some((folder.join(format!("{id}.f32")), layout))
        }
        None => None,
    };
    let writer = match &sound {
        Some((path, _)) => Some(SoundWriter::create(path)?),
        None => None,
    };
    let request = MasterRequest {
        width,
        height,
        rate,
        profile,
        sound,
        output,
    };
    let master = Master {
        destination: destination.clone(),
        request,
        tools,
        sound: Mutex::new(writer),
        writer: Mutex::new(None),
    };
    state
        .masters
        .lock()
        .expect("masters")
        .insert(id.clone(), Arc::new(master));
    Ok(Some(MasterFile {
        id,
        path: destination.display().to_string(),
        frame_bytes: profile.frame_bytes(width, height),
    }))
}

/// Appends `len` bytes of 32-bit float sound from slot `slot` of channel `channel`.
#[tauri::command]
pub async fn master_sound(
    frames: State<'_, FrameState>,
    state: State<'_, ExportState>,
    id: String,
    channel: String,
    slot: usize,
    len: usize,
) -> Result<(), String> {
    let master = state.master(&id)?;
    let channel = frames.channel(&channel)?;
    let mut sound = master.sound.lock().expect("master sound");
    sound
        .as_mut()
        .ok_or("This master has no sound, or its frames have started")?
        .write(channel.bytes(slot, len)?)
}

/// Hands FFmpeg the frame in slot `slot` of channel `channel`; resolves once it
/// has taken it, so the slot can be filled again.
#[tauri::command]
pub async fn master_frame(
    frames: State<'_, FrameState>,
    state: State<'_, ExportState>,
    id: String,
    channel: String,
    slot: usize,
    len: usize,
) -> Result<(), String> {
    let master = state.master(&id)?;
    let channel = frames.channel(&channel)?;
    tauri::async_runtime::spawn_blocking(move || master.write_frame(channel.bytes(slot, len)?))
        .await
        .map_err(|error| format!("The master failed: {error}"))?
}

/// Ends master `id`: waits for FFmpeg and moves the file into place. Resolves
/// with its path and size.
#[tauri::command]
pub async fn master_finish(
    state: State<'_, ExportState>,
    id: String,
) -> Result<MasterDone, String> {
    let master = state.master(&id)?;
    state.masters.lock().expect("masters").remove(&id);
    let finished = tauri::async_runtime::spawn_blocking({
        let master = master.clone();
        move || {
            let writer = master
                .writer
                .lock()
                .expect("master writer")
                .take()
                .ok_or("This master has no frames")?;
            writer.finish()
        }
    })
    .await
    .map_err(|error| format!("The master failed: {error}"))?;
    if let Err(error) = finished {
        master.cancel();
        return Err(error);
    }
    master.remove_files(false);
    let destination = &master.destination;
    std::fs::rename(&master.request.output, destination)
        .map_err(|error| format!("Could not save {}: {error}", destination.display()))?;
    Ok(MasterDone {
        path: destination.display().to_string(),
        bytes: std::fs::metadata(destination).map_or(0, |meta| meta.len()),
    })
}

/// Stops master `id` and removes its files.
#[tauri::command]
pub fn master_cancel(state: State<'_, ExportState>, id: String) {
    if let Some(master) = state.masters.lock().expect("masters").remove(&id) {
        master.cancel();
    }
}

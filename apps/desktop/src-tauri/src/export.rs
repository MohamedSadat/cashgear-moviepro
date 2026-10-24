//! Export commands. The webview renders, encodes and muxes; these commands ask
//! where to save, write the muxed bytes they are handed at their positions, and
//! finish the file: a rename into place, or an FFmpeg conversion (GIF, MP3).
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cgv_native::export::{part_path, Conversion, ExportWriter};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::media::MediaState;

struct Job {
    /// Taken when the file is finished.
    writer: Mutex<Option<ExportWriter>>,
    /// Where the finished export goes.
    destination: PathBuf,
    conversion: Option<Conversion>,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct ExportState {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl ExportState {
    fn job(&self, id: &str) -> Result<Arc<Job>, String> {
        self.jobs
            .lock()
            .expect("export jobs")
            .get(id)
            .cloned()
            .ok_or_else(|| format!("No export with id {id}"))
    }
}

#[derive(Serialize)]
pub struct ExportFile {
    id: String,
    path: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ExportEvent {
    Progress { progress: f32 },
}

/// Asks where to save an export (or takes `path`, for tests) and opens the file
/// the webview writes into: beside the destination until it is complete, or in
/// the cache folder when FFmpeg converts it afterwards. Null when the user cancels.
#[tauri::command]
pub async fn export_open(
    app: AppHandle,
    media: State<'_, MediaState>,
    state: State<'_, ExportState>,
    name: String,
    extension: String,
    path: Option<String>,
    convert: Option<Conversion>,
) -> Result<Option<ExportFile>, String> {
    let destination = match path {
        Some(path) => PathBuf::from(path),
        None => {
            let mut dialog = app
                .dialog()
                .file()
                .set_title("Export video")
                .set_file_name(&name)
                .add_filter(extension.to_uppercase(), &[extension.as_str()]);
            if let Ok(videos) = app.path().video_dir() {
                dialog = dialog.set_directory(videos);
            }
            match dialog
                .blocking_save_file()
                .and_then(|file| file.into_path().ok())
            {
                Some(path) => path,
                None => return Ok(None),
            }
        }
    };
    let id = uuid::Uuid::new_v4().to_string();
    let file = match convert {
        Some(conversion) => media
            .cache_root()
            .join("exports")
            .join(format!("{id}.{}", conversion.intermediate_extension())),
        None => part_path(&destination),
    };
    let writer = ExportWriter::create(&file)?;
    let job = Job {
        writer: Mutex::new(Some(writer)),
        destination: destination.clone(),
        conversion: convert,
        cancel: Arc::new(AtomicBool::new(false)),
    };
    state
        .jobs
        .lock()
        .expect("export jobs")
        .insert(id.clone(), Arc::new(job));
    Ok(Some(ExportFile {
        id,
        path: destination.display().to_string(),
    }))
}

/// Writes the raw body at the `x-position` byte of export `x-export-id`.
#[tauri::command]
pub fn export_write(
    state: State<'_, ExportState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| format!("Missing {name} header"))
    };
    let job = state.job(header("x-export-id")?)?;
    let position: u64 = header("x-position")?
        .parse()
        .map_err(|_| "Invalid x-position header")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("export_write expects raw bytes".into());
    };
    let mut writer = job.writer.lock().expect("export writer");
    writer
        .as_mut()
        .ok_or("This export is already finished")?
        .write_at(position, bytes)
}

/// Finishes export `id`: moves it into place, or converts it with FFmpeg,
/// reporting progress. Resolves with the file's path.
#[tauri::command]
pub async fn export_finish(
    media: State<'_, MediaState>,
    state: State<'_, ExportState>,
    id: String,
    duration_seconds: f64,
    audio_bitrate: Option<u32>,
    events: Channel<ExportEvent>,
) -> Result<String, String> {
    let job = state.job(&id)?;
    let result = finish(&media, &job, duration_seconds, audio_bitrate, events).await;
    state.jobs.lock().expect("export jobs").remove(&id);
    if result.is_err() {
        remove_partial(&job);
    }
    result
}

async fn finish(
    media: &MediaState,
    job: &Job,
    duration_seconds: f64,
    audio_bitrate: Option<u32>,
    events: Channel<ExportEvent>,
) -> Result<String, String> {
    let writer = job
        .writer
        .lock()
        .expect("export writer")
        .take()
        .ok_or("This export is already finished")?;
    let written = writer.finish()?;
    let destination = job.destination.clone();
    let Some(conversion) = job.conversion else {
        std::fs::rename(&written, &destination)
            .map_err(|error| format!("Could not save {}: {error}", destination.display()))?;
        return Ok(destination.display().to_string());
    };
    let tools = media.tools()?.clone();
    let partial = part_path(&destination);
    let cancel = job.cancel.clone();
    let args = conversion.arguments(&written, &partial, audio_bitrate.unwrap_or(256_000));
    let what = match conversion {
        Conversion::Gif => "make the GIF",
        Conversion::Mp3 => "make the MP3",
    };
    let converted = tauri::async_runtime::spawn_blocking(move || {
        cgv_native::ffmpeg::run_job(
            &tools,
            &args,
            duration_seconds,
            &cancel,
            |progress| {
                let _ = events.send(ExportEvent::Progress { progress });
            },
            what,
        )
    })
    .await
    .map_err(|error| format!("The conversion failed: {error}"))?;
    let _ = std::fs::remove_file(&written);
    if let Err(error) = converted {
        let _ = std::fs::remove_file(&partial);
        return Err(error);
    }
    std::fs::rename(&partial, &destination)
        .map_err(|error| format!("Could not save {}: {error}", destination.display()))?;
    Ok(destination.display().to_string())
}

/// Removes what was written of a failed or cancelled export.
fn remove_partial(job: &Job) {
    if let Some(writer) = job.writer.lock().expect("export writer").take() {
        let path = writer.path().to_path_buf();
        drop(writer);
        let _ = std::fs::remove_file(path);
    }
    let _ = std::fs::remove_file(part_path(&job.destination));
}

/// Stops export `id` (a conversion that runs is killed) and removes its files.
#[tauri::command]
pub fn export_cancel(state: State<'_, ExportState>, id: String) -> Result<(), String> {
    let Some(job) = state.jobs.lock().expect("export jobs").remove(&id) else {
        return Ok(());
    };
    job.cancel.store(true, Ordering::Relaxed);
    remove_partial(&job);
    Ok(())
}

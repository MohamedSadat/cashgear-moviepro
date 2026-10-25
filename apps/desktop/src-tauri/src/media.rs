//! Media commands and the `cgv-media://` protocol. The webview never sees raw
//! paths it did not get from the user: files are registered by id, served by
//! id with HTTP ranges, probed with ffprobe and proxied with ffmpeg.
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cgv_native::ffmpeg::Tools;
use cgv_native::probe::{self, NativeProbe};
use cgv_native::range::{self, RangeError};
use cgv_native::registry::{valid_id, RegisteredMedia, Registry};
use cgv_native::{cache, proxy, recording};
use serde::{Deserialize, Serialize};
use tauri::http::{header, Request, Response, StatusCode};
use tauri::ipc::{Channel, InvokeBody};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Largest single protocol response; the webview asks again for the rest.
const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

pub struct MediaState {
    registry: Registry,
    probes: Mutex<HashMap<String, NativeProbe>>,
    proxies: Mutex<HashMap<String, Arc<AtomicBool>>>,
    tools: Result<Tools, String>,
    cache_root: PathBuf,
}

impl MediaState {
    pub fn new(app: &AppHandle) -> MediaState {
        let app_dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf));
        let tools = Tools::locate(app_dir.as_deref()).and_then(|tools| {
            tools.check_license()?;
            Ok(tools)
        });
        let cache_root = app
            .path()
            .app_cache_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("cashgear-video"));
        MediaState {
            registry: Registry::default(),
            probes: Mutex::new(HashMap::new()),
            proxies: Mutex::new(HashMap::new()),
            tools,
            cache_root,
        }
    }

    pub(crate) fn tools(&self) -> Result<&Tools, String> {
        self.tools.as_ref().map_err(Clone::clone)
    }

    /// The app cache folder (thumbnails, waveforms, proxies, export intermediates).
    pub(crate) fn cache_root(&self) -> &Path {
        &self.cache_root
    }

    /// Makes `path` readable through the protocol as `id`.
    pub(crate) fn register_file(&self, id: &str, path: &Path) -> Result<RegisteredMedia, String> {
        self.registry.register(id, path)
    }
}

/// A registered file as the UI receives it: where to stream it from, and what ffprobe saw.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaFile {
    #[serde(flatten)]
    media: RegisteredMedia,
    probe: Option<NativeProbe>,
    probe_error: Option<String>,
}

#[derive(Deserialize)]
pub struct FileRequest {
    id: Option<String>,
    path: String,
}

pub(crate) fn register(state: &MediaState, id: String, path: &Path) -> Result<MediaFile, String> {
    let media = state.registry.register(&id, path)?;
    let (probe, probe_error) = match state.tools().and_then(|tools| probe::probe(tools, path)) {
        Ok(probe) => (Some(probe), None),
        Err(error) => (None, Some(error)),
    };
    if let Some(probe) = &probe {
        state
            .probes
            .lock()
            .expect("probes")
            .insert(id, probe.clone());
    }
    Ok(MediaFile {
        media,
        probe,
        probe_error,
    })
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

const EXTENSIONS: [&str; 16] = [
    "mp4", "m4v", "mov", "webm", "mkv", "avi", "mts", "mxf", "mp3", "wav", "aac", "m4a", "opus",
    "ogg", "flac", "png",
];

/// Opens the native file dialog and registers what the user picked.
#[tauri::command]
pub async fn media_pick(
    app: AppHandle,
    state: State<'_, MediaState>,
) -> Result<Vec<MediaFile>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Import media")
        .add_filter(
            "Video, audio and images",
            &[&EXTENSIONS[..], &["jpg", "jpeg", "webp"]].concat(),
        )
        .blocking_pick_files()
        .unwrap_or_default();
    picked
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .map(|path| register(&state, new_id(), &path))
        .collect()
}

/// Registers dropped or remembered paths (reusing their ids when given).
#[tauri::command]
pub fn media_register(
    state: State<'_, MediaState>,
    files: Vec<FileRequest>,
) -> Result<Vec<MediaFile>, String> {
    files
        .into_iter()
        .map(|file| {
            let id = match file.id {
                Some(id) if valid_id(&id) => id,
                Some(id) => return Err(format!("Invalid media id {id:?}")),
                None => new_id(),
            };
            register(&state, id, Path::new(&file.path))
        })
        .collect()
}

#[tauri::command]
pub fn media_forget(state: State<'_, MediaState>, id: String) -> Result<(), String> {
    if let Some(cancel) = state.proxies.lock().expect("proxies").remove(&id) {
        cancel.store(true, Ordering::Relaxed);
    }
    state.registry.forget(&id);
    state.registry.forget(&format!("{id}.proxy"));
    state.probes.lock().expect("probes").remove(&id);
    let _ = std::fs::remove_file(proxy_path(&state, &id)?);
    Ok(())
}

/// Drops the proxy of a file that changed on disk, so the next one is made from the new file.
#[tauri::command]
pub fn media_drop_proxy(state: State<'_, MediaState>, id: String) -> Result<(), String> {
    if let Some(cancel) = state.proxies.lock().expect("proxies").remove(&id) {
        cancel.store(true, Ordering::Relaxed);
    }
    state.registry.forget(&format!("{id}.proxy"));
    match std::fs::remove_file(proxy_path(&state, &id)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove the old proxy: {error}")),
    }
}

fn proxy_path(state: &MediaState, id: &str) -> Result<PathBuf, String> {
    cache::key_path(&state.cache_root, &format!("proxies/{id}.mp4"))
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum ProxyEvent {
    Progress { progress: f32 },
}

/// Transcodes a registered file to its 720p H.264 proxy (reusing one made earlier).
#[tauri::command]
pub async fn media_make_proxy(
    state: State<'_, MediaState>,
    id: String,
    events: Channel<ProxyEvent>,
) -> Result<RegisteredMedia, String> {
    let input = state
        .registry
        .path(&id)
        .ok_or_else(|| format!("No media with id {id}"))?;
    let output = proxy_path(&state, &id)?;
    let proxy_id = format!("{id}.proxy");
    if output.is_file() {
        let _ = events.send(ProxyEvent::Progress { progress: 1.0 });
        return state.registry.register(&proxy_id, &output);
    }
    let tools = state.tools()?.clone();
    let probe = state
        .probes
        .lock()
        .expect("probes")
        .get(&id)
        .cloned()
        .ok_or("This file could not be probed, so no proxy can be made")?;
    let video = probe
        .video
        .ok_or("This file has no video to make a proxy of")?;
    let encoder = tools
        .h264_encoder()
        .ok_or("No H.264 encoder works on this computer")?;
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .proxies
        .lock()
        .expect("proxies")
        .insert(id.clone(), cancel.clone());
    let job_output = output.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        proxy::run(
            &tools,
            &proxy::ProxyRequest {
                input: &input,
                output: &job_output,
                encoder,
                frame_rate: video.frame_rate,
                duration_seconds: probe.duration_seconds,
                has_audio: probe.audio.is_some(),
            },
            &cancel,
            |progress| {
                let _ = events.send(ProxyEvent::Progress { progress });
            },
        )
    })
    .await
    .map_err(|error| format!("The proxy job failed: {error}"))?;
    state.proxies.lock().expect("proxies").remove(&id);
    result?;
    state.registry.register(&proxy_id, &output)
}

#[tauri::command]
pub fn cache_read(
    state: State<'_, MediaState>,
    key: String,
) -> Result<tauri::ipc::Response, String> {
    // An empty body means "not cached"; real entries are never empty.
    Ok(tauri::ipc::Response::new(
        cache::read(&state.cache_root, &key)?.unwrap_or_default(),
    ))
}

#[tauri::command]
pub fn cache_write(
    state: State<'_, MediaState>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let key = request
        .headers()
        .get("x-cache-key")
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing x-cache-key header")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("cache_write expects raw bytes".into());
    };
    cache::write(&state.cache_root, key, bytes)
}

#[tauri::command]
pub fn cache_remove(state: State<'_, MediaState>, prefix: String) -> Result<(), String> {
    cache::remove(&state.cache_root, &prefix)
}

/// Keeps a voiceover the page wrote to cache entry `key`: moves it to the
/// project's `Voiceovers` folder as `name` and registers it as media.
#[tauri::command]
pub fn recording_save(
    app: AppHandle,
    state: State<'_, MediaState>,
    key: String,
    name: String,
    project: Option<String>,
) -> Result<MediaFile, String> {
    let from = cache::key_path(&state.cache_root, &key)?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No app data folder: {error}"))?;
    let folder = recording::folder(project.as_deref().map(Path::new), &data);
    let path = recording::keep(&from, &folder, &name)?;
    register(&state, new_id(), &path)
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4" | "m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("aac") => "audio/aac",
        Some("m4a") => "audio/mp4",
        Some("opus" | "ogg") => "audio/ogg",
        Some("flac") => "audio/flac",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

fn response(status: StatusCode) -> tauri::http::response::Builder {
    // The app origin differs from the protocol's, and the page is cross-origin isolated.
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Range, Content-Length, Accept-Ranges",
        )
        .header("Cross-Origin-Resource-Policy", "cross-origin")
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    response(status).body(Vec::new()).expect("response")
}

/// Serves one protocol request: a capped byte range of a registered file.
pub fn serve(state: &MediaState, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == "OPTIONS" {
        return empty(StatusCode::NO_CONTENT);
    }
    let Some(path) =
        Registry::id_from_uri_path(request.uri().path()).and_then(|id| state.registry.path(id))
    else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(mut file) = std::fs::File::open(&path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let header = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let span = match range::resolve(header, size, MAX_RESPONSE_BYTES) {
        Ok(span) => span,
        Err(RangeError::Unsatisfiable) => {
            return response(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Vec::new())
                .expect("response")
        }
        Err(RangeError::Malformed) => return empty(StatusCode::BAD_REQUEST),
    };
    let mut body = vec![0; span.len() as usize];
    if file.seek(SeekFrom::Start(span.start)).is_err() || file.read_exact(&mut body).is_err() {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    }
    if request.method() == "HEAD" {
        body.clear();
    }
    response(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, content_type(&path))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, span.content_range(size))
        .header(header::CONTENT_LENGTH, span.len())
        .body(body)
        .expect("response")
}

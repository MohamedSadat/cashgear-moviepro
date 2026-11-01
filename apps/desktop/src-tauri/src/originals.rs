//! Original frames for exports. FFmpeg decodes registered media at its own size
//! and bit depth into a frame channel's slot (`frames.rs`), one frame per
//! command, so an export reads the original rather than its proxy. Each session
//! keeps one FFmpeg running from the last frame it gave: exports read forwards.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use cgv_native::originals::{Original, OriginalDecoder};
use serde::Serialize;
use tauri::State;

use crate::frames::FrameState;
use crate::media::MediaState;

/// Frames a session decodes and drops rather than starting FFmpeg again.
const SKIP_FRAMES: u64 = 48;

struct Session {
    original: Original,
    decoder: Option<OriginalDecoder>,
}

#[derive(Default)]
pub struct OriginalsState {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginalSession {
    id: String,
    #[serde(flatten)]
    original: Original,
    /// Offset and stride in bytes of each plane.
    planes: [(u64, u64); 3],
}

/// Opens registered media `media` for decoding: its frame size before rotation,
/// layout and frame bytes.
#[tauri::command]
pub async fn originals_open(
    media: State<'_, MediaState>,
    state: State<'_, OriginalsState>,
    id: String,
) -> Result<OriginalSession, String> {
    let path = media
        .registered_path(&id)
        .ok_or("That media is not registered")?;
    let tools = media.tools()?.clone();
    let original = tauri::async_runtime::spawn_blocking(move || Original::probe(&tools, &path))
        .await
        .map_err(|error| error.to_string())??;
    let session = uuid::Uuid::new_v4().to_string();
    let planes = original.layout.planes(original.width, original.height);
    state.sessions.lock().expect("original sessions").insert(
        session.clone(),
        Arc::new(Mutex::new(Session {
            original: original.clone(),
            decoder: None,
        })),
    );
    Ok(OriginalSession {
        id: session,
        original,
        planes,
    })
}

/// Decodes frame `frame` (which starts at `seconds`, and lasts `frame_seconds`)
/// of session `id` into slot `slot` of channel `channel`.
#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri passes the page's fields one by one"
)]
pub async fn originals_frame(
    media: State<'_, MediaState>,
    frames: State<'_, FrameState>,
    state: State<'_, OriginalsState>,
    id: String,
    channel: String,
    slot: usize,
    frame: u64,
    seconds: f64,
    frame_seconds: f64,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .expect("original sessions")
        .get(&id)
        .cloned()
        .ok_or("That original is closed")?;
    let channel = frames.channel(&channel)?;
    let tools = media.tools()?.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = session.lock().expect("original session");
        let Session { original, decoder } = &mut *session;
        let bytes = channel.bytes_mut(slot, original.frame_bytes as usize)?;
        let ahead = decoder
            .as_ref()
            .and_then(|decoder| frame.checked_sub(decoder.next))
            .filter(|&ahead| ahead <= SKIP_FRAMES);
        let decoder = match (decoder, ahead) {
            (Some(decoder), Some(ahead)) => {
                for _ in 0..ahead {
                    decoder.read(bytes)?;
                }
                decoder
            }
            (decoder, _) => decoder.insert(OriginalDecoder::start(
                &tools,
                original,
                frame,
                seconds,
                frame_seconds,
            )?),
        };
        decoder.read(bytes)
    })
    .await
    .map_err(|error| format!("Decoding the original failed: {error}"))?
}

/// Closes session `id`, stopping its FFmpeg.
#[tauri::command]
pub fn originals_close(state: State<'_, OriginalsState>, id: String) {
    state
        .sessions
        .lock()
        .expect("original sessions")
        .remove(&id);
}

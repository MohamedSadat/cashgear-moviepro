//! Raw frames between the native side and the page, through WebView2 shared
//! buffers. On the reference machine Tauri's IPC carries about 11 MB/s and the
//! cgv-media protocol about 45 MB/s, while a 4K frame at 10-bit 4:2:2 is 33 MB.
//!
//! A channel is a few slots of memory that this process and the page both map.
//! The page is handed each slot once, as a `sharedbufferreceived` event whose
//! data is `{ "channel", "slot" }`; afterwards only slot numbers and lengths
//! cross the IPC. One side at a time owns a slot: the page, until it asks the
//! native side to read or fill it, and then the native side, until the command
//! that asked returns.

use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};

use tauri::{State, Webview};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment12, ICoreWebView2SharedBuffer, ICoreWebView2_17,
    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
};
use windows_core::{Interface, HSTRING};

/// The most memory one slot may take: a 8K frame at 12-bit 4:4:4 with alpha.
const MAX_SLOT_BYTES: u64 = 7680 * 4320 * 8;
const MAX_SLOTS: u32 = 8;

/// One slot's memory, mapped into this process.
#[derive(Clone, Copy)]
struct Slot {
    ptr: *mut u8,
    len: usize,
}

// The memory stays mapped until the channel's buffers are closed, which happens
// only once no command holds the channel (`Arc`).
unsafe impl Send for Slot {}
unsafe impl Sync for Slot {}

/// The WebView2 objects behind a channel. COM calls on them run on the UI thread.
struct Buffers(Vec<ICoreWebView2SharedBuffer>);

unsafe impl Send for Buffers {}

impl Buffers {
    /// Unmaps the memory here and in the page. Call on the UI thread.
    fn close(self) {
        for buffer in self.0 {
            // SAFETY: a COM call on the UI thread.
            let _ = unsafe { buffer.Close() };
        }
    }
}

pub struct FrameChannel {
    slots: Vec<Slot>,
    buffers: Mutex<Option<Buffers>>,
}

impl FrameChannel {
    /// Slot `index`'s first `len` bytes.
    fn bytes(&self, index: usize, len: usize) -> Result<&[u8], String> {
        let slot = self.slot(index, len)?;
        // SAFETY: the slot is mapped for the channel's lifetime, and the page does
        // not write to it while the native side owns it.
        Ok(unsafe { std::slice::from_raw_parts(slot.ptr, len) })
    }

    #[allow(
        clippy::mut_from_ref,
        reason = "shared memory: ownership is by protocol"
    )]
    fn bytes_mut(&self, index: usize, len: usize) -> Result<&mut [u8], String> {
        let slot = self.slot(index, len)?;
        // SAFETY: as for `bytes`; only the command that owns the slot writes it.
        Ok(unsafe { std::slice::from_raw_parts_mut(slot.ptr, len) })
    }

    fn slot(&self, index: usize, len: usize) -> Result<Slot, String> {
        let slot = *self
            .slots
            .get(index)
            .ok_or_else(|| format!("This channel has no slot {index}"))?;
        if len > slot.len {
            return Err(format!(
                "{len} bytes do not fit in a {}-byte slot",
                slot.len
            ));
        }
        Ok(slot)
    }
}

#[derive(Default)]
pub struct FrameState {
    channels: Mutex<HashMap<String, Arc<FrameChannel>>>,
}

impl FrameState {
    pub fn channel(&self, id: &str) -> Result<Arc<FrameChannel>, String> {
        self.channels
            .lock()
            .expect("frame channels")
            .get(id)
            .cloned()
            .ok_or_else(|| "That frame channel is closed".to_string())
    }
}

fn close_buffers(webview: &Webview, channel: Arc<FrameChannel>) {
    let Some(buffers) = channel.buffers.lock().expect("frame buffers").take() else {
        return;
    };
    // Unmapping happens on the UI thread, after every command using the channel
    // has let it go.
    let _ = webview.with_webview(move |_| {
        buffers.close();
        drop(channel);
    });
}

/// Makes a channel of `slots` slots of `size` bytes each and hands them to the page.
#[tauri::command]
pub async fn frames_open(
    webview: Webview,
    state: State<'_, FrameState>,
    size: u64,
    slots: u32,
) -> Result<String, String> {
    if size == 0 || size > MAX_SLOT_BYTES || slots == 0 || slots > MAX_SLOTS {
        return Err(format!("Cannot open {slots} frame slots of {size} bytes"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let tag = id.clone();
    let (send, receive) = mpsc::channel();
    webview
        .with_webview(move |platform| {
            let made = (|| -> windows_core::Result<Buffers> {
                // SAFETY: WebView2 calls on the UI thread, which `with_webview` runs on.
                unsafe {
                    let environment: ICoreWebView2Environment12 = platform.environment().cast()?;
                    let core: ICoreWebView2_17 = platform.controller().CoreWebView2()?.cast()?;
                    let mut buffers = Vec::new();
                    for slot in 0..slots {
                        let buffer = environment.CreateSharedBuffer(size)?;
                        let data = HSTRING::from(format!(r#"{{"channel":"{tag}","slot":{slot}}}"#));
                        core.PostSharedBufferToScript(
                            &buffer,
                            COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
                            &data,
                        )?;
                        buffers.push(buffer);
                    }
                    Ok(Buffers(buffers))
                }
            })();
            let _ = send.send(made.map_err(|error| error.message()));
        })
        .map_err(|error| error.to_string())?;
    let buffers = tauri::async_runtime::spawn_blocking(move || receive.recv())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "The webview closed".to_string())??;
    let mut slots = Vec::new();
    for buffer in &buffers.0 {
        let mut ptr = std::ptr::null_mut();
        // SAFETY: reading a buffer's address is safe from any thread.
        unsafe { buffer.Buffer(&mut ptr) }.map_err(|error| error.message())?;
        slots.push(Slot {
            ptr,
            len: size as usize,
        });
    }
    let channel = Arc::new(FrameChannel {
        slots,
        buffers: Mutex::new(Some(buffers)),
    });
    state
        .channels
        .lock()
        .expect("frame channels")
        .insert(id.clone(), channel);
    Ok(id)
}

/// Closes channel `id`: its slots' memory goes, in the page too.
#[tauri::command]
pub fn frames_close(webview: Webview, state: State<'_, FrameState>, id: String) {
    let channel = state.channels.lock().expect("frame channels").remove(&id);
    if let Some(channel) = channel {
        close_buffers(&webview, channel);
    }
}

/// Closes every channel: the page calls this when it starts, so a reload does
/// not leave the last page's slots mapped.
#[tauri::command]
pub fn frames_reset(webview: Webview, state: State<'_, FrameState>) {
    let channels: Vec<_> = state
        .channels
        .lock()
        .expect("frame channels")
        .drain()
        .map(|(_, channel)| channel)
        .collect();
    for channel in channels {
        close_buffers(&webview, channel);
    }
}

/// Test support: fills the first `len` bytes of a slot with `value`, as a frame
/// from FFmpeg would arrive.
#[tauri::command]
pub async fn frames_fill(
    state: State<'_, FrameState>,
    id: String,
    slot: usize,
    len: usize,
    value: u8,
) -> Result<(), String> {
    state.channel(&id)?.bytes_mut(slot, len)?.fill(value);
    Ok(())
}

/// Test support: the sum of the first `len` bytes of a slot, read as a frame on
/// its way to FFmpeg would be.
#[tauri::command]
pub async fn frames_sum(
    state: State<'_, FrameState>,
    id: String,
    slot: usize,
    len: usize,
) -> Result<u64, String> {
    let channel = state.channel(&id)?;
    Ok(channel
        .bytes(slot, len)?
        .iter()
        .map(|&byte| u64::from(byte))
        .sum())
}

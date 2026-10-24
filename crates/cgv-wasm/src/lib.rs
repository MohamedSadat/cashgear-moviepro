//! The only JavaScript-facing engine API. It runs in the engine Web Worker.
mod media_ref;

pub use media_ref::media_ref;

#[cfg(target_arch = "wasm32")]
mod bridge {
    use std::cell::RefCell;
    use wasm_bindgen::prelude::*;

    thread_local! {
        static ERROR_CALLBACK: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
    }

    fn report_error(message: String) {
        ERROR_CALLBACK.with(|callback| {
            if let Some(callback) = callback.borrow().as_ref() {
                let _ = callback.call1(&JsValue::NULL, &JsValue::from_str(&message));
            }
        });
    }

    #[wasm_bindgen]
    pub struct Engine {
        inner: cgv_engine::Engine,
    }

    #[wasm_bindgen]
    impl Engine {
        /// `preference` is `"auto"` or `"webgl2"`.
        pub async fn create(
            canvas: web_sys::OffscreenCanvas,
            preference: String,
            on_error: js_sys::Function,
        ) -> Result<Engine, JsValue> {
            ERROR_CALLBACK.with(|callback| *callback.borrow_mut() = Some(on_error));
            std::panic::set_hook(Box::new(|info| report_error(format!("Rust panic: {info}"))));
            let inner = cgv_engine::Engine::new(canvas, &preference, report_error)
                .await
                .map_err(|error| JsValue::from_str(&error))?;
            Ok(Self { inner })
        }
        pub fn backend(&self) -> String {
            self.inner.backend().into()
        }
        pub fn adapter_name(&self) -> String {
            self.inner.adapter_name().into()
        }
        pub fn width(&self) -> u32 {
            self.inner.width()
        }
        pub fn height(&self) -> u32 {
            self.inner.height()
        }
        pub fn frames(&self) -> u32 {
            self.inner.frames()
        }
        pub fn resize(&mut self, width: u32, height: u32) {
            self.inner.resize(width, height);
        }
        /// Draws the diagnostic test pattern for host time `now_ms`.
        pub fn pattern_frame(&mut self, now_ms: f64) -> Result<bool, JsValue> {
            self.inner.pattern_frame(now_ms).map_err(js_error)
        }
        /// The Phase 0 name of `pattern_frame`, until the worker drives playback.
        pub fn frame(&mut self, now_ms: f64) -> Result<bool, JsValue> {
            self.pattern_frame(now_ms)
        }

        /// Starts building the frame a `ProjectSession::plan_frame` plan describes.
        pub fn begin(&mut self, plan: &str) -> Result<(), JsValue> {
            self.inner.begin(parse(plan)?);
            Ok(())
        }
        /// Clears the monitor to black (no project open).
        pub fn clear(&mut self) -> Result<bool, JsValue> {
            self.inner.begin(cgv_engine::plan::FramePlan {
                frame: 0,
                time: cgv_time::Flicks::ZERO,
                width: 16,
                height: 9,
                layers: Vec::new(),
            });
            self.inner.compose(1.0, true).map_err(js_error)
        }
        /// A GPU-backed decoder output for layer `index`; the browser converts it.
        /// The frame can be closed as soon as this returns.
        pub fn set_layer_frame(
            &mut self,
            index: usize,
            frame: web_sys::VideoFrame,
            width: f64,
            height: f64,
            rotation: u32,
        ) -> Result<(), JsValue> {
            let source =
                cgv_render::FrameSource::External(wgpu::ExternalImageSource::VideoFrame(frame));
            self.inner
                .set_layer(index, source, width, height, rotation)
                .map_err(js_error)
        }
        /// CPU frame planes for layer `index`, converted with the frame's own matrix.
        /// `format` is `I420`, `NV12` or `RGBA`; `layout` holds offset and stride per plane.
        #[allow(clippy::too_many_arguments)]
        pub fn set_layer_planes(
            &mut self,
            index: usize,
            format: &str,
            coded_width: u32,
            coded_height: u32,
            data: &[u8],
            layout: &[u32],
            matrix: Option<String>,
            full_range: Option<bool>,
            transfer: Option<String>,
            width: f64,
            height: f64,
            rotation: u32,
        ) -> Result<(), JsValue> {
            let format = match format {
                "I420" => cgv_render::PlaneFormat::I420,
                "NV12" => cgv_render::PlaneFormat::Nv12,
                "RGBA" | "RGBX" => cgv_render::PlaneFormat::Rgba,
                other => return Err(js_error(format!("{other} frames are not supported"))),
            };
            let plane = |i: usize| {
                (
                    layout.get(2 * i).copied().unwrap_or(0),
                    layout.get(2 * i + 1).copied().unwrap_or(0),
                )
            };
            let color = cgv_render::color::FrameColor::from_names(
                matrix.as_deref(),
                full_range,
                transfer.as_deref(),
                coded_height,
            );
            let planes = cgv_render::Planes {
                format,
                width: coded_width,
                height: coded_height,
                data,
                layout: [plane(0), plane(1), plane(2)],
                color,
            };
            let source = cgv_render::FrameSource::Planes(planes);
            self.inner
                .set_layer(index, source, width, height, rotation)
                .map_err(js_error)
        }
        /// A still uploaded with `upload_still` for layer `index`.
        pub fn set_layer_still(
            &mut self,
            index: usize,
            key: &str,
            width: f64,
            height: f64,
        ) -> Result<(), JsValue> {
            let source = cgv_render::FrameSource::Still(key);
            self.inner
                .set_layer(index, source, width, height, 0)
                .map_err(js_error)
        }
        /// Composes the planned frame at `scale` of the project resolution and shows
        /// it when `present` is set. Returns whether the monitor shows it now.
        pub fn compose(&mut self, scale: f64, present: bool) -> Result<bool, JsValue> {
            self.inner.compose(scale, present).map_err(js_error)
        }
        pub fn needs_present(&self) -> bool {
            self.inner.needs_present()
        }
        pub fn present_again(&mut self) -> Result<bool, JsValue> {
            self.inner.present_again().map_err(js_error)
        }
        /// Resolves with `{ width, height, data }`: the latest composition as sRGB RGBA bytes.
        pub fn read_pixels(&mut self) -> Result<js_sys::Promise, JsValue> {
            let readback = self.inner.start_readback().map_err(js_error)?;
            Ok(wasm_bindgen_futures::future_to_promise(async move {
                let (width, height) = readback.size();
                let pixels = readback.wait().await.map_err(js_error)?;
                let result = js_sys::Object::new();
                js_sys::Reflect::set(&result, &"width".into(), &width.into())?;
                js_sys::Reflect::set(&result, &"height".into(), &height.into())?;
                let data = js_sys::Uint8Array::from(pixels.as_slice());
                js_sys::Reflect::set(&result, &"data".into(), &data)?;
                Ok(result.into())
            }))
        }
        /// Uploads a still image once. The bitmap can be closed afterwards.
        pub fn upload_still(
            &mut self,
            key: &str,
            bitmap: web_sys::ImageBitmap,
        ) -> Result<(), JsValue> {
            let image = wgpu::ExternalImageSource::ImageBitmap(bitmap);
            self.inner.upload_still(key, image).map_err(js_error)
        }
        pub fn has_still(&self, key: &str) -> bool {
            self.inner.has_still(key)
        }
        pub fn drop_still(&mut self, key: &str) -> bool {
            self.inner.drop_still(key)
        }
        /// Milliseconds the GPU took for the latest finished frame.
        pub fn gpu_ms(&self) -> f64 {
            self.inner.gpu_ms()
        }
        /// True while the GPU still works on a composed frame.
        pub fn gpu_busy(&self) -> bool {
            self.inner.gpu_busy()
        }
        pub fn composition_format(&self) -> String {
            self.inner.composition_format()
        }
        pub fn max_texture_size(&self) -> u32 {
            self.inner.max_texture_size()
        }
        pub fn dispose(&mut self) {
            self.inner.dispose();
            ERROR_CALLBACK.with(|callback| *callback.borrow_mut() = None);
        }
        pub fn diagnostic_device_loss(&self) {
            self.inner.simulate_device_loss();
            report_error("GPU device lost (diagnostic). Retry to restart the engine.".into());
        }
        pub fn diagnostic_panic(&self) {
            panic!("diagnostic engine panic");
        }
    }

    fn js_error(error: impl std::fmt::Display) -> JsValue {
        JsValue::from_str(&error.to_string())
    }

    /// The media library. Values cross the boundary as JSON matching
    /// `cgv_media::MediaProbe`, `MediaStatus` and `MediaItem`.
    #[wasm_bindgen]
    pub struct MediaLibrary {
        inner: cgv_media::MediaLibrary,
    }

    #[wasm_bindgen]
    impl MediaLibrary {
        /// `platform` is `"web"` or `"desktop"`.
        #[wasm_bindgen(constructor)]
        pub fn new(platform: &str) -> Result<MediaLibrary, JsValue> {
            let platform = match platform {
                "web" => cgv_media::Platform::Web,
                "desktop" => cgv_media::Platform::Desktop,
                other => return Err(js_error(format!("Unknown platform {other}"))),
            };
            Ok(Self {
                inner: cgv_media::MediaLibrary::new(platform),
            })
        }
        /// Adds a probed file and returns the normalized item.
        pub fn add(&mut self, probe: &str) -> Result<String, JsValue> {
            let probe: cgv_media::MediaProbe = serde_json::from_str(probe).map_err(js_error)?;
            let item = self.inner.add(probe).map_err(js_error)?;
            serde_json::to_string(item).map_err(js_error)
        }
        pub fn set_status(&mut self, id: &str, status: &str) -> Result<String, JsValue> {
            let status: cgv_media::MediaStatus = serde_json::from_str(status).map_err(js_error)?;
            let item = self.inner.set_status(id, status).map_err(js_error)?;
            serde_json::to_string(item).map_err(js_error)
        }
        pub fn remove(&mut self, id: &str) -> bool {
            self.inner.remove(id)
        }
        pub fn snapshot(&self) -> Result<String, JsValue> {
            serde_json::to_string(self.inner.items()).map_err(js_error)
        }
    }

    fn parse<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, JsValue> {
        serde_json::from_str(text).map_err(js_error)
    }

    fn checked_id(id: &str) -> Result<&str, JsValue> {
        if cgv_model::valid_project_id(id) {
            Ok(id)
        } else {
            Err(js_error(format!("Invalid project id {id:?}")))
        }
    }

    /// The open project and its undo history. Commands, snapshots and media
    /// references cross the boundary as JSON matching `cgv_model`; times are flicks.
    #[wasm_bindgen]
    pub struct ProjectSession {
        inner: cgv_model::Session,
    }

    #[wasm_bindgen]
    impl ProjectSession {
        /// A new project with the default settings.
        #[wasm_bindgen(constructor)]
        pub fn new(id: &str, name: &str) -> Result<ProjectSession, JsValue> {
            let project = cgv_model::Project::new(checked_id(id)?, name.trim());
            cgv_model::validate(&project).map_err(js_error)?;
            Ok(Self {
                inner: cgv_model::Session::new(project),
            })
        }
        /// Opens `.cgvproj` text. `recovered` marks an autosave (unsaved changes);
        /// `id` gives the project a new id (an imported copy).
        pub fn open(
            text: &str,
            recovered: bool,
            id: Option<String>,
        ) -> Result<ProjectSession, JsValue> {
            let mut project = cgv_model::file::from_json(text).map_err(js_error)?;
            if let Some(id) = id {
                project.id = checked_id(&id)?.to_string();
            }
            let inner = if recovered {
                cgv_model::Session::recovered(project)
            } else {
                cgv_model::Session::new(project)
            };
            Ok(Self { inner })
        }
        /// The `.cgvproj` text of the current state.
        pub fn save(&self) -> String {
            cgv_model::file::to_json(self.inner.project())
        }
        pub fn generation(&self) -> f64 {
            self.inner.generation() as f64
        }
        /// Records that the state with `generation` was written to the project file.
        pub fn mark_saved(&mut self, generation: f64) {
            self.inner.mark_saved_at(generation as u64);
        }
        pub fn mark_autosaved(&mut self, generation: f64) {
            self.inner.mark_autosaved_at(generation as u64);
        }
        pub fn snapshot(&self) -> Result<String, JsValue> {
            serde_json::to_string(&self.inner.snapshot()).map_err(js_error)
        }
        /// Runs a command and returns its outcome.
        pub fn execute(&mut self, command: &str) -> Result<String, JsValue> {
            let command: cgv_model::Command = parse(command)?;
            let outcome = self.inner.execute(&command).map_err(js_error)?;
            serde_json::to_string(&outcome).map_err(js_error)
        }
        pub fn undo(&mut self) -> bool {
            self.inner.undo()
        }
        pub fn redo(&mut self) -> bool {
            self.inner.redo()
        }
        pub fn begin_group(&mut self, label: &str) {
            self.inner.begin_group(label);
        }
        pub fn end_group(&mut self) {
            self.inner.end_group();
        }
        pub fn cancel_group(&mut self) {
            self.inner.cancel_group();
        }
        /// Records a relinked or changed media file. Not an undo step.
        pub fn update_media(&mut self, media: &str) -> Result<(), JsValue> {
            self.inner.update_media(parse(media)?).map_err(js_error)
        }
        /// The clips at `time` (flicks), bottom track first.
        pub fn clips_at(&self, time: f64) -> Result<String, JsValue> {
            let time = cgv_time::Flicks(time as i64);
            let clips = cgv_model::query::clips_at(self.inner.project(), time);
            serde_json::to_string(&clips).map_err(js_error)
        }
        /// Snap targets. `exclude` is a JSON array of the clip ids being dragged.
        pub fn snap_points(&self, playhead: Option<f64>, exclude: &str) -> Result<String, JsValue> {
            let exclude: Vec<cgv_model::ClipId> = parse(exclude)?;
            let points = cgv_model::query::snap_points(
                self.inner.project(),
                playhead.map(|time| cgv_time::Flicks(time as i64)),
                &exclude,
            );
            serde_json::to_string(&points).map_err(js_error)
        }
        /// The resolution presets offered for new projects and in settings.
        pub fn presets() -> Result<String, JsValue> {
            serde_json::to_string(&cgv_model::PRESETS).map_err(js_error)
        }
        /// The plan of the frame showing at `time` (flicks), as JSON
        /// (`cgv_engine::plan::FramePlan`): the pure half of `renderFrame(t)`.
        pub fn plan_frame(&self, time: f64) -> Result<String, JsValue> {
            let time = cgv_time::Flicks(time as i64);
            let plan = cgv_engine::plan::plan_frame(self.inner.project(), time);
            serde_json::to_string(&plan).map_err(js_error)
        }
        pub fn sample_rate(&self) -> u32 {
            self.inner.project().settings.sample_rate
        }
        pub fn channels(&self) -> u16 {
            self.inner.project().settings.channels
        }
        /// One project frame, in flicks.
        pub fn frame_duration(&self) -> f64 {
            self.inner.project().settings.frame_duration().0 as f64
        }
        /// The end of the last clip, in flicks.
        pub fn duration(&self) -> f64 {
            self.inner.project().duration().0 as f64
        }
        /// The project frame showing at `time` (flicks).
        pub fn frame_at(&self, time: f64) -> f64 {
            cgv_engine::plan::frame_at(self.inner.project(), cgv_time::Flicks(time as i64)) as f64
        }
        /// The start time of project frame `frame`.
        pub fn frame_time(&self, frame: f64) -> f64 {
            let rate = self.inner.project().settings.frame_rate;
            rate.time_of_frame(frame as i64).0 as f64
        }
        /// SMPTE timecode at `time`, drop-frame at 29.97 and 59.94.
        pub fn timecode(&self, time: f64) -> String {
            let rate = self.inner.project().settings.frame_rate;
            let frame = rate.frame_at(cgv_time::Flicks(time as i64));
            cgv_time::timecode(frame, rate, true)
        }
        /// Visible clips starting within `horizon` after `from`, planned at their
        /// first frame (JSON `LayerPlan[]`), so their decoders can start early.
        pub fn upcoming_layers(&self, from: f64, horizon: f64) -> Result<String, JsValue> {
            let layers = cgv_engine::plan::upcoming_layers(
                self.inner.project(),
                cgv_time::Flicks(from as i64),
                cgv_time::Flicks(horizon as i64),
            );
            serde_json::to_string(&layers).map_err(js_error)
        }
    }

    /// The audio mixer (`cgv_audio::Mixer`). Positions are samples at the project rate.
    #[wasm_bindgen]
    pub struct Mixer {
        inner: cgv_audio::Mixer,
    }

    fn audio_clips(
        session: &ProjectSession,
        start: f64,
        frames: usize,
    ) -> Vec<cgv_audio::AudioClip> {
        let start = start as i64;
        cgv_engine::plan::audio_clips(session.inner.project(), start, start + frames as i64)
    }

    #[wasm_bindgen]
    impl Mixer {
        #[wasm_bindgen(constructor)]
        pub fn new(rate: u32, channels: usize) -> Result<Mixer, JsValue> {
            if rate == 0 || !(1..=2).contains(&channels) {
                return Err(js_error(
                    "The mixer needs a sample rate and one or two channels",
                ));
            }
            Ok(Mixer {
                inner: cgv_audio::Mixer::new(rate, channels, cgv_audio::DEFAULT_BUDGET_BYTES),
            })
        }
        pub fn rate(&self) -> u32 {
            self.inner.rate()
        }
        pub fn channels(&self) -> usize {
            self.inner.channels()
        }
        /// JSON `[media, block][]`: blocks the stretch needs that are not stored, in play order.
        pub fn missing(
            &self,
            session: &ProjectSession,
            start: f64,
            frames: usize,
        ) -> Result<String, JsValue> {
            let clips = audio_clips(session, start, frames);
            let missing = self.inner.missing(&clips, start as i64, frames);
            serde_json::to_string(&missing).map_err(js_error)
        }
        pub fn ready(&self, session: &ProjectSession, start: f64, frames: usize) -> bool {
            let clips = audio_clips(session, start, frames);
            self.inner.ready(&clips, start as i64, frames)
        }
        /// The source span `[start, end]` in seconds to decode for `block`.
        pub fn block_span(&self, block: f64) -> Vec<f64> {
            let (start, end) = self.inner.block_span(block as i64);
            vec![start, end]
        }
        /// Stores a block from planar decoded audio starting at `start_seconds`.
        pub fn insert_block(
            &mut self,
            media: &str,
            block: f64,
            sample_rate: u32,
            channels: usize,
            start_seconds: f64,
            data: &[f32],
        ) -> Result<(), JsValue> {
            let source = cgv_audio::SourceAudio {
                sample_rate,
                channels,
                data,
                start_seconds,
            };
            self.inner
                .insert_block(media, block as i64, source)
                .map_err(js_error)
        }
        /// Interleaved samples for `frames` from timeline sample `start`.
        pub fn mix(&mut self, session: &ProjectSession, start: f64, frames: usize) -> Vec<f32> {
            let clips = audio_clips(session, start, frames);
            self.inner.mix(&clips, start as i64, frames)
        }
        pub fn forget(&mut self, media: &str) {
            self.inner.forget(media);
        }
        pub fn clear(&mut self) {
            self.inner.clear();
        }
        pub fn cached_bytes(&self) -> usize {
            self.inner.cached_bytes()
        }
    }

    /// Playback rules: the transport, Auto quality and the measurements.
    #[wasm_bindgen]
    pub struct Playback {
        transport: cgv_engine::transport::Transport,
        governor: cgv_engine::quality::Governor,
        stats: cgv_engine::stats::PlaybackStats,
    }

    impl Default for Playback {
        fn default() -> Self {
            Playback {
                transport: cgv_engine::transport::Transport::paused(cgv_time::Flicks::ZERO),
                governor: Default::default(),
                stats: Default::default(),
            }
        }
    }

    #[wasm_bindgen]
    impl Playback {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Playback {
            Playback::default()
        }
        /// The rate after a J, K or L press at `rate`.
        pub fn shuttle(rate: f64, key: &str) -> Result<f64, JsValue> {
            use cgv_engine::transport::{shuttle, Shuttle};
            let key = match key {
                "j" | "J" => Shuttle::Reverse,
                "k" | "K" => Shuttle::Stop,
                "l" | "L" => Shuttle::Forward,
                other => return Err(js_error(format!("{other} is not a shuttle key"))),
            };
            Ok(shuttle(rate, key))
        }
        /// Starts moving from `from` (flicks) at `rate`; the clock restarts at zero.
        pub fn play(&mut self, from: f64, rate: f64) {
            let from = cgv_time::Flicks(from as i64);
            self.transport = cgv_engine::transport::Transport::playing(from, rate);
            self.governor.restart();
        }
        pub fn pause(&mut self, at: f64) {
            let at = cgv_time::Flicks(at as i64);
            self.transport = cgv_engine::transport::Transport::paused(at);
        }
        pub fn rate(&self) -> f64 {
            self.transport.rate()
        }
        pub fn playing(&self) -> bool {
            self.transport.is_playing()
        }
        pub fn anchor(&self) -> f64 {
            self.transport.anchor().0 as f64
        }
        /// The position at clock `seconds`, within `0..=last`.
        pub fn position(&self, seconds: f64, last: f64) -> f64 {
            let last = cgv_time::Flicks(last as i64);
            self.transport.position(seconds, last).0 as f64
        }
        pub fn finished(&self, seconds: f64, end: f64) -> bool {
            self.transport
                .finished(seconds, cgv_time::Flicks(end as i64))
        }
        /// `auto`, `full`, `half` or `quarter`.
        pub fn set_quality(&mut self, mode: &str) -> Result<(), JsValue> {
            let mode = serde_json::Value::String(mode.into());
            self.governor
                .set_mode(serde_json::from_value(mode).map_err(js_error)?);
            Ok(())
        }
        pub fn quality_mode(&self) -> String {
            serde_json::to_value(self.governor.mode())
                .ok()
                .and_then(|value| value.as_str().map(String::from))
                .unwrap_or_default()
        }
        /// 0 full, 1 half, 2 quarter.
        pub fn quality_level(&self) -> usize {
            self.governor.level(self.transport.is_playing())
        }
        pub fn quality_scale(&self) -> f64 {
            self.governor.scale(self.transport.is_playing())
        }
        /// Records a frame shown while playing, after `missed` skipped frames, of
        /// which `drawing_missed` were decoded in time. `gpu_ms` is the latency from
        /// submitting a frame to the GPU finishing it. Returns true when Auto
        /// changed the level.
        pub fn record_frame(
            &mut self,
            now_ms: f64,
            render_ms: f64,
            gpu_ms: f64,
            missed: u32,
            drawing_missed: u32,
            late: bool,
        ) -> bool {
            self.stats.presented(render_ms, gpu_ms, late);
            self.stats.dropped(missed as u64);
            self.governor.record(now_ms, missed, drawing_missed)
        }
        /// Records the A/V offset at one display refresh (frame on screen minus sound heard).
        pub fn record_offset(&mut self, offset_ms: f64) {
            self.stats.offset(offset_ms);
        }
        /// JSON `cgv_engine::stats::StatsSummary`.
        pub fn stats(&self) -> Result<String, JsValue> {
            serde_json::to_string(&self.stats.summary()).map_err(js_error)
        }
        pub fn reset_stats(&mut self) {
            self.stats = Default::default();
        }
    }

    /// The project's reference to a library item: JSON `MediaItem` in, `MediaRef` out.
    #[wasm_bindgen]
    pub fn media_ref(item: &str, modified: Option<f64>) -> Result<String, JsValue> {
        let item: cgv_media::MediaItem = parse(item)?;
        let media = crate::media_ref(&item, modified.map(|ms| ms as i64));
        serde_json::to_string(&media).map_err(js_error)
    }
}

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
        pub fn frame(&mut self, now_ms: f64) -> Result<bool, JsValue> {
            self.inner
                .frame(now_ms)
                .map_err(|error| JsValue::from_str(&error))
        }
        pub fn dispose(&self) {
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
    }

    /// The project's reference to a library item: JSON `MediaItem` in, `MediaRef` out.
    #[wasm_bindgen]
    pub fn media_ref(item: &str, modified: Option<f64>) -> Result<String, JsValue> {
        let item: cgv_media::MediaItem = parse(item)?;
        let media = crate::media_ref(&item, modified.map(|ms| ms as i64));
        serde_json::to_string(&media).map_err(js_error)
    }
}

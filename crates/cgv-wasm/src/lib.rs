//! The only JavaScript-facing engine API. It runs in the engine Web Worker.
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
}

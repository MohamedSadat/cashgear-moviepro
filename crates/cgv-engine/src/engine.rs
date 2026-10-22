use cgv_render::Renderer;
use web_sys::OffscreenCanvas;

use crate::PatternClock;

pub struct Engine {
    renderer: Renderer,
    clock: PatternClock,
    frames: u32,
}

impl Engine {
    pub async fn new(
        canvas: OffscreenCanvas,
        preference: &str,
        on_error: fn(String),
    ) -> Result<Self, String> {
        Ok(Self {
            renderer: Renderer::new(canvas, preference, on_error).await?,
            clock: PatternClock::default(),
            frames: 0,
        })
    }

    /// Renders the frame for host time `now_ms`. Returns whether it was presented.
    pub fn frame(&mut self, now_ms: f64) -> Result<bool, String> {
        let seconds = self.clock.seconds(now_ms);
        let presented = self.renderer.frame(seconds)?;
        if presented {
            self.frames += 1;
        }
        Ok(presented)
    }

    pub fn frames(&self) -> u32 {
        self.frames
    }
    pub fn backend(&self) -> &str {
        self.renderer.backend()
    }
    pub fn adapter_name(&self) -> &str {
        self.renderer.adapter_name()
    }
    pub fn width(&self) -> u32 {
        self.renderer.width()
    }
    pub fn height(&self) -> u32 {
        self.renderer.height()
    }
    pub fn resize(&mut self, width: u32, height: u32) {
        self.renderer.resize(width, height);
    }
    pub fn dispose(&self) {
        self.renderer.dispose();
    }
    pub fn simulate_device_loss(&self) {
        self.renderer.simulate_device_loss();
    }
}

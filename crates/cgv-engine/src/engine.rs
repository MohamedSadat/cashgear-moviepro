use cgv_model::Project;
use cgv_render::geometry::{output_size, CropRect, LayerTransform, Picture};
use cgv_render::{FrameSource, LayerDraw, Readback, Renderer};
use cgv_time::Flicks;
use web_sys::OffscreenCanvas;

use crate::plan::{plan_frame, FramePlan};
use crate::PatternClock;

/// The engine's GPU side: the program monitor's renderer and the frame being
/// built. A frame is planned from the project, given a source per layer, then
/// composed and shown. Export uses the same steps without showing.
pub struct Engine {
    renderer: Renderer,
    clock: PatternClock,
    frames: u32,
    plan: Option<FramePlan>,
    pictures: Vec<Option<Picture>>,
}

fn transform(value: &cgv_model::Transform) -> LayerTransform {
    LayerTransform {
        x: value.x,
        y: value.y,
        scale_x: value.scale_x,
        scale_y: value.scale_y,
        rotation: value.rotation,
        anchor_x: value.anchor_x,
        anchor_y: value.anchor_y,
    }
}

fn crop(value: &cgv_model::Crop) -> CropRect {
    CropRect {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
    }
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
            plan: None,
            pictures: Vec::new(),
        })
    }

    /// Draws the diagnostic test pattern for host time `now_ms`.
    pub fn pattern_frame(&mut self, now_ms: f64) -> Result<bool, String> {
        let seconds = self.clock.seconds(now_ms);
        let presented = self.renderer.pattern_frame(seconds)?;
        self.frames += presented as u32;
        Ok(presented)
    }

    /// Plans the frame showing at `time` and starts building it.
    pub fn plan(&mut self, project: &Project, time: Flicks) -> &FramePlan {
        let plan = plan_frame(project, time);
        self.renderer.begin_frame(plan.layers.len());
        self.pictures = vec![None; plan.layers.len()];
        self.plan.insert(plan)
    }

    /// Gives layer `index` of the planned frame its picture. `width` and `height`
    /// are the display size before `rotation` (clockwise degrees).
    pub fn set_layer(
        &mut self,
        index: usize,
        source: FrameSource,
        width: f64,
        height: f64,
        rotation: u32,
    ) -> Result<(), String> {
        if index >= self.pictures.len() {
            return Err(format!("Layer {index} is not in the planned frame"));
        }
        self.renderer.set_source(index, source)?;
        self.pictures[index] = Some(Picture {
            width,
            height,
            rotation: rotation % 360,
        });
        Ok(())
    }

    /// Composes the planned frame at `scale` of the project resolution (layers
    /// without a picture are left out) and shows it when `present` is set.
    /// Returns whether the monitor shows it now.
    pub fn compose(&mut self, scale: f64, present: bool) -> Result<bool, String> {
        let plan = self.plan.take().ok_or("No frame is planned")?;
        let draws: Vec<(usize, LayerDraw)> = plan
            .layers
            .iter()
            .enumerate()
            .filter_map(|(index, layer)| {
                Some((
                    index,
                    LayerDraw {
                        picture: self.pictures[index]?,
                        transform: transform(&layer.transform),
                        crop: crop(&layer.crop),
                        opacity: layer.opacity,
                    },
                ))
            })
            .collect();
        let output = output_size(plan.width, plan.height, scale);
        self.renderer
            .compose((plan.width, plan.height), output, &draws)?;
        let shown = self.renderer.finish(present)?;
        self.frames += shown as u32;
        Ok(shown)
    }

    pub fn needs_present(&self) -> bool {
        self.renderer.needs_present()
    }

    /// Shows the latest composition again (after a resize).
    pub fn present_again(&mut self) -> Result<bool, String> {
        let shown = self.renderer.present_again()?;
        self.frames += shown as u32;
        Ok(shown)
    }

    pub fn start_readback(&mut self) -> Result<Readback, String> {
        self.renderer.start_readback()
    }

    pub fn upload_still(
        &mut self,
        key: &str,
        image: wgpu::ExternalImageSource,
    ) -> Result<(), String> {
        self.renderer.upload_still(key, image)
    }
    pub fn has_still(&self, key: &str) -> bool {
        self.renderer.has_still(key)
    }
    pub fn drop_still(&mut self, key: &str) -> bool {
        self.renderer.drop_still(key)
    }

    pub fn gpu_ms(&self) -> f64 {
        self.renderer.gpu_ms()
    }
    pub fn composition_format(&self) -> String {
        self.renderer.composition_format()
    }
    pub fn max_texture_size(&self) -> u32 {
        self.renderer.max_texture_size()
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
    pub fn dispose(&mut self) {
        self.renderer.dispose();
    }
    pub fn simulate_device_loss(&self) {
        self.renderer.simulate_device_loss();
    }
}

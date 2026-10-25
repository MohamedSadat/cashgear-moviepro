use cgv_effects::Registry;
use cgv_model::{parse_lut_ref, LutShape, ParamValue};
use cgv_render::geometry::{output_size, CropRect, LayerTransform, Picture};
use cgv_render::{EffectRun, FrameSource, LayerDraw, LayerStep, LutUse, Readback, Renderer, Step};
use web_sys::OffscreenCanvas;

use crate::plan::{self, EffectPlan, FramePlan, LutPlan};
use crate::PatternClock;

/// The engine's GPU side: the program monitor's renderer, the effects it knows
/// and the frame being built. A frame is planned from the project, given a source
/// per layer, then composed and shown. Export uses the same steps without showing.
pub struct Engine {
    renderer: Renderer,
    registry: Registry,
    clock: PatternClock,
    frames: u32,
    plan: Option<FramePlan>,
    pictures: Vec<Option<Picture>>,
}

/// An effect of the plan as the renderer runs it; None for one this build lacks.
fn effect_run<'a>(
    registry: &'a Registry,
    luts: &'a [LutPlan],
    effect: &'a EffectPlan,
    time: f64,
    seed: f64,
) -> Option<EffectRun<'a>> {
    let entry = registry.get(&effect.pack, &effect.kind)?;
    let definition = &entry.definition;
    if definition.kind == cgv_effects::Kind::Audio {
        return None;
    }
    let lut = definition
        .lut_param()
        .and_then(|param| match effect.params.get(param) {
            Some(ParamValue::Text(text)) => parse_lut_ref(text),
            _ => None,
        })
        .and_then(|id| luts.iter().find(|lut| lut.id == id))
        .map(|lut| LutUse {
            key: &lut.key,
            min: lut.domain_min,
            max: lut.domain_max,
        });
    Some(EffectRun {
        entry,
        params: &effect.params,
        time,
        seed,
        lut,
        image: definition
            .image(&effect.params)
            .map(|file| entry.image_key(file)),
    })
}

fn faces_json(faces: &[cgv_text::FaceInfo]) -> String {
    let faces: Vec<serde_json::Value> = faces
        .iter()
        .map(|face| {
            serde_json::json!({
                "family": face.family,
                "weights": [face.weights.0, face.weights.1],
                "italic": face.italic,
            })
        })
        .collect();
    serde_json::Value::Array(faces).to_string()
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
            registry: Registry::builtin()?,
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

    /// Starts building the frame `plan` describes (from `plan::plan_frame`). Sources
    /// may take a while to gather; start the frame once they are all at hand.
    pub fn begin(&mut self, plan: FramePlan) -> Result<(), String> {
        self.renderer.begin_frame(plan.layers.len());
        self.pictures = vec![None; plan.layers.len()];
        // Titles need no source: their canvas is the frame, drawn at compose time.
        for (index, layer) in plan.layers.iter().enumerate() {
            if let Some(title) = &layer.title {
                self.renderer.set_title(index, title.clone())?;
                self.pictures[index] = Some(Picture {
                    width: plan.width as f64,
                    height: plan.height as f64,
                    rotation: 0,
                });
            }
        }
        self.plan = Some(plan);
        Ok(())
    }

    /// Adds a font file (once per `source`); returns its faces as JSON.
    pub fn load_font(&mut self, source: &str, data: Vec<u8>) -> Result<String, String> {
        let faces = self.renderer.load_font(source, data)?;
        Ok(faces_json(&faces))
    }
    pub fn has_font(&self, source: &str) -> bool {
        self.renderer.has_font(source)
    }
    /// The loaded faces as JSON `[{ family, weights: [lo, hi], italic }]`.
    pub fn font_families(&self) -> String {
        faces_json(&self.renderer.font_families())
    }
    /// Families the plan's titles need that are not loaded, fallbacks included.
    pub fn fonts_needed(&mut self, plan: &FramePlan) -> Vec<String> {
        let mut needed: Vec<String> = Vec::new();
        for title in plan.layers.iter().filter_map(|layer| layer.title.as_ref()) {
            for family in self.renderer.missing_fonts(title) {
                if !needed.contains(&family) {
                    needed.push(family);
                }
            }
        }
        needed
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
        let (registry, pictures) = (&self.registry, &self.pictures);
        let layer = |index: usize| -> Option<LayerStep> {
            let layer = plan.layers.get(index)?;
            Some(LayerStep {
                index,
                key: layer.clip.0,
                draw: LayerDraw {
                    picture: (*pictures.get(index)?)?,
                    transform: transform(&layer.transform),
                    crop: crop(&layer.crop),
                    opacity: layer.opacity,
                },
                effects: layer
                    .effects
                    .iter()
                    .filter_map(|e| {
                        effect_run(registry, &plan.luts, e, layer.clip_seconds, layer.seed)
                    })
                    .collect(),
                moving: layer.moving,
            })
        };
        let steps: Vec<Step> = plan
            .steps
            .iter()
            .filter_map(|step| match step {
                plan::Step::Layer { layer: index } => layer(*index).map(Step::Layer),
                plan::Step::Transition {
                    from,
                    to,
                    transition,
                    progress,
                } => {
                    let (from, to) = (from.and_then(layer), to.and_then(layer));
                    match effect_run(registry, &plan.luts, transition, 0.0, 0.0) {
                        Some(transition) => Some(Step::Transition {
                            from,
                            to,
                            transition,
                            progress: *progress,
                        }),
                        // A transition this build lacks cuts at its middle.
                        None if *progress < 0.5 => from.map(Step::Layer),
                        None => to.map(Step::Layer),
                    }
                }
                plan::Step::Adjustment {
                    effects,
                    opacity,
                    clip_seconds,
                    seed,
                    ..
                } => Some(Step::Adjustment {
                    effects: effects
                        .iter()
                        .filter_map(|e| effect_run(registry, &plan.luts, e, *clip_seconds, *seed))
                        .collect(),
                    opacity: *opacity,
                }),
            })
            .collect();
        let output = output_size(plan.width, plan.height, scale);
        self.renderer
            .compose((plan.width, plan.height), output, &steps)?;
        let shown = self.renderer.finish(present)?;
        self.frames += shown as u32;
        Ok(shown)
    }

    /// The images the definitions read, as JSON `[{ key, path }]`.
    pub fn pack_images(&self) -> Result<String, String> {
        serde_json::to_string(&self.registry.images()).map_err(|error| error.to_string())
    }

    /// Uploads pack image `key` from RGBA8 `pixels`, `size` texels.
    pub fn upload_image(
        &mut self,
        key: &str,
        size: (u32, u32),
        pixels: &[u8],
    ) -> Result<(), String> {
        self.renderer.upload_image(key, size, pixels)
    }
    pub fn has_image(&self, key: &str) -> bool {
        self.renderer.has_image(key)
    }

    /// Uploads a project LUT's 16-bit RGB outputs under `key` (its fingerprint).
    pub fn upload_lut(
        &mut self,
        key: &str,
        shape: LutShape,
        size: u32,
        values: &[u16],
    ) -> Result<(), String> {
        let (points, texels) = cgv_effects::lut_texels(shape, size, values)
            .ok_or("The LUT's data does not match its size")?;
        self.renderer.upload_lut(key, points, &texels)
    }
    pub fn has_lut(&self, key: &str) -> bool {
        self.renderer.has_lut(key)
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

    /// Export: the latest composition as an NV12 frame of `width` × `height`.
    pub fn start_nv12_readback(&mut self, width: u32, height: u32) -> Result<Readback, String> {
        self.renderer.start_nv12_readback((width, height))
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
    pub fn gpu_busy(&self) -> bool {
        self.renderer.gpu_busy()
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

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use wasm_bindgen::JsCast;
use web_sys::OffscreenCanvas;
use wgpu::*;

use crate::compositor::{Compositor, FrameSource, LayerDraw, Readback};
use crate::geometry::letterbox;
use crate::pattern::PatternUniforms;

/// The diagnostic test pattern of Phase 0.
struct Pattern {
    pipeline: RenderPipeline,
    uniforms: Buffer,
    bind_group: BindGroup,
}

pub struct Renderer {
    surface: Surface<'static>,
    device: Device,
    queue: Queue,
    config: SurfaceConfiguration,
    pattern: Pattern,
    compositor: Compositor,
    backend: &'static str,
    adapter_name: String,
    paused: bool,
    resized: bool,
    /// The monitor does not show the latest composition yet.
    stale: bool,
    /// Milliseconds from the last submission to the GPU finishing it (f64 bits).
    gpu_ms: Arc<AtomicU64>,
    /// Composed frames submitted but not finished by the GPU yet.
    in_flight: Arc<AtomicU32>,
}

async fn device_for(adapter: &Adapter) -> Result<(Device, Queue), String> {
    adapter
        .request_device(&DeviceDescriptor {
            label: Some("CashGear Video engine"),
            required_limits: Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits()),
            ..Default::default()
        })
        .await
        .map_err(|error| format!("GPU device unavailable: {error}"))
}

async fn webgpu_device() -> Result<(Instance, Adapter, Device, Queue), String> {
    let instance = Instance::new(InstanceDescriptor {
        backends: Backends::BROWSER_WEBGPU,
        ..InstanceDescriptor::new_without_display_handle()
    });
    // Request the device before acquiring a canvas context: a failed request must
    // leave the canvas free to acquire a WebGL2 context instead.
    let adapter = instance
        .request_adapter(&RequestAdapterOptions::default())
        .await
        .map_err(|error| format!("WebGPU adapter unavailable: {error}"))?;
    let (device, queue) = device_for(&adapter).await?;
    Ok((instance, adapter, device, queue))
}

/// The worker's clock in milliseconds.
pub fn now_ms() -> f64 {
    js_sys::global()
        .unchecked_into::<web_sys::WorkerGlobalScope>()
        .performance()
        .map_or(0.0, |performance| performance.now())
}

fn pattern(device: &Device, format: TextureFormat) -> Pattern {
    let shader = device.create_shader_module(ShaderModuleDescriptor {
        label: Some("Test pattern shader"),
        source: ShaderSource::Wgsl(include_str!("pattern.wgsl").into()),
    });
    let pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
        label: Some("Test pattern pipeline"),
        layout: None,
        vertex: VertexState {
            module: &shader,
            entry_point: Some("vertex"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(FragmentState {
            module: &shader,
            entry_point: Some("fragment"),
            compilation_options: Default::default(),
            targets: &[Some(ColorTargetState {
                format,
                blend: None,
                write_mask: ColorWrites::ALL,
            })],
        }),
        primitive: PrimitiveState::default(),
        depth_stencil: None,
        multisample: MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    });
    let uniforms = device.create_buffer(&BufferDescriptor {
        label: Some("Test pattern uniforms"),
        size: 16,
        usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind_group = device.create_bind_group(&BindGroupDescriptor {
        label: Some("Test pattern binding"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[BindGroupEntry {
            binding: 0,
            resource: uniforms.as_entire_binding(),
        }],
    });
    Pattern {
        pipeline,
        uniforms,
        bind_group,
    }
}

impl Renderer {
    /// `preference` is `"auto"` (WebGPU, falling back to WebGL2) or `"webgl2"`.
    pub async fn new(
        canvas: OffscreenCanvas,
        preference: &str,
        on_error: fn(String),
    ) -> Result<Self, String> {
        let candidate = if preference != "webgl2" && util::is_browser_webgpu_supported().await {
            webgpu_device().await.ok()
        } else {
            None
        };
        let (surface, adapter, device, queue) = match candidate {
            Some((instance, adapter, device, queue)) => {
                let surface = instance
                    .create_surface(SurfaceTarget::OffscreenCanvas(canvas.clone()))
                    .map_err(|error| format!("WebGPU surface unavailable: {error}"))?;
                (surface, adapter, device, queue)
            }
            None => {
                let instance = Instance::new(InstanceDescriptor {
                    backends: Backends::GL,
                    ..InstanceDescriptor::new_without_display_handle()
                });
                let surface = instance
                    .create_surface(SurfaceTarget::OffscreenCanvas(canvas.clone()))
                    .map_err(|error| format!("WebGL2 surface unavailable: {error}"))?;
                let adapter = instance
                    .request_adapter(&RequestAdapterOptions {
                        compatible_surface: Some(&surface),
                        ..Default::default()
                    })
                    .await
                    .map_err(|error| format!("No usable WebGPU or WebGL2 adapter: {error}"))?;
                let (device, queue) = device_for(&adapter).await?;
                (surface, adapter, device, queue)
            }
        };
        let info = adapter.get_info();
        let backend = match info.backend {
            Backend::BrowserWebGpu => "WebGPU",
            Backend::Gl => "WebGL2",
            _ => return Err("Unexpected browser GPU backend".into()),
        };
        device.set_device_lost_callback(move |reason, message| {
            if reason != DeviceLostReason::Destroyed {
                on_error(format!(
                    "GPU device lost: {message}. Retry to restart the engine."
                ));
            }
        });
        device.on_uncaptured_error(Arc::new(move |error| {
            on_error(format!("GPU error: {error}"));
        }));
        let mut config = surface
            .get_default_config(&adapter, 1, 1)
            .ok_or("Adapter cannot present to the canvas")?;
        let unorm = config.format.remove_srgb_suffix();
        if surface.get_capabilities(&adapter).formats.contains(&unorm) {
            config.format = unorm;
        }
        let compositor = Compositor::new(&device, &adapter);
        compositor.init(&queue);
        let (width, height) = (canvas.width(), canvas.height());
        let mut renderer = Self {
            pattern: pattern(&device, config.format),
            compositor,
            surface,
            device,
            queue,
            config,
            backend,
            adapter_name: info.name,
            paused: true,
            resized: true,
            stale: false,
            gpu_ms: Arc::new(AtomicU64::new(0)),
            in_flight: Arc::new(AtomicU32::new(0)),
        };
        renderer.resize(width, height);
        Ok(renderer)
    }

    pub fn backend(&self) -> &str {
        self.backend
    }
    pub fn adapter_name(&self) -> &str {
        &self.adapter_name
    }
    /// The texture format compositions blend in.
    pub fn composition_format(&self) -> String {
        format!("{:?}", self.compositor.comp_format())
    }
    pub fn max_texture_size(&self) -> u32 {
        self.device.limits().max_texture_dimension_2d
    }

    pub fn width(&self) -> u32 {
        if self.paused {
            0
        } else {
            self.config.width
        }
    }
    pub fn height(&self) -> u32 {
        if self.paused {
            0
        } else {
            self.config.height
        }
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        let was_paused = self.paused;
        self.paused = width == 0 || height == 0;
        if self.paused {
            return;
        }
        let max = self.device.limits().max_texture_dimension_2d;
        let width = width.min(max);
        let height = height.min(max);
        if !was_paused && width == self.config.width && height == self.config.height {
            return;
        }
        // Both wgpu browser backends set the canvas dimensions in configure.
        // Setting them here too resets the WebGPU presentation texture twice.
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
        self.resized = true;
        self.stale = true;
    }

    /// The monitor's next texture, or None when it cannot show one this frame.
    fn acquire(&mut self) -> Result<Option<SurfaceTexture>, String> {
        if self.paused {
            return Ok(None);
        }
        // A transferred canvas resize crosses the browser compositor boundary.
        // Acquire a fresh texture on the next animation frame, after it settles.
        if self.resized {
            self.resized = false;
            return Ok(None);
        }
        match self.surface.get_current_texture() {
            CurrentSurfaceTexture::Success(frame) | CurrentSurfaceTexture::Suboptimal(frame) => {
                Ok(Some(frame))
            }
            CurrentSurfaceTexture::Lost | CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                Ok(None)
            }
            CurrentSurfaceTexture::Timeout | CurrentSurfaceTexture::Occluded => Ok(None),
            CurrentSurfaceTexture::Validation => Err("GPU surface validation failed".into()),
        }
    }

    /// Draws the test pattern at `seconds`. Returns whether a frame was presented.
    pub fn pattern_frame(&mut self, seconds: f32) -> Result<bool, String> {
        let Some(output) = self.acquire()? else {
            return Ok(false);
        };
        let uniforms = PatternUniforms {
            width: self.config.width as f32,
            height: self.config.height as f32,
            seconds,
        };
        self.queue
            .write_buffer(&self.pattern.uniforms, 0, &uniforms.to_bytes());
        let view = output
            .texture
            .create_view(&TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&CommandEncoderDescriptor::default());
        {
            let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("Program monitor"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(Color::BLACK),
                        store: StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.pattern.pipeline);
            pass.set_bind_group(0, &self.pattern.bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(output);
        Ok(true)
    }

    /// Starts a composed frame with `layers` source slots.
    pub fn begin_frame(&mut self, layers: usize) {
        self.compositor.begin(&self.device, layers);
    }

    pub fn set_source(&mut self, index: usize, source: FrameSource) -> Result<(), String> {
        self.compositor
            .set_source(&self.device, &self.queue, index, source)
    }

    pub fn compose(
        &mut self,
        project: (u32, u32),
        output: (u32, u32),
        draws: &[(usize, LayerDraw)],
    ) -> Result<(), String> {
        self.compositor
            .compose(&self.device, project, output, draws)
    }

    fn viewport(&self) -> [f32; 4] {
        letterbox(
            (self.config.width, self.config.height),
            self.compositor.project(),
        )
    }

    fn time_submission(&self) {
        let started = now_ms();
        let gpu_ms = self.gpu_ms.clone();
        let in_flight = self.in_flight.clone();
        in_flight.fetch_add(1, Ordering::Relaxed);
        self.queue.on_submitted_work_done(move || {
            gpu_ms.store((now_ms() - started).to_bits(), Ordering::Relaxed);
            in_flight.fetch_sub(1, Ordering::Relaxed);
        });
    }

    /// True while the GPU still works on a composed frame. The first frames of a
    /// playback can take long (shaders, shared images); playback waits them out.
    pub fn gpu_busy(&self) -> bool {
        // WebGL2 runs completion callbacks only when polled.
        let _ = self.device.poll(PollType::Poll);
        self.in_flight.load(Ordering::Relaxed) > 0
    }

    /// Submits the composed frame, showing it on the monitor when `present` is set.
    /// Returns whether the monitor shows it now; if not, `present_again` will.
    pub fn finish(&mut self, present: bool) -> Result<bool, String> {
        // WebGL2 runs completion callbacks only when polled.
        let _ = self.device.poll(PollType::Poll);
        let output = if present { self.acquire()? } else { None };
        match output {
            Some(output) => {
                let view = output
                    .texture
                    .create_view(&TextureViewDescriptor::default());
                let viewport = self.viewport();
                self.compositor.submit(
                    &self.device,
                    &self.queue,
                    Some((&view, self.config.format, viewport)),
                )?;
                self.time_submission();
                self.queue.present(output);
                self.stale = false;
                Ok(true)
            }
            None => {
                self.compositor.submit(&self.device, &self.queue, None)?;
                self.time_submission();
                self.stale = present || self.stale;
                Ok(false)
            }
        }
    }

    /// True when the monitor should show the latest composition again.
    pub fn needs_present(&self) -> bool {
        self.stale && !self.paused && self.compositor.has_composition()
    }

    /// Shows the latest composition again, after a resize or a missed frame.
    pub fn present_again(&mut self) -> Result<bool, String> {
        if !self.compositor.has_composition() {
            return Ok(false);
        }
        let Some(output) = self.acquire()? else {
            return Ok(false);
        };
        let view = output
            .texture
            .create_view(&TextureViewDescriptor::default());
        let viewport = self.viewport();
        self.compositor.present_last(
            &self.device,
            &self.queue,
            &view,
            self.config.format,
            viewport,
        );
        self.queue.present(output);
        self.stale = false;
        Ok(true)
    }

    /// Milliseconds the GPU took for the last finished submission.
    pub fn gpu_ms(&self) -> f64 {
        f64::from_bits(self.gpu_ms.load(Ordering::Relaxed))
    }

    pub fn upload_still(&mut self, key: &str, image: ExternalImageSource) -> Result<(), String> {
        self.compositor
            .upload_still(&self.device, &self.queue, key, image)
    }
    pub fn has_still(&self, key: &str) -> bool {
        self.compositor.has_still(key)
    }
    pub fn drop_still(&mut self, key: &str) -> bool {
        self.compositor.drop_still(key)
    }

    /// Reads the latest composition back as sRGB RGBA bytes at its own size.
    pub fn start_readback(&mut self) -> Result<Readback, String> {
        self.compositor.start_readback(&self.device, &self.queue)
    }

    /// Reads the latest composition back as a BT.709 NV12 frame of `frame` pixels.
    pub fn start_nv12_readback(&mut self, frame: (u32, u32)) -> Result<Readback, String> {
        self.compositor
            .start_nv12_readback(&self.device, &self.queue, frame)
    }

    pub fn dispose(&mut self) {
        self.compositor.dispose();
        self.device.destroy();
    }
    pub fn simulate_device_loss(&self) {
        self.device.destroy();
    }
}

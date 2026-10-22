use std::sync::Arc;

use web_sys::OffscreenCanvas;
use wgpu::*;

use crate::pattern::PatternUniforms;

pub struct Renderer {
    surface: Surface<'static>,
    device: Device,
    queue: Queue,
    config: SurfaceConfiguration,
    pipeline: RenderPipeline,
    uniforms: Buffer,
    bind_group: BindGroup,
    backend: &'static str,
    adapter_name: String,
    paused: bool,
    resized: bool,
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
                    format: config.format,
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
        let (width, height) = (canvas.width(), canvas.height());
        let mut renderer = Self {
            surface,
            device,
            queue,
            config,
            pipeline,
            uniforms,
            bind_group,
            backend,
            adapter_name: info.name,
            paused: true,
            resized: true,
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
    }

    /// Draws the pattern at `seconds`. Returns whether a frame was presented.
    pub fn frame(&mut self, seconds: f32) -> Result<bool, String> {
        if self.paused {
            return Ok(false);
        }
        // A transferred canvas resize crosses the browser compositor boundary.
        // Acquire a fresh texture on the next animation frame, after it settles.
        if self.resized {
            self.resized = false;
            return Ok(false);
        }
        let output = match self.surface.get_current_texture() {
            CurrentSurfaceTexture::Success(frame) | CurrentSurfaceTexture::Suboptimal(frame) => {
                frame
            }
            CurrentSurfaceTexture::Lost | CurrentSurfaceTexture::Outdated => {
                self.surface.configure(&self.device, &self.config);
                return Ok(false);
            }
            CurrentSurfaceTexture::Timeout | CurrentSurfaceTexture::Occluded => return Ok(false),
            CurrentSurfaceTexture::Validation => return Err("GPU surface validation failed".into()),
        };
        let uniforms = PatternUniforms {
            width: self.config.width as f32,
            height: self.config.height as f32,
            seconds,
        };
        self.queue
            .write_buffer(&self.uniforms, 0, &uniforms.to_bytes());
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
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(output);
        Ok(true)
    }

    pub fn dispose(&self) {
        self.device.destroy();
    }
    pub fn simulate_device_loss(&self) {
        self.device.destroy();
    }
}

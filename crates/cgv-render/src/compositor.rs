//! The GPU side of the compositor (browser only). A frame is built in three
//! steps: each layer's source becomes a linear, premultiplied texture; the layers
//! draw bottom first into the composition target; the target is presented on the
//! monitor or read back. Preview and export share all of it.
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use wgpu::*;

use crate::color::{yuv_to_rgb, FrameColor, Matrix, Transfer};
use crate::geometry::{layer_geometry, CropRect, LayerTransform, Picture};

/// Layers sample sRGB-encoded storage, which the GPU decodes to linear light.
const LAYER_FORMAT: TextureFormat = TextureFormat::Rgba8UnormSrgb;
/// Readback encodes sRGB in the shader into plain 8-bit storage.
const READBACK_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;
const LAYER_UNIFORM_SIZE: u64 = 96;
const CONVERT_UNIFORM_SIZE: u64 = 64;
/// Uniform slots per frame: one per layer and one per frame conversion.
const UNIFORM_SLOTS: u64 = 256;
/// Free textures kept per size and format.
const POOL_KEEP: usize = 6;

/// How a CPU frame's bytes are arranged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaneFormat {
    /// 8-bit Y, then Cb and Cr at quarter size.
    I420,
    /// 8-bit Y, then interleaved CbCr at quarter size.
    Nv12,
    /// 8-bit sRGB-encoded RGBA, opaque.
    Rgba,
}

/// A CPU frame's pixels as WebCodecs `copyTo` lays them out.
pub struct Planes<'a> {
    pub format: PlaneFormat,
    /// The visible size in pixels.
    pub width: u32,
    pub height: u32,
    pub data: &'a [u8],
    /// Offset and stride in bytes of each plane; unused planes are ignored.
    pub layout: [(u32, u32); 3],
    pub color: FrameColor,
}

pub enum FrameSource<'a> {
    /// A decoder output or image bitmap, copied and converted by the browser on
    /// the GPU. Use it for GPU-backed frames, whose conversion is correct.
    External(ExternalImageSource),
    /// CPU frame planes, converted here with the frame's own matrix.
    Planes(Planes<'a>),
    /// A still image uploaded earlier.
    Still(&'a str),
}

/// One layer to draw, bottom first.
#[derive(Clone, Copy, Debug)]
pub struct LayerDraw {
    pub picture: Picture,
    pub transform: LayerTransform,
    pub crop: CropRect,
    pub opacity: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct TextureKey {
    width: u32,
    height: u32,
    format: TextureFormat,
}

struct Pooled {
    key: TextureKey,
    texture: Texture,
    view: TextureView,
    /// The layer-pass binding of this texture, made on first use.
    binding: Option<BindGroup>,
}

#[derive(Default)]
struct TexturePool {
    free: HashMap<TextureKey, Vec<Pooled>>,
}

impl TexturePool {
    fn acquire(&mut self, device: &Device, key: TextureKey) -> Pooled {
        if let Some(texture) = self.free.get_mut(&key).and_then(Vec::pop) {
            return texture;
        }
        let mut usage = TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST;
        if key.format == LAYER_FORMAT {
            // Conversion passes render into it; external copies require it too.
            usage |= TextureUsages::RENDER_ATTACHMENT;
        }
        let texture = device.create_texture(&TextureDescriptor {
            label: Some("Layer texture"),
            size: Extent3d {
                width: key.width,
                height: key.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: key.format,
            usage,
            view_formats: &[],
        });
        let view = texture.create_view(&TextureViewDescriptor::default());
        Pooled {
            key,
            texture,
            view,
            binding: None,
        }
    }

    fn release(&mut self, texture: Pooled) {
        let free = self.free.entry(texture.key).or_default();
        if free.len() < POOL_KEEP {
            free.push(texture);
        } else {
            texture.texture.destroy();
        }
    }

    fn clear(&mut self) {
        for (_, textures) in self.free.drain() {
            for texture in textures {
                texture.texture.destroy();
            }
        }
    }
}

struct Still {
    texture: Texture,
    binding: BindGroup,
}

enum LayerTexture {
    Pooled(Pooled),
    Still(String),
}

/// A frame being built: its command encoder, layer textures and uniforms.
struct FrameBuild {
    encoder: CommandEncoder,
    layers: Vec<Option<LayerTexture>>,
    /// Plane textures to return to the pool after submission.
    planes: Vec<Pooled>,
    uniforms: Vec<u8>,
    slots: u64,
}

struct CompTarget {
    texture: Texture,
    view: TextureView,
    width: u32,
    height: u32,
    /// Present bindings: [linear target, sRGB-encoding target].
    present: [BindGroup; 2],
}

/// A readback in flight. `wait` resolves with tightly packed RGBA rows.
pub struct Readback {
    device: Device,
    buffer: Buffer,
    width: u32,
    height: u32,
    padded_row: u32,
    mapped: Rc<Cell<Option<bool>>>,
}

impl Readback {
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub async fn wait(self) -> Result<Vec<u8>, String> {
        loop {
            // WebGL2 needs polling to finish the map; WebGPU resolves on its own.
            let _ = self.device.poll(PollType::Poll);
            match self.mapped.get() {
                Some(true) => break,
                Some(false) => return Err("Could not read the frame back from the GPU".into()),
                None => sleep_ms(1).await,
            }
        }
        let data = self
            .buffer
            .slice(..)
            .get_mapped_range()
            .map_err(|error| format!("Could not read the frame back: {error}"))?;
        let row = self.width as usize * 4;
        let mut pixels = Vec::with_capacity(row * self.height as usize);
        for y in 0..self.height as usize {
            let start = y * self.padded_row as usize;
            pixels.extend_from_slice(&data[start..start + row]);
        }
        drop(data);
        self.buffer.unmap();
        self.buffer.destroy();
        Ok(pixels)
    }
}

async fn sleep_ms(ms: i32) {
    use wasm_bindgen::JsCast;
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        let scope: web_sys::WorkerGlobalScope = js_sys::global().unchecked_into();
        let _ = scope.set_timeout_with_callback_and_timeout_and_arguments_0(&resolve, ms);
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}

pub struct Compositor {
    comp_format: TextureFormat,
    align: u64,
    sampler: Sampler,
    texture_layout: BindGroupLayout,
    convert_layout: BindGroupLayout,
    present_layout: BindGroupLayout,
    layer_pipeline: RenderPipeline,
    nv12_pipeline: RenderPipeline,
    i420_pipeline: RenderPipeline,
    premultiply_pipeline: RenderPipeline,
    present_pipelines: HashMap<TextureFormat, RenderPipeline>,
    shader: ShaderModule,
    uniforms: Buffer,
    layer_uniforms: BindGroup,
    present_uniforms: Buffer,
    pool: TexturePool,
    stills: HashMap<String, Still>,
    comp: Option<CompTarget>,
    frame: Option<FrameBuild>,
    project: (u32, u32),
}

fn uniform_entry(binding: u32, dynamic: bool, size: u64) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::VERTEX_FRAGMENT,
        ty: BindingType::Buffer {
            ty: BufferBindingType::Uniform,
            has_dynamic_offset: dynamic,
            min_binding_size: BufferSize::new(size),
        },
        count: None,
    }
}

fn texture_entry(binding: u32) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::FRAGMENT,
        ty: BindingType::Texture {
            sample_type: TextureSampleType::Float { filterable: true },
            view_dimension: TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn sampler_entry(binding: u32) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::FRAGMENT,
        ty: BindingType::Sampler(SamplerBindingType::Filtering),
        count: None,
    }
}

fn floats(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

impl Compositor {
    pub fn new(device: &Device, adapter: &Adapter) -> Compositor {
        // Half-float targets keep linear-light blending free of banding. WebGL2
        // without float render targets falls back to sRGB 8-bit storage, which
        // still blends in linear light.
        let half = adapter.get_texture_format_features(TextureFormat::Rgba16Float);
        let comp_format = if half
            .allowed_usages
            .contains(TextureUsages::RENDER_ATTACHMENT)
            && half.flags.contains(
                TextureFormatFeatureFlags::BLENDABLE | TextureFormatFeatureFlags::FILTERABLE,
            ) {
            TextureFormat::Rgba16Float
        } else {
            TextureFormat::Rgba8UnormSrgb
        };
        let align = device.limits().min_uniform_buffer_offset_alignment as u64;
        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("Compositor shader"),
            source: ShaderSource::Wgsl(include_str!("compositor.wgsl").into()),
        });
        let sampler = device.create_sampler(&SamplerDescriptor {
            label: Some("Linear clamp"),
            address_mode_u: AddressMode::ClampToEdge,
            address_mode_v: AddressMode::ClampToEdge,
            mag_filter: FilterMode::Linear,
            min_filter: FilterMode::Linear,
            ..Default::default()
        });
        let layer_uniform_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("Layer uniforms"),
            entries: &[uniform_entry(0, true, LAYER_UNIFORM_SIZE)],
        });
        let texture_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("Layer texture"),
            entries: &[texture_entry(0), sampler_entry(1)],
        });
        let convert_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("Frame conversion"),
            entries: &[
                uniform_entry(10, false, CONVERT_UNIFORM_SIZE),
                texture_entry(11),
                texture_entry(12),
                texture_entry(13),
                sampler_entry(14),
            ],
        });
        let present_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("Present"),
            entries: &[
                uniform_entry(20, false, 16),
                texture_entry(21),
                sampler_entry(22),
            ],
        });
        let layer_pipeline = Self::pipeline(
            device,
            &shader,
            &[&layer_uniform_layout, &texture_layout],
            ("vs_layer", "fs_layer"),
            comp_format,
            Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING),
            PrimitiveTopology::TriangleStrip,
        );
        let convert = |entry| {
            Self::pipeline(
                device,
                &shader,
                &[&convert_layout],
                ("vs_full", entry),
                LAYER_FORMAT,
                None,
                PrimitiveTopology::TriangleList,
            )
        };
        let uniforms = device.create_buffer(&BufferDescriptor {
            label: Some("Compositor uniforms"),
            size: UNIFORM_SLOTS * align,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let layer_uniforms = device.create_bind_group(&BindGroupDescriptor {
            label: Some("Layer uniforms"),
            layout: &layer_uniform_layout,
            entries: &[BindGroupEntry {
                binding: 0,
                resource: BindingResource::Buffer(BufferBinding {
                    buffer: &uniforms,
                    offset: 0,
                    size: BufferSize::new(LAYER_UNIFORM_SIZE),
                }),
            }],
        });
        // Two present modes: the target encodes sRGB itself, or the shader must.
        let present_uniforms = device.create_buffer(&BufferDescriptor {
            label: Some("Present uniforms"),
            size: 2 * align,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Compositor {
            comp_format,
            align,
            sampler,
            nv12_pipeline: convert("fs_nv12"),
            i420_pipeline: convert("fs_i420"),
            premultiply_pipeline: convert("fs_premultiply"),

            texture_layout,
            convert_layout,
            present_layout,
            layer_pipeline,
            present_pipelines: HashMap::new(),
            shader,
            uniforms,
            layer_uniforms,
            present_uniforms,
            pool: TexturePool::default(),
            stills: HashMap::new(),
            comp: None,
            frame: None,
            project: (16, 16),
        }
    }

    /// Writes the fixed present uniforms. Call once after creation, with the queue.
    pub fn init(&self, queue: &Queue) {
        queue.write_buffer(&self.present_uniforms, 0, &floats(&[0.0; 4]));
        queue.write_buffer(
            &self.present_uniforms,
            self.align,
            &floats(&[1.0, 0.0, 0.0, 0.0]),
        );
    }

    pub fn comp_format(&self) -> TextureFormat {
        self.comp_format
    }

    #[allow(clippy::too_many_arguments)]
    fn pipeline(
        device: &Device,
        shader: &ShaderModule,
        layouts: &[&BindGroupLayout],
        entries: (&str, &str),
        format: TextureFormat,
        blend: Option<BlendState>,
        topology: PrimitiveTopology,
    ) -> RenderPipeline {
        let layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some(entries.1),
            bind_group_layouts: &layouts
                .iter()
                .map(|layout| Some(*layout))
                .collect::<Vec<_>>(),
            immediate_size: 0,
        });
        device.create_render_pipeline(&RenderPipelineDescriptor {
            label: Some(entries.1),
            layout: Some(&layout),
            vertex: VertexState {
                module: shader,
                entry_point: Some(entries.0),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(FragmentState {
                module: shader,
                entry_point: Some(entries.1),
                compilation_options: Default::default(),
                targets: &[Some(ColorTargetState {
                    format,
                    blend,
                    write_mask: ColorWrites::ALL,
                })],
            }),
            primitive: PrimitiveState {
                topology,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        })
    }

    fn present_pipeline(&mut self, device: &Device, format: TextureFormat) -> &RenderPipeline {
        if !self.present_pipelines.contains_key(&format) {
            let pipeline = Self::pipeline(
                device,
                &self.shader,
                &[&self.present_layout],
                ("vs_full", "fs_present"),
                format,
                None,
                PrimitiveTopology::TriangleList,
            );
            self.present_pipelines.insert(format, pipeline);
        }
        &self.present_pipelines[&format]
    }

    /// Starts a frame with `layers` source slots.
    pub fn begin(&mut self, device: &Device, layers: usize) {
        if let Some(frame) = self.frame.take() {
            self.recycle(frame);
        }
        self.frame = Some(FrameBuild {
            encoder: device.create_command_encoder(&CommandEncoderDescriptor {
                label: Some("Compose"),
            }),
            layers: (0..layers).map(|_| None).collect(),
            planes: Vec::new(),
            uniforms: Vec::new(),
            slots: 0,
        });
    }

    fn slot(frame: &mut FrameBuild, align: u64, bytes: &[u8]) -> Result<u64, String> {
        if frame.slots >= UNIFORM_SLOTS {
            return Err(format!("A frame can hold at most {UNIFORM_SLOTS} layers"));
        }
        let offset = frame.slots * align;
        frame.uniforms.resize(offset as usize, 0);
        frame.uniforms.extend_from_slice(bytes);
        frame.slots += 1;
        Ok(offset)
    }

    /// Gives layer `index` its picture for this frame.
    pub fn set_source(
        &mut self,
        device: &Device,
        queue: &Queue,
        index: usize,
        source: FrameSource,
    ) -> Result<(), String> {
        let limit = device.limits().max_texture_dimension_2d;
        let frame = self.frame.as_mut().ok_or("No frame is being built")?;
        if index >= frame.layers.len() {
            return Err(format!("Layer {index} is not in this frame"));
        }
        let texture = match source {
            FrameSource::Still(key) => {
                if !self.stills.contains_key(key) {
                    return Err(format!("Still {key} is not loaded"));
                }
                LayerTexture::Still(key.to_string())
            }
            FrameSource::External(image) => {
                let (width, height) = (image.width(), image.height());
                if width == 0 || height == 0 || width > limit || height > limit {
                    return Err(format!("A {width}×{height} frame does not fit on the GPU"));
                }
                let texture = self.pool.acquire(
                    device,
                    TextureKey {
                        width,
                        height,
                        format: LAYER_FORMAT,
                    },
                );
                queue.copy_external_image_to_texture(
                    &CopyExternalImageSourceInfo {
                        source: image,
                        origin: Origin2d::ZERO,
                        flip_y: false,
                    },
                    CopyExternalImageDestInfo {
                        texture: &texture.texture,
                        mip_level: 0,
                        origin: Origin3d::ZERO,
                        aspect: TextureAspect::All,
                        color_space: PredefinedColorSpace::Srgb,
                        premultiplied_alpha: false,
                    },
                    Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                );
                LayerTexture::Pooled(texture)
            }
            FrameSource::Planes(planes) => {
                let (width, height) = (planes.width, planes.height);
                if width == 0 || height == 0 || width > limit || height > limit {
                    return Err(format!("A {width}×{height} frame does not fit on the GPU"));
                }
                LayerTexture::Pooled(self.convert_planes(device, queue, &planes)?)
            }
        };
        let frame = self.frame.as_mut().unwrap();
        if let Some(LayerTexture::Pooled(old)) = frame.layers[index].replace(texture) {
            self.pool.release(old);
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn write_plane(
        &mut self,
        device: &Device,
        queue: &Queue,
        planes: &Planes,
        plane: usize,
        size: (u32, u32),
        format: TextureFormat,
        bytes_per_pixel: u32,
    ) -> Result<Pooled, String> {
        let (offset, stride) = planes.layout[plane];
        let needed =
            offset as u64 + stride as u64 * (size.1 as u64 - 1) + (size.0 * bytes_per_pixel) as u64;
        if stride < size.0 * bytes_per_pixel || needed > planes.data.len() as u64 {
            return Err("The frame's plane layout does not match its size".into());
        }
        let texture = self.pool.acquire(
            device,
            TextureKey {
                width: size.0,
                height: size.1,
                format,
            },
        );
        queue.write_texture(
            TexelCopyTextureInfo {
                texture: &texture.texture,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            planes.data,
            TexelCopyBufferLayout {
                offset: offset as u64,
                bytes_per_row: Some(stride),
                rows_per_image: None,
            },
            Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
        );
        Ok(texture)
    }

    fn convert_planes(
        &mut self,
        device: &Device,
        queue: &Queue,
        planes: &Planes,
    ) -> Result<Pooled, String> {
        let (width, height) = (planes.width, planes.height);
        if planes.format == PlaneFormat::Rgba {
            // Opaque sRGB bytes go straight into a layer texture.
            return self.write_plane(device, queue, planes, 0, (width, height), LAYER_FORMAT, 4);
        }
        let chroma = (width.div_ceil(2), height.div_ceil(2));
        let nv12 = planes.format == PlaneFormat::Nv12;
        let r8 = TextureFormat::R8Unorm;
        let mut used = vec![self.write_plane(device, queue, planes, 0, (width, height), r8, 1)?];
        if nv12 {
            used.push(self.write_plane(
                device,
                queue,
                planes,
                1,
                chroma,
                TextureFormat::Rg8Unorm,
                2,
            )?);
        } else {
            used.push(self.write_plane(device, queue, planes, 1, chroma, r8, 1)?);
            used.push(self.write_plane(device, queue, planes, 2, chroma, r8, 1)?);
        }
        let color = planes.color;
        let matrix = yuv_to_rgb(color.matrix, color.full_range);
        let transfer = match color.transfer {
            Transfer::Sdr => 0.0,
            Transfer::Pq => 1.0,
            Transfer::Hlg => 2.0,
        };
        let wide = if color.transfer != Transfer::Sdr && color.matrix == Matrix::Bt2020 {
            1.0
        } else {
            0.0
        };
        let mut values: Vec<f32> = matrix.iter().flatten().copied().collect();
        values.extend([transfer, wide, 0.0, 0.0]);
        let frame = self.frame.as_mut().unwrap();
        let offset = Self::slot(frame, self.align, &floats(&values))?;
        let output = self.pool.acquire(
            device,
            TextureKey {
                width,
                height,
                format: LAYER_FORMAT,
            },
        );
        let views = [&used[0].view, &used[1].view, &used[used.len() - 1].view];
        let binding = device.create_bind_group(&BindGroupDescriptor {
            label: Some("Frame conversion"),
            layout: &self.convert_layout,
            entries: &[
                BindGroupEntry {
                    binding: 10,
                    resource: BindingResource::Buffer(BufferBinding {
                        buffer: &self.uniforms,
                        offset,
                        size: BufferSize::new(CONVERT_UNIFORM_SIZE),
                    }),
                },
                BindGroupEntry {
                    binding: 11,
                    resource: BindingResource::TextureView(views[0]),
                },
                BindGroupEntry {
                    binding: 12,
                    resource: BindingResource::TextureView(views[1]),
                },
                BindGroupEntry {
                    binding: 13,
                    resource: BindingResource::TextureView(views[2]),
                },
                BindGroupEntry {
                    binding: 14,
                    resource: BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        {
            let mut pass = frame.encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("Frame conversion"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &output.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(Color::TRANSPARENT),
                        store: StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(if nv12 {
                &self.nv12_pipeline
            } else {
                &self.i420_pipeline
            });
            pass.set_bind_group(0, &binding, &[]);
            pass.draw(0..3, 0..1);
        }
        frame.planes.extend(used);
        Ok(output)
    }

    /// Uploads a still image once, as premultiplied linear colour.
    pub fn upload_still(
        &mut self,
        device: &Device,
        queue: &Queue,
        key: &str,
        image: ExternalImageSource,
    ) -> Result<(), String> {
        let (width, height) = (image.width(), image.height());
        let limit = device.limits().max_texture_dimension_2d;
        if width == 0 || height == 0 || width > limit || height > limit {
            return Err(format!("A {width}×{height} image does not fit on the GPU"));
        }
        let staging = self.pool.acquire(
            device,
            TextureKey {
                width,
                height,
                format: LAYER_FORMAT,
            },
        );
        queue.copy_external_image_to_texture(
            &CopyExternalImageSourceInfo {
                source: image,
                origin: Origin2d::ZERO,
                flip_y: false,
            },
            CopyExternalImageDestInfo {
                texture: &staging.texture,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
                color_space: PredefinedColorSpace::Srgb,
                premultiplied_alpha: false,
            },
            Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let texture = device.create_texture(&TextureDescriptor {
            label: Some("Still"),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: LAYER_FORMAT,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = texture.create_view(&TextureViewDescriptor::default());
        // The premultiply pass only reads plane0; the other planes repeat it.
        queue.write_buffer(&self.uniforms, 0, &floats(&[0.0; 16]));
        let binding = device.create_bind_group(&BindGroupDescriptor {
            label: Some("Still conversion"),
            layout: &self.convert_layout,
            entries: &[
                BindGroupEntry {
                    binding: 10,
                    resource: BindingResource::Buffer(BufferBinding {
                        buffer: &self.uniforms,
                        offset: 0,
                        size: BufferSize::new(CONVERT_UNIFORM_SIZE),
                    }),
                },
                BindGroupEntry {
                    binding: 11,
                    resource: BindingResource::TextureView(&staging.view),
                },
                BindGroupEntry {
                    binding: 12,
                    resource: BindingResource::TextureView(&staging.view),
                },
                BindGroupEntry {
                    binding: 13,
                    resource: BindingResource::TextureView(&staging.view),
                },
                BindGroupEntry {
                    binding: 14,
                    resource: BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("Still upload"),
        });
        {
            let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("Premultiply still"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(Color::TRANSPARENT),
                        store: StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.premultiply_pipeline);
            pass.set_bind_group(0, &binding, &[]);
            pass.draw(0..3, 0..1);
        }
        queue.submit([encoder.finish()]);
        self.pool.release(staging);
        let binding = self.texture_binding(device, &view);
        if let Some(old) = self
            .stills
            .insert(key.to_string(), Still { texture, binding })
        {
            old.texture.destroy();
        }
        Ok(())
    }

    pub fn has_still(&self, key: &str) -> bool {
        self.stills.contains_key(key)
    }

    pub fn drop_still(&mut self, key: &str) -> bool {
        match self.stills.remove(key) {
            Some(still) => {
                still.texture.destroy();
                true
            }
            None => false,
        }
    }

    fn texture_binding(&self, device: &Device, view: &TextureView) -> BindGroup {
        device.create_bind_group(&BindGroupDescriptor {
            label: Some("Layer texture"),
            layout: &self.texture_layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: BindingResource::TextureView(view),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: BindingResource::Sampler(&self.sampler),
                },
            ],
        })
    }

    fn ensure_comp(&mut self, device: &Device, width: u32, height: u32) {
        if self
            .comp
            .as_ref()
            .is_some_and(|comp| comp.width == width && comp.height == height)
        {
            return;
        }
        if let Some(old) = self.comp.take() {
            old.texture.destroy();
        }
        let texture = device.create_texture(&TextureDescriptor {
            label: Some("Composition"),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: self.comp_format,
            usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&TextureViewDescriptor::default());
        let present = |mode: u64| {
            device.create_bind_group(&BindGroupDescriptor {
                label: Some("Present"),
                layout: &self.present_layout,
                entries: &[
                    BindGroupEntry {
                        binding: 20,
                        resource: BindingResource::Buffer(BufferBinding {
                            buffer: &self.present_uniforms,
                            offset: mode * self.align,
                            size: BufferSize::new(16),
                        }),
                    },
                    BindGroupEntry {
                        binding: 21,
                        resource: BindingResource::TextureView(&view),
                    },
                    BindGroupEntry {
                        binding: 22,
                        resource: BindingResource::Sampler(&self.sampler),
                    },
                ],
            })
        };
        let present = [present(0), present(1)];
        self.comp = Some(CompTarget {
            texture,
            view,
            width,
            height,
            present,
        });
    }

    /// Draws the frame's layers, bottom first, into a composition of `output`
    /// pixels for a project of `project` pixels. `draws` pairs each source slot
    /// with how to draw it.
    pub fn compose(
        &mut self,
        device: &Device,
        project: (u32, u32),
        output: (u32, u32),
        draws: &[(usize, LayerDraw)],
    ) -> Result<(), String> {
        let limit = device.limits().max_texture_dimension_2d;
        let output = (output.0.clamp(1, limit), output.1.clamp(1, limit));
        self.ensure_comp(device, output.0, output.1);
        self.project = project;
        let scale = output.0 as f64 / project.0 as f64;
        let project_f = (project.0 as f64, project.1 as f64);
        let mut frame = self.frame.take().ok_or("No frame is being built")?;
        let mut drawn = Vec::new();
        for (index, draw) in draws {
            if !matches!(frame.layers.get(*index), Some(Some(_))) {
                continue;
            }
            let Some(geometry) =
                layer_geometry(project_f, scale, &draw.picture, &draw.transform, &draw.crop)
            else {
                continue;
            };
            let opacity = draw.opacity.clamp(0.0, 1.0);
            if opacity <= 0.0 {
                continue;
            }
            let clip = geometry.to_clip.to_f32();
            let tex = geometry.to_texture.to_f32();
            let v = geometry.visible.map(|value| value as f32);
            let q = geometry.quad.map(|value| value as f32);
            let values = [
                clip[0],
                clip[1],
                clip[2],
                clip[3],
                clip[4],
                clip[5],
                opacity as f32,
                0.0,
                tex[0],
                tex[1],
                tex[2],
                tex[3],
                tex[4],
                tex[5],
                0.0,
                0.0,
                v[0],
                v[1],
                v[2],
                v[3],
                q[0],
                q[1],
                q[2],
                q[3],
            ];
            let offset = match Self::slot(&mut frame, self.align, &floats(&values)) {
                Ok(offset) => offset,
                Err(error) => {
                    self.frame = Some(frame);
                    return Err(error);
                }
            };
            if let Some(Some(LayerTexture::Pooled(pooled))) = frame.layers.get_mut(*index) {
                if pooled.binding.is_none() {
                    pooled.binding = Some(self.texture_binding(device, &pooled.view));
                }
            }
            drawn.push((*index, offset as u32));
        }
        {
            let comp = self.comp.as_ref().unwrap();
            let mut pass = frame.encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("Composition"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &comp.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(Color::TRANSPARENT),
                        store: StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&self.layer_pipeline);
            for (index, offset) in &drawn {
                let binding = match frame.layers[*index].as_ref().unwrap() {
                    LayerTexture::Pooled(pooled) => pooled.binding.as_ref().unwrap(),
                    LayerTexture::Still(key) => &self.stills[key].binding,
                };
                pass.set_bind_group(0, &self.layer_uniforms, &[*offset]);
                pass.set_bind_group(1, binding, &[]);
                pass.draw(0..4, 0..1);
            }
        }
        self.frame = Some(frame);
        Ok(())
    }

    /// Records a pass that shows the composition in `viewport` of `target`.
    /// `encode` applies the sRGB curve in the shader (for non-sRGB targets).
    fn record_present(
        &mut self,
        device: &Device,
        encoder: &mut CommandEncoder,
        target: &TextureView,
        format: TextureFormat,
        viewport: [f32; 4],
    ) {
        let encode = !format.is_srgb();
        let pipeline = self.present_pipeline(device, format).clone();
        let Some(comp) = self.comp.as_ref() else {
            return;
        };
        let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
            label: Some("Present"),
            color_attachments: &[Some(RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: Operations {
                    load: LoadOp::Clear(Color::BLACK),
                    store: StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        if viewport[2] >= 1.0 && viewport[3] >= 1.0 {
            pass.set_pipeline(&pipeline);
            pass.set_viewport(viewport[0], viewport[1], viewport[2], viewport[3], 0.0, 1.0);
            pass.set_bind_group(0, &comp.present[encode as usize], &[]);
            pass.draw(0..3, 0..1);
        }
    }

    /// Submits the frame being built; with `target`, it is shown there too.
    pub fn submit(
        &mut self,
        device: &Device,
        queue: &Queue,
        target: Option<(&TextureView, TextureFormat, [f32; 4])>,
    ) -> Result<(), String> {
        let mut frame = self.frame.take().ok_or("No frame is being built")?;
        if let Some((view, format, viewport)) = target {
            self.record_present(device, &mut frame.encoder, view, format, viewport);
        }
        if !frame.uniforms.is_empty() {
            queue.write_buffer(&self.uniforms, 0, &frame.uniforms);
        }
        let FrameBuild {
            encoder,
            layers,
            planes,
            ..
        } = frame;
        queue.submit([encoder.finish()]);
        // Queue order makes the textures safe to reuse in the next frame.
        for texture in layers.into_iter().flatten() {
            if let LayerTexture::Pooled(texture) = texture {
                self.pool.release(texture);
            }
        }
        for texture in planes {
            self.pool.release(texture);
        }
        Ok(())
    }

    fn recycle(&mut self, frame: FrameBuild) {
        for texture in frame.layers.into_iter().flatten() {
            if let LayerTexture::Pooled(texture) = texture {
                self.pool.release(texture);
            }
        }
        for texture in frame.planes {
            self.pool.release(texture);
        }
    }

    /// Shows the last composition again (after a resize, say).
    pub fn present_last(
        &mut self,
        device: &Device,
        queue: &Queue,
        target: &TextureView,
        format: TextureFormat,
        viewport: [f32; 4],
    ) {
        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("Present again"),
        });
        self.record_present(device, &mut encoder, target, format, viewport);
        queue.submit([encoder.finish()]);
    }

    pub fn has_composition(&self) -> bool {
        self.comp.is_some()
    }

    /// The project size of the last composition.
    pub fn project(&self) -> (u32, u32) {
        self.project
    }

    /// Reads the last composition back as sRGB RGBA bytes at its own size.
    pub fn start_readback(&mut self, device: &Device, queue: &Queue) -> Result<Readback, String> {
        let (width, height) = self
            .comp
            .as_ref()
            .map(|comp| (comp.width, comp.height))
            .ok_or("Nothing has been composed yet")?;
        let texture = device.create_texture(&TextureDescriptor {
            label: Some("Readback"),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: READBACK_FORMAT,
            usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&TextureViewDescriptor::default());
        let padded_row =
            (width * 4).div_ceil(COPY_BYTES_PER_ROW_ALIGNMENT) * COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = device.create_buffer(&BufferDescriptor {
            label: Some("Readback"),
            size: padded_row as u64 * height as u64,
            usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("Readback"),
        });
        self.record_present(
            device,
            &mut encoder,
            &view,
            READBACK_FORMAT,
            [0.0, 0.0, width as f32, height as f32],
        );
        encoder.copy_texture_to_buffer(
            TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            TexelCopyBufferInfo {
                buffer: &buffer,
                layout: TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row),
                    rows_per_image: None,
                },
            },
            Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([encoder.finish()]);
        texture.destroy();
        let mapped = Rc::new(Cell::new(None));
        let done = mapped.clone();
        buffer
            .slice(..)
            .map_async(MapMode::Read, move |result| done.set(Some(result.is_ok())));
        Ok(Readback {
            device: device.clone(),
            buffer,
            width,
            height,
            padded_row,
            mapped,
        })
    }

    pub fn dispose(&mut self) {
        if let Some(frame) = self.frame.take() {
            self.recycle(frame);
        }
        self.pool.clear();
        for (_, still) in self.stills.drain() {
            still.texture.destroy();
        }
        if let Some(comp) = self.comp.take() {
            comp.texture.destroy();
        }
    }
}

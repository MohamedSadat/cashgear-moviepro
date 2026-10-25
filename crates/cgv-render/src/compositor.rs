//! The GPU side of the compositor (browser only). A frame is built in steps:
//! each layer's source becomes a linear, premultiplied texture; layers run their
//! effects; transitions blend their two sides; then the layers draw bottom first
//! into the composition target, which adjustment layers change in place. The
//! target is presented on the monitor or read back. Preview and export share all
//! of it.
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use cgv_model::Params;
use wgpu::*;

use crate::color::{rgb_to_yuv, yuv_to_rgb, FrameColor, Matrix, Transfer};
use crate::geometry::{
    effect_size, export_picture, layer_geometry, nv12_texels, visible_map, Affine, CropRect,
    LayerGeometry, LayerTransform, Picture,
};

/// Layers sample sRGB-encoded storage, which the GPU decodes to linear light.
const LAYER_FORMAT: TextureFormat = TextureFormat::Rgba8UnormSrgb;
/// Readback encodes sRGB in the shader into plain 8-bit storage.
const READBACK_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;
const LAYER_UNIFORM_SIZE: u64 = 96;
const CONVERT_UNIFORM_SIZE: u64 = 64;
const EXPORT_UNIFORM_SIZE: u64 = 80;
/// The `frame` uniform of an effect pass.
const EFFECT_FRAME_SIZE: u64 = 64;
/// Uniform slots per frame: one per layer and frame conversion, two or more per
/// effect pass.
const UNIFORM_SLOTS: u64 = 2048;
/// Pack images and LUTs hold data, not colour: no sRGB decoding.
const DATA_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;
/// Free textures kept per size and format.
const POOL_KEEP: usize = 6;
/// Free textures unused for this many frames are destroyed: a layer whose size
/// changes leaves textures of sizes no frame asks for again.
const POOL_AGE: u64 = 30;

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

/// A LUT an effect reads: the key it was uploaded under, and its input range.
#[derive(Clone, Copy, Debug)]
pub struct LutUse<'a> {
    pub key: &'a str,
    pub min: [f64; 3],
    pub max: [f64; 3],
}

/// An effect or transition to run, with its settings at this frame.
#[derive(Clone, Debug)]
pub struct EffectRun<'a> {
    pub entry: &'a cgv_effects::Entry,
    pub params: &'a Params,
    /// Seconds since the clip's start.
    pub time: f64,
    pub seed: f64,
    pub lut: Option<LutUse<'a>>,
    /// The key of the pack image the shader reads.
    pub image: Option<String>,
}

/// A layer: its source slot, where it goes and the effects it runs first.
#[derive(Clone, Debug)]
pub struct LayerStep<'a> {
    pub index: usize,
    pub draw: LayerDraw,
    pub effects: Vec<EffectRun<'a>>,
    /// Its drawn size may change from frame to frame (see [`effect_size`]).
    pub moving: bool,
}

/// How a frame is drawn, bottom first. A frame has a handful of steps, built
/// once: their size does not matter.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug)]
pub enum Step<'a> {
    Layer(LayerStep<'a>),
    /// Two layers blended by a transition; a missing side is transparent.
    Transition {
        from: Option<LayerStep<'a>>,
        to: Option<LayerStep<'a>>,
        transition: EffectRun<'a>,
        progress: f64,
    },
    /// Effects applied to the composition so far, mixed in by `opacity`.
    Adjustment {
        effects: Vec<EffectRun<'a>>,
        opacity: f64,
    },
}

/// Where a layer is drawn from: its source slot, or a texture its effects left.
#[derive(Clone, Copy, Debug)]
enum Source {
    Layer(usize),
    Output(usize),
}

/// A layer ready to draw: its texture and its layer uniforms.
#[derive(Clone, Copy, Debug)]
struct Drawable {
    source: Source,
    offset: u32,
}

/// What the composition passes do, in order.
enum Op<'s> {
    Draw(Drawable),
    /// A full-frame texture over the composition (a transition's result).
    Over(usize),
    Adjust(&'s [EffectRun<'s>], f64),
}

/// The frame being composed: the project's size and the output's.
struct Scene {
    project: (f64, f64),
    scale: f64,
    output: (u32, u32),
}

fn begin_pass<'e>(
    encoder: &'e mut CommandEncoder,
    label: &str,
    view: &TextureView,
    clear: bool,
) -> RenderPass<'e> {
    encoder.begin_render_pass(&RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: Operations {
                load: if clear {
                    LoadOp::Clear(Color::TRANSPARENT)
                } else {
                    LoadOp::Load
                },
                store: StoreOp::Store,
            },
        })],
        ..Default::default()
    })
}

/// The layer shader's uniforms: where the picture goes, how its texture maps,
/// its visible part and the quad drawn around it.
fn layer_values(geometry: &LayerGeometry, to_texture: &Affine, opacity: f64) -> Vec<u8> {
    let clip = geometry.to_clip.to_f32();
    let tex = to_texture.to_f32();
    let v = geometry.visible.map(|value| value as f32);
    let q = geometry.quad.map(|value| value as f32);
    floats(&[
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
    ])
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
    /// Free textures by key, each with the frame it was released in.
    free: HashMap<TextureKey, Vec<(Pooled, u64)>>,
    /// Frames trimmed so far.
    frame: u64,
}

impl TexturePool {
    fn acquire(&mut self, device: &Device, key: TextureKey) -> Pooled {
        if let Some((texture, _)) = self.free.get_mut(&key).and_then(Vec::pop) {
            return texture;
        }
        // Conversion and effect passes render into it; external copies require it too.
        let usage = TextureUsages::TEXTURE_BINDING
            | TextureUsages::COPY_DST
            | TextureUsages::RENDER_ATTACHMENT;
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

    /// Returns a texture for reuse. Effect chains release textures while a frame
    /// is built, so nothing is destroyed until [`TexturePool::trim`].
    fn release(&mut self, texture: Pooled) {
        let frame = self.frame;
        self.free
            .entry(texture.key)
            .or_default()
            .push((texture, frame));
    }

    /// Keeps at most a few free textures of each size, and none that have gone
    /// unused for long; call after a submission.
    fn trim(&mut self) {
        self.frame += 1;
        let oldest = self.frame.saturating_sub(POOL_AGE);
        self.free.retain(|_, free| {
            // The most recently released are at the end.
            let stale = free.iter().take_while(|(_, frame)| *frame < oldest).count();
            let excess = free.len().saturating_sub(POOL_KEEP);
            for (texture, _) in free.drain(..stale.max(excess)) {
                texture.texture.destroy();
            }
            !free.is_empty()
        });
    }

    fn clear(&mut self) {
        for (_, textures) in self.free.drain() {
            for (texture, _) in textures {
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
    /// What effects and transitions left, drawn in the composition.
    outputs: Vec<Pooled>,
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

/// A readback in flight. `wait` resolves with tightly packed RGBA rows, or with
/// an NV12 frame whose rows are `stride` bytes apart.
pub struct Readback {
    device: Device,
    buffer: Buffer,
    /// The frame's size in pixels.
    width: u32,
    height: u32,
    /// Bytes per row in the buffer.
    padded_row: u32,
    /// RGBA readbacks drop the row padding: the bytes a row keeps.
    tight_row: Option<u32>,
    mapped: Rc<Cell<Option<bool>>>,
}

impl Readback {
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    /// Bytes from one row to the next in what `wait` returns.
    pub fn stride(&self) -> u32 {
        self.tight_row.unwrap_or(self.padded_row)
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
        let pixels = match self.tight_row {
            Some(row) => {
                let (row, padded) = (row as usize, self.padded_row as usize);
                let rows = data.len() / padded;
                let mut pixels = Vec::with_capacity(row * rows);
                for y in 0..rows {
                    pixels.extend_from_slice(&data[y * padded..y * padded + row]);
                }
                pixels
            }
            None => data.to_vec(),
        };
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

/// The packed NV12 target of an export frame size.
struct ExportTarget {
    frame: (u32, u32),
    texture: Texture,
    view: TextureView,
}

pub struct Compositor {
    comp_format: TextureFormat,
    webgl: bool,
    align: u64,
    sampler: Sampler,
    texture_layout: BindGroupLayout,
    convert_layout: BindGroupLayout,
    present_layout: BindGroupLayout,
    export_layout: BindGroupLayout,
    effect_layout: BindGroupLayout,
    copy_layout: BindGroupLayout,
    layer_pipeline: RenderPipeline,
    extract_pipeline: RenderPipeline,
    copy_pipeline: RenderPipeline,
    over_pipeline: RenderPipeline,
    mix_pipeline: RenderPipeline,
    /// Each effect's pass pipelines, by `pack/id`, made on first use.
    effect_pipelines: HashMap<String, Vec<RenderPipeline>>,
    /// Bound where an effect reads no image, LUT or second picture: transparent.
    blank: TextureView,
    blank_cube: TextureView,
    blank_textures: [Texture; 2],
    images: HashMap<String, (Texture, TextureView)>,
    luts: HashMap<String, (Texture, TextureView, u32)>,
    nv12_pipeline: RenderPipeline,
    i420_pipeline: RenderPipeline,
    premultiply_pipeline: RenderPipeline,
    blit_pipeline: RenderPipeline,
    present_pipelines: HashMap<TextureFormat, RenderPipeline>,
    /// Made on the first export frame.
    export_pipeline: Option<RenderPipeline>,
    shader: ShaderModule,
    uniforms: Buffer,
    layer_uniforms: BindGroup,
    present_uniforms: Buffer,
    export_uniforms: Buffer,
    pool: TexturePool,
    stills: HashMap<String, Still>,
    comp: Option<CompTarget>,
    export: Option<ExportTarget>,
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
            mipmap_filter: MipmapFilterMode::Linear,
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
        let export_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("Export"),
            entries: &[
                uniform_entry(30, false, EXPORT_UNIFORM_SIZE),
                texture_entry(31),
                sampler_entry(32),
            ],
        });
        // Effect passes: frame and settings uniforms, input, original, sampler,
        // LUT cube and pack image.
        let effect_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("Effect"),
            entries: &[
                uniform_entry(0, true, EFFECT_FRAME_SIZE),
                BindGroupLayoutEntry {
                    binding: 1,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Buffer {
                        ty: BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: None,
                    },
                    count: None,
                },
                texture_entry(2),
                texture_entry(3),
                sampler_entry(4),
                BindGroupLayoutEntry {
                    binding: 5,
                    visibility: ShaderStages::FRAGMENT,
                    ty: BindingType::Texture {
                        sample_type: TextureSampleType::Float { filterable: true },
                        view_dimension: TextureViewDimension::D3,
                        multisampled: false,
                    },
                    count: None,
                },
                texture_entry(6),
            ],
        });
        let copy_layout = device.create_bind_group_layout(&BindGroupLayoutDescriptor {
            label: Some("Copy"),
            entries: &[texture_entry(40), sampler_entry(41)],
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
        let extract_pipeline = Self::pipeline(
            device,
            &shader,
            &[&layer_uniform_layout, &texture_layout],
            ("vs_full", "fs_extract"),
            comp_format,
            None,
            PrimitiveTopology::TriangleList,
        );
        let copy = |blend| {
            Self::pipeline(
                device,
                &shader,
                &[&copy_layout],
                ("vs_full", "fs_copy"),
                comp_format,
                blend,
                PrimitiveTopology::TriangleList,
            )
        };
        // Adjustments mix their result in by a constant: src · k + dst · (1 − k).
        let constant = BlendComponent {
            src_factor: BlendFactor::Constant,
            dst_factor: BlendFactor::OneMinusConstant,
            operation: BlendOperation::Add,
        };
        let blank_texture = |dimension| {
            device.create_texture(&TextureDescriptor {
                label: Some("Blank"),
                size: Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension,
                format: DATA_FORMAT,
                usage: TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
        };
        let blank_textures = [
            blank_texture(TextureDimension::D2),
            blank_texture(TextureDimension::D3),
        ];
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
        let export_uniforms = device.create_buffer(&BufferDescriptor {
            label: Some("Export uniforms"),
            size: EXPORT_UNIFORM_SIZE,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Compositor {
            comp_format,
            webgl: adapter.get_info().backend == Backend::Gl,
            align,
            sampler,
            nv12_pipeline: convert("fs_nv12"),
            i420_pipeline: convert("fs_i420"),
            premultiply_pipeline: convert("fs_premultiply"),
            blit_pipeline: convert("fs_blit"),

            texture_layout,
            convert_layout,
            present_layout,
            export_layout,
            layer_pipeline,
            extract_pipeline,
            copy_pipeline: copy(None),
            over_pipeline: copy(Some(BlendState::PREMULTIPLIED_ALPHA_BLENDING)),
            mix_pipeline: copy(Some(BlendState {
                color: constant,
                alpha: constant,
            })),
            effect_layout,
            copy_layout,
            effect_pipelines: HashMap::new(),
            blank: blank_textures[0].create_view(&TextureViewDescriptor::default()),
            blank_cube: blank_textures[1].create_view(&TextureViewDescriptor::default()),
            blank_textures,
            images: HashMap::new(),
            luts: HashMap::new(),
            present_pipelines: HashMap::new(),
            export_pipeline: None,
            shader,
            uniforms,
            layer_uniforms,
            present_uniforms,
            export_uniforms,
            pool: TexturePool::default(),
            stills: HashMap::new(),
            comp: None,
            export: None,
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
            outputs: Vec::new(),
            uniforms: Vec::new(),
            slots: 0,
        });
    }

    /// Stores `bytes` in the frame's uniforms at the next aligned slots.
    fn slot(frame: &mut FrameBuild, align: u64, bytes: &[u8]) -> Result<u64, String> {
        let needed = (bytes.len() as u64).div_ceil(align).max(1);
        if frame.slots + needed > UNIFORM_SLOTS {
            return Err("The frame has too many layers and effects to draw".into());
        }
        let offset = frame.slots * align;
        frame.uniforms.resize(offset as usize, 0);
        frame.uniforms.extend_from_slice(bytes);
        frame.slots += needed;
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
                // wgpu's WebGL2 backend copies VideoFrames only with unstable
                // web-sys APIs (and panics without them): those take the planes path.
                if self.webgl && matches!(image, ExternalImageSource::VideoFrame(_)) {
                    return Err("WebGL2 draws video frames from their planes".into());
                }
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
        // A full mip chain: stills are often shown far smaller than they are, and
        // sampling them unfiltered would alias (and differ from GPU to GPU).
        let levels = 32 - width.max(height).leading_zeros();
        let texture = device.create_texture(&TextureDescriptor {
            label: Some("Still"),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: levels,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: LAYER_FORMAT,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = texture.create_view(&TextureViewDescriptor::default());
        let level = |mip: u32| {
            texture.create_view(&TextureViewDescriptor {
                base_mip_level: mip,
                mip_level_count: Some(1),
                ..Default::default()
            })
        };
        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("Still upload"),
        });
        // Level 0 is the image premultiplied; each further level halves the one above.
        let mut source = staging.view.clone();
        for mip in 0..levels {
            let target = level(mip);
            let pipeline = if mip == 0 {
                &self.premultiply_pipeline
            } else {
                &self.blit_pipeline
            };
            self.record_pass(device, &mut encoder, &source, &target, pipeline);
            source = target;
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

    /// A full-screen pass from `source` into `target` with a conversion pipeline.
    fn record_pass(
        &self,
        device: &Device,
        encoder: &mut CommandEncoder,
        source: &TextureView,
        target: &TextureView,
        pipeline: &RenderPipeline,
    ) {
        // These passes read plane 0 only, and no uniforms; the layout wants all bound.
        let entries = [
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
                resource: BindingResource::TextureView(source),
            },
            BindGroupEntry {
                binding: 12,
                resource: BindingResource::TextureView(source),
            },
            BindGroupEntry {
                binding: 13,
                resource: BindingResource::TextureView(source),
            },
            BindGroupEntry {
                binding: 14,
                resource: BindingResource::Sampler(&self.sampler),
            },
        ];
        let binding = device.create_bind_group(&BindGroupDescriptor {
            label: Some("Full-screen pass"),
            layout: &self.convert_layout,
            entries: &entries,
        });
        let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
            label: Some("Full-screen pass"),
            color_attachments: &[Some(RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: Operations {
                    load: LoadOp::Clear(Color::TRANSPARENT),
                    store: StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &binding, &[]);
        pass.draw(0..3, 0..1);
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

    /// Draws the frame's `steps`, bottom first, into a composition of `output`
    /// pixels for a project of `project` pixels. Layers name their source slots.
    pub fn compose(
        &mut self,
        device: &Device,
        project: (u32, u32),
        output: (u32, u32),
        steps: &[Step],
    ) -> Result<(), String> {
        let limit = device.limits().max_texture_dimension_2d;
        let output = (output.0.clamp(1, limit), output.1.clamp(1, limit));
        self.ensure_comp(device, output.0, output.1);
        self.project = project;
        let scene = Scene {
            project: (project.0 as f64, project.1 as f64),
            scale: output.0 as f64 / project.0 as f64,
            output,
        };
        let mut frame = self.frame.take().ok_or("No frame is being built")?;
        let result = self.compose_steps(device, &mut frame, &scene, steps);
        self.frame = Some(frame);
        result
    }

    fn compose_steps(
        &mut self,
        device: &Device,
        frame: &mut FrameBuild,
        scene: &Scene,
        steps: &[Step],
    ) -> Result<(), String> {
        // Everything that depends only on the sources is drawn first.
        let mut ops = Vec::new();
        for step in steps {
            match step {
                Step::Layer(layer) => {
                    if let Some(drawable) = self.prepare_layer(device, frame, scene, layer)? {
                        ops.push(Op::Draw(drawable));
                    }
                }
                Step::Transition {
                    from,
                    to,
                    transition,
                    progress,
                } => {
                    let from = match from {
                        Some(side) => self.render_side(device, frame, scene, side)?,
                        None => None,
                    };
                    let to = match to {
                        Some(side) => self.render_side(device, frame, scene, side)?,
                        None => None,
                    };
                    if from.is_none() && to.is_none() {
                        continue;
                    }
                    let blended = self.run_transition(
                        device,
                        frame,
                        scene.output,
                        from,
                        to,
                        transition,
                        *progress,
                    )?;
                    frame.outputs.push(blended);
                    ops.push(Op::Over(frame.outputs.len() - 1));
                }
                Step::Adjustment { effects, opacity } => {
                    if !effects.is_empty() && *opacity > 0.0 {
                        ops.push(Op::Adjust(effects, opacity.min(1.0)));
                    }
                }
            }
        }
        // Then the composition, in passes split where an adjustment layer reads it.
        let mut clear = true;
        let mut rest = &ops[..];
        loop {
            let split = rest
                .iter()
                .position(|op| matches!(op, Op::Adjust(..)))
                .unwrap_or(rest.len());
            self.draw_ops(device, frame, &rest[..split], clear);
            clear = false;
            let Some(Op::Adjust(effects, opacity)) = rest.get(split) else {
                break;
            };
            self.adjust(device, frame, scene.output, effects, *opacity)?;
            rest = &rest[split + 1..];
        }
        Ok(())
    }

    fn target_key(&self, size: (u32, u32)) -> TextureKey {
        TextureKey {
            width: size.0.max(1),
            height: size.1.max(1),
            format: self.comp_format,
        }
    }

    /// The layer-pass binding of a drawable's texture.
    fn binding<'f>(&'f self, frame: &'f FrameBuild, source: Source) -> &'f BindGroup {
        match source {
            Source::Layer(index) => match frame.layers[index].as_ref().expect("source") {
                LayerTexture::Pooled(pooled) => pooled.binding.as_ref().expect("binding"),
                LayerTexture::Still(key) => &self.stills[key].binding,
            },
            Source::Output(index) => frame.outputs[index].binding.as_ref().expect("binding"),
        }
    }

    fn copy_binding(&self, device: &Device, view: &TextureView) -> BindGroup {
        device.create_bind_group(&BindGroupDescriptor {
            label: Some("Copy"),
            layout: &self.copy_layout,
            entries: &[
                BindGroupEntry {
                    binding: 40,
                    resource: BindingResource::TextureView(view),
                },
                BindGroupEntry {
                    binding: 41,
                    resource: BindingResource::Sampler(&self.sampler),
                },
            ],
        })
    }

    /// Readies layer `step` to draw: its uniforms, and its effects run on its
    /// visible part, upright, at the size it is drawn. None when it shows nothing.
    fn prepare_layer(
        &mut self,
        device: &Device,
        frame: &mut FrameBuild,
        scene: &Scene,
        step: &LayerStep,
    ) -> Result<Option<Drawable>, String> {
        let index = step.index;
        if !matches!(frame.layers.get(index), Some(Some(_))) {
            return Ok(None);
        }
        let draw = &step.draw;
        let Some(geometry) = layer_geometry(
            scene.project,
            scene.scale,
            &draw.picture,
            &draw.transform,
            &draw.crop,
        ) else {
            return Ok(None);
        };
        let opacity = draw.opacity.clamp(0.0, 1.0);
        if opacity <= 0.0 {
            return Ok(None);
        }
        if let Some(Some(LayerTexture::Pooled(pooled))) = frame.layers.get_mut(index) {
            if pooled.binding.is_none() {
                pooled.binding = Some(self.texture_binding(device, &pooled.view));
            }
        }
        if step.effects.is_empty() {
            let values = layer_values(&geometry, &geometry.to_texture, opacity);
            let offset = Self::slot(frame, self.align, &values)?;
            return Ok(Some(Drawable {
                source: Source::Layer(index),
                offset: offset as u32,
            }));
        }
        let limit = device.limits().max_texture_dimension_2d;
        let size = effect_size(&geometry, &draw.picture, limit, step.moving);
        let values = layer_values(&geometry, &geometry.to_texture, 1.0);
        let extract = Self::slot(frame, self.align, &values)?;
        let input = self.pool.acquire(device, self.target_key(size));
        {
            let binding = self.binding(frame, Source::Layer(index)).clone();
            let mut pass = begin_pass(&mut frame.encoder, "Effect input", &input.view, true);
            pass.set_pipeline(&self.extract_pipeline);
            pass.set_bind_group(0, &self.layer_uniforms, &[extract as u32]);
            pass.set_bind_group(1, &binding, &[]);
            pass.draw(0..3, 0..1);
        }
        let aspect = size.0 as f64 / size.1 as f64;
        let mut result = self.run_effects(device, frame, input, aspect, &step.effects)?;
        if result.binding.is_none() {
            result.binding = Some(self.texture_binding(device, &result.view));
        }
        let values = layer_values(&geometry, &visible_map(geometry.visible), opacity);
        let offset = Self::slot(frame, self.align, &values)?;
        frame.outputs.push(result);
        Ok(Some(Drawable {
            source: Source::Output(frame.outputs.len() - 1),
            offset: offset as u32,
        }))
    }

    /// Runs `effects` in order, each pass into a fresh texture of the pool;
    /// returns the last one.
    fn run_effects(
        &mut self,
        device: &Device,
        frame: &mut FrameBuild,
        input: Pooled,
        aspect: f64,
        effects: &[EffectRun],
    ) -> Result<Pooled, String> {
        let mut current = input;
        for run in effects {
            let pipelines = self.effect_pipelines(device, run.entry);
            let size = (current.key.width, current.key.height);
            let mut latest: Option<Pooled> = None;
            for (pass, pipeline) in run.entry.definition.passes.iter().zip(&pipelines) {
                let scaled = |side: u32| ((side as f64 * pass.scale).round() as u32).max(1);
                let target = self
                    .pool
                    .acquire(device, self.target_key((scaled(size.0), scaled(size.1))));
                let source = latest.as_ref().unwrap_or(&current);
                let input = (&source.view, (source.key.width, source.key.height));
                self.effect_pass(
                    device,
                    frame,
                    pipeline,
                    &target,
                    input,
                    &current.view,
                    run,
                    aspect,
                    0.0,
                )?;
                // The pass just recorded reads it; later passes may write it again.
                if let Some(old) = latest.replace(target) {
                    self.pool.release(old);
                }
            }
            if let Some(result) = latest {
                let original = std::mem::replace(&mut current, result);
                self.pool.release(original);
            }
        }
        Ok(current)
    }

    /// One pass of an effect or transition into `target`.
    #[allow(clippy::too_many_arguments)]
    fn effect_pass(
        &self,
        device: &Device,
        frame: &mut FrameBuild,
        pipeline: &RenderPipeline,
        target: &Pooled,
        input: (&TextureView, (u32, u32)),
        original: &TextureView,
        run: &EffectRun,
        aspect: f64,
        progress: f64,
    ) -> Result<(), String> {
        let lut = run
            .lut
            .and_then(|lut| self.luts.get(lut.key).map(|(_, view, n)| (lut, view, *n)));
        let (lut_view, lut_min, lut_scale) = match lut {
            Some((lut, view, n)) => {
                let scale = |axis: usize| 1.0 / (lut.max[axis] - lut.min[axis]).max(1e-9);
                (
                    view,
                    [lut.min[0], lut.min[1], lut.min[2], n as f64],
                    [scale(0), scale(1), scale(2), 1.0],
                )
            }
            None => (&self.blank_cube, [0.0, 0.0, 0.0, 2.0], [1.0, 1.0, 1.0, 0.0]),
        };
        let image = run
            .image
            .as_deref()
            .and_then(|key| self.images.get(key))
            .map_or(&self.blank, |(_, view)| view);
        let size = (target.key.width, target.key.height);
        let mut values = vec![
            size.0 as f32,
            size.1 as f32,
            input.1 .0 as f32,
            input.1 .1 as f32,
            run.time as f32,
            progress as f32,
            run.seed as f32,
            aspect as f32,
        ];
        values.extend(lut_min.iter().chain(&lut_scale).map(|&v| v as f32));
        let frame_offset = Self::slot(frame, self.align, &floats(&values))?;
        let params = cgv_effects::pack_params(run.entry, run.params);
        let params_offset = Self::slot(frame, self.align, &params)?;
        let buffer = |size: u64| {
            BindingResource::Buffer(BufferBinding {
                buffer: &self.uniforms,
                offset: 0,
                size: BufferSize::new(size),
            })
        };
        let binding = device.create_bind_group(&BindGroupDescriptor {
            label: Some("Effect pass"),
            layout: &self.effect_layout,
            entries: &[
                BindGroupEntry {
                    binding: 0,
                    resource: buffer(EFFECT_FRAME_SIZE),
                },
                BindGroupEntry {
                    binding: 1,
                    resource: buffer(params.len() as u64),
                },
                BindGroupEntry {
                    binding: 2,
                    resource: BindingResource::TextureView(input.0),
                },
                BindGroupEntry {
                    binding: 3,
                    resource: BindingResource::TextureView(original),
                },
                BindGroupEntry {
                    binding: 4,
                    resource: BindingResource::Sampler(&self.sampler),
                },
                BindGroupEntry {
                    binding: 5,
                    resource: BindingResource::TextureView(lut_view),
                },
                BindGroupEntry {
                    binding: 6,
                    resource: BindingResource::TextureView(image),
                },
            ],
        });
        let mut pass = begin_pass(&mut frame.encoder, "Effect", &target.view, true);
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &binding, &[frame_offset as u32, params_offset as u32]);
        pass.draw(0..3, 0..1);
        Ok(())
    }

    /// The pass pipelines of an effect, compiled on first use.
    fn effect_pipelines(
        &mut self,
        device: &Device,
        entry: &cgv_effects::Entry,
    ) -> Vec<RenderPipeline> {
        let key = format!("{}/{}", entry.pack, entry.definition.id);
        if let Some(pipelines) = self.effect_pipelines.get(&key) {
            return pipelines.clone();
        }
        let module = device.create_shader_module(ShaderModuleDescriptor {
            label: Some(&key),
            source: ShaderSource::Wgsl(cgv_effects::shader_source(entry).into()),
        });
        let pipelines: Vec<RenderPipeline> = (0..entry.definition.passes.len())
            .map(|index| {
                let fragment = format!("cgv_pass_{index}");
                Self::pipeline(
                    device,
                    &module,
                    &[&self.effect_layout],
                    ("cgv_vertex", &fragment),
                    self.comp_format,
                    None,
                    PrimitiveTopology::TriangleList,
                )
            })
            .collect();
        self.effect_pipelines.insert(key, pipelines.clone());
        pipelines
    }

    /// One side of a transition: the layer, with its effects, drawn alone in a
    /// full-frame texture.
    fn render_side(
        &mut self,
        device: &Device,
        frame: &mut FrameBuild,
        scene: &Scene,
        side: &LayerStep,
    ) -> Result<Option<Pooled>, String> {
        let Some(drawable) = self.prepare_layer(device, frame, scene, side)? else {
            return Ok(None);
        };
        let target = self.pool.acquire(device, self.target_key(scene.output));
        let binding = self.binding(frame, drawable.source).clone();
        let mut pass = begin_pass(&mut frame.encoder, "Transition side", &target.view, true);
        pass.set_pipeline(&self.layer_pipeline);
        pass.set_bind_group(0, &self.layer_uniforms, &[drawable.offset]);
        pass.set_bind_group(1, &binding, &[]);
        pass.draw(0..4, 0..1);
        drop(pass);
        Ok(Some(target))
    }

    #[allow(clippy::too_many_arguments)]
    fn run_transition(
        &mut self,
        device: &Device,
        frame: &mut FrameBuild,
        output: (u32, u32),
        from: Option<Pooled>,
        to: Option<Pooled>,
        run: &EffectRun,
        progress: f64,
    ) -> Result<Pooled, String> {
        let pipelines = self.effect_pipelines(device, run.entry);
        let target = self.pool.acquire(device, self.target_key(output));
        let from_view = from.as_ref().map_or(&self.blank, |side| &side.view);
        let to_view = to.as_ref().map_or(&self.blank, |side| &side.view);
        let aspect = output.0 as f64 / output.1 as f64;
        self.effect_pass(
            device,
            frame,
            &pipelines[0],
            &target,
            (from_view, output),
            to_view,
            run,
            aspect,
            progress,
        )?;
        for side in [from, to].into_iter().flatten() {
            self.pool.release(side);
        }
        Ok(target)
    }

    /// Draws `ops` into the composition in one pass, clearing it first if asked.
    fn draw_ops(&self, device: &Device, frame: &mut FrameBuild, ops: &[Op], clear: bool) {
        let bindings: Vec<BindGroup> = ops
            .iter()
            .map(|op| match op {
                Op::Draw(drawable) => self.binding(frame, drawable.source).clone(),
                Op::Over(index) => self.copy_binding(device, &frame.outputs[*index].view),
                Op::Adjust(..) => unreachable!("adjustments split the passes"),
            })
            .collect();
        let comp = self.comp.as_ref().expect("composition target");
        let mut pass = begin_pass(&mut frame.encoder, "Composition", &comp.view, clear);
        for (op, binding) in ops.iter().zip(&bindings) {
            match op {
                Op::Draw(drawable) => {
                    pass.set_pipeline(&self.layer_pipeline);
                    pass.set_bind_group(0, &self.layer_uniforms, &[drawable.offset]);
                    pass.set_bind_group(1, binding, &[]);
                    pass.draw(0..4, 0..1);
                }
                Op::Over(_) => {
                    pass.set_pipeline(&self.over_pipeline);
                    pass.set_bind_group(0, binding, &[]);
                    pass.draw(0..3, 0..1);
                }
                Op::Adjust(..) => {}
            }
        }
    }

    /// An adjustment layer: its effects run on a copy of the composition so far,
    /// and the result is mixed back in by `opacity`.
    fn adjust(
        &mut self,
        device: &Device,
        frame: &mut FrameBuild,
        output: (u32, u32),
        effects: &[EffectRun],
        opacity: f64,
    ) -> Result<(), String> {
        let copy = self.pool.acquire(device, self.target_key(output));
        let comp_binding = self.copy_binding(device, &self.comp.as_ref().expect("target").view);
        {
            let mut pass = begin_pass(&mut frame.encoder, "Adjustment input", &copy.view, true);
            pass.set_pipeline(&self.copy_pipeline);
            pass.set_bind_group(0, &comp_binding, &[]);
            pass.draw(0..3, 0..1);
        }
        let aspect = output.0 as f64 / output.1 as f64;
        let adjusted = self.run_effects(device, frame, copy, aspect, effects)?;
        let binding = self.copy_binding(device, &adjusted.view);
        {
            let comp = self.comp.as_ref().expect("target");
            let mut pass = begin_pass(&mut frame.encoder, "Adjustment", &comp.view, false);
            pass.set_pipeline(&self.mix_pipeline);
            let k = opacity.clamp(0.0, 1.0);
            pass.set_blend_constant(Color {
                r: k,
                g: k,
                b: k,
                a: k,
            });
            pass.set_bind_group(0, &binding, &[]);
            pass.draw(0..3, 0..1);
        }
        frame.outputs.push(adjusted);
        Ok(())
    }

    /// Uploads an image a pack's definitions read (such as a luma-wipe gradient):
    /// RGBA8 rows, top first, as data with no colour conversion. Bytes, not a
    /// bitmap: SwiftShader's WebGPU sometimes fails to copy grey bitmaps.
    pub fn upload_image(
        &mut self,
        device: &Device,
        queue: &Queue,
        key: &str,
        (width, height): (u32, u32),
        pixels: &[u8],
    ) -> Result<(), String> {
        let limit = device.limits().max_texture_dimension_2d;
        if width == 0 || height == 0 || width > limit || height > limit {
            return Err(format!("A {width}×{height} image does not fit on the GPU"));
        }
        if pixels.len() as u64 != width as u64 * height as u64 * 4 {
            return Err(format!(
                "The {width}×{height} image's pixels do not match its size"
            ));
        }
        let texture = device.create_texture(&TextureDescriptor {
            label: Some("Pack image"),
            size: Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D2,
            format: DATA_FORMAT,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            pixels,
            TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: None,
            },
            Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        let view = texture.create_view(&TextureViewDescriptor::default());
        if let Some((old, _)) = self.images.insert(key.to_string(), (texture, view)) {
            old.destroy();
        }
        Ok(())
    }

    pub fn has_image(&self, key: &str) -> bool {
        self.images.contains_key(key)
    }

    /// Uploads a LUT as a cube of `points` per side: RGBA8 texels, red fastest.
    pub fn upload_lut(
        &mut self,
        device: &Device,
        queue: &Queue,
        key: &str,
        points: u32,
        texels: &[u8],
    ) -> Result<(), String> {
        if points < 2 || texels.len() != (points as usize).pow(3) * 4 {
            return Err("The LUT's data does not match its size".into());
        }
        let size = Extent3d {
            width: points,
            height: points,
            depth_or_array_layers: points,
        };
        let texture = device.create_texture(&TextureDescriptor {
            label: Some("LUT"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: TextureDimension::D3,
            format: DATA_FORMAT,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: Origin3d::ZERO,
                aspect: TextureAspect::All,
            },
            texels,
            TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(points * 4),
                rows_per_image: Some(points),
            },
            size,
        );
        let view = texture.create_view(&TextureViewDescriptor::default());
        if let Some((old, _, _)) = self.luts.insert(key.to_string(), (texture, view, points)) {
            old.destroy();
        }
        Ok(())
    }

    pub fn has_lut(&self, key: &str) -> bool {
        self.luts.contains_key(key)
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
            outputs,
            ..
        } = frame;
        queue.submit([encoder.finish()]);
        // Queue order makes the textures safe to reuse in the next frame.
        for texture in layers.into_iter().flatten() {
            if let LayerTexture::Pooled(texture) = texture {
                self.pool.release(texture);
            }
        }
        for texture in planes.into_iter().chain(outputs) {
            self.pool.release(texture);
        }
        self.pool.trim();
        Ok(())
    }

    fn recycle(&mut self, frame: FrameBuild) {
        for texture in frame.layers.into_iter().flatten() {
            if let LayerTexture::Pooled(texture) = texture {
                self.pool.release(texture);
            }
        }
        for texture in frame.planes.into_iter().chain(frame.outputs) {
            self.pool.release(texture);
        }
        self.pool.trim();
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
        Ok(Readback {
            device: device.clone(),
            mapped: map(&buffer),
            buffer,
            width,
            height,
            padded_row,
            tight_row: Some(width * 4),
        })
    }

    /// Reads the last composition back as an NV12 frame of `frame` pixels, BT.709
    /// limited range: the composition centred over black. `frame` must have even sides.
    pub fn start_nv12_readback(
        &mut self,
        device: &Device,
        queue: &Queue,
        frame: (u32, u32),
    ) -> Result<Readback, String> {
        if frame.0 < 2 || frame.1 < 2 || frame.0 % 2 == 1 || frame.1 % 2 == 1 {
            return Err(format!(
                "An export frame of {}×{} needs even sides",
                frame.0, frame.1
            ));
        }
        let (comp_width, comp_height) = self
            .comp
            .as_ref()
            .map(|comp| (comp.width, comp.height))
            .ok_or("Nothing has been composed yet")?;
        let texels = nv12_texels(frame);
        let limit = device.limits().max_texture_dimension_2d;
        if texels.0 > limit || texels.1 > limit {
            return Err(format!(
                "A {}×{} export does not fit on this GPU",
                frame.0, frame.1
            ));
        }
        if self
            .export
            .as_ref()
            .is_none_or(|target| target.frame != frame)
        {
            if let Some(old) = self.export.take() {
                old.texture.destroy();
            }
            let texture = device.create_texture(&TextureDescriptor {
                label: Some("Export frame"),
                size: Extent3d {
                    width: texels.0,
                    height: texels.1,
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
            self.export = Some(ExportTarget {
                frame,
                texture,
                view,
            });
        }
        if self.export_pipeline.is_none() {
            self.export_pipeline = Some(Self::pipeline(
                device,
                &self.shader,
                &[&self.export_layout],
                ("vs_full", "fs_export"),
                READBACK_FORMAT,
                None,
                PrimitiveTopology::TriangleList,
            ));
        }
        let picture = export_picture(frame, (comp_width, comp_height));
        let mut values: Vec<f32> = rgb_to_yuv(Matrix::Bt709, false)
            .iter()
            .flatten()
            .copied()
            .collect();
        values.extend(picture.map(|value| value as f32));
        values.extend([frame.0 as f32, frame.1 as f32, 0.0, 0.0]);
        queue.write_buffer(&self.export_uniforms, 0, &floats(&values));

        let comp = self.comp.as_ref().unwrap();
        let target = self.export.as_ref().unwrap();
        let binding = device.create_bind_group(&BindGroupDescriptor {
            label: Some("Export"),
            layout: &self.export_layout,
            entries: &[
                BindGroupEntry {
                    binding: 30,
                    resource: self.export_uniforms.as_entire_binding(),
                },
                BindGroupEntry {
                    binding: 31,
                    resource: BindingResource::TextureView(&comp.view),
                },
                BindGroupEntry {
                    binding: 32,
                    resource: BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        let padded_row =
            (texels.0 * 4).div_ceil(COPY_BYTES_PER_ROW_ALIGNMENT) * COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer = device.create_buffer(&BufferDescriptor {
            label: Some("Export readback"),
            size: padded_row as u64 * texels.1 as u64,
            usage: BufferUsages::COPY_DST | BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&CommandEncoderDescriptor {
            label: Some("Export frame"),
        });
        {
            let mut pass = encoder.begin_render_pass(&RenderPassDescriptor {
                label: Some("Export frame"),
                color_attachments: &[Some(RenderPassColorAttachment {
                    view: &target.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: Operations {
                        load: LoadOp::Clear(Color::BLACK),
                        store: StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(self.export_pipeline.as_ref().unwrap());
            pass.set_bind_group(0, &binding, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            TexelCopyTextureInfo {
                texture: &target.texture,
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
                width: texels.0,
                height: texels.1,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([encoder.finish()]);
        Ok(Readback {
            device: device.clone(),
            mapped: map(&buffer),
            buffer,
            width: frame.0,
            height: frame.1,
            padded_row,
            tight_row: None,
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
        if let Some(export) = self.export.take() {
            export.texture.destroy();
        }
        for (_, (texture, _)) in self.images.drain() {
            texture.destroy();
        }
        for (_, (texture, _, _)) in self.luts.drain() {
            texture.destroy();
        }
        for texture in &self.blank_textures {
            texture.destroy();
        }
    }
}

/// Starts mapping a readback buffer; the cell says how it went once it has.
fn map(buffer: &Buffer) -> Rc<Cell<Option<bool>>> {
    let mapped = Rc::new(Cell::new(None));
    let done = mapped.clone();
    buffer
        .slice(..)
        .map_async(MapMode::Read, move |result| done.set(Some(result.is_ok())));
    mapped
}

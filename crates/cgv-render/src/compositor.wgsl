// The compositor. Every texture a layer samples holds linear, premultiplied
// colour (sRGB-encoded storage decodes to linear when sampled). Layers draw
// bottom first into the composition target with premultiplied "over" blending,
// and the present pass shows the result over black.

// ---- Layers ----

struct Layer {
    // Upright (u, v) to clip space: a, b, c, d, then tx, ty.
    clip0: vec4<f32>,
    // tx, ty, opacity, unused.
    clip1: vec4<f32>,
    // Upright (u, v) to texture coordinates: a, b, c, d.
    tex0: vec4<f32>,
    // tx, ty, unused, unused.
    tex1: vec4<f32>,
    // The visible part of the picture: u0, v0, u1, v1.
    visible: vec4<f32>,
    // The drawn quad, about a pixel larger than the visible part.
    quad: vec4<f32>,
}

@group(0) @binding(0) var<uniform> layer: Layer;
@group(1) @binding(0) var layer_texture: texture_2d<f32>;
@group(1) @binding(1) var layer_sampler: sampler;

struct LayerOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

fn affine(row0: vec4<f32>, row1: vec4<f32>, p: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(
        row0.x * p.x + row0.z * p.y + row1.x,
        row0.y * p.x + row0.w * p.y + row1.y,
    );
}

// Four vertices as a triangle strip: (0, 0), (1, 0), (0, 1), (1, 1).
@vertex
fn vs_layer(@builtin(vertex_index) index: u32) -> LayerOut {
    let corner = vec2<f32>(f32(index & 1u), f32(index >> 1u));
    let uv = mix(layer.quad.xy, layer.quad.zw, corner);
    var out: LayerOut;
    out.position = vec4<f32>(affine(layer.clip0, layer.clip1, uv), 0.0, 1.0);
    out.uv = uv;
    return out;
}

@fragment
fn fs_layer(in: LayerOut) -> @location(0) vec4<f32> {
    let st = affine(layer.tex0, layer.tex1, in.uv);
    let color = textureSample(layer_texture, layer_sampler, st);
    // Distance to the visible edges in output pixels gives smooth, rotation-proof edges.
    let per_u = max(length(vec2<f32>(dpdx(in.uv.x), dpdy(in.uv.x))), 1e-7);
    let per_v = max(length(vec2<f32>(dpdx(in.uv.y), dpdy(in.uv.y))), 1e-7);
    let du = min(in.uv.x - layer.visible.x, layer.visible.z - in.uv.x) / per_u;
    let dv = min(in.uv.y - layer.visible.y, layer.visible.w - in.uv.y) / per_v;
    let coverage = clamp(du + 0.5, 0.0, 1.0) * clamp(dv + 0.5, 0.0, 1.0);
    return color * (coverage * layer.clip1.z);
}

// ---- Full-screen passes ----

struct FullOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

// One triangle covering the target; uv (0, 0) is the top left.
@vertex
fn vs_full(@builtin(vertex_index) index: u32) -> FullOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: FullOut;
    out.position = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    out.uv = uv;
    return out;
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let low = c / 12.92;
    let high = pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(high, low, c <= vec3<f32>(0.04045));
}

fn linear_to_srgb(value: vec3<f32>) -> vec3<f32> {
    let c = clamp(value, vec3<f32>(0.0), vec3<f32>(1.0));
    let low = c * 12.92;
    let high = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(high, low, c <= vec3<f32>(0.0031308));
}

// ---- Frame conversion: Y'CbCr planes to linear RGB ----

struct Convert {
    // Rows of the matrix from (Y, Cb, Cr, 1) to R'G'B'.
    r: vec4<f32>,
    g: vec4<f32>,
    b: vec4<f32>,
    // x: transfer (0 SDR, 1 PQ, 2 HLG); y: 1 for BT.2020 primaries.
    mode: vec4<f32>,
}

@group(0) @binding(10) var<uniform> convert: Convert;
@group(0) @binding(11) var plane0: texture_2d<f32>;
@group(0) @binding(12) var plane1: texture_2d<f32>;
@group(0) @binding(13) var plane2: texture_2d<f32>;
@group(0) @binding(14) var plane_sampler: sampler;

const REFERENCE_WHITE_NITS: f32 = 203.0;

fn pq_to_nits(e: vec3<f32>) -> vec3<f32> {
    let m1 = 2610.0 / 16384.0;
    let m2 = 2523.0 / 4096.0 * 128.0;
    let c1 = 3424.0 / 4096.0;
    let c2 = 2413.0 / 4096.0 * 32.0;
    let c3 = 2392.0 / 4096.0 * 32.0;
    let p = pow(clamp(e, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / m2));
    let ratio = max(p - vec3<f32>(c1), vec3<f32>(0.0)) / (vec3<f32>(c2) - c3 * p);
    return 10000.0 * pow(ratio, vec3<f32>(1.0 / m1));
}

fn hlg_to_nits(e: vec3<f32>) -> vec3<f32> {
    let a = 0.17883277;
    let b = 0.28466892;
    let c = 0.55991073;
    let v = clamp(e, vec3<f32>(0.0), vec3<f32>(1.0));
    let low = v * v / 3.0;
    let high = (exp((v - vec3<f32>(c)) / a) + vec3<f32>(b)) / 12.0;
    let scene = select(high, low, v <= vec3<f32>(0.5));
    // A 1,000-nit display with system gamma 1.2.
    return 1000.0 * pow(scene, vec3<f32>(1.2));
}

fn tone_map(x: vec3<f32>) -> vec3<f32> {
    let over = max(x - vec3<f32>(0.5), vec3<f32>(0.0));
    let shoulder = vec3<f32>(0.5) + 0.5 * over / (over + vec3<f32>(0.5));
    return select(shoulder, x, x <= vec3<f32>(0.5));
}

fn to_linear(rgb: vec3<f32>) -> vec3<f32> {
    if (convert.mode.x < 0.5) {
        return srgb_to_linear(rgb);
    }
    var light: vec3<f32>;
    if (convert.mode.x < 1.5) {
        light = pq_to_nits(rgb) / REFERENCE_WHITE_NITS;
    } else {
        light = hlg_to_nits(rgb) / REFERENCE_WHITE_NITS;
    }
    if (convert.mode.y > 0.5) {
        light = vec3<f32>(
            dot(vec3<f32>(1.660491, -0.587641, -0.072850), light),
            dot(vec3<f32>(-0.124550, 1.132900, -0.008349), light),
            dot(vec3<f32>(-0.018151, -0.100579, 1.118730), light),
        );
    }
    return tone_map(max(light, vec3<f32>(0.0)));
}

fn decode_ycc(y: f32, cb: f32, cr: f32) -> vec4<f32> {
    let p = vec4<f32>(y, cb, cr, 1.0);
    let rgb = vec3<f32>(dot(convert.r, p), dot(convert.g, p), dot(convert.b, p));
    return vec4<f32>(to_linear(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0))), 1.0);
}

// NV12: luma in plane0, interleaved Cb and Cr in plane1.
@fragment
fn fs_nv12(in: FullOut) -> @location(0) vec4<f32> {
    let y = textureSample(plane0, plane_sampler, in.uv).r;
    let c = textureSample(plane1, plane_sampler, in.uv).rg;
    return decode_ycc(y, c.x, c.y);
}

// I420: luma, Cb and Cr in three planes.
@fragment
fn fs_i420(in: FullOut) -> @location(0) vec4<f32> {
    let y = textureSample(plane0, plane_sampler, in.uv).r;
    let cb = textureSample(plane1, plane_sampler, in.uv).r;
    let cr = textureSample(plane2, plane_sampler, in.uv).r;
    return decode_ycc(y, cb, cr);
}

// Straight-alpha RGBA (stored sRGB-encoded, so sampled linear) to premultiplied.
@fragment
fn fs_premultiply(in: FullOut) -> @location(0) vec4<f32> {
    let c = textureSample(plane0, plane_sampler, in.uv);
    return vec4<f32>(c.rgb * c.a, c.a);
}

// One mip level from the level above. With sRGB storage the GPU averages in linear light.
@fragment
fn fs_blit(in: FullOut) -> @location(0) vec4<f32> {
    return textureSample(plane0, plane_sampler, in.uv);
}

// ---- Present: the composition over black, sRGB-encoded when the target is not ----

struct Present {
    // x: 1 when the shader must apply the sRGB curve itself.
    mode: vec4<f32>,
}

@group(0) @binding(20) var<uniform> present: Present;
@group(0) @binding(21) var comp_texture: texture_2d<f32>;
@group(0) @binding(22) var comp_sampler: sampler;

@fragment
fn fs_present(in: FullOut) -> @location(0) vec4<f32> {
    let c = textureSample(comp_texture, comp_sampler, in.uv);
    var rgb = c.rgb;
    if (present.mode.x > 0.5) {
        rgb = linear_to_srgb(rgb);
    }
    return vec4<f32>(rgb, 1.0);
}

// ---- Export: the composition over black as Y'CbCr 4:2:0 (NV12) ----
// The target packs four bytes a texel: the luma rows, then the chroma rows with
// two Cb, Cr pairs a texel. Read back, its bytes are an NV12 frame.

struct Export {
    // Rows of the matrix from (R', G', B', 1) to Y, Cb and Cr code values (0 to 1).
    y: vec4<f32>,
    cb: vec4<f32>,
    cr: vec4<f32>,
    // The composition in frame pixels: x, y, width, height.
    picture: vec4<f32>,
    // x, y: the frame's size in pixels.
    size: vec4<f32>,
}

@group(0) @binding(30) var<uniform> export_info: Export;
@group(0) @binding(31) var export_texture: texture_2d<f32>;
@group(0) @binding(32) var export_sampler: sampler;

// R'G'B' (sRGB-encoded, as the preview shows it) at frame pixel centre `p`;
// black outside the composition.
fn export_rgb(p: vec2<f32>) -> vec4<f32> {
    let uv = (p - export_info.picture.xy) / export_info.picture.zw;
    let inside = all(uv >= vec2<f32>(0.0)) && all(uv < vec2<f32>(1.0));
    let c = textureSampleLevel(export_texture, export_sampler, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0);
    return vec4<f32>(select(vec3<f32>(0.0), linear_to_srgb(c.rgb), inside), 1.0);
}

// Cb and Cr of chroma sample `c`: the mean of its 2×2 block of pixels.
fn export_chroma(c: vec2<f32>) -> vec2<f32> {
    let p = c * 2.0 + vec2<f32>(0.5);
    let rgb = (export_rgb(p) + export_rgb(p + vec2<f32>(1.0, 0.0)) + export_rgb(p + vec2<f32>(0.0, 1.0))
        + export_rgb(p + vec2<f32>(1.0, 1.0))) * 0.25;
    return vec2<f32>(dot(export_info.cb, rgb), dot(export_info.cr, rgb));
}

@fragment
fn fs_export(in: FullOut) -> @location(0) vec4<f32> {
    let texel = floor(in.position.xy);
    if (texel.y < export_info.size.y) {
        let p = vec2<f32>(texel.x * 4.0 + 0.5, texel.y + 0.5);
        return vec4<f32>(
            dot(export_info.y, export_rgb(p)),
            dot(export_info.y, export_rgb(p + vec2<f32>(1.0, 0.0))),
            dot(export_info.y, export_rgb(p + vec2<f32>(2.0, 0.0))),
            dot(export_info.y, export_rgb(p + vec2<f32>(3.0, 0.0))),
        );
    }
    let row = texel.y - export_info.size.y;
    return vec4<f32>(
        export_chroma(vec2<f32>(texel.x * 2.0, row)),
        export_chroma(vec2<f32>(texel.x * 2.0 + 1.0, row)),
    );
}

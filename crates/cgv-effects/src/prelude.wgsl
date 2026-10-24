// ---- The effect prelude: around every effect and transition shader ----
//
// Textures hold linear, premultiplied colour. `read_input` and friends hand the
// shader colour in its declared space ("linear": linear and premultiplied;
// "srgb": sRGB-encoded with straight alpha), and the pass stores what it returns
// from that space.

struct Frame {
    // This pass's target and its input, in pixels.
    size: vec2<f32>,
    input_size: vec2<f32>,
    // Seconds since the clip's start.
    time: f32,
    // A transition's progress, from 0 to 1.
    progress: f32,
    // A number from 0 to 1 that differs from clip to clip.
    seed: f32,
    // Width over height of the picture.
    aspect: f32,
    // The LUT's input range: xyz the minimum and w the points per side; xyz
    // 1 / (maximum - minimum) and w 1 when a LUT is bound.
    lut_min: vec4<f32>,
    lut_scale: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(2) var input_texture: texture_2d<f32>;
@group(0) @binding(3) var original_texture: texture_2d<f32>;
@group(0) @binding(4) var tex_sampler: sampler;
@group(0) @binding(5) var lut_texture: texture_3d<f32>;
@group(0) @binding(6) var image_texture: texture_2d<f32>;

const PI: f32 = 3.141592653589793;

struct FullOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

// One triangle covering the target; uv (0, 0) is the top left.
@vertex
fn cgv_vertex(@builtin(vertex_index) index: u32) -> FullOut {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: FullOut;
    out.position = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
    out.uv = uv;
    return out;
}

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let v = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    let low = v / 12.92;
    let high = pow((v + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4));
    return select(high, low, v <= vec3<f32>(0.04045));
}

fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let v = clamp(c, vec3<f32>(0.0), vec3<f32>(1.0));
    let low = v * 12.92;
    let high = 1.055 * pow(v, vec3<f32>(1.0 / 2.4)) - vec3<f32>(0.055);
    return select(high, low, v <= vec3<f32>(0.0031308));
}

// Rec. 709 luma of R'G'B' (or luminance of linear RGB).
fn luma(rgb: vec3<f32>) -> f32 {
    return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// A repeatable random number from 0 to 1 for a point.
fn hash(p: vec2<f32>) -> f32 {
    let q = fract(p * vec2<f32>(0.1031, 0.1030));
    let r = q + dot(q, q.yx + vec2<f32>(33.33));
    return fract((r.x + r.y) * r.x);
}

// Smooth value noise from 0 to 1.
fn value_noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (vec2<f32>(3.0) - 2.0 * f);
    let a = hash(i);
    let b = hash(i + vec2<f32>(1.0, 0.0));
    let c = hash(i + vec2<f32>(0.0, 1.0));
    let d = hash(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn rgb_to_hsv(c: vec3<f32>) -> vec3<f32> {
    let k = vec4<f32>(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    let p = select(vec4<f32>(c.gb, k.xy), vec4<f32>(c.bg, k.wz), c.g < c.b);
    let q = select(vec4<f32>(p.xyw, c.r), vec4<f32>(c.r, p.yzx), p.x < c.r);
    let d = q.x - min(q.w, q.y);
    let e = 1.0e-10;
    return vec3<f32>(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

fn hsv_to_rgb(c: vec3<f32>) -> vec3<f32> {
    let p = abs(fract(vec3<f32>(c.x) + vec3<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - vec3<f32>(3.0));
    return c.z * mix(vec3<f32>(1.0), clamp(p - vec3<f32>(1.0), vec3<f32>(0.0), vec3<f32>(1.0)), c.y);
}

// Linear, premultiplied storage to sRGB-encoded, straight-alpha colour.
fn cgv_to_srgb(c: vec4<f32>) -> vec4<f32> {
    if (c.a <= 0.0) {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(linear_to_srgb(c.rgb / c.a), c.a);
}

fn cgv_from_srgb(c: vec4<f32>) -> vec4<f32> {
    let a = clamp(c.a, 0.0, 1.0);
    return vec4<f32>(srgb_to_linear(c.rgb) * a, a);
}

// The previous pass (or the effect's input); for a transition, the outgoing picture.
fn read_input(uv: vec2<f32>) -> vec4<f32> {
    return cgv_load(textureSampleLevel(input_texture, tex_sampler, uv, 0.0));
}

// The effect's input, whatever pass this is; for a transition, the incoming picture.
fn read_original(uv: vec2<f32>) -> vec4<f32> {
    return cgv_load(textureSampleLevel(original_texture, tex_sampler, uv, 0.0));
}

fn read_from(uv: vec2<f32>) -> vec4<f32> {
    return read_input(uv);
}

fn read_to(uv: vec2<f32>) -> vec4<f32> {
    return read_original(uv);
}

// The definition's image (such as a luma-wipe gradient), as stored.
fn read_image(uv: vec2<f32>) -> vec4<f32> {
    return textureSampleLevel(image_texture, tex_sampler, uv, 0.0);
}

// Maps sRGB-encoded colour through the bound LUT; unchanged without one.
fn apply_lut(rgb: vec3<f32>) -> vec3<f32> {
    if (frame.lut_scale.w < 0.5) {
        return rgb;
    }
    let n = frame.lut_min.w;
    let x = clamp((rgb - frame.lut_min.xyz) * frame.lut_scale.xyz, vec3<f32>(0.0), vec3<f32>(1.0));
    let uvw = x * ((n - 1.0) / n) + vec3<f32>(0.5 / n);
    return textureSampleLevel(lut_texture, tex_sampler, uvw, 0.0).rgb;
}

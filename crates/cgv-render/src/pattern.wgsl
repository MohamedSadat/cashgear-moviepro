// Phase 0 test pattern: eight color bars above a strip with a moving white band.
// Keep the constants in sync with pattern.rs.
const BARS_HEIGHT: f32 = 0.7;
const SWEEP_PERIOD: f32 = 2.0;
const SWEEP_WIDTH: f32 = 0.0625;

struct Uniforms {
    resolution: vec2<f32>,
    seconds: f32,
    padding: f32,
}
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let positions = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
    );
    return vec4<f32>(positions[index], 0.0, 1.0);
}

fn bar_color(index: u32) -> vec3<f32> {
    switch index {
        case 0u: { return vec3<f32>(1.0, 1.0, 1.0); }
        case 1u: { return vec3<f32>(1.0, 1.0, 0.0); }
        case 2u: { return vec3<f32>(0.0, 1.0, 1.0); }
        case 3u: { return vec3<f32>(0.0, 1.0, 0.0); }
        case 4u: { return vec3<f32>(1.0, 0.0, 1.0); }
        case 5u: { return vec3<f32>(1.0, 0.0, 0.0); }
        case 6u: { return vec3<f32>(0.0, 0.0, 1.0); }
        default: { return vec3<f32>(0.0, 0.0, 0.0); }
    }
}

@fragment
fn fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = position.xy / uniforms.resolution;
    if uv.y < BARS_HEIGHT {
        return vec4<f32>(bar_color(min(u32(uv.x * 8.0), 7u)), 1.0);
    }
    let center = fract(uniforms.seconds / SWEEP_PERIOD);
    // Distance on a ring, so the band wraps cleanly from the right edge to the left.
    let offset = abs(uv.x - center);
    let distance = min(offset, 1.0 - offset);
    if distance < SWEEP_WIDTH * 0.5 {
        return vec4<f32>(1.0, 1.0, 1.0, 1.0);
    }
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}

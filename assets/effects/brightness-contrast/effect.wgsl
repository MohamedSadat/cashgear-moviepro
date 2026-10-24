// Brightness lifts or lowers every level; contrast stretches levels around mid grey.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let rgb = (c.rgb - vec3<f32>(0.5)) * (1.0 + params.contrast) + vec3<f32>(0.5 + 0.5 * params.brightness);
    return vec4<f32>(rgb, c.a);
}

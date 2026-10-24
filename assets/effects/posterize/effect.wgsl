// A few flat levels per channel.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let steps = round(params.levels) - 1.0;
    let rgb = round(clamp(c.rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * steps) / steps;
    return vec4<f32>(rgb, c.a);
}

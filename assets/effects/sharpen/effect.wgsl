// Unsharp mask: the picture plus its difference from a small blur.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let r = vec2<f32>(max(params.radius * frame.input_size.y, 0.5)) / frame.input_size;
    let near = read_input(uv + vec2<f32>(r.x, 0.0)) + read_input(uv - vec2<f32>(r.x, 0.0))
        + read_input(uv + vec2<f32>(0.0, r.y)) + read_input(uv - vec2<f32>(0.0, r.y));
    let rgb = c.rgb + (c.rgb - near.rgb * 0.25) * params.amount;
    return vec4<f32>(rgb, c.a);
}

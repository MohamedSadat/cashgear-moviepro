// Maps brightness onto a ramp from the shadow colour to the highlight colour.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let t = clamp(luma(c.rgb), 0.0, 1.0);
    let toned = mix(params.shadows.rgb, params.highlights.rgb, t);
    return vec4<f32>(mix(c.rgb, toned, params.amount), c.a);
}

// Saturation moves every colour from its grey; vibrance moves muted colours most.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    var rgb = mix(vec3<f32>(luma(c.rgb)), c.rgb, params.saturation);
    let spread = max(rgb.r, max(rgb.g, rgb.b)) - min(rgb.r, min(rgb.g, rgb.b));
    let vibrance = params.vibrance * (1.0 - clamp(spread, 0.0, 1.0));
    rgb = mix(vec3<f32>(luma(rgb)), rgb, 1.0 + vibrance);
    return vec4<f32>(rgb, c.a);
}

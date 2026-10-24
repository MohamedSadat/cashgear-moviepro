// Fades to a colour by the middle, then from it.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let color = vec4<f32>(params.color.rgb * params.color.a, params.color.a);
    let p = frame.progress;
    if (p < 0.5) {
        return mix(read_from(uv), color, p * 2.0);
    }
    return mix(color, read_to(uv), p * 2.0 - 1.0);
}

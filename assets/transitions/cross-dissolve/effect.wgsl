fn render(uv: vec2<f32>) -> vec4<f32> {
    return mix(read_from(uv), read_to(uv), frame.progress);
}

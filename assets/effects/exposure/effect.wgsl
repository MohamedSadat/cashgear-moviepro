// Exposure scales linear light: one stop doubles it.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    return vec4<f32>(c.rgb * exp2(params.stops), c.a);
}

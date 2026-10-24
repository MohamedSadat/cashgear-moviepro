// Red and blue drift apart towards the edges, like a cheap lens.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let offset = (uv - vec2<f32>(0.5)) * params.amount * 2.0;
    let r = read_input(uv + offset);
    let g = read_input(uv);
    let b = read_input(uv - offset);
    return vec4<f32>(r.r, g.g, b.b, max(g.a, max(r.a, b.a)));
}

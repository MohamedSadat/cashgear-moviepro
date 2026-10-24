// The next picture appears where a greyscale pattern is darker than the progress:
// black parts first, white parts last.
fn render(uv: vec2<f32>) -> vec4<f32> {
    var level = read_image(uv).r;
    if (params.invert > 0.5) {
        level = 1.0 - level;
    }
    let s = max(params.softness, 0.0001);
    let edge = frame.progress * (1.0 + s);
    let shown = 1.0 - smoothstep(edge - s, edge, level);
    return mix(read_from(uv), read_to(uv), shown);
}

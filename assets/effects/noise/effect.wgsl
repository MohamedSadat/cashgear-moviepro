// Film grain: random levels per grain, a new pattern every frame when animated.
// The grain size is in pixels of a 1080-line picture, so it looks the same at any size.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let grain = max(params.size * frame.input_size.y / 1080.0, 0.5);
    let cell = floor(uv * frame.input_size / grain);
    var t = frame.seed * 101.0;
    if (params.animated > 0.5) {
        t = t + floor(frame.time * 24.0) * 7.31;
    }
    let n = hash(cell + vec2<f32>(t, t * 1.7)) - 0.5;
    var noise = vec3<f32>(n);
    if (params.colored > 0.5) {
        noise = vec3<f32>(
            n,
            hash(cell + vec2<f32>(t * 2.3, 51.0)) - 0.5,
            hash(cell + vec2<f32>(t * 3.1, 97.0)) - 0.5,
        );
    }
    return vec4<f32>(c.rgb + noise * params.amount, c.a);
}

// Film grain: random levels per grain, a new pattern every frame when animated.
// The grain size is in pixels of a 1080-line picture, so it looks the same at any size.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let cell = cell_of(uv, params.size * frame.input_size.y / 1080.0);
    var t = seed_step();
    if (params.animated > 0.5) {
        t = t + time_step(24.0) * 131.0;
    }
    let n = hash(cell + vec2<f32>(t, t * 3.0)) - 0.5;
    var noise = vec3<f32>(n);
    if (params.colored > 0.5) {
        noise = vec3<f32>(
            n,
            hash(cell + vec2<f32>(t * 5.0 + 17.0, t * 7.0 + 29.0)) - 0.5,
            hash(cell + vec2<f32>(t * 11.0 + 41.0, t * 13.0 + 53.0)) - 0.5,
        );
    }
    return vec4<f32>(c.rgb + noise * params.amount, c.a);
}

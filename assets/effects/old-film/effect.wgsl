// Sepia, grain, flicker, scratches and a vignette, changing 18 times a second.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let t = time_step(18.0) + seed_step();
    let toned = vec3<f32>(luma(c.rgb)) * vec3<f32>(1.07, 0.88, 0.62);
    var rgb = mix(c.rgb, toned, params.sepia);
    rgb = rgb * (1.0 + (hash(vec2<f32>(t, 1.0)) - 0.5) * 0.35 * params.flicker);
    let cell = cell_of(uv, 1.5 * frame.input_size.y / 1080.0);
    rgb = rgb + vec3<f32>(hash(cell + vec2<f32>(t * 13.0, t * 7.0 + 3.0)) - 0.5) * 0.25 * params.grain;
    for (var i = 0.0; i < 3.0; i = i + 1.0) {
        let x = hash(vec2<f32>(t, i + 10.0));
        let on = step(1.0 - params.scratches * 0.7, hash(vec2<f32>(t, i + 20.0)));
        let line = 1.0 - smoothstep(0.0, 0.0015, abs(uv.x - x));
        rgb = mix(rgb, vec3<f32>(0.92), on * line * 0.6);
    }
    let d = length(uv - vec2<f32>(0.5)) * 1.41421356;
    rgb = rgb * (1.0 - params.vignette * smoothstep(0.4, 1.0, d));
    return vec4<f32>(rgb, c.a);
}

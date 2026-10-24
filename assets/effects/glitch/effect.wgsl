// Bands jump sideways, the channels split and scanlines show, a few times a second.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let a = params.amount;
    let t = floor(frame.time * params.speed) + floor(frame.seed * 997.0);
    let band = floor(uv.y * 24.0);
    var shift = 0.0;
    if (hash(vec2<f32>(band, t)) > 1.0 - a * 0.5) {
        shift = (hash(vec2<f32>(band + 7.0, t)) - 0.5) * 0.2 * a;
    }
    let p = vec2<f32>(uv.x + shift, uv.y);
    let split = a * 0.015 * (hash(vec2<f32>(t, 3.0)) - 0.5);
    let r = read_input(p + vec2<f32>(split, 0.0));
    let g = read_input(p);
    let b = read_input(p - vec2<f32>(split, 0.0));
    let lines = 0.5 + 0.5 * sin(uv.y * frame.input_size.y * PI);
    let rgb = vec3<f32>(r.r, g.g, b.b) * (1.0 - a * 0.15 * lines);
    return vec4<f32>(rgb, max(g.a, max(r.a, b.a)));
}

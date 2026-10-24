// The picture spins a full turn, shrinking towards the middle, and the next one
// takes its place as it grows back.
fn turned(uv: vec2<f32>, angle: f32, scale: f32) -> vec2<f32> {
    let aspect = frame.size.x / frame.size.y;
    var p = (uv - vec2<f32>(0.5)) * vec2<f32>(aspect, 1.0);
    let c = cos(angle);
    let s = sin(angle);
    p = vec2<f32>(c * p.x + s * p.y, -s * p.x + c * p.y) / scale;
    return p / vec2<f32>(aspect, 1.0) + vec2<f32>(0.5);
}

// A picture shown at `scale`, transparent outside it, with smooth edges.
fn read_clipped(p: vec2<f32>, incoming: bool, scale: f32) -> vec4<f32> {
    let shown = coverage(p, frame.size * scale);
    if (shown <= 0.0) {
        return vec4<f32>(0.0);
    }
    let q = clamp(p, vec2<f32>(0.0), vec2<f32>(1.0));
    if (incoming) {
        return read_to(q) * shown;
    }
    return read_from(q) * shown;
}

fn render(uv: vec2<f32>) -> vec4<f32> {
    let t = frame.progress;
    let e = t * t * (3.0 - 2.0 * t);
    var turn = 1.0;
    if (params.direction == DIRECTION_COUNTERCLOCKWISE) {
        turn = -1.0;
    }
    let angle = e * 2.0 * PI * turn;
    let scale = 1.0 - 0.7 * sin(t * PI);
    let p = turned(uv, angle, scale);
    let mixing = smoothstep(0.45, 0.55, t);
    return mix(read_clipped(p, false, scale), read_clipped(p, true, scale), mixing);
}

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

fn read_clipped(p: vec2<f32>, incoming: bool) -> vec4<f32> {
    if (any(p < vec2<f32>(0.0)) || any(p > vec2<f32>(1.0))) {
        return vec4<f32>(0.0);
    }
    if (incoming) {
        return read_to(p);
    }
    return read_from(p);
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
    return mix(read_clipped(p, false), read_clipped(p, true), mixing);
}

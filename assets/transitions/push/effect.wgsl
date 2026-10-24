fn travel() -> vec2<f32> {
    if (params.direction == DIRECTION_LEFT) {
        return vec2<f32>(-1.0, 0.0);
    }
    if (params.direction == DIRECTION_UP) {
        return vec2<f32>(0.0, -1.0);
    }
    if (params.direction == DIRECTION_DOWN) {
        return vec2<f32>(0.0, 1.0);
    }
    return vec2<f32>(1.0, 0.0);
}

fn inside(p: vec2<f32>) -> bool {
    return all(p >= vec2<f32>(0.0)) && all(p <= vec2<f32>(1.0));
}

fn ease(t: f32) -> f32 {
    return t * t * (3.0 - 2.0 * t);
}

// The next picture pushes the current one out of the frame.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let p = ease(frame.progress);
    let d = travel();
    let incoming = uv + d * (1.0 - p);
    let outgoing = uv - d * p;
    if (inside(incoming)) {
        return read_to(incoming);
    }
    if (inside(outgoing)) {
        return read_from(outgoing);
    }
    return vec4<f32>(0.0);
}

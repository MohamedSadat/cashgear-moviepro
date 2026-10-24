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

// The next picture slides in over the current one.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let p = ease(frame.progress);
    let q = uv + travel() * (1.0 - p);
    let below = read_from(uv);
    if (inside(q)) {
        let above = read_to(q);
        return above + below * (1.0 - above.a);
    }
    return below;
}

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

// An edge travels across the picture, revealing the next one behind it.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let d = travel();
    // How far along the travel direction this point is, from 0 to 1.
    let x = dot(uv - vec2<f32>(0.5), d) + 0.5;
    let s = max(params.softness, 0.0001);
    let edge = frame.progress * (1.0 + s);
    let shown = 1.0 - smoothstep(edge - s, edge, x);
    return mix(read_from(uv), read_to(uv), shown);
}

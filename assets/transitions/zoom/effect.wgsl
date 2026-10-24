fn ease(t: f32) -> f32 {
    return t * t * (3.0 - 2.0 * t);
}

// Reads a picture scaled about the centre by `scale`; transparent outside it.
fn scaled(uv: vec2<f32>, scale: f32, incoming: bool) -> vec4<f32> {
    let p = vec2<f32>(0.5) + (uv - vec2<f32>(0.5)) / scale;
    if (any(p < vec2<f32>(0.0)) || any(p > vec2<f32>(1.0))) {
        return vec4<f32>(0.0);
    }
    if (incoming) {
        return read_to(p);
    }
    return read_from(p);
}

// Zooming in: this picture grows past the frame as the next grows into it.
// Zooming out: this picture shrinks away as the next shrinks into place.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let e = ease(frame.progress);
    var from_scale = mix(1.0, 3.0, e);
    var to_scale = mix(0.35, 1.0, e);
    if (params.mode == MODE_OUT) {
        from_scale = mix(1.0, 0.35, e);
        to_scale = mix(3.0, 1.0, e);
    }
    return mix(scaled(uv, from_scale, false), scaled(uv, to_scale, true), e);
}

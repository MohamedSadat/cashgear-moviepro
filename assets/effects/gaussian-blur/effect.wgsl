// A separable Gaussian: a horizontal pass, then a vertical one. The radius is a
// fraction of the picture's height (about three standard deviations).
fn blur(uv: vec2<f32>, axis: vec2<f32>) -> vec4<f32> {
    let sigma = params.radius * frame.input_size.y / 3.0;
    if (sigma < 0.25) {
        return read_input(uv);
    }
    let taps = min(ceil(sigma * 3.0), 48.0);
    let stride = max(1.0, sigma * 3.0 / 48.0);
    let texel = axis / frame.input_size;
    var sum = read_input(uv);
    var weight = 1.0;
    for (var i = 1.0; i <= taps; i = i + 1.0) {
        let x = i * stride;
        let w = exp(-0.5 * x * x / (sigma * sigma));
        sum = sum + (read_input(uv + texel * x) + read_input(uv - texel * x)) * w;
        weight = weight + 2.0 * w;
    }
    return sum / weight;
}

fn blur_horizontal(uv: vec2<f32>) -> vec4<f32> {
    if (params.direction == DIRECTION_VERTICAL) {
        return read_input(uv);
    }
    return blur(uv, vec2<f32>(1.0, 0.0));
}

fn blur_vertical(uv: vec2<f32>) -> vec4<f32> {
    if (params.direction == DIRECTION_HORIZONTAL) {
        return read_input(uv);
    }
    return blur(uv, vec2<f32>(0.0, 1.0));
}

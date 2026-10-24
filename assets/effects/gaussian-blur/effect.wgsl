// A separable Gaussian: a horizontal pass, then a vertical one. The radius is a
// fraction of the picture's height (about three standard deviations).
fn weight_at(x: f32, sigma: f32) -> f32 {
    return exp(-0.5 * x * x / (sigma * sigma));
}

fn blur(uv: vec2<f32>, axis: vec2<f32>) -> vec4<f32> {
    let sigma = params.radius * frame.input_size.y / 3.0;
    if (sigma < 0.25) {
        return read_input(uv);
    }
    let reach = ceil(sigma * 3.0);
    // Neighbouring texels are read in pairs: one filtered read between them,
    // placed by their weights, gives both. Wide blurs space the pairs out.
    let stride = max(1.0, reach / 64.0);
    let pairs = ceil(reach / (2.0 * stride));
    let texel = axis / frame.input_size;
    var sum = read_input(uv);
    var weight = 1.0;
    for (var i = 0.0; i < pairs; i = i + 1.0) {
        let a = (2.0 * i + 1.0) * stride;
        let b = a + stride;
        let wa = weight_at(a, sigma);
        let wb = weight_at(b, sigma);
        let w = wa + wb;
        let x = (a * wa + b * wb) / w;
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

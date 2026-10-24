// Streaks towards a centre, as if zooming during the exposure.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let center = vec2<f32>(params.center_x, params.center_y);
    let jitter = hash(uv * frame.size);
    var sum = vec4<f32>(0.0);
    let n = 24.0;
    for (var i = 0.0; i < n; i = i + 1.0) {
        let scale = 1.0 - params.amount * 0.5 * ((i + jitter) / n);
        sum = sum + read_input(center + (uv - center) * scale);
    }
    return sum / n;
}

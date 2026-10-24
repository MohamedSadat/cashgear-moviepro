// Blurs out of this picture and into the next, dissolving at the peak.
fn blurred(uv: vec2<f32>, radius: f32, incoming: bool) -> vec4<f32> {
    let aspect = frame.size.x / frame.size.y;
    var sum = vec4<f32>(0.0);
    let n = 24.0;
    let spin = hash(uv * frame.size) * 2.0 * PI;
    for (var i = 0.0; i < n; i = i + 1.0) {
        // Points spread evenly over a disc (a golden-angle spiral).
        let r = sqrt((i + 0.5) / n) * radius;
        let a = i * 2.39996323 + spin;
        let p = uv + vec2<f32>(cos(a) / aspect, sin(a)) * r;
        if (incoming) {
            sum = sum + read_to(p);
        } else {
            sum = sum + read_from(p);
        }
    }
    return sum / n;
}

fn render(uv: vec2<f32>) -> vec4<f32> {
    let t = frame.progress;
    let radius = sin(t * PI) * params.amount;
    let mixing = smoothstep(0.3, 0.7, t);
    return mix(blurred(uv, radius, false), blurred(uv, radius, true), mixing);
}

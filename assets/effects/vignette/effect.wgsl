// Darkens (or with a negative amount, lightens) towards the corners.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let d = length(uv - vec2<f32>(0.5)) * 1.41421356;
    let radius = mix(0.25, 1.25, params.size);
    let feather = mix(0.02, 1.0, params.softness);
    let edge = smoothstep(radius - feather, radius, d);
    var rgb = c.rgb * (1.0 - max(params.amount, 0.0) * edge);
    rgb = mix(rgb, vec3<f32>(1.0), max(-params.amount, 0.0) * edge);
    return vec4<f32>(rgb, c.a);
}

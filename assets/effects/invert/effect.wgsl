fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    return vec4<f32>(mix(c.rgb, vec3<f32>(1.0) - c.rgb, params.amount), c.a);
}

// Turns every colour around the colour wheel.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    var hsv = rgb_to_hsv(clamp(c.rgb, vec3<f32>(0.0), vec3<f32>(1.0)));
    hsv.x = fract(hsv.x + params.shift / 360.0 + 1.0);
    return vec4<f32>(hsv_to_rgb(hsv), c.a);
}

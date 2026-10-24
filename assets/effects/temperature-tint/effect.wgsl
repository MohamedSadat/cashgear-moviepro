// White balance: channel gains in linear light, normalised so brightness stays.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let t = params.temperature;
    var gain = vec3<f32>(1.0 + 0.35 * t, 1.0 - 0.3 * params.tint, 1.0 - 0.35 * t);
    gain = gain / dot(gain, vec3<f32>(0.2126, 0.7152, 0.0722));
    return vec4<f32>(c.rgb * gain, c.a);
}

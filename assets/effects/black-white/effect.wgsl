// Grey from a weighted mix of channels, like a colour filter on black-and-white film.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    var weights = vec3<f32>(0.2126, 0.7152, 0.0722);
    if (params.tone == TONE_RED) {
        weights = vec3<f32>(0.6, 0.3, 0.1);
    } else if (params.tone == TONE_YELLOW) {
        weights = vec3<f32>(0.45, 0.45, 0.1);
    } else if (params.tone == TONE_GREEN) {
        weights = vec3<f32>(0.2, 0.7, 0.1);
    } else if (params.tone == TONE_BLUE) {
        weights = vec3<f32>(0.1, 0.3, 0.6);
    }
    let grey = dot(c.rgb, weights);
    return vec4<f32>(mix(c.rgb, vec3<f32>(grey), params.amount), c.a);
}

// A colour lookup table, blended with the original by strength.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    return vec4<f32>(mix(c.rgb, apply_lut(c.rgb), params.strength), c.a);
}

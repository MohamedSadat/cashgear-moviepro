// Primary correction on sRGB-encoded values, as colourists grade. Each wheel is
// a brightness and a push towards a hue that leaves luma alone: lift raises or
// lowers the shadows and leaves white, gain scales, gamma bends the midtones and
// offset moves everything.

// A wheel's push towards `hue` (degrees) by `amount`, with no luma of its own.
fn wheel_colour(hue: f32, amount: f32) -> vec3<f32> {
    let colour = hsv_to_rgb(vec3<f32>(hue / 360.0, 1.0, 1.0));
    return (colour - vec3<f32>(luma(colour))) * amount * 0.25;
}

fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let lift = vec3<f32>(params.lift_master * 0.5) + wheel_colour(params.lift_hue, params.lift_amount);
    let gain = vec3<f32>(1.0 + params.gain_master) + 4.0 * wheel_colour(params.gain_hue, params.gain_amount);
    let gamma = vec3<f32>(params.gamma_master) + 2.0 * wheel_colour(params.gamma_hue, params.gamma_amount);
    let offset = vec3<f32>(params.offset_master * 0.5) + wheel_colour(params.offset_hue, params.offset_amount);
    var rgb = c.rgb + lift * (vec3<f32>(1.0) - c.rgb);
    rgb = rgb * gain;
    // Gamma above 0 brightens the midtones; black and white stay where they are.
    rgb = sign(rgb) * pow(abs(rgb), exp(-gamma));
    rgb = rgb + offset;
    return vec4<f32>(rgb, c.a);
}

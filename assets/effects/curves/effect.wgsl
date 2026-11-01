// Curves through five evenly spaced points (luma, then red, green and blue),
// smooth and monotone between them, and hue against hue, hue against saturation
// and luma against saturation through six and five points. All on sRGB-encoded
// values, as colourists grade.

// A monotone cubic (Fritsch–Carlson) through points at x = 0, 0.25 … 1.
fn curve5(p: array<f32, 5>, x: f32) -> f32 {
    let t = clamp(x, 0.0, 1.0) * 4.0;
    let i = min(u32(floor(t)), 3u);
    let f = t - f32(i);
    var slopes: array<f32, 5>;
    for (var k = 0u; k < 5u; k = k + 1u) {
        let before = select(p[k] - p[k - 1u], p[1] - p[0], k == 0u);
        let after = select(p[k + 1u] - p[k], p[4] - p[3], k == 4u);
        slopes[k] = select(0.0, 2.0 * before * after / (before + after), before * after > 0.0);
    }
    let a = p[i];
    let b = p[i + 1u];
    let ma = slopes[i];
    let mb = slopes[i + 1u];
    let f2 = f * f;
    let f3 = f2 * f;
    return (2.0 * f3 - 3.0 * f2 + 1.0) * a + (f3 - 2.0 * f2 + f) * ma
        + (-2.0 * f3 + 3.0 * f2) * b + (f3 - f2) * mb;
}

// A smooth periodic curve through six points at hue 0, 60 … 300 degrees (0 to 1).
fn curve6(p: array<f32, 6>, hue: f32) -> f32 {
    let t = fract(hue) * 6.0;
    let i = u32(floor(t)) % 6u;
    let f = t - floor(t);
    let a = p[(i + 5u) % 6u];
    let b = p[i];
    let c = p[(i + 1u) % 6u];
    let d = p[(i + 2u) % 6u];
    // Catmull-Rom.
    return b + 0.5 * f * (c - a + f * (2.0 * a - 5.0 * b + 4.0 * c - d + f * (3.0 * (b - c) + d - a)));
}

fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let luma_points = array<f32, 5>(params.luma_0, params.luma_1, params.luma_2, params.luma_3, params.luma_4);
    let red = array<f32, 5>(params.red_0, params.red_1, params.red_2, params.red_3, params.red_4);
    let green = array<f32, 5>(params.green_0, params.green_1, params.green_2, params.green_3, params.green_4);
    let blue = array<f32, 5>(params.blue_0, params.blue_1, params.blue_2, params.blue_3, params.blue_4);
    var rgb = vec3<f32>(curve5(red, c.r), curve5(green, c.g), curve5(blue, c.b));
    // The luma curve moves every channel by what it does to luma.
    let y = luma(rgb);
    rgb = rgb + vec3<f32>(curve5(luma_points, y) - y);
    var hsv = rgb_to_hsv(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)));
    let hue_shift = array<f32, 6>(params.hue_hue_0, params.hue_hue_1, params.hue_hue_2, params.hue_hue_3, params.hue_hue_4, params.hue_hue_5);
    let hue_sat = array<f32, 6>(params.hue_sat_0, params.hue_sat_1, params.hue_sat_2, params.hue_sat_3, params.hue_sat_4, params.hue_sat_5);
    let luma_sat = array<f32, 5>(params.luma_sat_0, params.luma_sat_1, params.luma_sat_2, params.luma_sat_3, params.luma_sat_4);
    let saturation = curve6(hue_sat, hsv.x) * curve5(luma_sat, y);
    hsv.x = fract(hsv.x + curve6(hue_shift, hsv.x) / 360.0);
    let shifted = hsv_to_rgb(hsv);
    // Saturation scales the distance from grey, keeping luma.
    let grey = vec3<f32>(luma(shifted));
    rgb = grey + (shifted - grey) * max(saturation, 0.0);
    return vec4<f32>(rgb, c.a);
}

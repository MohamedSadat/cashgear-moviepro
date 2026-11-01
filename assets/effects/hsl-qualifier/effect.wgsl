// Secondary correction on sRGB-encoded values. The selection is whole within
// each range around the key colour and falls to nothing across that range's
// softness; hue wraps round. A grade applies through it, so the rest stays exact.

// 1 within `range` of the centre, 0 past `range + soft`, in between straight.
fn within(distance: f32, range: f32, soft: f32) -> f32 {
    if (distance <= range) {
        return 1.0;
    }
    if (soft <= 0.0) {
        return 0.0;
    }
    return clamp(1.0 - (distance - range) / soft, 0.0, 1.0);
}

// How much of the colour `rgb` the qualifier selects.
fn selected(rgb: vec3<f32>) -> f32 {
    let key = rgb_to_hsv(params.color.rgb);
    let c = rgb_to_hsv(rgb);
    let turn = abs(c.x - key.x);
    // Hue means nothing without colour, and rounding would flip it from pixel to
    // pixel: grey is as far as hue goes from a colourful key, and a grey key
    // leaves the choice to saturation and luma.
    let sure = smoothstep(0.0, 0.04, c.y * c.z);
    let key_sure = smoothstep(0.0, 0.04, key.y * key.z);
    let hue = mix(180.0, min(turn, 1.0 - turn) * 360.0, sure) * key_sure;
    let matte = within(hue, params.hue_range, params.hue_soft)
        * within(abs(c.y - key.y), params.sat_range, params.sat_soft)
        * within(abs(luma(rgb) - luma(params.color.rgb)), params.luma_range, params.luma_soft);
    return select(matte, 1.0 - matte, params.invert > 0.5);
}

fn graded(rgb: vec3<f32>) -> vec3<f32> {
    var hsv = rgb_to_hsv(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)));
    hsv.x = fract(hsv.x + params.hue_shift / 360.0 + 1.0);
    hsv.y = clamp(hsv.y * params.saturation, 0.0, 1.0);
    var out = hsv_to_rgb(hsv);
    out = out + vec3<f32>(params.lift * 0.5) * (vec3<f32>(1.0) - out);
    out = out * (1.0 + params.gain);
    out = sign(out) * pow(abs(out), vec3<f32>(exp(-params.gamma)));
    return out + params.temperature * vec3<f32>(0.1, 0.0, -0.1);
}

fn render(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let matte = selected(c.rgb);
    if (params.view == VIEW_MATTE) {
        return vec4<f32>(vec3<f32>(matte), 1.0);
    }
    return vec4<f32>(mix(c.rgb, graded(c.rgb), matte), c.a);
}

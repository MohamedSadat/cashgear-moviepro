// A chroma keyer. The matte comes from how far each colour is from the key
// colour in the Cb-Cr plane, measured against how far the key is from grey, so
// shadows and highlights of the screen key with it. The matte is then thickened
// or thinned (a minimum or maximum over the edge thickness) and feathered (a
// Gaussian), and the key colour's spill is taken out of what stays. Passes after
// the first carry the matte in alpha and read colour from the original.

// BT.709 Cb and Cr of R'G'B'.
fn chroma(rgb: vec3<f32>) -> vec2<f32> {
    let y = luma(rgb);
    return vec2<f32>((rgb.b - y) / 1.8556, (rgb.r - y) / 1.5748);
}

fn with_matte(uv: vec2<f32>, alpha: f32) -> vec4<f32> {
    return vec4<f32>(read_original(uv).rgb, alpha);
}

fn key(uv: vec2<f32>) -> vec4<f32> {
    let c = read_input(uv);
    let k = chroma(params.color.rgb);
    let away = distance(chroma(c.rgb), k) / max(length(k), 0.05);
    let soft = max(params.softness, 0.001);
    return vec4<f32>(c.rgb, smoothstep(params.tolerance, params.tolerance + soft, away) * c.a);
}

// A thicker edge (negative) takes the most matte within reach, a thinner one
// (positive) the least.
fn choke(uv: vec2<f32>, axis: vec2<f32>) -> vec4<f32> {
    var alpha = read_input(uv).a;
    let reach = min(round(abs(params.choke) * frame.input_size.y), 64.0);
    let texel = axis / frame.input_size;
    for (var i = 1.0; i <= reach; i = i + 1.0) {
        let a = read_input(uv + texel * i).a;
        let b = read_input(uv - texel * i).a;
        if (params.choke > 0.0) {
            alpha = min(alpha, min(a, b));
        } else {
            alpha = max(alpha, max(a, b));
        }
    }
    return with_matte(uv, alpha);
}

fn choke_horizontal(uv: vec2<f32>) -> vec4<f32> {
    return choke(uv, vec2<f32>(1.0, 0.0));
}

fn choke_vertical(uv: vec2<f32>) -> vec4<f32> {
    return choke(uv, vec2<f32>(0.0, 1.0));
}

// The feather is about three standard deviations of a Gaussian.
fn feather(uv: vec2<f32>, axis: vec2<f32>) -> vec4<f32> {
    let sigma = params.feather * frame.input_size.y / 3.0;
    if (sigma < 0.25) {
        return with_matte(uv, read_input(uv).a);
    }
    let reach = min(ceil(sigma * 3.0), 96.0);
    let texel = axis / frame.input_size;
    var sum = read_input(uv).a;
    var weight = 1.0;
    for (var i = 1.0; i <= reach; i = i + 1.0) {
        let w = exp(-0.5 * i * i / (sigma * sigma));
        sum = sum + (read_input(uv + texel * i).a + read_input(uv - texel * i).a) * w;
        weight = weight + 2.0 * w;
    }
    return with_matte(uv, sum / weight);
}

fn feather_horizontal(uv: vec2<f32>) -> vec4<f32> {
    return feather(uv, vec2<f32>(1.0, 0.0));
}

fn feather_vertical(uv: vec2<f32>) -> vec4<f32> {
    return feather(uv, vec2<f32>(0.0, 1.0));
}

// Spill: the part of each colour's chroma that points towards the key colour
// is taken away, keeping its luma.
fn finish(uv: vec2<f32>) -> vec4<f32> {
    let alpha = read_input(uv).a;
    if (params.view == VIEW_MATTE) {
        return vec4<f32>(vec3<f32>(alpha), 1.0);
    }
    var rgb = read_original(uv).rgb;
    let k = chroma(params.color.rgb);
    let strength = length(k);
    if (strength > 0.01 && params.spill > 0.0) {
        let towards = k / strength;
        let c = chroma(rgb);
        let along = dot(c, towards);
        if (along > 0.0) {
            let y = luma(rgb);
            let fixed = c - towards * along * params.spill;
            rgb = vec3<f32>(
                y + 1.5748 * fixed.y,
                y - 0.1873 * fixed.x - 0.4681 * fixed.y,
                y + 1.8556 * fixed.x,
            );
        }
    }
    return vec4<f32>(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)), alpha);
}

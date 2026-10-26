// A chroma keyer. The matte comes from how far each colour is from the key
// colour in the Cb-Cr plane, measured against how far the key is from grey, so
// shadows and highlights of the screen key with it. The matte is then thickened
// or thinned (a minimum or maximum over the edge thickness) and feathered (a
// Gaussian), and the screen is taken out of partial edges and its spill out of
// what stays. Passes after the first carry the matte in alpha and read colour
// from the original.

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

// Where the matte is partial, the pixel mixes the subject with the screen: the
// key colour's share is taken out ("unmixing"), so edges keep the subject's own
// colour instead of a green or grey fringe. Then spill: the key's strongest
// channel is held down to the average of the other two. Holding it to the larger
// one would turn green on skin yellow, since skin's red is close to its green.
fn finish(uv: vec2<f32>) -> vec4<f32> {
    let alpha = read_input(uv).a;
    if (params.view == VIEW_MATTE) {
        return vec4<f32>(vec3<f32>(alpha), 1.0);
    }
    let key = params.color.rgb;
    var rgb = read_original(uv).rgb;
    if (alpha < 1.0) {
        // In linear light, where the camera mixed them and the layers are composited.
        let unmixed = (srgb_to_linear(rgb) - (1.0 - alpha) * srgb_to_linear(key)) / max(alpha, 0.001);
        rgb = linear_to_srgb(clamp(unmixed, vec3<f32>(0.0), vec3<f32>(1.0)));
    }
    let strongest = select(
        select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), key.b > key.g),
        vec3<f32>(1.0, 0.0, 0.0),
        key.r >= key.g && key.r >= key.b,
    );
    let others = rgb * (vec3<f32>(1.0) - strongest);
    let excess = max(dot(rgb, strongest) - (others.r + others.g + others.b) * 0.5, 0.0);
    rgb = rgb - strongest * excess * params.spill;
    return vec4<f32>(rgb, alpha);
}

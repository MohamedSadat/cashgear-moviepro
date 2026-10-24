fn render(uv: vec2<f32>) -> vec4<f32> {
    var p = uv;
    let mode = params.mode;
    if (mode == MODE_FLIP_HORIZONTAL || mode == MODE_FLIP_BOTH) {
        p.x = 1.0 - p.x;
    }
    if (mode == MODE_FLIP_VERTICAL || mode == MODE_FLIP_BOTH) {
        p.y = 1.0 - p.y;
    }
    if ((mode == MODE_MIRROR_LEFT && p.x > 0.5) || (mode == MODE_MIRROR_RIGHT && p.x < 0.5)) {
        p.x = 1.0 - p.x;
    }
    if ((mode == MODE_MIRROR_TOP && p.y > 0.5) || (mode == MODE_MIRROR_BOTTOM && p.y < 0.5)) {
        p.y = 1.0 - p.y;
    }
    return read_input(p);
}

// Square blocks, each the average of four samples; the size is a fraction of the width.
fn render(uv: vec2<f32>) -> vec4<f32> {
    let across = max(1.0, round(1.0 / params.size));
    let grid = vec2<f32>(across, max(1.0, round(across / frame.aspect)));
    let cell = floor(uv * grid);
    var sum = vec4<f32>(0.0);
    for (var i = 0.0; i < 4.0; i = i + 1.0) {
        let offset = vec2<f32>(0.25 + 0.5 * (i % 2.0), 0.25 + 0.5 * floor(i / 2.0));
        sum = sum + read_input((cell + offset) / grid);
    }
    return sum * 0.25;
}

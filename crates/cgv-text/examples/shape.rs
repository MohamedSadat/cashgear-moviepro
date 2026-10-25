// Prints rustybuzz's glyphs and positions for a string in a font: a check against HarfBuzz.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let data = std::fs::read(&args[1]).unwrap();
    let face = rustybuzz::Face::from_slice(&data, 0).unwrap();
    let mut buffer = rustybuzz::UnicodeBuffer::new();
    buffer.push_str(&args[2]);
    buffer.guess_segment_properties();
    println!("{:?} {:?}", buffer.direction(), buffer.script());
    let out = rustybuzz::shape(&face, &[], buffer);
    for (info, pos) in out.glyph_infos().iter().zip(out.glyph_positions()) {
        let id = rustybuzz::ttf_parser::GlyphId(info.glyph_id as u16);
        let bounds = face.glyph_bounding_box(id);
        println!(
            "{:6} cl={:2} adv={:5} dx={:5} dy={:5} bounds={:?}",
            info.glyph_id, info.cluster, pos.x_advance, pos.x_offset, pos.y_offset, bounds
        );
    }
}

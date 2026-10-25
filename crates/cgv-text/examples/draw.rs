// Draws one line of text with the text engine to a grey PGM: a check against browsers.
use cgv_model::title::{Content, Element, Font, Text, Title};
use cgv_text::{Fonts, Painter, View};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut fonts = Fonts::new();
    fonts.add("font", std::fs::read(&args[1]).unwrap()).unwrap();
    let family = fonts.families()[0].family.clone();
    let mut painter = Painter::new(fonts);
    let title = Title {
        elements: vec![Element {
            id: cgv_model::ElementId(1),
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: 1.0,
            fill: cgv_model::Color {
                r: 1.0,
                g: 1.0,
                b: 1.0,
                a: 1.0,
            },
            stroke: None,
            shadow: None,
            content: Content::Text(Text {
                text: args[2].clone(),
                font: Font {
                    family,
                    weight: 400,
                    italic: false,
                },
                size: 96.0,
                align: Default::default(),
                direction: Default::default(),
                line_spacing: 1.0,
                letter_spacing: 0.0,
                wrap: None,
                background: None,
                reveal: 1.0,
                reveal_by: Default::default(),
            }),
        }],
    };
    let (w, h) = (800u32, 300u32);
    let view = View {
        left: 0.0,
        top: 0.0,
        scale_x: 1.0,
        scale_y: 1.0,
        width: w,
        height: h,
    };
    let mut grey = vec![0u8; (w * h) as usize];
    painter.draw(&title, (w as f64, h as f64), view, |top, rows, bytes| {
        for i in 0..(rows * w) as usize {
            grey[top as usize * w as usize + i] = bytes[i * 4 + 3];
        }
    });
    let mut out = format!("P5\n{w} {h}\n255\n").into_bytes();
    out.extend(grey);
    std::fs::write(&args[3], out).unwrap();
}

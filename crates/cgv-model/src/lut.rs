//! Reading `.cube` LUT files (the Adobe and Resolve text format) into a [`LutSpec`].
use crate::effects::{LutShape, LutSpec, MAX_LUT_1D, MAX_LUT_3D};

/// Parses a `.cube` file. Outputs are clamped to 0..1, the range of the SDR pipeline.
pub fn parse_cube(name: &str, text: &str) -> Result<LutSpec, String> {
    let mut shape = None;
    let mut domain_min = [0.0; 3];
    let mut domain_max = [1.0; 3];
    let mut values: Vec<u16> = Vec::new();
    let mut title = None;
    for (number, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let error = |what: &str| format!("Line {} of the LUT {what}", number + 1);
        let mut words = line.split_whitespace();
        let keyword = words.next().unwrap_or_default();
        let numbers = |words: std::str::SplitWhitespace| -> Result<Vec<f64>, String> {
            words
                .map(|word| {
                    word.parse::<f64>()
                        .ok()
                        .filter(|value| value.is_finite())
                        .ok_or_else(|| error("has a value that is not a number"))
                })
                .collect()
        };
        match keyword {
            "TITLE" => {
                let rest = line["TITLE".len()..].trim().trim_matches('"').trim();
                if !rest.is_empty() {
                    title = Some(rest.to_string());
                }
            }
            "LUT_1D_SIZE" | "LUT_3D_SIZE" => {
                if shape.is_some() {
                    return Err(error("gives a second size"));
                }
                let size: u32 = words
                    .next()
                    .and_then(|word| word.parse().ok())
                    .ok_or_else(|| error("has no size"))?;
                let (kind, limit) = if keyword == "LUT_1D_SIZE" {
                    (LutShape::OneD, MAX_LUT_1D)
                } else {
                    (LutShape::ThreeD, MAX_LUT_3D)
                };
                if !(2..=limit).contains(&size) {
                    return Err(format!(
                        "LUTs of size {size} are not supported (2 to {limit})"
                    ));
                }
                shape = Some((kind, size));
            }
            "DOMAIN_MIN" | "DOMAIN_MAX" => {
                let triple = numbers(words)?;
                let triple: [f64; 3] =
                    triple.try_into().map_err(|_| error("needs three values"))?;
                if keyword == "DOMAIN_MIN" {
                    domain_min = triple;
                } else {
                    domain_max = triple;
                }
            }
            // Resolve's single-range form.
            "LUT_1D_INPUT_RANGE" | "LUT_3D_INPUT_RANGE" => {
                let pair = numbers(words)?;
                let [low, high]: [f64; 2] =
                    pair.try_into().map_err(|_| error("needs two values"))?;
                domain_min = [low; 3];
                domain_max = [high; 3];
            }
            _ if keyword
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit() || matches!(c, '-' | '+' | '.')) =>
            {
                let triple = numbers(line.split_whitespace())?;
                if triple.len() != 3 {
                    return Err(error("needs three values"));
                }
                for value in triple {
                    values.push((value.clamp(0.0, 1.0) * 65535.0).round() as u16);
                }
            }
            // Other keywords (such as LUT_IN_VIDEO_RANGE) do not change the mapping.
            _ => {}
        }
    }
    let (shape, size) = shape.ok_or("The file has no LUT_1D_SIZE or LUT_3D_SIZE line")?;
    let entries = match shape {
        LutShape::OneD => size as usize,
        LutShape::ThreeD => (size as usize).pow(3),
    };
    if values.len() != entries * 3 {
        return Err(format!(
            "The LUT has {} values; a size of {size} needs {}",
            values.len() / 3,
            entries
        ));
    }
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    let name = title
        .filter(|_| name.trim().is_empty())
        .unwrap_or_else(|| name.trim().to_string());
    let spec = LutSpec {
        name: if name.is_empty() { "LUT".into() } else { name },
        shape,
        size,
        domain_min,
        domain_max,
        data: crate::base64::encode(&bytes),
    };
    spec.check()?;
    Ok(spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_cube(size: u32) -> String {
        let mut text = String::from("# made by a test\nTITLE \"Identity\"\nLUT_3D_SIZE ");
        text.push_str(&format!("{size}\n"));
        let max = (size - 1) as f64;
        for b in 0..size {
            for g in 0..size {
                for r in 0..size {
                    text.push_str(&format!(
                        "{:.6} {:.6} {:.6}\n",
                        r as f64 / max,
                        g as f64 / max,
                        b as f64 / max
                    ));
                }
            }
        }
        text
    }

    #[test]
    fn reads_a_3d_lut_with_red_varying_fastest() {
        let spec = parse_cube("look.cube", &identity_cube(3)).unwrap();
        assert_eq!((spec.shape, spec.size), (LutShape::ThreeD, 3));
        assert_eq!(spec.name, "look.cube");
        let bytes = crate::base64::decode(&spec.data).unwrap();
        let value = |i: usize| u16::from_le_bytes([bytes[2 * i], bytes[2 * i + 1]]);
        // Entry 1 is r = 0.5, g = 0, b = 0.
        assert_eq!((value(3), value(4), value(5)), (32768, 0, 0));
        assert_eq!(value(26 * 3 + 2), 65535);
        assert_eq!(parse_cube("", &identity_cube(2)).unwrap().name, "Identity");
    }

    #[test]
    fn reads_1d_luts_domains_and_clamps_outputs() {
        let text = "LUT_1D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n-0.5 0 0\n1 1.5 1\n";
        let spec = parse_cube("curve", text).unwrap();
        assert_eq!((spec.shape, spec.size), (LutShape::OneD, 2));
        assert_eq!(spec.domain_max, [2.0; 3]);
        let bytes = crate::base64::decode(&spec.data).unwrap();
        assert_eq!(&bytes[..2], &[0, 0]);
        assert_eq!(&bytes[8..10], &[255, 255]);
        let resolve = "LUT_3D_INPUT_RANGE 0 4\nLUT_3D_SIZE 2\n".to_string() + &"0 0 0\n".repeat(8);
        assert_eq!(parse_cube("r", &resolve).unwrap().domain_max, [4.0; 3]);
    }

    #[test]
    fn refuses_broken_files() {
        assert!(parse_cube("x", "0 0 0\n")
            .unwrap_err()
            .contains("no LUT_1D_SIZE"));
        assert!(parse_cube("x", "LUT_3D_SIZE 2\n0 0 0\n")
            .unwrap_err()
            .contains("needs 8"));
        assert!(parse_cube("x", "LUT_3D_SIZE 99\n").is_err());
        assert!(parse_cube("x", "LUT_3D_SIZE 2\n0 0 nan\n").is_err());
        assert!(parse_cube(
            "x",
            "LUT_1D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 0 0 0\n0 0 0\n1 1 1\n"
        )
        .is_err());
    }
}

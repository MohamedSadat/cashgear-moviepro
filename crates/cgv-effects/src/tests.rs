use super::*;

fn validate(source: &str) -> (naga::Module, naga::valid::ModuleInfo) {
    let module = naga::front::wgsl::parse_str(source)
        .unwrap_or_else(|error| panic!("shader does not parse:\n{}", error.emit_to_string(source)));
    let info = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .unwrap_or_else(|error| panic!("shader does not validate: {error:?}"));
    (module, info)
}

/// WebGL2 runs the same WGSL translated to GLSL ES 3.0.
fn translate_for_webgl2(source: &str) {
    let (module, info) = validate(source);
    for entry in &module.entry_points {
        let options = naga::back::glsl::Options {
            version: naga::back::glsl::Version::Embedded {
                version: 300,
                is_webgl: true,
            },
            ..Default::default()
        };
        let pipeline = naga::back::glsl::PipelineOptions {
            shader_stage: entry.stage,
            entry_point: entry.name.clone(),
            multiview: None,
        };
        let mut output = String::new();
        naga::back::glsl::Writer::new(
            &mut output,
            &module,
            &info,
            &options,
            &pipeline,
            naga::proc::BoundsCheckPolicies::default(),
        )
        .and_then(|mut writer| writer.write())
        .unwrap_or_else(|error| panic!("{} does not translate to GLSL ES: {error}", entry.name));
    }
}

/// Items the browser lists: each variant, or the definition when it has none.
fn items(registry: &Registry, kind: Kind) -> usize {
    registry
        .entries()
        .iter()
        .filter(|entry| entry.definition.kind == kind)
        .map(|entry| entry.definition.variants.len().max(1))
        .sum()
}

#[test]
fn the_builtin_pack_loads_with_about_twenty_effects_and_transitions() {
    let registry = Registry::builtin().unwrap();
    assert!(
        items(&registry, Kind::Effect) >= 20,
        "{}",
        items(&registry, Kind::Effect)
    );
    assert!(
        items(&registry, Kind::Transition) >= 20,
        "{}",
        items(&registry, Kind::Transition)
    );
    let blur = registry.get(BUILTIN_PACK, "gaussian-blur").unwrap();
    assert_eq!(blur.folder, "effects/gaussian-blur");
    assert_eq!(blur.definition.passes.len(), 2);
    for entry in registry.entries() {
        let folder_id = entry.folder.rsplit('/').next().unwrap();
        assert_eq!(
            folder_id, entry.definition.id,
            "a folder is named after its effect"
        );
        let group = if entry.definition.kind == Kind::Effect {
            "effects/"
        } else {
            "transitions/"
        };
        assert!(
            entry.folder.starts_with(group),
            "{} is in the wrong folder",
            entry.folder
        );
    }
}

#[test]
fn every_builtin_shader_validates_and_translates_for_webgl2() {
    let registry = Registry::builtin().unwrap();
    for entry in registry.entries() {
        let source = shader_source(entry);
        let (module, _) = validate(&source);
        let passes = entry.definition.passes.len();
        for index in 0..passes {
            let name = format!("cgv_pass_{index}");
            assert!(
                module.entry_points.iter().any(|e| e.name == name),
                "{} lacks {name}",
                entry.definition.id
            );
        }
        translate_for_webgl2(&source);
    }
}

#[test]
fn every_image_a_definition_reads_exists() {
    let registry = Registry::builtin().unwrap();
    let assets = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets");
    let images = registry.images();
    assert_eq!(images.len(), 6, "{images:?}");
    for image in images {
        assert!(
            assets.join(&image.path).is_file(),
            "{} is missing",
            image.path
        );
        assert!(image
            .key
            .starts_with("builtin:transitions/luma-wipe/gradients/"));
    }
    let luma = registry.get(BUILTIN_PACK, "luma-wipe").unwrap();
    assert_eq!(
        luma.definition.image(&Params::new()),
        Some("gradients/clock.png")
    );
    let iris: Params = [("gradient".to_string(), ParamValue::Text("iris".into()))].into();
    assert_eq!(luma.definition.image(&iris), Some("gradients/iris.png"));
}

fn entry(definition: &str) -> Entry {
    let mut registry = Registry::default();
    registry
        .register(
            "test",
            "effects/test",
            definition,
            "fn render(uv: vec2<f32>) -> vec4<f32> { return read_input(uv); }",
        )
        .unwrap();
    registry.entries()[0].clone()
}

const SETTINGS: &str = r#"{
    "id": "test", "name": "Test", "category": "Test", "type": "effect", "version": 1,
    "space": "linear",
    "params": [
        { "id": "amount", "name": "Amount", "type": "number", "min": 0, "max": 2, "default": 1 },
        { "id": "tint", "name": "Tint", "type": "color", "default": [1, 0.5, 0, 1] },
        { "id": "on", "name": "On", "type": "bool", "default": true },
        { "id": "lut", "name": "LUT", "type": "lut" },
        { "id": "mode", "name": "Mode", "type": "choice", "default": "b",
          "options": [{ "id": "a", "name": "A" }, { "id": "b", "name": "B" }] }
    ]
}"#;

fn floats(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

#[test]
fn settings_pack_colours_first_then_scalars() {
    let entry = entry(SETTINGS);
    assert_eq!(entry.layout.size, 32);
    let offsets: Vec<(usize, u32)> = entry
        .layout
        .fields
        .iter()
        .map(|f| (f.param, f.offset))
        .collect();
    assert_eq!(offsets, [(1, 0), (0, 16), (2, 20), (4, 24)]);
    let source = shader_source(&entry);
    assert!(source.contains("    tint: vec4<f32>,\n    amount: f32,\n    on: f32,\n    mode: f32,\n    cgv_pad0: f32,\n"));
    assert!(source.contains("const MODE_B: f32 = 1.0;"));
    validate(&source);

    // Defaults, then values, clamped; linear effects get linear colours.
    let defaults = floats(&pack_params(&entry, &Params::new()));
    assert_eq!(defaults[4..7], [1.0, 1.0, 1.0]);
    assert!(
        (defaults[1] - 0.214_041).abs() < 1e-5,
        "0.5 sRGB is 0.214 linear"
    );
    let params: Params = [
        ("amount".to_string(), ParamValue::Number(5.0)),
        ("on".to_string(), ParamValue::Bool(false)),
        ("mode".to_string(), ParamValue::Text("a".into())),
        ("tint".to_string(), ParamValue::Text("not a colour".into())),
    ]
    .into();
    let packed = floats(&pack_params(&entry, &params));
    assert_eq!(packed[4..7], [2.0, 0.0, 0.0]);
    assert_eq!(packed[0], 1.0, "a wrong kind of value takes the default");
    assert_eq!(entry.definition.lut_param(), Some("lut"));
    assert_eq!(entry.definition.defaults().len(), 4);
}

#[test]
fn definitions_with_mistakes_are_refused() {
    let broken = |change: &dyn Fn(&mut serde_json::Value)| {
        let mut value: serde_json::Value = serde_json::from_str(SETTINGS).unwrap();
        change(&mut value);
        let mut registry = Registry::default();
        registry
            .register("test", "effects/test", &value.to_string(), "")
            .unwrap_err()
    };
    assert!(broken(&|v| v["id"] = "Bad Id".into()).contains("not an effect id"));
    assert!(broken(&|v| v["params"][0]["default"] = 3.into()).contains("invalid range"));
    assert!(broken(&|v| v["params"][1]["id"] = "amount".into()).contains("twice"));
    assert!(broken(&|v| v["params"][0]["id"] = "frame".into()).contains("not a setting name"));
    assert!(broken(&|v| v["params"][4]["default"] = "c".into()).contains("invalid options"));
    assert!(broken(&|v| v["passes"] = serde_json::json!([])).contains("1 to 8 passes"));
    assert!(broken(&|v| v["variants"] = serde_json::json!([{
        "id": "loud", "name": "Loud", "params": { "amount": 9 }
    }]))
    .contains("wrongly"));
    assert!(broken(&|v| v["bogus"] = 1.into()).contains("unknown field"));
}

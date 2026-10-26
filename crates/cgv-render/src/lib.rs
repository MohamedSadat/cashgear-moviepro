//! wgpu compositor: frames to linear-light textures, effects and transitions
//! from `cgv-effects` packs, layers drawn bottom track first with transform, crop
//! and opacity, and the result shown on the program monitor or read back. The
//! Phase 0 test pattern stays as a diagnostic.
pub mod color;
#[cfg(target_arch = "wasm32")]
mod compositor;
pub mod geometry;
pub mod masks;
pub mod pattern;
#[cfg(target_arch = "wasm32")]
mod renderer;
#[cfg(target_arch = "wasm32")]
pub use compositor::{
    EffectRun, FrameSource, LayerDraw, LayerStep, LutUse, PlaneFormat, Planes, Readback, Step,
};
#[cfg(target_arch = "wasm32")]
pub use renderer::{now_ms, Renderer};

#[cfg(test)]
mod tests {
    fn validate(source: &str) -> (naga::Module, naga::valid::ModuleInfo) {
        let module = naga::front::wgsl::parse_str(source).expect("shader must parse");
        let info = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .expect("shader must validate without optional GPU capabilities");
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
            .unwrap_or_else(|error| {
                panic!("{} does not translate to GLSL ES: {error}", entry.name)
            });
        }
    }

    #[test]
    fn pattern_shader_is_valid_wgsl() {
        translate_for_webgl2(include_str!("pattern.wgsl"));
    }

    #[test]
    fn compositor_shader_is_valid_on_both_backends() {
        translate_for_webgl2(include_str!("compositor.wgsl"));
    }
}

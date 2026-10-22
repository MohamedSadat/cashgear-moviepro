//! wgpu compositor. Phase 0 draws only the animated test pattern.
pub mod pattern;
#[cfg(target_arch = "wasm32")]
mod renderer;
#[cfg(target_arch = "wasm32")]
pub use renderer::Renderer;

#[cfg(test)]
mod tests {
    #[test]
    fn pattern_shader_is_valid_wgsl() {
        let module = naga::front::wgsl::parse_str(include_str!("pattern.wgsl"))
            .expect("pattern shader must parse");
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        )
        .validate(&module)
        .expect("pattern shader must validate without optional GPU capabilities");
    }
}

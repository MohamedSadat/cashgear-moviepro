# Assets

The built-in pack (effects, transitions, luma-wipe gradients and looks), and later fonts (OFL) and title and project templates.

## Effects and transitions

Each folder in `effects/` or `transitions/` is one definition: `effect.json` and `effect.wgsl`. `crates/cgv-effects` embeds every folder at build time, so adding a folder adds an effect. Its tests validate each shader with naga and translate it for WebGL2.

`effect.json`:

```json
{
  "id": "vignette",
  "name": "Vignette",
  "category": "Stylize",
  "type": "effect",
  "version": 1,
  "space": "srgb",
  "params": [
    { "id": "amount", "name": "Amount", "type": "number", "min": -1, "max": 1, "default": 0.5 }
  ],
  "passes": [{ "entry": "render" }],
  "variants": []
}
```

- `id` names the folder and is saved in projects, with the pack (`builtin`) and `version`.
- `type` is `effect` (changes one picture) or `transition` (blends two by `frame.progress`, one pass).
- `space` is what the shader reads and returns. In `linear`, colour is linear light with premultiplied alpha: use it for blurs, blends and geometry. In `srgb`, colour is sRGB-encoded with straight alpha, as the picture looks: use it for colour adjustments. Transitions are linear.
- `params` are the settings, and the inspector builds its controls from them:
  - `number`: `min`, `max`, `default`, and optionally `step`, `unit`, and `display` (the UI shows the value times this; 100 shows a fraction as %).
  - `bool`, `color` (`default` as sRGB RGBA, 0 to 1) and `choice` (`options` of `id` and `name`; an option may name an `image` file beside the definition).
  - `lut`: a project LUT, which the shader reads with `apply_lut`.
  - Numbers and colours can be keyframed unless `"animate": false`.
  - Sizes are fractions of the picture, so an effect looks the same at every preview quality and export size.
- `passes` run in order, each a function of the shader; the default is one pass, `render`. A pass may run smaller (`"scale": 0.5`).
- `variants` are named sets of settings listed as their own items, such as "Wipe left".

`effect.wgsl` defines each pass's function, `fn render(uv: vec2<f32>) -> vec4<f32>`, which returns the colour at `uv` (0 to 1, top left first). The prelude (`crates/cgv-effects/src/prelude.wgsl`) provides:

- `params.<id>`: the settings. Colours are `vec4<f32>`. Numbers, switches (0 or 1) and choices (the option's index, also named `<PARAM>_<OPTION>`) are `f32`.
- `frame.size`, `frame.input_size`, `frame.time` (seconds into the clip), `frame.progress`, `frame.seed` and `frame.aspect`.
- `read_input(uv)`: the previous pass. `read_original(uv)`: the effect's input. `read_from(uv)` and `read_to(uv)`: a transition's two pictures. `read_image(uv)`: the chosen option's image. `apply_lut(rgb)`.
- `luma`, `hash`, `value_noise`, `rgb_to_hsv`, `hsv_to_rgb`, `srgb_to_linear`, `linear_to_srgb` and `PI`.

## Generated files

`node scripts/make-effect-assets.mjs` writes the luma-wipe gradients (`transitions/luma-wipe/gradients/*.png`) and the built-in looks (`luts/*.cube`, 17 points). They come from our own code, so no third-party art or LUT licences are involved. A look is copied into a project when it is used, so the project keeps working if the look changes later.

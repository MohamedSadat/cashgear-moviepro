# Decisions

Dated entries, newest first. Every answer to a phase question is recorded here, along with each small default chosen during a phase.

## 2026-10-25: Phase 8 answers

- **Sound library:** about 30 sound effects and 10 music beds made by our own script (`scripts/make-sounds.mjs`), as the stickers and looks are. No licences are involved, and the files can be made again. The music is simple; licensed music can be added before release.
- **Audio effects at launch:** the plan's five plus basics.
  - The plan's five: EQ (parametric, with presets), compressor, noise gate, reverb and noise reduction (`nnnoiseless`).
  - The basics: a limiter, high- and low-pass filters, and echo.
- **CashGear Audio:** no shared code yet. No CashGear Audio repository exists on this machine. The DSP gets its own crate here, with no dependency on the project model, so it can move to a shared repository when CashGear Audio needs it.
- **Ducking:** live, by track role.
  - Tracks are marked Dialogue, Music or Effects.
  - The mixer lowers Music tracks whenever a Dialogue track plays, so ducking stays right after edits.
  - The amount and the fade times are set in the mixer.

## 2026-10-25: Phase 8 defaults

These were proposed alongside the questions, and the user raised no objection.

- **Sizes measured before asking:** on a probe crate built for wasm32 at `opt-level = "s"` with LTO, `nnnoiseless` 0.5 adds about 183 KB gzipped (its FFT through `easyfft` and `rustfft`, and the RNNoise weights), and `ebur128` 0.1 adds about 32 KB. The engine has 116 KB left of its 2 MB budget.
  - So noise reduction gets a WASM module of its own, loaded the first time a clip uses it.
  - `ebur128` and our own DSP go in the engine, built for size. The budget stays at 2 MB.
- **Model:** `.cgvproj` format 5, with a migration from format 4.
  - Tracks get a volume, a pan, solo and a role.
  - Clips get fade-in and fade-out lengths and an audio effect stack.
  - Music tracks get ducking settings.
- **Mixer:** a strip per track, with volume, constant-power pan, mute, solo and a meter.
  - The master strip has peak and RMS meters and a loudness readout in LUFS.
  - Solo mutes every track that is not soloed.
- **Meters:**
  - Peak meters hold for 1.5 s, then fall as IEC meters do.
  - RMS is taken over 300 ms and read plainly, so a full-scale sine shows −3.0 dBFS.
  - Loudness follows EBU R128.
  - The reference is FFmpeg's `astats` and `ebur128` filters, plus the EBU Tech 3341 test signals made by our own script. Readings must agree within 0.1 dB or 0.1 LU.
- **Fades and crossfades:**
  - Fade handles sit at a clip's top corners.
  - A transition on a cut also crossfades the sound of both clips, at equal power, using media beyond their edges. A cut between sound-only clips takes a transition too, which is then a crossfade.
  - The volume line on a clip drags up and down. Ctrl-click adds a key to the existing `volumeDb` keyframes.
- **Audio effects:**
  - Each clip has a stack in the inspector, like its video effects.
  - The DSP is our own Rust: biquad EQ and filters, compressor, gate, limiter, echo and a Freeverb-style reverb.
  - Effects run in play order. After a seek, each chain is warmed up on the second before the playhead, so the preview sounds as the export does.
- **Loudness on export:**
  - Two passes: the mix is measured first, then exported through a fixed gain and a true-peak limiter with a −1 dBTP ceiling.
  - Targets: −14 LUFS (the default, for YouTube, TikTok and Instagram), −16 (Apple, podcasts), −23 (EBU R128), −24 (ATSC A/85), a custom value, or off.
  - Exports are checked with FFmpeg's `ebur128` filter.
- **Voiceover:**
  - A record button in the timeline toolbar, a 3-2-1 countdown, an input meter, and hearing yourself as an option (off by default, to avoid feedback).
  - Sound is captured as raw PCM through an AudioWorklet into a 48 kHz WAV file. MediaRecorder's timing is too loose for alignment within a frame.
  - The clip is placed at the playhead. Placement is corrected from the output clock and the input latency the browser reports.
  - Files go to OPFS on the web. On the desktop they go to a `Voiceovers` folder next to the project.
- **Measuring voiceover alignment:**
  - On the reference machine, Chrome's system-audio loopback (`getDisplayMedia`, nothing to install) records the timeline's own click track through the real output device.
  - In CI, Chrome's fake microphone is used.
  - If the loopback does not work, a virtual audio cable is discussed with the user first.
- **Library tabs:** Music and Sounds, with search, categories and a preview played by the engine. A sound is added by dragging it or double-clicking it.
- **Already done:** detaching sound from video (Phase 2, with volume keys moving in Phase 6).
- **Pushing:** one push near the end of the phase, after the user's go-ahead.

## 2026-10-25: Phase 7 findings and defaults

Choices made while building titles, overlays and stickers.

- **The weak last row (Phase 6 gap):** the Phase 6 entry had the cause the wrong way round. Our planes path is right; Chrome's own conversion of hardware frames is wrong.
  - H.264 codes whole 16-pixel macroblocks, so a 1080p frame is 1088 rows high, with 8 rows of padding below the picture. Chrome converts a hardware frame by sampling chroma across that padding, so the last row shown mixes in a quarter of the padding's colour.
  - That only shows when the padding differs from the picture's edge. OpenH264 (our test media, and the browsers' software H.264 encoder) pads with black. Media Foundation repeats the edge row, and its files convert exactly.
  - Each H.264 file whose size is not a multiple of 16 is checked once when it opens: one frame is decoded in hardware, and its last rows shown are compared with its first padding rows (`paddingShows`). HEVC 1080p and VP9 720p hardware frames are not padded on the reference machine.
  - Files whose padding shows are drawn from their planes. Seeks wait for the frame cache's copy, so there is one readback, not two. Exports decode such files in software (`fastest`), because reading every hardware frame back made a one-minute export take 57 s instead of 12 s. Playback already decodes 1080p in software.
  - Measured on the GTX 1650: uncached seeks median 70 ms (Chrome) and 60 ms (Edge), as in Phase 3. The one-minute export of the OpenH264 test clip takes 21 s, 2.8× real time (12.4 s and 4.9× before, with the weak row). Files that repeat their edge keep hardware decoding.
  - Playing and paused frames of the keyframed-transform test now match exactly (mean 0.013 before).
- **Text engine:** a new crate, `cgv-text`, with no GPU code.
  - Shaping uses rustybuzz 0.20, which reads fonts with `ttf-parser` 0.25. HarfRust was not used: it reads fonts through `read-fonts`, which would add a second font parser to the WASM.
  - Direction uses `unicode-bidi` 0.3 (UAX #9), line breaks use `unicode-linebreak` 0.1 (UAX #14), and outlines are filled by `zeno` 0.3.
  - Variable fonts follow their `wght` axis. Fonts with an optical-size axis (`opsz`, Inter) take the drawn size, as Chrome's `font-optical-sizing: auto` does. Without it, Inter words came out 532 px wide where Chrome draws 500.
  - A family with no italic face is slanted by 0.2 (about 11°), as browsers synthesise it.
  - Letters a font lacks come from Noto Sans Arabic, then Inter, then Noto Emoji.
  - Digits after Arabic text are ordered as Arabic numbers (UAX #9 rule W2), as Chrome orders them.
- **Drawing titles:** on the CPU, at the size they appear, then uploaded as a picture. Effects, transforms and transitions treat that picture like any layer's.
  - Glyphs are filled in linear, premultiplied light, 128 rows at a time, so a 4K title never needs a whole-frame float buffer. The bytes go up sRGB-encoded and premultiplied, into `Rgba8UnormSrgb` textures.
  - Outlines draw under the fill. Shadows are three box blurs, which approximate a Gaussian.
  - Only the part that shows is drawn (`drawn_part`): what is on screen, inside the clip's crop and inside the title's ink. A moving title rounds its size as keyframed layers do, so pooled textures keep their keys.
  - Each title clip keeps its last drawing. It is drawn again only when the title, the part shown, the size or the loaded fonts change, so a still title costs one upload.
  - Reveals step by shaped cluster (letter), word or line, so Arabic letters appear already joined.
- **Title clips:** elements are text or shapes, each with its own position, scale, rotation, opacity, fill, stroke and shadow. Their keyframes are named `title.<element>.<setting>`.
  - A new or pasted title clip gives its elements new ids, and its keyframes follow them.
  - Templates are designed at 1920×1080 and fitted to the project's frame when added.
- **Animated images:** an image whose file holds more than one frame is media with a duration, and its clips loop.
  - Frame times follow the file, except that frames of 10 ms or less count as 100 ms, as browsers play them.
  - A new clip lasts one loop, and at least one second.
  - Every frame is uploaded as a still texture the first time the clip shows, within 32 M pixels per file; larger animations are scaled down to fit.
- **Pack media:** a sticker in a project names its file in the app's pack (`assets/stickers/…`), not a URL. Each build finds it at its own asset address, so the project opens the same on the web and on the desktop.
- **Stickers:** 30, in three groups (emoji, callouts and badges), as animated WebP with alpha, 2.68 MB in all.
  - Each is 256 px, 15 frames a second, a two-second loop, lossy quality 75 with compression 4. A first try at 24 frames a second (48 frames each) was too slow to make.
  - `scripts/make-stickers.mjs` draws the frames in Playwright's Chrome and encodes them with the pinned FFmpeg's `libwebp_anim`.
  - A new sticker clip lasts 5 s and is scaled to 35% of the frame.
  - Noto Emoji's repository moved to the OFL on 2024-07-29. Its images are taken from commit `41e31b110b4eb929dffb410264694a06205b7ad7`, the last under Apache-2.0, and that licence is kept beside the stickers.
- **Bundled fonts:** 25 families (the 24 agreed and Noto Emoji), 11.5 MB, from `google/fonts` at a pinned commit, each with its OFL text.
  - `assets/fonts/fonts.json` records each file's hash, and `pnpm fetch-fonts` fetches or checks them.
  - An engine fetches a family the first time a title needs it. Each frame's plan says which families its titles lack, fallbacks included.
- **Imported and installed fonts:**
  - Imported files (on the web and on the desktop) are kept in the browser's private storage under `fonts/`, with an index of their families. The family is read from the file's `name` table: the typographic family where there is one, as the engine and `fontdb` read it.
  - The desktop app lists installed fonts with `fontdb` once per run, at start, and serves each file through the `cgv-media` protocol. The reference machine has 236 installed families.
  - A bundled family wins over an installed or imported one of the same name.
  - The page's font list is the reference. The monitor's, the previews' and each export's workers are given the extra families.
  - A font the project names that this computer lacks gets a notice, as missing media does, and its titles draw with the fallback fonts until it is imported or installed.
- **WASM size:** 1,884,286 bytes gzipped, within the new 2 MB budget. rustybuzz, `unicode-bidi` and `unicode-linebreak` are built at `opt-level = "s"`.

## 2026-10-25: Phase 7 answers

- **Fonts:** a curated set of about 24 OFL families from `github.com/google/fonts`, roughly 10 MB in the repository.
  - Arabic: Noto Sans Arabic, Noto Naskh Arabic, Noto Kufi Arabic, Cairo, Tajawal, Almarai, Amiri, Reem Kufi, El Messiri, Lalezar, Changa and Aref Ruqaa.
  - Latin: Inter, Montserrat, Poppins, Oswald, Bebas Neue, Anton, Playfair Display, Lobster, Pacifico, Caveat, Permanent Marker and Roboto Mono.
- **Arabic UI:** in Phase 11, before release. The UI stays in English until then; titles support Arabic fully from this phase.
  - Phase 11 moves the UI's text into a translation file and lays it out right to left in one pass. The timeline still runs left to right.
- **Stickers:** about 30 built-in stickers as animated WebP with alpha, decoded by `ImageDecoder`, made by our own script.
  - The art: arrows, callouts, highlights, sparkles, shapes, and emoji animated from Noto Emoji's images (Apache-2.0).
  - Imports accept GIF, animated WebP, APNG and WebM with alpha. Lottie is evaluated later.
- **WASM size:** the gzip budget rises from 1.5 MB to 2 MB.
  - Measured before asking: rustybuzz, `unicode-bidi`, `unicode-linebreak` and a rasteriser add about 284 KB gzipped when built for size.
  - The text crates are built for size, and the engine is expected at about 1.75 to 1.8 MB.

## 2026-10-25: Phase 7 defaults

These were proposed alongside the questions, and the user raised no objection.

- **First:** fix the Phase 6 gap where paused frames and exports of 4:2:0 video show the bottom row's colour too weak.
- **Text engine:** Rust, in the engine.
  - Shaping uses rustybuzz, or HarfRust, its maintained HarfBuzz successor, if that turns out better.
  - Direction uses `unicode-bidi`, line breaks use `unicode-linebreak`, and fonts are read with `ttf-parser` and `fontdb`.
- **Drawing text:** each glyph is drawn from its outline at the size it appears, with sizes rounded to sixteenths of an octave as for keyframed layers. No SDF.
  - SDF rounds corners at 400%. MSDF goes wrong on overlapping contours, which are common in Arabic fonts.
  - Drawing at the shown size is exact and gives the same picture on every GPU. Effects and the clip's transform then apply as they do to any picture.
- **Title clips:** a title is a clip without media, like an adjustment layer. The project file moves to format 4, with a migration from format 3.
  - A title holds one or more text blocks. Each block has one style: font, size, colour, stroke, shadow, background box, alignment, line spacing and letter spacing. Different styles inside a block can come later.
  - Text is edited in the inspector. A new title lasts 5 s.
  - Each paragraph takes its direction from its first strong letter, and the direction can be overridden.
  - Missing glyphs fall back to the bundled Noto fonts. Emoji in titles draw in one colour from Noto Emoji; colour emoji come as stickers.
- **Animations:** in and out presets (fade, slide, scale) write ordinary keyframes.
  - Typewriter and word-by-word animate a new "reveal" setting that can be keyframed.
  - Arabic is revealed by whole shaped clusters, so letters keep their joined forms as they appear.
- **Templates:** 30 templates, designed by us, as JSON in `assets/titles/`, using bundled fonts only.
  - A Titles tab shows live previews. A template is used by dragging it or double-clicking it.
- **Fonts:**
  - Bundled fonts are committed to `assets/fonts/` with their licence texts. The app downloads each one the first time it is used; none are inside the WASM.
  - Projects name fonts by family and style.
  - The desktop app also lists installed fonts. The web app keeps font files the user imports.
  - A missing font is replaced, with a notice, as missing media is.
- **Overlays:**
  - GIF, animated WebP and APNG decode through WebCodecs `ImageDecoder`. They loop over the clip's length, and a new clip lasts one loop.
  - Shapes: rectangle (with rounded corners), ellipse, line, arrow, polygon and star, styled as titles are.
- **Tests:**
  - Arabic, English and mixed text are compared with Chrome's own layout of the same font and text, which uses HarfBuzz and ICU independently of our engine.
  - Golden renders at several sizes and rotations on both GPU backends.
  - Sharpness is measured at 4K and at 400%.
- **Pushing:** one push near the end of the phase, after the user's go-ahead.

## 2026-10-25: Phase 6 findings and defaults

Choices made while building effects, transitions and keyframes.

- **Launch set:** 21 effects and 26 transitions, 47 catalogue items.
  - Effects: the plan's 13, plus hue, black and white, sepia, invert, posterize, zoom blur, chromatic aberration and duotone.
  - Transitions: cross dissolve, dip to black and to white, wipe, slide and push in four directions each, zoom in and out, spin both ways, blur dissolve, and six luma wipes (clock, iris, diamond, diagonal, blinds, clouds).
  - Directional and coloured versions are variants of one effect folder, each its own catalogue item with preset settings.
- **Effect format:** `effect.json` and `effect.wgsl` per folder, as decided, plus what building it showed was needed:
  - `space` picks linear light (premultiplied) or sRGB-encoded values (straight alpha). Colour settings follow the space.
  - `passes` lists entry points and a size scale, for separable or multi-step effects; a pass reads the previous one and the effect's input.
  - Choice settings become WGSL constants, so shaders compare names, not numbers.
  - The prelude gives inputs (`read_input`, `read_original`, `read_from`, `read_to`, `read_image`, `apply_lut`) and helpers (`luma`, HSV, `value_noise`, `hash`, `time_step`, `seed_step`, `cell_of`, `coverage`).
  - Pack images, such as the luma-wipe gradients, are PNGs in the effect's folder. Every engine (monitor, export, previews) loads them at start.
  - The worker decodes them to RGBA bytes through a 2D canvas, and the renderer writes the bytes. Copying the grey gradients from `ImageBitmap`s failed inside the browser on SwiftShader's WebGPU, about one engine start in five ("[Invalid Texture] is invalid due to a previous error"), which CI's first Phase 6 run showed. 30 starts in a row now pass, and the luma-wipe goldens are unchanged.
  - `assets/README.md` is the authoring guide. Adding Duotone touched only its folder and its golden fixture.
- **The same picture on every GPU:** golden renders on WebGPU and WebGL2, hardware and software, must agree, which shaped the helpers.
  - Noise comes from an integer hash (PCG), not the usual `sin` hash, whose precision differs between GPUs.
  - Animated grain and glitches step at whole steps of the clip's time, nudged so no GPU lands either side of a step.
  - Pixel cells use integer division, and scaled pictures smooth their edges over one pixel.
  - Result: hardware WebGPU renders match the references exactly, WebGL2 within one level, and software GPUs within 22 levels at a few pixels (mean 0.1).
- **Golden pictures:** two synthetic scenes, a sunset and a night city, generated by the test at the project's 480×270, so no photographs need licensing and no GPU's filtering takes part.
  - Effects run on the sunset at frame 12. Transitions run 30 frames, centred on the cut at frame 30, shown at frame 26.
  - The Phase 3 tolerance applies, and each effect must also fail that tolerance against the untouched picture, so an effect that does nothing fails.
- **Where effects run:** on the visible part of the picture, upright, at the size it is drawn, never above the picture's own pixels.
  - A layer whose transform or crop is keyframed rounds that size up to a sixteenth of its octave (multiples of 64 between 1024 and 2048 pixels). Before this, a keyframed zoom made new 1080p textures every frame and never freed them: GPU latency reached 220 ms. Now 6–8 ms.
  - Free textures unused for 30 frames are destroyed.
- **Gaussian blur:** neighbouring taps share one filtered read, placed by their weights. Five stacked effects on 1080p30 went from 11.9 to 9.5 ms mean GPU latency; goldens moved by at most one level.
- **Transitions:**
  - Each side is drawn alone, with its own transform and effects, into a full-frame texture, and the shader blends the two. Progress is taken at the middle of each frame.
  - A transition whose kind is not installed shows a cut at its middle.
  - One transition per edge. Adding one where there is no room fails with "There is no room for a transition there"; edits that shrink clips shorten or drop the transitions on them.
  - Splitting a clip moves the transitions at its end to the right-hand part.
  - A transition at a free edge (fade from or to transparent) always sits inside its clip, starting or ending at the edge.
  - Changing a transition's type in the inspector replaces it and keeps the replacement selected.
- **Adjustment layers:** the composition below is copied, run through the layer's effects and mixed back by its opacity. They have no speed and cannot be slipped.
- **LUTs:**
  - Stored in the project as 16-bit values (base64), with an FNV-1a fingerprint so the GPU copy is uploaded once.
  - 1D LUTs become 33³ cubes on the GPU.
  - Built-in looks are copied into the project when used, so a project never depends on the app's own files.
  - An imported LUT is named after its file; a `TITLE` is used only when there is no file name.
- **Keyframes:**
  - Trimming a clip's start keeps each key on the same frame of its content. Both parts of a split keep all the keys, so the animation runs on across the cut, and the right part's effects get new ids with their keys.
  - Detaching sound moves volume keys to the sound clip.
  - "Stop animating" keeps the value at the playhead.
  - Volume keys become a gain envelope, evaluated every 256 samples and blended linearly between.
  - Multi-property changes (a uniform scale keys X and Y) are one command, one undo step.
- **Effect previews:** drawn once per session by a worker with its own engine, on two pictures it paints itself.
- **Software GPUs:** the five-effect real-time test runs at 640×360 there. At 1080p, CI's SwiftShader never moved the playhead in 10 s; locally it played at a third of real time.
- **WASM size:** the effect catalogue, the model and `serde_json` are built with `opt-level = "s"`. Release WASM is 1,482,207 bytes gzipped, within the 1.5 MB budget (1,518,732 before).
- **Found, not fixed:** paused frames and exports of 4:2:0 video show the picture's last row with its colour a quarter weaker. The browser's own conversion, used while playing, and FFmpeg both show it at full strength. The cause is in the planes path (Phases 1 to 3), not in effects. On an untransformed frame it is one row; under rotation it shows along the bottom edge.

## 2026-10-24: Phase 6 answers

- **Launch set:** about 20 effects and 20 transitions.
  - Effects: the plan's 13 (brightness and contrast, exposure, saturation, temperature and tint, LUT, Gaussian blur, sharpen, vignette, noise, pixelate, mirror and flip, glitch, old film) plus cheap ones such as hue, black and white, sepia, invert, posterize, chromatic aberration and zoom blur.
  - Transitions: the plan's kinds, with wipe, slide and push in four directions as separate items.
  - Each one gets a golden test.
- **Packs:** the format is shaped as a pack, but only the built-in pack ships.
  - A pack manifest has an id and a version. The built-ins are one pack, and the engine registers effects from data at runtime.
  - Projects save each effect's id, pack and version.
  - No install UI or store yet.
- **LUTs:** `.cube` import in this phase, saved inside the project.
  - 1D and 3D `.cube` files up to 65³. The LUT's data is stored in the `.cgvproj` (about 0.3 MB for 33³), so a project stays portable.
  - About six built-in looks, generated by our own script, so no third-party LUT licences are involved.
- **Transition timing:** centred on the cut.
  - The edit's length never changes, and the magnetic main track does not move.
  - Media beyond each clip's edge feeds the transition. Where it runs out, the edge frame holds.
  - Start, centre or end alignment can be chosen per transition.

## 2026-10-24: Phase 6 defaults

These were proposed alongside the questions, and the user raised no objection.

- **Keyframes:** per property. Transform, opacity, crop, volume and every number or colour setting of an effect can be animated.
  - Times count from the clip's start, as the model already stores them. A keyframe's interpolation shapes the stretch that follows it.
  - Colours blend channel by channel in linear light.
  - Each property in the inspector has a stopwatch, as in Premiere. Once a property is animated, changing it at the playhead adds or updates a keyframe.
  - Diamonds show on the selected clip in the timeline and can be dragged, one undo step per drag. A curve lane with Bézier handles sits under each animated property.
- **Effect format:** a folder per effect in `assets/effects/`, holding `effect.json` (id, name, category, version, settings and passes) and `effect.wgsl`, written against a small fixed prelude.
  - A build script finds the folders and embeds them in the WASM, so adding a folder adds an effect. naga validates every shader.
  - The inspector's controls are generated from the JSON.
- **Where effects run:** on the clip's picture after crop and before transform, at the size it is drawn.
  - Sizes are fractions of the picture, so a blur looks the same at 1/4 preview and in a 4K export.
  - Colour effects and LUTs work on sRGB-encoded values, as LUT files expect. Blurs, transitions and compositing stay in linear light.
- **Model:** `.cgvproj` format 3, with a migration from format 2.
  - Effects get an id and typed settings (number, colour, on/off, choice, file).
  - An adjustment layer is a clip without media.
  - Transitions are stored on their track, at the cut.
- **Transitions:** two-input shaders driven by progress from 0 to 1.
  - They sit on a cut between touching clips on one track, or on a clip's open edge, where they fade from or to transparent.
  - Cross dissolve is the default transition, 1 s long, on an editable shortcut.
  - Luma-wipe gradients are generated by our own script.
- **UI:** Effects and Transitions tabs beside Media, with each item previewed by the engine on a bundled sample frame. Dragging an item onto a clip or a cut applies it, and so does double-clicking it with clips selected.
- **Tests:**
  - A golden render of every effect and transition at fixed settings, on WebGPU and WebGL2, within the Phase 3 tolerance.
  - A keyframed-transform export compared with the preview by PSNR, as in Phase 5.
  - Real time: Gaussian blur, sharpen, LUT, vignette and noise stacked on a 1080p30 clip for 60 s on the GTX 1650 at Full, Chrome and Edge, with no dropped frames.
- **Pushing:** one push near the end of the phase, after the user's go-ahead.

## 2026-10-24: Phase 5 findings and defaults

Choices made while building the export pipeline.

- **Sound bitrate:** 96 kbit/s a channel for AAC and Opus, so 192 kbit/s stereo. This replaces the 256 kbit/s default: Windows' AAC encoder (Media Foundation, behind Chrome and Edge) takes at most 192 kbit/s and refuses more.
- **Encoder delay:** Chrome and Edge time their AAC and Opus chunks with the encoder's start-up delay already accounted for, so the export adds no correction.
  - Measured with a clip that flashes white at 1, 2.5 and 4 s and clicks at the same times. In MP4, WebM, MOV and MKV, decoded by FFmpeg, every click lands on its flash frame: 0.0 ms.
- **Colour conversion:**
  - The GPU writes NV12 as BT.709 limited range. Chroma is the mean of each 2×2 block, sited at its centre, as FFmpeg assumes when it decodes 4:2:0. Left-sited chroma, H.264's nominal default, decoded worse in FFmpeg (31.3 instead of 34.5 dB RGB on a sharp-edged frame).
  - The target packs four bytes a texel (RGBA8), luma rows then chroma rows. One readback is then an NV12 frame on WebGPU and WebGL2 alike; WebGL2 cannot reliably read single- and two-channel targets back.
- **Measuring PSNR:** on the Y'CbCr 4:2:0 planes, as codecs report it. FFmpeg converts the preview frame to the export's own format, and its `psnr` filter compares the planes.
  - RGB PSNR cannot reach 40 dB on frames with sharp edges between saturated colours, in any 4:2:0 file. A lossless 4:2:0 copy of the fixture frames reaches only 34.4 to 45.4 dB, and the exports come within 0.1 to 1.7 dB of that.
  - So the test also requires RGB PSNR within 6 dB of that ceiling, which catches a wrong matrix or a shifted picture (both cost well over 10 dB). The hardware encoders come within 1.7 dB; CI's software encoder (OpenH264) within 5 dB.
  - Comparing with the next frame of the moving clip, a control, gives 22.4 dB and must fail.
- **Encoding:**
  - The hardware encoder is used first (`prefer-hardware`), then the browser's choice, then software. VBR, `latencyMode: 'quality'`, a key frame every 2 s.
  - Each is tried on one black frame before the export starts. In CI's software GPU process (WARP), Chrome offers its hardware H.264 encoder, and picks it for "no preference", but it fails to start; only `prefer-software` (OpenH264) encodes there.
  - H.264 is High profile, HEVC Main, VP9 profile 0 and AV1 Main, all 8-bit, each at the lowest level that holds the frame size, rate and bitrate.
  - Exports decode in hardware where they can.
- **Quality and bitrates:**
  - Presets use YouTube's recommended SDR bitrates: 1080p 8 Mbit/s (12 at 48 fps and up), 4K 40 (60), TikTok 8 (12), Instagram 6 (9).
  - High, Medium and Low are 0.13, 0.08 and 0.05 bits per pixel per frame for H.264. HEVC, VP9 and AV1 get 0.65, 0.7 and 0.55 of the H.264 bitrate.
- **Frame rates:** an export at another rate shows, at each of its frames, the project frame showing at that moment. Frames are not blended.
- **Muxing:**
  - MP4 and MOV reserve space for their index at the front from the packet counts, which are known in advance.
  - WAV switches to RF64 past 4 GB.
  - Sound may trail the picture by at most 2 s before the export waits for it.
- **Saving on the web:** Chrome and Edge write through the save picker's file. Writes go to the browser's swap file until the end, so a failed export leaves an existing file as it was.
  - Elsewhere, the export goes to OPFS (`exports/`) and is downloaded. The copy is removed at the next export, once its download has long finished.
- **Saving on the desktop:**
  - The muxed bytes reach the native side through raw-body IPC calls, because Tauri channels only carry messages from native code to the webview.
  - They are written to a `.part` file beside the destination, renamed when complete.
  - GIFs come from an H.264 intermediate at three times the High bitrate, by default 640 px wide at 15 fps. FFmpeg makes one palette for the clip (`palettegen=stats_mode=diff`, Sierra dithering).
  - MP3s come from a WAV intermediate with `libmp3lame` at 128 to 320 kbit/s.
- **UI:**
  - Export sits in the header, with Ctrl+E for Filmora-like keys and Ctrl+M for Premiere-like keys.
  - The project file's web download is now called "Download project", so it is not mistaken for exporting video.

## 2026-10-24: Phase 5 answers

- **Codecs:** MP4 with H.264 and AAC is the default.
  - HEVC, VP9 and AV1 are offered only where the browser can encode them (`VideoEncoder.isConfigSupported`). WebM pairs VP9 or AV1 with Opus.
  - Opus replaces AAC where AAC encoding is missing.
  - On the reference machine, Chrome 156 and Edge 156 encode H.264 in hardware (1080p and 4K), AAC and Opus. They encode VP9 and AV1 in software only. Only Chrome encodes HEVC, in hardware.
- **Formats:** MP4 and WebM, plus MOV, MKV and WAV on web and desktop, and GIF and MP3 on desktop only.
  - Mediabunny already muxes MOV, MKV and WAV in the worker, so no FFmpeg is needed for them.
  - GIF and MP3 need FFmpeg, which only the desktop app has.
- **Free tier:** no limits in the MVP: no watermark and no resolution cap. Phase 11 adds the limits with licensing.
- **Desktop muxing:** Mediabunny in the export worker on both platforms. This replaces PLAN task 5's FFmpeg muxing.
  - The worker streams the muxed bytes to a native file writer over a Tauri channel. They are encoded packets in a container, never raw frames.
  - FFmpeg only converts the finished file to GIF or MP3.

## 2026-10-24: Phase 5 defaults

These were proposed alongside the questions, and the user raised no objection.

- **Export worker:** export runs in its own worker. A second engine instance, with its own WASM, GPU device and decoders, gets a copy of the project when the export starts.
  - Editing and preview carry on during an export. Later edits do not change an export that is running.
  - One export runs at a time.
- **Frame path:** `renderFrame(t)` at full quality for every frame. Every source is awaited and no frame is dropped.
  - Export decodes in hardware where it can, because the clip-end stall only hurts real-time playback.
- **Colour:** the compositor converts to BT.709 limited-range 4:2:0 on the GPU. The encoder gets I420 frames tagged BT.709, so the browser never chooses a matrix.
- **Audio:**
  - The `cgv-audio` mixer runs offline at the project rate.
  - AAC-LC, 48 kHz stereo at 256 kbps, or Opus in WebM.
  - The encoder's start-up delay is removed with an edit list, so sound starts at 0.
- **Presets:** YouTube 1080p (8 Mbps), YouTube 4K (40 Mbps), TikTok 1080×1920 and Instagram 1080×1080.
  - Custom settings: resolution, frame rate, quality or a bitrate, and format.
  - A preset with a different shape from the project fits the picture with black bars and says so.
- **Saving:**
  - Web: Chrome and Edge write straight into the file picked in the save dialog. Other browsers write to OPFS and download the file at the end.
  - Desktop: the native save dialog, opening in the Videos folder.
  - MP4 files keep their index at the front, which YouTube prefers.
- **Progress:** time remaining and Cancel, which removes the partial file.
  - The dialog can be closed while the export continues, with a progress chip in the project bar.
  - Leaving the page during an export asks first.
- **Tests:**
  - Fixture projects are exported in Playwright and decoded with the pinned FFmpeg. Each compared frame must be above 40 dB PSNR against the preview's render of the same frame.
  - A flash-and-click fixture measures the A/V offset.
  - Speed is measured on the GTX 1650 in Chrome, Edge and WebView2. CI checks function only.
- **Player checks:** Chrome playback is checked automatically. Windows Media Player is installed. VLC is not, and installing it needs the user's go-ahead. The YouTube upload needs the user's account, so the user uploads the files, unlisted.
- **Pushing:** one push near the end of the phase, after the user's go-ahead.

## 2026-10-24: Phase 4 findings and defaults

Choices made while building the timeline, the editing tools and the workspace.

- **Magnetic main track rules** (`cgv-model`):
  - The main track is a track id (`mainTrack`), so tracks added below it, such as detached sound, leave it the main track. It cannot be deleted.
  - Insert, overwrite and moves onto the main track happen at the cut nearest the given time. A moved block is lifted out first and goes in whole.
  - On the main track every trim ripples, whatever the command's ripple flag says. A delete closes the gap; so does a ripple delete, without moving other tracks.
  - After each edit the main track settles: its clips are packed from 0 in the order the edit left them, and clips linked to a main-track clip move by the same amount. A link follows the first main-track clip it holds.
  - Overlap checks wait until the main track has settled. Before that, a clip may overlap one that settling moves out of its way.
  - Format 1 projects open with magnetism off, so their edits stay exactly as they were. Turning it on closes the gaps as one undo step.
  - Sound cannot be detached onto the magnetic main track.
- **Moves across tracks:** the clips moved take their linked partners along in time, but the partners keep their own tracks. Video dragged to an overlay track leaves its sound where it is. A clip may not land on a clip that moves with it.
- **Clip property changes are patches:** a transform or crop change names only the values that change. The inspector sent whole transforms, and two quick edits (scale, then position) undid each other.
- **Pasting:** each copy carries its speed, transform, crop, opacity and volume (`ClipSpec.speed`, `ClipSpec.properties`).
  - Main-track copies go in one after another from the cut nearest the playhead. The other copies keep their offset to them, and copies that were linked are linked again.
  - A copy whose track is gone goes on the main track. A paste is one undo step.
- **Gestures:** a drag sends the whole gesture so far, and the engine applies it from where the gesture began (`Session::preview`). Steps are coalesced, so a slow engine is sent only the latest. A step that cannot apply keeps the last one that could, and releasing keeps that.
- **Main-track drags** insert at the cut nearest the pointer (not the clip's edge), so a clip passes its neighbour when the pointer passes the neighbour's middle.
- **Timeline geometry:**
  - Tracks are 58 px tall, under a 28 px ruler.
  - A 32 px drop zone above the top track makes a new track.
  - Edges grab within 7 px (a third of a short clip).
  - Zoom runs from 0.02 to 2,160 px a second (a frame at 30 fps is then 72 px).
  - The view fits the whole edit, and keeps fitting it as the edit changes, until the user zooms or scrolls along the timeline. Shift+Z (zoom to fit) returns to that. While playing, the view turns a page when the playhead nears the right edge.
  - The playhead is an element over the canvas, and playback state reaches only the components that show it, so playing never redraws the canvas or re-renders the workspace.
- **Tools:** the blade splits the clip it clicks, or every track with Shift. Ripple trims from the keyboard (trim start or end to the playhead) ripple their own track, as in Premiere.
- **Selection:** clicking a clip selects its linked clips too. Ctrl-click toggles, Shift-click adds, and dragging across empty space selects with a rectangle. Clips that disappear (undo, delete) leave the selection.
- **Shortcuts:**
  - Filmora-like: Ctrl+B splits; Alt+[ and Alt+] trim to the playhead; N snaps; Ctrl+= and Ctrl+- zoom; Shift+Z fits.
  - Premiere-like: Ctrl+K splits; Q and W trim to the playhead; S snaps; = and - zoom; \ fits.
  - Both: Space, J, K, L, the arrows (Up and Down move between edit points), Home, End, Delete, Shift+Delete, Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+A, Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Ctrl+S, M for a marker, V and C for the tools, and Esc to clear the selection or cancel a drag.
  - Keys do nothing while typing in a field or while a dialog or menu is open. Changing the preset starts from its own keys. Ctrl means Cmd on a Mac.
- **Per-user settings** (shortcuts, snapping, panel sizes) are kept in `localStorage` (`cgv.settings.v1`) in the browser and in the desktop app's WebView2 profile.
- **CG library integration:**
  - The dark theme and compact density are set on `<html>`, so menus the library opens outside the app take them too.
  - The editor's colours are mapped onto the library's tokens.
  - Some library styles read tokens no theme defines (`--cg-color-text` and others), and fell back to dark text on dark menus. The app defines them; worth fixing upstream.
  - The app's plain button and input styles sit in a CSS layer, so the library's own styles win.
  - The Phase 2 dialogs keep their small `Dialog` component. Panels (`CgSplitter`), menus (`CgContextMenu`), buttons and number fields (`CgNumericEdit`) come from the library.
- **Accessibility and tests:**
  - A visually hidden list names every clip and marker on the canvas, and a clip can be selected from it.
  - The canvas publishes its zoom and scroll as data attributes, so a time can be found on screen from the page alone.
- **Inspector:**
  - Scale is uniform. Crop goes to 95% a side. Speed takes presets or a value from 0.1× to 100×, as a reduced fraction to two decimals.
  - Dragging a field's label scrubs it, as one undo step (Shift for ×10, Alt for ×0.1). Typing a value sets it on Enter or when the field loses focus.

## 2026-10-24: Phase 4 answers

- **Main track:** magnetic, as in Filmora.
  - The bottom track is the main track. Its clips always butt together from 0, so delete, trim, move and insert close gaps automatically.
  - Other tracks place clips freely, and a main-track edit does not move them.
  - A toolbar toggle turns magnetism off per project. The flag is saved in `.cgvproj` (format version 2, with a migration from version 1).
- **Shortcuts:** both presets, with Filmora as the default.
  - Filmora-like keys are active at first. A Premiere-like preset can be chosen in settings.
  - Every key can be changed. The map is a per-user setting, not part of the project.
- **UI components:** the CG component library, `@cashgear/ui`.
  - It is pinned to a commit of its public GitHub repository, as ERPClient and ShippingApp do.
  - It is re-skinned through its tokens. The canvas timeline and the inspector's scrub fields are custom.
  - The license gate allows this first-party `UNLICENSED` package by name.
- **Theme:** dark only for now. Every colour is a token, the canvas timeline's included, so a light theme can be added later.

## 2026-10-24: Phase 4 defaults

These were proposed alongside the questions, and the user raised no objection.

- **Timeline drawing:** Canvas 2D on the page, drawn from engine snapshots.
  - Thumbnails and waveform peaks come from the jobs worker.
  - React draws only the headers, menus and overlays. Scrolling and zooming redraw the canvas without re-rendering React.
- **Selection, playhead and zoom** are UI state, never undo steps. Every edit is an engine command. A drag, or one gesture on an inspector control, is one undo group.
- **Dropping from the library:**
  - On the main track, a drop inserts.
  - On another track, it overwrites at the drop point.
  - Pasted clips land at the playhead on their own tracks. The clipboard holds only clips inside the app.
- **Snapping:** on by default, to clip edges, the playhead and markers, within 8 px.
  - A guide line shows the snap, and a toolbar toggle turns snapping off.
  - Tools are Select and Blade, as in Filmora.
- **Layout:** the library on the left, the monitor in the centre, the inspector on the right and the timeline at the bottom. Panel sizes are a per-user setting.
- **Inspector:** transform, crop, opacity and volume, and speed presets from 0.25× to 4× plus a custom value. Clips at other speeds stay silent until Phase 9.
- **Measurements:**
  - "60 fps with 500 clips" is measured from `requestAnimationFrame` frame times during scripted scrolling and zooming, on the reference machine's GTX 1650 in Chrome and Edge. CI checks function only.
  - "Built without code" is shown by a Playwright flow that builds a 5-minute, 30-clip edit with mouse and keyboard alone, never calling the `__cgv` test hooks.

## 2026-10-24: Phase 3 findings and defaults

Choices made while building the compositor, the audio engine and playback.

- **One frame path.** `renderFrame(t)` is three steps:
  - `plan_frame` in Rust (pure: the layers bottom first, each with its source time, transform, crop and opacity).
  - A source per layer.
  - Composition on the GPU.
  - Paused, seeking and (in Phase 5) exporting await their sources. Playing takes them from decoders running ahead, and a frame that is not decoded in time is dropped, never waited for.
- **Colour.**
  - Video R'G'B' is treated as sRGB-encoded, as browsers display it, so an untouched clip keeps its values. There is no BT.709 or BT.1886 curve conversion.
  - Hardware decoder frames are converted by the browser on the GPU; CPU frames by the compositor from their planes. The two agree within 2/255 (mean 0.07) on the same frame.
- **Composition.**
  - Layers become linear, premultiplied textures and blend into an `rgba16float` target. WebGL2 without float targets uses 8-bit sRGB storage, which still blends in linear light.
  - The result is shown over black, letterboxed in the monitor.
- **Geometry.**
  - Rotation is clockwise.
  - The anchor is the pivot for scale and rotation; moving it does not move the picture.
  - Crop hides edges without moving the rest.
  - Edges are smoothed analytically, so rotated layers have no jaggies on either backend.
  - Scales stay positive as Phase 2 requires; flips come with Phase 6's mirror effect.
- **Stills** are scaled down to the GPU's texture limit and get a mip chain averaged in linear light. Without mipmaps a still shown at an eighth of its size aliased, and differently on each GPU.
- **Playback decoders.**
  - Playback decodes frames up to 1080p in software where the browser can. Hardware decoders (Chrome and Edge on Windows, GTX 1650, driver 457.51) stall the browser's GPU process for 50 to 100 ms when a clip ends: they hand over their last frames at once.
  - With three tracks cutting together, that cost 2 to 11 frames a minute despite pooling, pacing and spacing out flushes. Software decoding played the same minute with none.
  - Larger frames, and codecs without a software decoder (HEVC), use hardware.
  - Seeks use hardware where they can: they are faster there, and a paused monitor does not mind the stall.
  - A hardware decoder the browser offers but cannot run (a software GPU process) falls back to the browser's choice.
- **Decoder handling.**
  - Playback decoders are pooled per medium, warmed up before the clock starts, and passed from clip to clip.
  - Upcoming clips (3 s ahead) decode one packet per playback tick.
  - Decoders ask for `optimizeForLatency`.
  - A decoder goes back to the pool without a flush when nothing is queued.
- **WebGL2** draws video frames from their planes: wgpu 30 copies VideoFrames into GL textures only with unstable web-sys APIs, and panics without them. Software WebGPU adapters do the same, since they cannot reach a hardware decoder's frames.
- **Audio.**
  - Decoded audio is kept in 1-second blocks at the project rate, decoded with 0.1 s of padding on each side, within a 64 MB budget.
  - Sources at another rate are resampled per block with `rubato` 5 (128-tap sinc, no FFT feature, to keep the WASM small). Each block's input starts on a whole sample, so blocks join at the same sub-sample phase; the remaining fixed offset is under half a sample.
  - The 5 ms edge fades are skipped where a clip continues the same audio (a split).
  - Clips at other speeds are silent until Phase 9's time-stretch. Of more than two channels, the first two are kept.
- **Sound output.**
  - A 2-second ring buffer, with 250 ms mixed ahead.
  - The heard sample comes from the worklet's (context time, ring frame) pairs and the page's `getOutputTimestamp`, both behind seqlocks. The last good reading covers a writer caught mid-update.
  - Playback follows the wall clock if the device's clock stays unreadable for 600 ms, and says why in the playback stats.
- **Pre-roll.** Playback starts when:
  - every layer has its first two frames decoded, and 0.3 s of sound is ready;
  - the first frame is drawn and the GPU has finished it.
  - It starts anyway after 1.5 s (3 s for the GPU).
  - A frame drawn now is taken to show one display refresh later.
- **A/V offset** is measured at every display refresh as the middle of the frame on screen minus the sound heard. A frame shown late therefore counts against sync too, not just as a drop.
- **Auto quality.**
  - It drops a level when two or more frames in a second are skipped although they were decoded in time (drawing is behind). Frames skipped for decoding never lower quality.
  - It steps back up after 3 calm seconds, doubling the wait each time a step up does not hold.
  - The GPU time in the stats is the latency from submission to the work-done callback, which includes waiting for the display, so it is shown but not used.
- **Shuttle.** Each J or L press restarts pre-roll at the new rate. Backwards playback reads each frame from its key frame through the seek path, so it is smooth only for short GOPs.
- **Golden tolerance.**
  - Mean difference at most 0.35 levels; at most 1.5% of pixels off by more than 8 and 1% by more than 16; no pixel off by more than 64.
  - Measured on every backend: at most a mean of 0.2, 0.54% and 0.32%, and 44.
  - Controls that must fail: 55% instead of 50% opacity (mean 0.77, 7.4% off by more than 8) and a 2-pixel shift (mean 2.6, 4.3% off by more than 16).
- **Diagnostics.** `?pattern=1` shows the Phase 0 test pattern for GPU checks. `?decode=software` or `?decode=hardware` (with `?diagnostic=1`) forces playback decoders for tests.

## 2026-10-24: Phase 3 answers

- **WebGL2 fallback:** stays in the MVP.
  - The same WGSL draws on both backends through wgpu, and golden tests run on both, as the exit criterion says.
  - The real-time target is measured on WebGPU. WebGL2 may need a lower preview quality.
- **Colour:** Rec.709 SDR only for now.
  - BT.709 and BT.601 sources convert with their own matrix and range.
  - HDR sources (PQ or HLG) get a simple tone map and a notice. A wide-gamut and HDR pipeline comes later.
- **Preview quality:** Full, 1/2 and 1/4, plus Auto.
  - Full is the project resolution.
  - Auto is the default. It drops one step when frames run late and steps back up after a few seconds with headroom.
  - When the GPU falls behind, frames are dropped, never delayed.
- **Blending:** compositing happens in linear light, as PLAN says, with premultiplied alpha and sRGB output. A 50% opacity looks a little brighter than in Filmora.

## 2026-10-24: Phase 3 defaults

These were proposed alongside the questions, and the user raised no objection.

- **Frames to the GPU:**
  - Decoder outputs go to the GPU with `copyExternalImageToTexture`, where the browser converts them on the GPU. That is correct for hardware frames.
  - Frames in CPU memory (software decodes and cached copies) upload their Y, U and V planes, and WGSL converts them with their own matrix. This avoids Chrome's BT.601 conversion.
- **Scale 1 means fit:** a clip whose size differs from the project's fits inside the frame at scale 1, keeping its aspect ratio, as in Filmora. Rotated media is shown upright first.
- **Audio:**
  - WebCodecs decodes in the engine worker, in blocks around the playhead, within a memory budget.
  - `cgv-audio` (WASM) mixes each clip's volume and track mute, with 5 ms anti-click fades at clip edges. Fade handles come in Phase 8.
  - `rubato` resamples to the project rate. The AudioContext runs at the project rate.
  - `engine-client` creates the AudioContext on the main thread, because workers cannot. UI components never touch it.
  - When no audio device runs, the clock falls back to `performance.now()`.
- **Shuttle:**
  - L plays at 1×, 2×, 4× and 8×, J the same in reverse, and K pauses.
  - Arrow keys step one frame, and Space plays or pauses.
  - Sound plays only at forward 1× until Phase 9 adds time-stretch. Scrubbing plays 80 ms snippets.
- **Monitor controls:** a simple scrub bar and timecode sit under the monitor until Phase 4 builds the timeline.
- **Golden tests:**
  - Small fixture projects render at 480×270.
  - Reference PNGs are rendered on the reference machine's WebGPU and committed to `tests/golden`.
  - Every backend must match them within a small per-channel tolerance: WebGPU, WebGL2 and CI's software GPUs.
- **Measurements:**
  - Real time means no dropped frames over 60 s of three stacked 1080p30 tracks, on the GTX 1650 in Chrome and Edge.
  - A/V drift compares the audio worklet's output timestamps with the time each video frame is shown. It runs for 10 minutes on the reference machine and 60 s in CI.
  - CI numbers are functional checks, never hardware performance.
  - The seek criterion is reported for frame-cache hits and for uncached seeks on local media.

## 2026-10-23: Phase 2 findings and defaults

Small choices made while building the model and the project UI.

- **Ripple scope:** ripple delete, ripple trim and insert shift later clips only on the tracks being edited.
  - Linked partners are always part of the edit, so a clip and its detached sound close their gaps together.
  - Clips on other tracks stay put. Phase 4's magnetic-track answer may add ripple across tracks.
- **Links:**
  - Delete, split, trim, roll, move, slip, slide and speed act on a clip's linked partners too.
  - Linked clips that touch on one track slide as one block. A property test found that sliding them one by one trimmed each other.
  - A slide finds neighbours where the clips stood before it, never among the clips that slide. In CI, the property test found a block that slid up against another linked clip and trimmed it.
  - A link left with one clip is cleared.
  - Overwrite and insert never split a linked partner on another track. A clip they cut into two keeps its link on the left part only.
- **Detach audio:** without a target track, the sound goes on a new track directly below the clip's track, so the picture stays above it.
- **Frame rate changes:** clips keep their times; later edits snap to the new rate. Only the 10 standard rates are allowed, because their frame boundaries are exact in flicks.
- **Numbers:** clip properties are `f64`. `serde_json` uses `float_roundtrip`, so files reload bit for bit. Times stay below 2^53 flicks (about 147 days) to remain exact in JavaScript.
- **Speed:** a reduced fraction from 0.1× to 100×. Changing it keeps the clip's start and source in point; its length follows, rounded down to whole frames. Stills have no speed and cannot be slipped.
- **Undo history:**
  - At most 10,000 steps.
  - Snapshots share unchanged tracks (`Arc`), so a step costs about the tracks it touched.
  - A command that changes nothing leaves no step. A group that ends where it started leaves no step and no unsaved changes.
- **Media bin edits are undoable:** import and remove are commands.
  - Removed files stay open in the engine, so undo brings them back at once.
  - Files no project uses are forgotten when a project opens: their IndexedDB record, OPFS copy and caches. Files remembered after that pass started are kept.
- **Relinking** updates the media in the current state and in every undo step. It is not an undo step itself, but it leaves unsaved changes.
- **Saving** records the generation that was written. A save that finishes after further edits marks the right state as saved.
- **New projects:** two empty tracks.
  - On the web, a new project is saved at once, so it is listed.
  - On desktop, a new project stays in memory until its first save or autosave.
- **Switching projects** with unsaved changes writes an autosave first. The changes are offered as a recovery when that project opens again.
- **Changed files:** a different size, or a different modified time, means a file changed. Browser copies in OPFS compare size only.
- **Phase 1 library:** on first start, remembered media goes into an "Untitled project". The web saves it at once; desktop leaves it for the first save or autosave.

## 2026-10-23: Phase 2 answers

- **Track model:** free tracks, as in Filmora.
  - Any clip type can go on any track. Higher tracks draw on top.
  - A video clip keeps its own sound. "Detach audio" moves the sound to a linked audio clip on another track.
- **Project defaults:** 1920×1080 at 30 fps with 48 kHz stereo audio.
  - Presets: 16:9, 9:16 (1080×1920), 1:1 (1080×1080), 4K UHD and custom.
  - Settings can be changed at any time.
- **Project file:** one versioned JSON `.cgvproj` file that points to media by path.
  - Thumbnails, waveforms and proxies stay in the app cache, linked to each media file, and are rebuilt when missing.
- **Web projects:** stored in the browser's private storage (OPFS), with a recent-projects list.
  - Autosave and recovery work in every browser.
  - Export downloads a `.cgvproj` file and Open imports one; its media then needs relinking.

## 2026-10-23: Phase 2 defaults

Proposed alongside the questions; the user raised no objection.

- **Media library per project:** each project has its own media bin. The Phase 1 library moves into the first project.
- **Time and IDs:**
  - Times are flicks, and every edit snaps to the project's frame boundaries.
  - Tracks, clips and markers get counter IDs within the project, so replays and undo give exactly the same result.
- **Undo history:** in memory only, not saved with the project. There is no small limit, because the exit test needs 1,000 undos.
- **Autosave:**
  - Every 30 s after a change, into app storage: OPFS on the web, the app data folder on desktop. It never overwrites the saved file.
  - On startup the app offers to recover when an autosave is newer than the last save.
- **Relink:**
  - A project with missing media opens a relink dialog that matches files by name, size and duration.
  - A source file that has changed (different size or modified time) drops its old proxy and caches. This closes the Phase 1 gap.
- **UI this phase:**
  - A project bar (New, Open, Save, Save As, Undo, Redo, Settings), the recovery prompt, the relink dialog and an "Add to timeline" action.
  - A plain read-only list of tracks and clips. The canvas timeline comes in Phase 4.
- **Pushing:** commits stay local, and every push needs the user's go-ahead, because each push to `main` redeploys video.cashgearerp.com. The plan is one push near the end of the phase.

## 2026-10-23: Azure Static Web Apps

- **Early web deploy:** the user connected the repository to Azure Static Web Apps ahead of Phase 11. The production host and domain are still the Phase 11 question.
- **Build:** the Azure workflow builds with the same pins as CI (Rust 1.99.1, Node 24, pnpm 12.11.2, wasm-bindgen 0.2.129 from `taiki-e/install-action`) and uploads `apps/web/dist` prebuilt, as `cashgear-fotoeditor` does. Oryx cannot detect or build this workspace.
- **Headers:** `apps/web/public/staticwebapp.config.json` sets COOP, COEP and CORP on every response, serves `.wasm` as `application/wasm`, caches `/assets/*` as immutable and sends `no-cache` for `/` and `/index.html`.

## 2026-10-23: Phase 1 answers

- **Demuxer:** Mediabunny (MPL-2.0), running in the engine worker. Our own WebCodecs decoder wrappers, decoder pool, frame-accurate seek and frame cache sit on top of its packet API.
- **Proxy format:** 720p H.264 MP4 with a keyframe every 0.5 s and AAC audio.
  - The encoder is the OS one where available: Media Foundation `h264_mf` on Windows, VideoToolbox on macOS. NVENC is used when the driver supports it.
- **Web, undecodable codecs:** the import is rejected with a message that names the codec and points to the desktop app. Nothing is uploaded.
- **Web storage:** File System Access handles where the browser has them (Chrome, Edge). Other browsers copy the file into OPFS.
- **FFmpeg on desktop:** `ffmpeg` and `ffprobe` run as child processes of the native side. There are no in-process libav bindings.
- **FFmpeg build:** a pinned BtbN LGPL shared release, fetched by `scripts/build-ffmpeg-lgpl.mjs`.
  - The script verifies the SHA-256 and rejects builds configured with `--enable-gpl` or `--enable-nonfree`.
  - The build is LGPL-3.0, because BtbN configures with `--enable-version3`.
- **Test media:** synthetic clips generated locally by `scripts/make-test-media.mjs` with the LGPL FFmpeg.
  - They are published once as a GitHub release asset, and `pnpm fetch-test-media` downloads them by SHA-256.

## 2026-10-23: Phase 1 findings and defaults

- **Dev machine:** FFmpeg 9.0.1 (`BtbN.FFmpeg.LGPL.Shared.9.0`) is installed with winget.
  - NVENC fails with driver 457.51 ("Cannot load cuMemAllocAsync"). It needs a newer NVIDIA driver.
  - `h264_mf`, `libopenh264`, `libkvazaar` (HEVC), `libvpx-vp9`, `prores_ks` and `libmp3lame` all work.
- **Pinned FFmpeg release:** BtbN `autobuild-2026-08-31-13-27`, 9.0 LGPL shared. BtbN keeps the last build of each month for longer than its daily builds.
- **Proxy encoder order:** `h264_nvenc`, then `h264_mf` (Windows) or `h264_videotoolbox` (macOS), then `libopenh264`.
  - `libopenh264` is a fallback for CI and development only. Before release we check whether shipping it carries H.264 patent obligations.
- **Proxies keep the original's frame grid:** `-fps_mode passthrough`, so frame N of the proxy is frame N of the source. They also keep its orientation (`-noautorotate`, so rotation stays metadata).
- **Decoder surfaces:**
  - The frame cache stores copies in the frame's own format (NV12 or I420), not decoder outputs.
  - At most 5 outputs are held as look-ahead for sequential reads, and frames before the target are closed as they arrive.
  - Holding more stalls hardware decoders: `flush()` never resolved before this change.
- **Chrome colour conversion:**
  - For CPU-backed YUV frames, Chrome's `drawImage` and `copyTo(RGBA)` use the BT.601 matrix even when the frame is tagged BT.709. That covers software-decoded I420 and NV12 copies.
  - Hardware frames convert correctly.
  - So seek tests compare raw I420 bytes with FFmpeg's decode, which is exact. Phase 3 converts YUV on the GPU with each frame's own matrix.
  - Until then, thumbnails of software-decoded video can be slightly off in colour.
- **Test media colour tags:** frames are tagged with `setparams` in the filter graph. FFmpeg encoders take colour metadata from frames, so `-color_*` output options alone left primaries and transfer "unknown".
- **HEVC:**
  - Chrome on this machine decodes HEVC in hardware.
  - WebView2 on Windows 10 needs the HEVC Video Extensions, so the desktop app proxies HEVC there.
  - CI's software Chrome cannot decode HEVC, so the web app refuses it with the codec-named message.
- **Mediabunny pin:** 1.61.3 (released 2026-10-05). Newer releases were days old.
- **Desktop file access:** the `cgv-media` protocol serves only registered ids. Responses are capped at 8 MiB per request, with CORS and `Cross-Origin-Resource-Policy: cross-origin` because the app is cross-origin isolated.

- **Targets:** Windows 10/11 x64 first, macOS second. Chrome and Edge come first on the web; Safari and Firefox are best-effort. CI builds the desktop app on Windows only for now.
- **Tooling:**
  - pnpm workspaces and GitHub Actions.
  - Work happens directly on `main` and is pushed to `MohamedSadat/cashgear-moviepro`.
  - The repository stays public.
- **Reference machine:** this development PC.
  - Intel Xeon E5-2680 v3 (12 cores at 2.5 GHz), NVIDIA GeForce GTX 1650, 32 GB RAM, Windows 10 Pro 22H2, WebView2 155.
  - All performance exit criteria are measured on it.
- **Naming:**
  - The repository keeps its name, `cashgear-moviepro`.
  - The product is "CashGear Video", Rust crates are `cgv-*`, npm packages are `@cgv/*`, and the Tauri identifier is `com.cashgear.video`.

## 2026-10-22: Phase 0 defaults

- **Toolchain pins:** Rust 1.99.1, Node 24, pnpm 12.11.2, wgpu =30.0.1, naga =30.0.1, wasm-bindgen and wasm-bindgen-cli =0.2.129, web-sys/js-sys 0.3.106, Tauri 2.12 (crate and `@tauri-apps/cli`/`@tauri-apps/api` 2.12.4), React 19.3.1, Vite 8.3.5, TypeScript 6.0.3, Vitest 4, Playwright 1.64.1, comlink 4.4.2 and binaryen 123.
  - These match `cashgear-fotoeditor`, which has already proved this stack on this machine and in CI.
  - TypeScript stays on 6.0.3 because typescript-eslint does not support TypeScript 7 yet.
- **wasm-bindgen-cli:** `pnpm setup:wasm` builds it from crates.io into `.tools/` (`cargo install --locked`), so no prebuilt binary is downloaded locally. CI installs it with `taiki-e/install-action`.
- **Product license:** proprietary. Crates have `publish = false` and `license = "LicenseRef-CashGear-Proprietary"`, npm packages are `private`, and there is no LICENSE file.
- **License allow-list:** the plan's list (MIT, BSD, Apache, MPL, Zlib, OFL for fonts), plus permissive licenses found in transitive dependencies.
  - Rust adds MIT-0, ISC, 0BSD, CC0-1.0, Unicode-3.0 and Unlicense.
  - npm also adds BlueOak-1.0.0.
  - GPL, AGPL, LGPL, SSPL and BUSL are denied.
  - cargo-deny checks Rust (`deny.toml`). `scripts/check-licenses.mjs` checks npm (`license-policy.json`): shipped packages must be allowed, and no package, dev tools included, may be denied.
  - RustSec advisories run in CI but do not fail the build.
- **Engine frame loop:**
  - The engine worker drives rendering with its own `requestAnimationFrame`, falling back to a 60 Hz timer. The main thread only sends resizes.
  - This keeps the frame path off the UI thread, ready for the playback clock in Phase 3.
- **Worker RPC:** comlink, with canvas transfer. Frame stats and fatal errors travel as plain worker messages.
- **Test pattern:** eight full-intensity color bars above a strip with a white sweep band that crosses the frame every 2 s.
  - Every channel is 0 or 255, so the colors read back exactly on both sRGB and unorm surfaces.
  - Browser tests sample the bars and check that the band moves.
- **Capability check:**
  - Blockers: no cross-origin isolation, failed shared memory, missing WebCodecs, OffscreenCanvas or AudioWorklet, and no GPU backend. A blocker shows a full-screen message.
  - Running on the WebGL2 fallback is a warning, shown as a notice; the status reads "degraded".
- **Release profile:** `opt-level = 3`, LTO and one codegen unit. The engine favours speed over size, and the release WASM has a 1.5 MB gzip budget.
- **Desktop bundle:** off (`bundle.active: false`) until Phase 11. CI builds the unbundled `cgv-desktop.exe` and drives it over CDP (`scripts/desktop-smoke.mjs`).
- **Test media:**
  - `pnpm fetch-test-media` reads `tests/media/manifest.json` and verifies SHA-256 for each clip. Clips stay out of git.
  - The manifest is empty until Phase 1 picks licensed clips.

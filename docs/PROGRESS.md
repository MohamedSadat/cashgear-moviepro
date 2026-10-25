# Progress

Newest phase first. Each phase lists the evidence for every exit criterion.

## Phase 6: Effects, transitions, keyframes (complete)

- **Completed:** 2026-10-25, tag `phase-6`.
- **CI:** [run 40166463139](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/40166463139) on commit `d06fdee`, green (License gates 38 s; Windows build and test 32 min 13 s).
  - The first run, [40161995901](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/40161995901) on `a15bb00`, failed two software-GPU tests. The monitor recovery test hit the pack-image copy error at engine start (see Local verification). The five-effects test never moved the playhead at 1080p on SwiftShader. Both were fixed before the green run.
  - The Azure Static Web Apps deploys of both commits succeeded.
- **Reference machine:** as in Phase 0: Xeon E5-2680 v3, GTX 1650 (driver 457.51), Chrome 156, Edge 156 and WebView2 155. Every performance number below comes from it; CI's software GPUs give functional results only.

### Shipped

- **Model (`cgv-model`, `.cgvproj` format 3):**
  - Clips carry effect stacks: each effect has an id, a kind, its pack and version, an on/off switch and typed settings. Format 2 projects migrate.
  - Keyframes on transform, opacity, crop, volume and every number or colour setting of an effect. Linear, hold, ease in, ease out, ease in-out and Bézier; colours blend in linear light.
  - Transitions live on their track at a cut, or at a clip's free edge, with start, centre or end alignment. Edits keep them valid: they move with splits, shrink or go with their clips, and never change the edit's length.
  - Adjustment layers are clips without media.
  - `.cube` LUTs (1D and 3D up to 65³) are stored in the project.
  - New commands for all of these, and a batch of property changes as one undo step.
- **Effects as data (`cgv-effects`, `assets/`):**
  - An effect or transition is a folder with `effect.json` (settings, passes, variants) and `effect.wgsl`, written against a shared prelude. The build embeds the folders; naga checks every shader and its WebGL2 translation.
  - The built-in pack: 21 effects and 26 transitions, six looks and six luma-wipe gradients, made by our own script.
- **Frame path (`cgv-engine`, `cgv-render`):**
  - The frame plan says, bottom up, which layers, transitions and adjustment layers to draw, with every keyframe applied.
  - Effects run in pooled textures on the visible part of a picture at its drawn size, so they look the same at 1/4 preview and in a 4K export.
  - Transitions draw each side alone, effects included, and blend them. Adjustment layers re-grade everything below.
  - LUTs and pack images are GPU textures, uploaded once.
  - The mixer applies volume keyframes as a gain envelope.
- **Editor (`ui`, `engine-client`):**
  - Effects and Transitions tabs beside Media: a searchable browser with previews drawn by a worker of its own. Drag onto a clip or a cut, or double-click; the adjustment layer is dragged or double-clicked in the same way.
  - The inspector's effect stack: add, reorder, switch off, reset and remove, with each effect's controls generated from its JSON.
  - A stopwatch on every animatable field, keyframe stepping and toggling at the playhead, and a curve lane with Bézier handles.
  - On the timeline: diamonds on the selected clip that drag, transitions drawn on their cuts, selected by click, lengthened by their edges and deleted with Delete. Ctrl+D adds the default cross dissolve at the playhead.
  - The transition inspector: type, length, alignment and settings. LUT settings import `.cube` files or use a built-in look.
- **Tests:**
  - Model: 16 effect, keyframe and transition tests; the property tests now also add effects, keys, transitions and LUTs.
  - Effects crate: the pack loads, every shader validates and translates for WebGL2, every image exists, settings pack and bad definitions are refused.
  - Engine and renderer: plans with keyframes, transitions and adjustment layers; effect sizes; the volume envelope. UI: interpolation and transition placement.
  - Playwright: golden renders of every effect and transition on both backends, an export fixture with keyframes, effects, a transition and an adjustment layer, two real-time tests and three editing flows.

### Exit criteria

| Criterion                                                                             | Result | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every built-in effect and transition has a passing golden test                        | Passed | `WebGPU golden renders of every effect and transition match the references` and its WebGL2 twin render 51 fixtures from `tests/fixtures/effects.json`: each of the 21 effects and 26 transitions (every variant) at fixed settings, plus an adjustment layer, keyframes mid-animation, a four-effect stack and a luma-wipe fade-in over a turned clip. The test fails if any catalogue item has no fixture, and every effect and transition must visibly change the picture. References are Chrome's WebGPU renders on the reference machine (2.1 MB of PNGs); the tolerance is Phase 3's (mean 0.35 levels, 1.5% of pixels off by more than 8, 1% by more than 16, none by more than 64). Chrome 156 and Edge 156: WebGPU matches exactly on 49 of 51 and within one level on the two blur fixtures; WebGL2 within one level everywhere (mean at most 0.003). Software GPUs (SwiftShader WebGPU, WARP and SwiftShader WebGL2): mean at most 0.103, 0.02% of pixels off by more than 8, worst 22. The Phase 3 compositor goldens still pass.                                                                                                                                                                                                           |
| A new effect can be added with only a shader file and a JSON schema                   | Passed | Duotone was added after the rest as commit `b5f4ce1`, `feat(effects): duotone`. It changes four files: `assets/effects/duotone/effect.json` (34 lines), `effect.wgsl` (7 lines), one fixture line in `tests/fixtures/effects.json` and its golden PNG. No Rust, TypeScript or build change. From those files alone it appears in the catalogue and the browser with a preview, its inspector shows two colour pickers and a slider, all three settings can be keyframed, and its golden passes on Chrome and Edge, WebGPU and WebGL2. `assets/README.md` is the authoring guide.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Keyframed transform plays smoothly and exports identically to preview                 | Passed | **Plays smoothly:** `a keyframed transform plays smoothly and as drawn when paused`: a 1080p30 clip moves 960 px across, grows from half size and turns 40° (ease in-out and ease out keys) while a keyed vignette fades in, for 10 s at Full. Chrome: 301 frames shown, 0 dropped, GPU latency mean 6.8 ms; Edge: 301, 0, 6.5 ms. The frame on screen when paused matches the paused render within the golden tolerance: mean 0.013 levels, 0.05% of pixels off by more than 16, all along the clip's bottom edge (Known gaps). Before the texture-size fix the same test dropped 29 frames, with GPU stalls of 220 ms. **Exports identically:** the `effects-keyframes` fixture in `tests/fixtures/export.json` keys scale and rotation (ease in-out) and the vignette's amount on the 1080p clip, adds saturation, dissolves over 12 frames into a still, and puts an adjustment layer at 80% over both. It is exported as 720p H.264 and compared with the preview's `renderFrame(t)` at frames 3, 14, 24, 30, 36 and 50, inside the keys, the dissolve and the adjustment layer. Chrome and Edge, WebGPU and WebGL2: 52.2 to 55.3 dB Y'CbCr (Y 52.5 to 58.8), RGB within 0.4 dB of a lossless 4:2:0 copy. CI's software encoder: 48.3 to 52.6 dB. |
| Five stacked effects on a 1080p clip still play in real time on the reference machine | Passed | `five stacked effects on a 1080p30 clip play in real time at full resolution`: Gaussian blur (radius 3% of the height, two passes), sharpen, the teal-orange look through the LUT effect, vignette and animated grain on every clip, played for 60 s at Full. Chrome 156: 1,801 frames shown, 0 dropped, GPU latency mean 10.9 ms (max 32.8), drawing 4.1 ms (max 12.3), A/V offset at most 14.8 ms. Edge 156: 1,800 frames, 0 dropped, GPU latency 9.4 ms (max 31.4), A/V offset at most 25.0 ms. Before the blur read texels in pairs, 20 s runs dropped one frame in two runs of three. The Phase 3 test of three stacked 1080p30 tracks still drops none (1,803 and 1,802 frames).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Local verification

| Check                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fmt, clippy `-D warnings` (native and wasm32) | Clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cargo test --workspace`                      | 204 passed (Phase 5: 161), FFmpeg conversions included. New: effects, keyframes, transitions, adjustment layers and LUTs in the model, format 3 migration, the effect catalogue and shader checks, frame plans with effects, effect sizes and the volume envelope.                                                                                                                                                                                                                   |
| Vitest                                        | 97 passed; 8 new: interpolation and transition placement                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Playwright, hardware: Chrome 156, Edge 156    | The full run passed 109 of 112. Three failures led to fixes: clicking a field's name pressed its stopwatch (it broke the Phase 4 inspector flow), and a new flow read a duration before the edit landed. The timeline spec then passed 22 of 22 on both browsers.                                                                                                                                                                                                                    |
| Playwright, software (`GPU_TEST_SOFTWARE=1`)  | The full run passed 60 of 64: the same two, the five-effects test and one GPU error at engine start. The error came back in CI's first run, failing the monitor recovery test: copying the grey luma-wipe gradients from bitmaps failed about one start in five on SwiftShader's WebGPU. Pack images now upload as bytes; 30 starts in a row pass. The five-effects test runs at 640×360 on software GPUs and checks function only. The affected tests then passed three times each. |
| Desktop smoke, WebView2 155                   | Passed on hardware after updating its project format check to 3: media, a saved project that reopens, recovery, playback (91 frames, 0 dropped) and exports (a 12 s 720p MP4 in 2.8 s, GIF, MP3). The engine and the export worker load the pack's images under `tauri.localhost`, and still pass after the images moved to bytes.                                                                                                                                                   |
| Licenses                                      | cargo-deny ok: `cgv-effects` adds no third-party crate (naga was already in the workspace). npm 155 packages, unchanged. The GPL self-test rejects both fixtures.                                                                                                                                                                                                                                                                                                                    |
| Release WASM                                  | 3,979,783 bytes; gzip 1,483,421, within the 1,500,000 budget (Phase 5: 1,314,715), with the catalogue, model and JSON built for size                                                                                                                                                                                                                                                                                                                                                 |

### Known gaps

- Only the built-in pack exists: no installing, store or third-party packs yet, as agreed.
- Choice, switch and LUT settings cannot be keyframed; numbers and colours can.
- A transition sits between touching clips on one track. There are no transitions between tracks, and one per edge.
- Paused frames and exports of 4:2:0 video show the picture's last row with its colour a quarter weaker than the browser and FFmpeg show it (decisions). It predates this phase and is worth fixing next.
- Keyframed layers run their effects up to 1/16 larger than drawn, then scale down.
- Effect previews in the browser are drawn on two painted pictures, not on the user's media.
- Real time was measured at 1080p30 with five effects. Heavier stacks, 4K and WebGL2 were not measured; Auto quality lowers the preview when frames drop.
- Release WASM is 17 KB under the 1.5 MB gzip budget. Phase 7's text engine will need the budget revisited or more size work.
- The browser's effect previews are not covered by the desktop smoke.
- Firefox and Safari (best-effort) were not tried.

## Phase 5: Export pipeline (MVP complete)

- **Completed:** 2026-10-24, tag `v0.1.0-mvp`.
- **CI:** [run 40116662195](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/40116662195) on commit `13869c9`, green (License gates 9 min 54 s; Windows build and test 26 min 9 s).
  - It ran 161 Rust tests, the real FFmpeg conversions among them, and 56 software-GPU browser tests, with no retries; the export spec took 6.6 min there.
  - The desktop smoke exported the recovered timeline in WebView2 on software rendering: MP4 in 128 s, GIF in 20 s, MP3 in 0.3 s.
  - The Azure Static Web Apps deploy of the same commit succeeded.
- **Reference machine:** as in Phase 0: Xeon E5-2680 v3, GTX 1650 (driver 457.51), Chrome 156, Edge 156 and WebView2 155. Every performance number below comes from it; CI's software GPUs and encoders give functional results only.

### Shipped

- **One frame path, now to a file (`cgv-render`, WGSL):**
  - Export frames go through the preview's `renderFrame(t)` at full quality, every source awaited, nothing dropped.
  - The composition, over black, becomes BT.709 limited-range Y'CbCr 4:2:0 on the GPU. It is packed so that one RGBA8 readback is an NV12 frame, on WebGPU and WebGL2 alike. The encoder never picks a colour matrix.
  - An export of another shape centres the picture on whole pixels between black bars.
- **Export worker (`engine-client`):**
  - Each export runs in its own worker, with its own engine, GPU device, decoders and a copy of the project. Editing and preview carry on, and later edits do not change it.
  - WebCodecs encoders, each tried on one frame first: hardware, then the browser's choice, then software. H.264 High, HEVC, VP9 and AV1 at the lowest level that fits; AAC or Opus sound.
  - Mediabunny muxes MP4 and MOV (index at the front), WebM, MKV and WAV into the picked file, OPFS or the desktop's native writer.
  - Sound is mixed offline by the playback mixer and kept within 2 s of the picture.
- **Desktop (`cgv-native`, Tauri):**
  - The native side writes the muxed bytes at their positions into a `.part` file beside the destination, renamed when complete, so a failed export never touches an existing file.
  - GIF and MP3 are made by FFmpeg from an intermediate MP4 or WAV, with progress and cancel. Proxies and conversions share one FFmpeg job runner.
  - Closing the window during an export asks first. Leftover intermediates are cleared at startup.
- **Export dialog (`ui`):**
  - Export sits in the header: Ctrl+E, or Ctrl+M with Premiere-like keys.
  - Presets: YouTube 1080p and 4K, TikTok 9:16 and Instagram 1:1.
  - Settings: format, size, frame rate, codec (only those the browser encodes, hardware marked), quality or bitrate, and sound.
  - Notes for black bars and missing files, and an estimated size.
  - Progress shows time left and speed, with Cancel. Hide keeps the export running behind a header chip.
  - Web: the save picker where the browser has it, else OPFS and a download. Desktop: the native save dialog, opening in Videos.
  - The project file's web download is now called "Download project".
- **Tests:**
  - Unit tests for settings, codec levels, bitrates, frame timing, the dialog form and progress estimates.
  - Native tests for the export writer and the FFmpeg arguments, plus real GIF and MP3 conversions.
  - Seven Playwright export tests: round-trip PSNR on WebGPU and WebGL2, A/V sync in four containers, the dialog, cancel, formats and speed.
  - Exports in the desktop smoke.

### Exit criteria

| Criterion                                                                                    | Result                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exported files play correctly in VLC, Chrome, Windows Media Player and pass a YouTube upload | Passed, except YouTube: pending, by the user | **Chrome:** `the export dialog saves through the save picker while editing goes on` exports through the dialog and plays the MP4 in a `<video>` element: 1080×1080, 4.01 s, frames shown, no error (Chrome 156, Edge 156, software Chrome). **VLC 3.0.24**, headless with its scene filter saving decoded frames: MP4, MOV and MKV (H.264 with AAC or Opus), WebM (VP9 and AV1, the latter through dav1d), HEVC MP4, 23.976 fps MOV and WAV all decode, with frames saved for each video. **Windows Media Player**, played through its own engine (`WMPlayer.OCX`): MP4, MOV, MKV with Opus, 23.976 fps MOV and WAV reach the playing state, at the right size and length, with the position advancing. Legacy WMP cannot open WebM at all, and shows HEVC without picture on this machine, which lacks Microsoft's HEVC Video Extensions. **YouTube:** `bench/results/youtube/` holds a 60 s 1080p30 sample (H.264 High 7.2 Mbit/s, AAC, 55 MB) and a 20 s 4K30 sample (33 Mbit/s, 83 MB). The user tags without waiting and uploads them later (decisions). |
| Preview-to-export PSNR is above 40 dB on all fixture projects                                | Passed                                       | `WebGPU exports match the preview above 40 dB` and its WebGL2 twin use four fixtures from `tests/fixtures/export.json`: YouTube 1080p, three layers with crop, rotation, opacity and a 25 fps clip at 720p, TikTok 9:16 with a still, and stills with sound in WebM (VP9 and Opus). Each is exported at its project's size and decoded by the pinned FFmpeg. PSNR is measured on the Y'CbCr 4:2:0 planes, as codecs report it, against the preview's `renderFrame(t)` converted by FFmpeg (decisions). Chrome and Edge, both backends: 46.5 to 55.3 dB (Y 47.4 to 58.1). By fixture: 53.2–55.0, 50.3–52.0, 53.7–55.3 and 46.5–53.3. RGB PSNR is 0.1 to 1.7 dB below what a lossless 4:2:0 copy of the preview reaches, at 34.4 to 45.4 dB; sharp edges between saturated colours cannot survive 4:2:0 in any file. The control, the next frame of the moving clip, gives 22.4 dB and fails as it must. CI's software encoder: 44.0 to 53.6 dB.                                                                                                                |
| A/V offset in exports is under one frame                                                     | Passed, 0.0 ms                               | `exports keep picture and sound in sync in every format`: a clip that flashes white at 1, 2.5 and 4 s, with clicks at the same times on another track. It is exported as MP4 (H.264, AAC), WebM (VP9, Opus), MOV (H.264, AAC) and MKV (H.264, Opus), and decoded by FFmpeg (edit lists applied). Every click starts on its flash frame to the sample: offset 0.0 ms in all twelve on Chrome, Edge and software Chrome. AV1 in MKV gave the same by hand. One frame is 33.3 ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A 1-minute 1080p30 project exports faster than real time on the reference machine            | Passed                                       | `a one-minute 1080p30 project exports faster than real time`: six 10 s cuts of the 1080p30 H.264 clip on the main track with music under them, exported as YouTube 1080p (H.264 8 Mbit/s, AAC). Chrome 156: 12.4 s, 4.9× real time; Edge 156: 12.9 s, 4.7×. Earlier runs: 12.6 and 12.1 s. WebView2 155 (the desktop app, same project): 15.7 s, 3.8×. All use the hardware encoder; 1,800 frames each. A 20 s 4K30 export took 12.1 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Local verification

| Check                                             | Result                                                                                                                                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fmt, clippy `-D warnings` (native and wasm32)     | Clean                                                                                                                                                                                                                                               |
| `cargo test --workspace` (`CGV_REQUIRE_FFMPEG=1`) | 161 passed. New: the BT.709 export matrix and its inverse, export geometry and NV12 packing, the export writer, FFmpeg GIF and MP3 arguments, and a real GIF and MP3 conversion with cancel.                                                        |
| Vitest                                            | 89 passed; 14 new: export settings 7, progress 2, the dialog form 5                                                                                                                                                                                 |
| Playwright, hardware: Chrome 156, Edge 156        | 98 passed, the 14 export tests among them; the Phase 1 to 4 suites unchanged                                                                                                                                                                        |
| Playwright, software (`GPU_TEST_SOFTWARE=1`)      | The export spec passed: 7 on SwiftShader WebGPU and the WebGL2 test on SwiftShader WebGL2. The first runs found that the hardware H.264 encoder Chrome offers there cannot start, which led to the software fallback.                               |
| Desktop smoke, WebView2 155                       | Passed on hardware. New export step on the recovered project, including the ProRes clip through its proxy: a 12 s 720p MP4 written natively in 2.6 s, then a GIF (120 frames at 320×180) and an MP3 converted by FFmpeg, each checked with ffprobe. |
| Licenses                                          | cargo-deny ok, no new crates. npm 155 packages, unchanged: Mediabunny was already shipped. The GPL self-test rejects both fixtures.                                                                                                                 |
| Release WASM                                      | 3,551,894 bytes; gzip 1,314,715, within the 1,500,000 budget (Phase 4: 1,311,461)                                                                                                                                                                   |

### Known gaps

- Media that plays through a desktop proxy (ProRes, and HEVC where WebView2 lacks it) exports from its 720p proxy, not the original.
- On frames with sharp edges between saturated colours, RGB PSNR is limited by 4:2:0 chroma, as in any H.264, VP9 or AV1 file. Three fixtures sit at 34 to 37 dB, within 1.7 dB of what a lossless 4:2:0 copy reaches. The 40 dB criterion is measured on the Y'CbCr planes (decisions).
- Windows' AAC encoder stops at 192 kbit/s, below YouTube's recommended 384 kbit/s for stereo.
- VP9 and AV1 encode in software on this machine; only Chrome offers HEVC.
- An export at another frame rate repeats or skips project frames; it does not blend them.
- Clips at other speeds export silent, as they play, until Phase 9.
- One export runs at a time, with no queue. The dialog starts from the preset that matches the project each time, not from the last export's settings.
- Legacy Windows Media Player cannot open WebM; WebM is for browsers.
- Firefox and Safari (best-effort) were not tried; they would take the OPFS-and-download path.
- No 10-bit or HDR export.
- The YouTube upload of the samples is pending, by the user.

## Phase 4: Timeline UI and editing tools (complete)

- **Completed:** 2026-10-24, tag `phase-4`.
- **CI:** [run 40101632403](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/40101632403) on commit `8e299fe`, green (License gates 1 min 8 s; Windows build and test 19 min 46 s).
  - It ran 153 Rust tests and 48 software-GPU browser tests, the eight timeline flows and the 500-clip test among them.
  - One Phase 3 test passed on retry (see Known gaps).
  - The desktop smoke played the recovered project in WebView2 on software rendering: frame 86 reached on the audio clock, Auto at 1/4.
  - The Azure Static Web Apps deploy of the same commit succeeded.
- **Reference machine:** as in Phase 0: Xeon E5-2680 v3, GTX 1650 (driver 457.51), Chrome 156, Edge 156 and WebView2 155. Every performance number below comes from it; CI's software GPUs give functional results only.

### Shipped

- **Magnetic main track (`cgv-model`, `.cgvproj` format 2):**
  - New projects have a main track (the bottom track, kept by id, never deleted) that is magnetic. Its clips butt together from 0.
  - Inserts, overwrites and moves onto it land at the nearest cut. Trims ripple, gaps close as each edit settles, and clips linked to its clips follow. Other tracks stay put.
  - Magnetism can be switched off per project. Format 1 projects open with it off, so their edits do not change.
  - Moving clips across tracks takes their linked partners along in time only.
  - Clip specs carry speed and properties, for pasting. Property changes are patches of the values that change.
  - `Session::preview` lets a drag show each step from where it began, as one undo step.
- **Workspace (`@cashgear/ui`):**
  - Library, monitor and inspector sit above the timeline in resizable CG splitters, with sizes kept per user.
  - Dark and compact throughout, CG menus included.
- **Canvas timeline:**
  - One Canvas 2D draws the ruler, tracks and clips: names, filmstrips decoded off the main thread, waveforms from halving peak pyramids, speed, offline media.
  - It also draws markers, snapping guides and drop previews, and only what is in view.
  - The playhead is an element over the canvas, so playing never redraws it.
  - The view fits the whole edit until the user zooms or scrolls along it.
  - Track headers lock, mute, hide, rename, reorder and delete, and mark the main track.
  - A hidden list names every clip and marker for screen readers.
- **Editing:**
  - Select, Ctrl- and Shift-click, and rectangle selection; linked clips select together.
  - Moves across tracks and onto the main track, edge trims, the blade, split at the playhead, delete and ripple delete.
  - Copy, cut and paste with links, markers that drag and snap, detach audio, link and unlink.
  - Media dragged from the library onto any track or a new one.
  - Snapping to edges, the playhead and markers within 8 px, with a guide.
  - Each drag or slider gesture is one undo step, previewed live by the engine.
- **Inspector:** position, scale, rotation, opacity, crop, volume and speed (presets and a value), typed or scrubbed by dragging a label.
- **Shortcuts:** every key goes through one map, with Filmora-like (default) and Premiere-like presets and a settings dialog to change keys. Settings, snapping and panel sizes are per user.
- **Tests:**
  - Model: magnetic rules, previews and patches. The property tests now run with and without magnetism and check that linked clips stay in step with the main track.
  - Unit tests for the key map, geometry, waveform pyramids and paste planning.
  - Eight Playwright editing flows, and the 500-clip scroll and zoom measurement.

### Exit criteria

| Criterion                                                                     | Result | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 5-minute edit with 30 clips can be built without touching code or dev tools | Passed | `a five-minute edit with 30 clips is built with the mouse and keyboard alone` opens the app without `?diagnostic=1`, so no test hooks exist, and reads only the page. Files come in through the Import picker. 24 clips are added with Add to timeline. Two stills are dragged onto the end of the main track and stretched to 32 s by dragging their ends. Two titles go on a new track by dropping above the tracks, and two music clips on another. One clip is reordered by dragging. Two markers are added with the ruler and M, and the music is turned down to −12 dB in the inspector. Result: 30 clips, 5:04, and a main track of 26 clips without gaps. Passes on Chrome 156 and Edge 156 (hardware) and in CI (software).                                  |
| The timeline scrolls and zooms at 60 fps with 500 clips                       | Passed | `the timeline scrolls and zooms at 60 fps with 500 clips`: four tracks of 125 two-second clips (video, stills and sound, each with a filmstrip or waveform), one wheel event per display frame. Zoom: 240 frames from the whole edit (all 500 clips on screen) to close up and back. Scroll: 300 frames across the edit. Chrome 156: zoom frame interval p95 16.7 ms, 1 frame of 240 at 33 ms, draw mean 2.1 ms, p95 5.2 ms, max 10.5 ms; scroll every frame on time (max 16.8 ms), draw p95 3.1 ms. Edge 156: zoom and scroll every frame on time (max 16.8 ms), draw p95 4.7 and 3.2 ms. The first pass over a new project, which decodes each thumbnail and uploads it to the GPU, is recorded too: Chrome lost 4 of 240 frames there (max 50 ms), Edge 1 (33 ms). |
| Every action can be undone and redone                                         | Passed | Every edit in the UI is an engine command, and each drag or slider gesture is one undo step (`Session::preview`). Selection, zoom, scrolling, the playhead, tools, snapping, panel sizes and shortcut settings are not edits (decisions). `random_edits_keep_every_rule_and_undo_exactly` (with and without magnetism; 7,680 extra cases run locally) and the 1,000-command runs (8 seeds, 4 magnetic) undo and redo every command exactly. In the browser, `clips move, trim, split and delete with the mouse and keys, and each step undoes` walks Ctrl+Z back through every state and Ctrl+Y forward again. The paste, track header and inspector flows undo their steps too.                                                                                      |
| Playwright flows pass in CI                                                   | Passed | [Run 40101632403](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/40101632403) ran all eight timeline flows and the 500-clip test on the runner's software GPU (SwiftShader WebGPU). All passed first time, the five-minute edit included. The 500-clip timings there (zoom frame interval p95 44 ms, scroll 17 ms) check function only. 47 of 48 browser tests passed first time; a Phase 3 test passed on retry (Known gaps).                                                                                                                                                                                                                                                                                                                        |

### Local verification

| Check                                             | Result                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fmt, clippy `-D warnings` (native and wasm32)     | Clean                                                                                                                                                                                                                                             |
| `cargo test --workspace` (`CGV_REQUIRE_FFMPEG=1`) | 153 passed. New: 10 magnetic main track tests, gesture previews, property patches, format 1 migration; property tests in both modes.                                                                                                              |
| Vitest                                            | 75 passed; 26 new: key map 9, geometry 9, paste 4 and copy 2, waveform pyramid 2                                                                                                                                                                  |
| Playwright, hardware: Chrome 156, Edge 156        | 84 passed, among them the eight timeline flows and the 500-clip measurement on each browser. Real-time playback (Phase 3) still holds: three 1080p30 layers for 60 s with 0 dropped frames, worst A/V offset 15.5 ms (Chrome) and 18.0 ms (Edge). |
| Desktop smoke, WebView2 155                       | Passed on hardware: media, a saved project that reopens, recovery after a hard kill, and playback (92 frames in 3 s, 0 dropped)                                                                                                                   |
| Licenses                                          | cargo-deny ok. npm 155 packages: `@cashgear/ui` is allowed by name as first-party (`UNLICENSED`), and its bundled PDF.js, Leaflet, Tiptap and DOMPurify are permissive. The GPL self-test rejects both fixtures.                                  |
| Release WASM                                      | 3,541,365 bytes; gzip 1,311,461, within the 1,500,000 budget (Phase 3: 1,295,298)                                                                                                                                                                 |

### Known gaps

- The first time a thumbnail is drawn, the browser uploads it to the GPU. The first zoom across a new project can lose a few frames.
- While playing, a page turn redraws the timeline. A view zoomed in closely can then cost a frame near a cut on a busy machine.
- There are no slip, slide or roll tools with the mouse yet; the model has those commands. Trims to the playhead and edge trims cover common work.
- Markers cannot be renamed from the UI yet: they can be added, dragged, recoloured and deleted.
- Tracks are named by position ("Track 2") unless renamed. There are no video and audio track kinds.
- Dragging does not scroll the timeline when the pointer reaches its edge.
- Only the dark theme exists, as agreed.
- The Phase 2 dialogs still use the app's own dialog, not the CG window.
- The CG library reads some tokens no theme defines (`--cg-color-text` and others); the app defines them. Worth fixing upstream.
- Clips at other speeds stay silent until Phase 9.
- In CI, the Phase 3 test `picture and sound stay within one frame while playing` passed on retry. Its timeline is only 5 s longer than the 60 s it plays. On the slow software runner, the Pause click came after playback had ended, so the click started playback again. The test needs a longer timeline.

## Phase 3: GPU compositor, audio engine, real-time playback (complete)

- **Completed:** 2026-10-24, tag `phase-3`.
- **CI:** [run 40083555684](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/40083555684) on commit `234f59b`, green (License gates 27 s; Windows build and test 12 min 46 s).
  - It ran 141 Rust tests and 38 software-GPU browser tests, golden renders included; one Phase 0 test passed on retry (see Known gaps). The desktop smoke played the recovered project in WebView2 on software rendering: frame 103 reached on the audio clock, Auto at 1/4.
  - The first run, [run 40082250051](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/40082250051) on `76c2ceb`, failed one timing check: three 1080p layers on the runner's software GPU take about a second a frame, too slow for the page to time playback to 10%. Sound and clock were fine (0 underruns). `234f59b` checks only function there.
- **Reference machine:** as in Phase 0: Xeon E5-2680 v3, GTX 1650 (driver 457.51), Chrome 156, Edge and WebView2 155. Every performance number below comes from it; CI's software GPUs give functional results only.

### Shipped

- **One frame path, `renderFrame(t)`:**
  - `plan_frame` (Rust, pure) lists the layers of a project frame, bottom track first, with source time, transform, crop and opacity.
  - The worker gathers a source per layer, and the engine composes them on the GPU.
  - Paused and seeking, sources are awaited. Playing, they come from decoders running ahead, and a late frame is dropped. Export (Phase 5) will await them, like a seek.
- **Compositor (`cgv-render`, WGSL):**
  - Frames become linear, premultiplied textures. GPU-backed decoder frames are copied by the browser. CPU frames upload their Y'CbCr planes and convert with their own matrix and range (BT.709, BT.601, BT.2020; simple PQ and HLG tone map).
  - Layers blend in linear light into an `rgba16float` target (8-bit sRGB on WebGL2 without float targets).
  - Transform (position, scale, clockwise rotation, anchor as pivot), crop and opacity, with analytic edge smoothing.
  - Scale 1 fits the picture in the frame; media rotation shows it upright.
  - Stills get a linear-light mip chain.
  - The result is shown letterboxed over black, or read back as sRGB bytes.
  - A texture pool is reused across frames.
- **Audio (`cgv-audio`):**
  - Decoded audio is kept in one-second blocks at the project rate, resampled with `rubato` 5 (sinc) when the source rate differs.
  - Mixing applies clip volume, track mute and 5 ms fades at clip edges (none at seamless cuts), and maps mono, stereo and wider sources.
  - The mixed sound goes to a SharedArrayBuffer ring that an AudioWorklet plays.
- **Playback (`cgv-engine`, `engine-client`):**
  - The clock is the sample the listener hears (worklet position plus `getOutputTimestamp`), with the wall clock as fallback.
  - Pre-roll waits for the first frames, 0.3 s of sound and the GPU.
  - Decoders are pooled per medium, warmed before the clock starts and passed from clip to clip; upcoming clips start 3 s ahead at one packet per tick. Playback decodes up to 1080p in software (see decisions).
  - Auto quality, J/K/L at 1×, 2×, 4× and 8× each way, frame steps and 80 ms scrub snippets.
  - Per-refresh A/V offset, drops and render times are kept for the dev overlay and the tests.
- **Monitor UI:** transport buttons, timecode, a scrub bar, the quality menu (Auto, Full, 1/2, 1/4), keyboard shortcuts (Space, J/K/L, arrows, Home and End), a no-sound notice, and frame times in the dev overlay.
- **Tests:**
  - Golden renders of 7 fixtures on both backends, with negative controls.
  - Barcode-exact `renderFrame(t)`.
  - Playing-against-paused colour parity.
  - Seek latency, three-track real-time playback and A/V sync.
  - Shuttle and keys.
  - Ring-buffer, mixer, plan, transport, governor and stats unit tests.
  - Playback in the desktop smoke.

### Exit criteria

| Criterion                                                                                                | Result | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Three stacked 1080p30 H.264 tracks play in real time at full preview resolution on the reference machine | Passed | `three stacked 1080p30 tracks play in real time at full resolution`, quality forced to Full. Three tracks of the 1080p30 H.264 test clip (cut every 10 s on all three at once, the worst case), the top two at 50% opacity, 60 s on the audio clock. Chrome 156: 1,802 frames shown, 0 dropped, 0 late, worst A/V offset 28.6 ms. Edge 155: 1,803 shown, 0 dropped, 0 late, worst 20.7 ms. 0 sound underruns; render time 7.8 to 9.6 ms mean, 22.5 ms worst. Earlier runs of the same test also dropped none. The desktop smoke plays the recovered project in WebView2: 90 frames in 3 s, 0 dropped.                                                             |
| A/V drift stays under one frame over 10 minutes of playback                                              | Passed | `picture and sound stay within one frame while playing` with `CGV_DRIFT_SECONDS=600`. The offset is the middle of the frame on screen minus the sound heard (worklet position and `getOutputTimestamp`), sampled at every display refresh. Chrome: 36,002 samples, worst 17.3 ms, p99 16.75 ms, mean +2.6 ms, 18,001 frames shown, 0 dropped, 0 underruns. Edge: 36,000 samples, worst 22.3 ms, p99 13.5 ms, mean +1.0 ms, 18,000 shown, 0 dropped, 0 underruns. One frame is 33.3 ms. The picture follows the sound clock, so the offset does not grow. The display pipeline after the next refresh is not visible to the page, which counts one refresh for it. |
| Golden tests for transform, crop and opacity pass on both GPU backends                                   | Passed | `WebGPU golden renders of transform, crop and opacity match the references` and its WebGL2 twin. Seven fixtures from `tests/fixtures/golden.json`: fit, 9:16 letterbox, transform, anchor and rotation, crop, opacity, alpha. They pass on Chrome and Edge (GTX 1650, both backends; WebGPU matches the references exactly), SwiftShader WebGPU and WebGL2, and WARP WebGL2. The tolerance (decisions) is set from those runs. Renders at 55% instead of 50% opacity, and shifted by 2 pixels, must fail it, and do.                                                                                                                                              |
| A seek on cached media shows the frame in under 100 ms                                                   | Passed | `seeks show the frame within 100 ms`: from the page's seek call until the frame is composed and presented. 30 cached frames: worst 8.5 ms (Chrome) and 9.1 ms (Edge), median 5.4 and 5.8 ms; across all runs never over 14 ms. The same 30 frames uncached, decoded from the key frame before them (one a second): median 60 and 68 ms, p95 97 and 101 ms, worst 115 and 143 ms. The test guards uncached seeks at 150 ms.                                                                                                                                                                                                                                        |

Also checked: `renderFrame(t) shows the exact source frame at any seek` reads the frame-number barcode from the composition at 10 frames in any order, on both backends. Rendering the same time twice gives identical bytes. A 25 fps clip on a 30 fps timeline shows the right source frame. The same frame drawn while playing (hardware frame, converted by the browser) and paused (planes, converted by the compositor) differs by at most 2 levels, mean 0.07.

### Local verification

| Check                                             | Result                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fmt, clippy `-D warnings` (native and wasm32)     | Clean                                                                                                                                                                                                                                                                                                                    |
| `cargo test --workspace` (`CGV_REQUIRE_FFMPEG=1`) | 141 passed. New: render 18 (geometry, colour, both shaders translated to GLSL ES for WebGL2), audio 9 (blocks, resampling in tune and in phase across blocks, fades, channel mapping, budget), engine 15 (plan, audio plan, transport, Auto governor, stats).                                                            |
| Vitest                                            | 49 passed, 6 of them for the audio ring (wrap-around, underruns, flush, heard-sample clock, mid-update readings)                                                                                                                                                                                                         |
| Playwright, hardware: Chrome 156, Edge 155        | 66 passed                                                                                                                                                                                                                                                                                                                |
| Playwright, software (`GPU_TEST_SOFTWARE=1`)      | 39 passed. Software rendering and decoding are no measure of speed: three 1080p layers show about 2 frames a second there, yet the sound clock keeps real time (9.83 s of 10.04 s, 0 underruns).                                                                                                                         |
| Desktop smoke, WebView2 155                       | Passed on hardware (playback: 90 frames in 3 s, 0 dropped, audio clock, worst offset 14.4 ms, Full) and software (on time; Auto drops to 1/4)                                                                                                                                                                            |
| Licenses                                          | cargo-deny ok. New: rubato 5.0.1, audioadapter 5, audioadapter-buffers 5.2, audioadapter-sample 5.2 and num-integer (MIT or Apache-2.0), audio-codec-algorithms (0BSD or Apache-2.0), visibility (Zlib, MIT or Apache-2.0), windowfunctions (MIT). npm 154 packages, unchanged. The GPL self-test rejects both fixtures. |
| Release WASM                                      | 3,494,559 bytes in CI; gzip 1,295,298, within the 1,500,000 budget (Phase 2: 1,209,250)                                                                                                                                                                                                                                  |

### Known gaps

- Playback decodes up to 1080p in software, because hardware decoders stall the GPU process when a clip ends on this machine. Larger frames and HEVC still decode in hardware and can lose a frame at a cut. 4K on the web has no proxies yet; desktop proxies are 720p.
- Video layers have no mipmaps: video shown at a small fraction of its size can alias. Stills have them.
- Backwards playback reads each frame from its key frame, so it is smooth only for short GOPs.
- Clips at other speeds play silent until Phase 9's time-stretch.
- An uncached seek can take up to about 150 ms at the end of a one-second GOP.
- WebGL2 reads every video frame back to the CPU: wgpu 30 has no VideoFrame upload there without unstable web-sys APIs.
- Auto quality looks only at skipped frames. The browser gives no reliable GPU time without timestamp queries, which are not used.
- The A/V measurement counts one display refresh for showing a frame. Browsers do not report when a canvas frame reaches the screen.
- The monitor area is 16:9; other aspect ratios are letterboxed inside it.
- A clip whose media is missing draws nothing; there is no offline slate yet.
- HDR: CPU frames get a simple tone map; hardware frames are tone mapped by the browser.
- CI marked the Phase 0 test `WebGL2 recovers from device loss and a Rust panic on retry` flaky once: a project notice appeared beside the engine error, and the test's `getByRole('alert')` matched both. It passed on retry and never failed locally. The test should look for the engine error by its test id.

## Phase 2: Project model, timeline core, undo/redo (complete)

- **Completed:** 2026-10-23, tag `phase-2`.
- **CI:** [run 39933600959](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/39933600959) on commit `bc2df0c`, green (License gates 37 s; Windows build and test 9 min 7 s).
  - It ran 105 Rust tests, including the property tests, and 28 software-GPU browser tests, 8 of them project specs.
  - The desktop smoke saved, reopened, hard-killed and recovered a project.
  - The first run, [run 39905306624](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/39905306624) on `7c7212c`, failed: its property test found the slide bug that `bc2df0c` fixes.
- **Reference machine:** as in Phase 0: GTX 1650, driver 457.51, Chrome 156, Edge and WebView2 155.

### Shipped

- **Model (`cgv-model`, pure Rust):**
  - A project holds settings, a media bin, free tracks (any clip on any track, the bottom track drawn first) and markers.
  - Settings default to 1080p30 with 48 kHz stereo. Presets: 16:9, 9:16, 1:1 and 4K UHD.
  - Clips carry media, timeline start and duration, source in point, speed, picture and sound switches, link, transform, crop, opacity, volume, effects and keyframes. Effects and keyframes are stored now; Phase 6 gives them commands.
- **30 commands, each applied whole or not at all:**
  - Edits: insert, overwrite, append, delete, ripple delete, split, trim (plain and ripple), roll, move (across tracks, optionally overwriting), slip and slide.
  - Clips: link, unlink, detach audio, speed and properties.
  - Tracks: add, remove, move, rename, lock, mute and hide.
  - Markers, media, rename and settings.
  - Times snap to project frames. Locked tracks refuse edits, and linked partners follow.
  - The rules are checked after every edit, so a bug fails the command instead of corrupting the project.
- **Undo and redo:**
  - Groups make one drag or one multi-clip action a single step, and a group can be cancelled.
  - A command that changes nothing leaves no step.
  - Snapshots share unchanged tracks; the history keeps 10,000 steps.
  - Unsaved changes are tracked per state, so undoing back to the saved state is clean.
- **Queries:** `clips_at`, track ranges, and snap points (clip edges, the playhead and markers) with nearest-point snapping.
- **The `.cgvproj` file:**
  - Pretty-printed JSON with a format name and version, and a migration chain for later versions.
  - It is validated on open, refuses newer versions, and reloads floats bit for bit.
- **Engine:**
  - `cgv-wasm` exposes `ProjectSession`; the engine worker runs it behind `projectExecute`, `projectUndo` and the other project calls.
  - Imports report each file's modified time and its `MediaRef`.
- **Saving and recovery:**
  - Web: projects live in OPFS and are listed in IndexedDB. Export downloads a `.cgvproj` file, and Import opens one as a copy.
  - Desktop: native save and open dialogs; the file goes where the user saves it.
  - Autosave every 30 s, into OPFS on the web or the app data folder on desktop (`CGV_DATA_DIR` for tests). It never touches the saved file.
  - At startup, an autosave that differs from the saved file offers Recover or Discard.
  - Switching projects keeps unsaved changes as an autosave. The web warns before leaving with unsaved changes.
- **Relinking:**
  - Missing files open a relink dialog: Locate on both platforms, and Search a folder on desktop (by name and size).
  - Clips of missing media stay in place and show as offline.
  - A file whose size or modified time changed drops its cached thumbnails, waveform and proxy. This closes the Phase 1 gap.
  - On the web, files no project uses are forgotten.
- **UI:**
  - A project bar: name, save state, New, Open, Save, Save as or Export, Undo, Redo and Settings.
  - Projects, settings, recovery and relink dialogs.
  - A per-project media bin with Add to timeline and a Missing status.
  - A read-only timeline outline with lock, mute and hide.
  - Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Ctrl+S and Ctrl+Shift+S.
- **Phase 1 library:** on first start, remembered media moves into an "Untitled project".

### Exit criteria

| Criterion                                                                          | Result | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every edit command has unit tests and passes the property tests                    | Passed | `crates/cgv-model/tests/commands.rs` has 41 tests covering every command's effect and refusals, plus the session, queries and files. `random_edits_keep_every_rule_and_undo_exactly` (proptest, 128 cases of up to 120 commands per run; more than 44,000 cases run locally) checks after every applied command: the structural rules, whole frames, sources inside their media, untouched locked tracks, each command's own promise (split keeps coverage, ripple delete closes exactly the removed lengths, insert grows its track, slip leaves the timeline alone, a move keeps content), and an exact undo then redo. It found two bugs, both in sliding linked clips on one track. Touching clips trimmed each other, so they now slide as one block. On the CI runner, a block that slid up against another linked clip was taken for that clip's neighbour; neighbours now come from the positions before the slide, and the seed is kept as a proptest regression. |
| Save then load produces an identical project                                       | Passed | Every property case and every 1,000-command run ends with save then load equal to the project and a byte-identical second save. In the browser, `save then reload gives an identical project` passes on Chrome, Edge and software Chrome: after a reload, the project equals the saved one and the file text is identical. The edits include split, detach, speed, a move across tracks, fractional transforms, a Unicode marker and 9:16 settings. `an exported project file imports as a copy with the same edit` also passes. The desktop smoke writes a `.cgvproj` equal to the open project, then reopens it from the recent list unchanged and clean.                                                                                                                                                                                                                                                                                                                |
| 1,000 random commands followed by 1,000 undos restore the original project exactly | Passed | `a_thousand_random_commands_then_a_thousand_undos_restore_the_original_exactly` runs 4 seeds (1, 2, 3 and 0xC0FFEE). Each applies 1,000 changing commands; another 322 to 804 are refused and must change nothing. The ends hold 27 to 41 tracks and 169 to 350 clips. 1,000 undos match every intermediate state and end equal to the original, with the same file bytes and no unsaved changes. 1,000 redos return to the end state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Autosave recovers a project after the app is killed mid-edit                       | Passed | `autosave recovers the project after the tab is killed mid-edit` (Chrome, Edge, software Chrome): after a save, more edits including an open drag, the autosave runs (400 ms in tests) and the browser's renderer processes are terminated. A new tab offers recovery, and Recover gives exactly the autosaved project, with unsaved changes. `discarding a recovery opens the last saved version` covers the other choice. In the desktop smoke, `cgv-desktop.exe` is hard-killed mid-drag and relaunched with the same profile; Recover gives exactly the autosaved project (WebView2 155, hardware and software).                                                                                                                                                                                                                                                                                                                                                       |

### Local verification

| Check                                                          | Result                                                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| fmt, clippy `-D warnings` (native and wasm32)                  | Clean                                                                                                                                                        |
| `cargo test --workspace` (`CGV_REQUIRE_FFMPEG=1`)              | 105 passed: model 53 (10 unit, 41 command, 2 property), native 17, desktop 1, wasm 1, plus the Phase 1 suites. The property tests take 4 s in a debug build. |
| Vitest                                                         | 43 passed, including recovery decisions, referenced media, changed-file detection and autosave timing                                                        |
| Playwright, hardware: Chrome 156, Edge 155                     | 48 passed, 8 of them project specs per browser                                                                                                               |
| Playwright, software (`GPU_TEST_SOFTWARE=1`, installed Chrome) | 28 passed                                                                                                                                                    |
| Desktop smoke, WebView2 155                                    | Passed on hardware and software: media, a saved `.cgvproj` that reopens, and recovery after a hard kill                                                      |
| Licenses                                                       | cargo-deny ok (proptest 1.11.0 is MIT or Apache-2.0, dev only); npm 154 packages; the GPL self-test rejects both fixtures                                    |
| Release WASM                                                   | 3,284,072 bytes in CI; gzip 1,209,250, within the 1,500,000 budget (Phase 1: 1,041,193)                                                                      |

### Known gaps

- The timeline is a read-only outline. Phase 4 builds the editing timeline; until then, only Add to timeline and the track switches send edits from the UI. Tests drive the rest through the engine API.
- Ripple edits move later clips only on the edited tracks and their linked partners. Ripple across tracks waits for Phase 4's magnetic-track answer.
- Effects and keyframes are saved and reloaded, but no command creates them before Phase 6.
- Desktop has no "save changes?" prompt when the window closes. Autosave and recovery cover it.
- The desktop cache folder (thumbnails, waveforms, proxies) is not pruned for media no project uses. The web forgets such files.
- A web project imported from another browser always needs relinking. Folder search is desktop-only.
- Undo history is not saved with the project, as agreed.

## Phase 1: Media import, decoding, proxies, thumbnails (complete)

- **Completed:** 2026-10-23, tag `phase-1`.
- **CI:** [run 39869268031](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/39869268031) on commit `8857eae`, green (License gates 31 s; Windows build and test 10 min 25 s). It fetched the pinned FFmpeg and all 36 test files from the release, ran the 3 FFmpeg integration tests on the runner, passed 20 software-GPU browser tests, and the desktop smoke took ProRes to `proxyReady`.
- **Reference machine:** as in Phase 0: GTX 1650, driver 457.51, Chrome 156, Edge and WebView2 155.

### Shipped

- **Time:** `cgv-time` with integer flicks, frame rates that snap measured values to the standard rates, and SMPTE timecode including drop-frame (15 tests).
- **Library model:** `cgv-media` normalizes probes into items with kind, codec labels, frame rate, rotation, colour and status (9 tests). The worker reaches it through WASM.
- **Engine worker media pipeline:**
  - Mediabunny demuxing.
  - WebCodecs decoder sessions in a pool of 4.
  - Frame-exact seeks, using a presentation-order frame index and decoding forward from the previous key frame.
  - A 5-frame look-ahead for sequential reads.
  - A 256 MB LRU cache of native-format frame copies.
  - Every VideoFrame wrapped, closed once and counted.
- **Background jobs worker:** filmstrip thumbnails (key frames, rotated for display) and waveform peaks (WebCodecs, plus the engine's own PCM decoding).
- **Library panel:**
  - Import by picker, file input or drop, showing thumbnail or waveform, name, duration, resolution, frame rate, codecs, size and status.
  - Remembered across reloads: File System Access handles where the browser has them, OPFS copies elsewhere.
  - Thumbnail and peak caches live in OPFS on the web and in the app cache folder on desktop.
  - A dev overlay (`?dev=1`, Ctrl+Shift+D) shows open frames, the cache and decoders.
- **Desktop:**
  - The `cgv-media` protocol streams only registered files, in capped byte ranges.
  - ffprobe runs on every file, so containers Mediabunny can't read still import.
  - 720p H.264 proxies with a 0.5 s GOP and the source's frame timing and orientation, with progress.
  - Native file dialog and drag and drop.
- **Scripts:**
  - `setup:ffmpeg` fetches the pinned LGPL FFmpeg 9.0.1, checks its hash and license flags.
  - `make-test-media` and `fetch-test-media` handle 11 synthetic clips with frame-number barcodes, plus 25 FFmpeg I420 reference crops, published as release [test-media-v1](https://github.com/MohamedSadat/cashgear-moviepro/releases/tag/test-media-v1).

### Exit criteria

| Criterion                                                                                                       | Result                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A test set (H.264 MP4, HEVC MOV, VP9 WebM, ProRes MOV on desktop, MP3, WAV, PNG) imports and shows correct info | Passed                 | `imports the test set and shows correct info` passes on Chrome 156 and Edge 155 (hardware) and software Chrome in CI. It imports all 11 files (plus AAC, Opus, JPEG and WebP) and checks the shown resolution, frame rate, codec, rotation, sample rate and channels against the manifest. The desktop smoke imports H.264 and ProRes natively.                                                                                                                       |
| Seeking to frame N matches the reference frame extracted by FFmpeg                                              | Passed, byte-identical | `seeks to the exact frame, byte-identical to FFmpeg reference frames`: the raw I420 planes of a 384×216 or 256×144 crop equal FFmpeg's decode with 0 differing bytes. Chrome checked 25 frames (H.264 9, HEVC with B-frames 9, VP9 with alt-ref 7). Edge and software Chrome checked 16 each; neither can decode HEVC here. Barcodes match on 25 further random frames per clip, and the desktop smoke reads frames 0, 1, 45 and 89 exactly through the ProRes proxy. |
| Unsupported codecs get proxies on desktop and a clear message on the web                                        | Passed                 | Desktop smoke: ProRes 422 Proxy reaches `proxyReady`, and its frames read exactly through the proxy. WebView2 on Windows 10 also proxies HEVC. Web: ProRes, and HEVC where the browser lacks it, show "_codec_ can't be decoded in this browser. Open the file in the CashGear Video desktop app, which converts it to a playable proxy."                                                                                                                             |
| 1,000 random seeks leave zero open VideoFrames and stable memory                                                | Passed                 | `1,000 random seeks leave zero open VideoFrames and stable memory`: 0 wrong frames, the cache never over its 256 MB budget, 0 open frames and 0 cached bytes after release. JS heap 4.70 to 4.77 MB (Chrome), 4.71 to 4.36 MB (Edge), 4.72 to 3.96 MB (software). The 1,000 seeks took 64 s (Chrome) and 50 s (Edge), including readback.                                                                                                                             |

### Local verification

| Check                                                          | Result                                                                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| fmt, clippy `-D warnings` (native and wasm32)                  | Clean                                                                                                                                               |
| `cargo test --workspace` (`CGV_REQUIRE_FFMPEG=1`)              | 47 passed, including real ffprobe and ffmpeg runs: probes of the test set, and a ProRes to 720p H.264 proxy with key frames at most 15 frames apart |
| Vitest                                                         | 33 passed: frame cache, decoder pool, frame index, barcode, PCM, peaks, cache keys, capabilities, license policy                                    |
| Playwright, hardware: Chrome 156, Edge 155                     | 32 passed                                                                                                                                           |
| Playwright, software (`GPU_TEST_SOFTWARE=1`, installed Chrome) | 20 passed                                                                                                                                           |
| Desktop smoke, WebView2 155                                    | Passed on hardware and software, including the media import and ProRes proxy                                                                        |
| Licenses                                                       | cargo-deny ok; npm 154 packages (Mediabunny MPL-2.0 shipped); GPL self-test rejects both fixtures                                                   |
| Release WASM                                                   | 2,707,882 bytes; gzip 1,041,193, within the 1,500,000 budget                                                                                        |

### Known gaps

- Edge and WebView2 on Windows 10 decode HEVC only with Microsoft's HEVC Video Extensions. Without them, desktop proxies HEVC and the web refuses it.
- NVENC needs a newer NVIDIA driver than 457.51. Proxies use Media Foundation `h264_mf` here and `libopenh264` in CI.
- Chrome converts CPU-backed YUV frames with the BT.601 matrix, so thumbnails of software-decoded video can be slightly off in colour. Phase 3's GPU compositor converts with each frame's own matrix.
- macOS has no pinned FFmpeg build or desktop test yet.
- Proxies made in an earlier session are reused by id, but a changed source file does not invalidate its proxy yet. Relinking comes in Phase 2.

## Phase 0: Scaffold, toolchain, CI (complete)

- **Completed:** 2026-10-22, tag `phase-0`.
- **CI:** [run 39853239074](https://github.com/MohamedSadat/cashgear-moviepro/actions/runs/39853239074) on commit `22c98cc`, green. The License gates job took 39 s; the Windows build and test job took 15 min 23 s.
- **Reference machine:** Xeon E5-2680 v3, GTX 1650, 32 GB RAM, Windows 10 Pro 22H2.

### Shipped

- **Workspaces:**
  - A Cargo workspace with all eight `cgv-*` crates. `cgv-time`, `cgv-model`, `cgv-media` and `cgv-audio` are stubs.
  - A pnpm workspace with `apps/web`, `apps/desktop`, `packages/ui` and `packages/engine-client`.
- **Engine:**
  - `cgv-wasm` is built with wasm-bindgen 0.2.129 and runs in a dedicated engine worker, which renders to an `OffscreenCanvas` transferred from the program monitor.
  - wgpu 30 starts on WebGPU and falls back to WebGL2.
  - The animated test pattern is eight color bars plus a sweep band.
- **Cross-origin isolation:**
  - COOP/COEP/CORP are set in the Vite dev and preview servers, in `apps/web/public/_headers` (production sample, with an nginx snippet in `docs/DEPLOYMENT.md`) and in the Tauri config.
  - A `SharedArrayBuffer` round trip between the page and the worker proves shared memory works.
- **Desktop:** a Tauri 2 shell that loads the same UI, with the `native_info` command from `cgv-native`.
- **Startup capability check:**
  - Blockers: missing isolation, shared memory, WebCodecs, OffscreenCanvas or AudioWorklet, or no GPU backend. Each gets a full-screen message.
  - The WebGL2 fallback shows a "degraded" notice.
- **CI (GitHub Actions):**
  - Linux job: cargo-deny, the npm license check and the GPL self-test.
  - Windows job: fmt, release build, clippy (native and wasm32), cargo tests, typecheck, lint, Prettier, Vitest, Playwright on software WebGPU and WebGL2, the desktop build and the desktop smoke test.
- **Docs and scripts:** `docs/PLAN.md`, `docs/PROGRESS.md`, `docs/decisions.md`, `docs/DEPLOYMENT.md`, `CLAUDE.md` and `scripts/fetch-test-media.mjs` (empty manifest).

### Exit criteria

| Criterion                                                             | Result | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev:web` shows the animated wgpu pattern rendered in the worker | Passed | Checked in the browser pane at 127.0.0.1:5173: WebGPU, about 63 frames/s, status `ok`, no console errors. With `?gpu=webgl2`: WebGL2, status `degraded`, notice shown.                                                                                                                                                                                                                                                                                                                           |
| `pnpm dev:desktop` shows the same pattern in Tauri                    | Passed | The dev window was inspected over CDP: WebGPU, 679 frames, cross-origin isolated, shared memory OK, `Desktop 0.1.0 · windows x86_64`. The pattern was confirmed in a screenshot.                                                                                                                                                                                                                                                                                                                 |
| The capability check reports correctly on WebGPU and WebGL2 paths     | Passed | Playwright on Chrome 156 and Edge 155 (GTX 1650): `WebGPU draws the animated test pattern…` (status `ok`), `WebGL2 draws…` (`degraded` plus notice), `reports the WebGL2 fallback when the WebGPU adapter/device fails`, and `blocks with a clear message when WebCodecs is missing`. Vitest has 9 `evaluateCapabilities`/`probeCapabilities` cases.                                                                                                                                             |
| CI is green, and adding a GPL test dependency makes it fail           | Passed | Run 39853239074 is green: 14/14 Playwright tests on software WebGPU and WebGL2; desktop smoke on WebView2 155 with `google swiftshader` (WebGPU) and Microsoft Basic Render Driver (WebGL2); release WASM gzip 977,167 bytes. The "GPL dependencies fail both gates" step runs `pnpm licenses:selftest`: cargo-deny rejects the GPL-3.0-only path crate in `tests/license-gate/cargo` (`error[rejected]: … license is not explicitly allowed`), and the npm checker rejects `gpl-fixture@1.0.0`. |

### Local verification

| Check                                                                                 | Result                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cargo fmt --check`, clippy `-D warnings` (native workspace and `cgv-wasm` on wasm32) | Clean                                                                                                                                                                                |
| `cargo test --workspace`                                                              | 7 passed: WGSL validation, pattern layout and constants, clock, `native_info`                                                                                                        |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`                                    | Clean                                                                                                                                                                                |
| Vitest                                                                                | 21 passed: frame loop, capability check, license policy                                                                                                                              |
| Playwright, hardware: Chrome 156.0.8078.47 and Edge 155.0.4283.62                     | 20 passed. WebGPU adapter `nvidia turing`; WebGL2 `ANGLE (NVIDIA GeForce GTX 1650 Direct3D11)`                                                                                       |
| Playwright, software (`GPU_TEST_SOFTWARE=1`): Chromium 156.0.8078.4                   | 14 passed. WebGPU `google swiftshader`; WebGL2 WARP and SwiftShader                                                                                                                  |
| Desktop smoke, WebView2 155.0.4283.62                                                 | Passed on hardware (WebGPU `nvidia`, WebGL2 GTX 1650) and on software (SwiftShader, WARP). Each run checks pattern pixels, sweep motion, isolation, shared memory and `native_info`. |
| `cargo deny check licenses sources`                                                   | `licenses ok, sources ok`                                                                                                                                                            |
| `pnpm licenses:check`                                                                 | Passed: 151 packages; the shipped set is react, react-dom, scheduler, comlink and @tauri-apps/api                                                                                    |
| Release WASM                                                                          | 2,566,096 bytes; gzip 976,939, within the 1,500,000 budget                                                                                                                           |
| Release desktop exe                                                                   | `target/release/cgv-desktop.exe`, 5.0 MB, unbundled                                                                                                                                  |

### Known gaps

- macOS is not built or tested yet. Windows is first, as agreed.
- RustSec advisories run in CI but do not fail it.
- The test-media manifest is empty; Phase 1 adds licensed clips.
- No golden-image harness yet. Phase 0 samples pattern pixels directly. Golden tests start in Phase 3.
- CI runs the GPU tests on software renderers, so its timings are not hardware performance.

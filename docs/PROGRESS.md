# Progress

Newest phase first. Each phase lists the evidence for every exit criterion.

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

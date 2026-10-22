# Progress

Newest phase first. Each phase lists the evidence for every exit criterion.

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

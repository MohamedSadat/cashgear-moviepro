# Progress

Newest phase first. Each phase lists the evidence for every exit criterion.

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

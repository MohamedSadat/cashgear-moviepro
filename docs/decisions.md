# Decisions

Dated entries, newest first. Every answer to a phase question is recorded here, along with each small default chosen during a phase.

## 2026-10-22: Phase 0 answers

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

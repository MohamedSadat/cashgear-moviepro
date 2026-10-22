# CashGear Video

A Filmora-level video editor for the browser and the desktop, built from one Rust engine. The engine compiles to WASM and runs in a Web Worker in both versions. The desktop app is a Tauri 2 shell around the same UI, plus a native Rust side for files and FFmpeg jobs.

Status: **Phase 0** (scaffold, toolchain, CI). The program monitor shows an animated wgpu test pattern drawn by the engine worker. See [docs/PLAN.md](docs/PLAN.md) and [docs/PROGRESS.md](docs/PROGRESS.md).

## Prerequisites

- Node 24 and pnpm 12.11.2
- Rust 1.99.1 (installed through `rust-toolchain.toml`)
- Windows: Visual Studio C++ build tools, the Windows SDK and the WebView2 Runtime
- Current Chrome or Edge with WebGPU

## Run

```bash
pnpm install
pnpm setup:wasm
pnpm dev:web
```

`pnpm setup:wasm` adds the wasm32 target and builds wasm-bindgen-cli 0.2.129 into `.tools/`. After that, `pnpm dev:web` serves the app at http://127.0.0.1:5173. Run `pnpm dev:desktop` to open the same app in Tauri.

## Verify

```bash
cargo fmt --all --check
pnpm build
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm typecheck && pnpm lint && pnpm test
pnpm test:e2e
pnpm desktop:build && pnpm desktop:smoke
pnpm deny && pnpm licenses:check && pnpm licenses:selftest
```

Build first: the engine bindings and `apps/web/dist` are generated, and typecheck, clippy (Tauri embeds `dist`) and the browser tests all need them.

- **GPU in tests:** Playwright runs on Chrome and Edge with the real GPU locally. CI has no GPU, so there it uses SwiftShader for WebGPU and WARP or SwiftShader for WebGL2.
- **Desktop smoke:** `desktop:smoke` launches the release desktop build and attaches to its WebView2 over CDP. It checks the same pattern, cross-origin isolation, shared memory and the `native_info` command.

Diagnostic URLs are listed in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

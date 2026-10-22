# CashGear Video

A Filmora-level video editor for the browser and the desktop, built from one Rust engine. The engine compiles to WASM and runs in a Web Worker in both versions. The desktop app is a Tauri 2 shell around the same UI, plus a native Rust side for files and FFmpeg jobs.

Status: **Phase 1** (media import, decoding, proxies, thumbnails).

- Video, audio and image files import into the media library, with thumbnails and waveforms.
- The engine returns the exact frame at any time.
- On the desktop, files WebCodecs can't decode (such as ProRes) are edited through 720p H.264 proxies.

See [docs/PLAN.md](docs/PLAN.md) and [docs/PROGRESS.md](docs/PROGRESS.md).

## Prerequisites

- Node 24 and pnpm 12.11.2
- Rust 1.99.1 (installed through `rust-toolchain.toml`)
- Windows: Visual Studio C++ build tools, the Windows SDK and the WebView2 Runtime
- Current Chrome or Edge with WebGPU

## Run

```bash
pnpm install
pnpm setup:wasm
pnpm setup:ffmpeg
pnpm fetch-test-media
pnpm dev:web
```

- `pnpm setup:wasm` adds the wasm32 target and builds wasm-bindgen-cli 0.2.129 into `.tools/`.
- `pnpm setup:ffmpeg` fetches the pinned LGPL FFmpeg build into `.tools/ffmpeg`. It checks the build's hash and license flags.
- `pnpm fetch-test-media` downloads the synthetic test clips into `tests/media/`.
- `pnpm dev:web` serves the app at http://127.0.0.1:5173.

Run `pnpm dev:desktop` to open the same app in Tauri.

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

- **GPU in tests:** Playwright runs on Chrome and Edge with the real GPU locally. CI has no GPU, so there it runs Chrome with SwiftShader for WebGPU and WARP or SwiftShader for WebGL2.
- **Seek checks:** the test clips carry their frame number as a barcode, so seek tests read back exactly which frame they got. They also compare pixels with FFmpeg reference crops.
- **Desktop smoke:** `desktop:smoke` launches the release desktop build and attaches to its WebView2 over CDP. It checks the pattern, cross-origin isolation, shared memory and `native_info`, then imports clips natively and plays ProRes through its proxy.
- **Regenerating test media:** `node scripts/make-test-media.mjs` regenerates the clips with the LGPL FFmpeg and rewrites `tests/media/manifest.json`. Publish a new release when the set changes.

Diagnostic URLs are listed in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

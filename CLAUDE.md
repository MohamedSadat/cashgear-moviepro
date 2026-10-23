# CashGear Video — agent notes

CashGear Video is a browser and desktop video editor built on one Rust/WASM engine. `docs/PLAN.md` holds the phased plan, `docs/PROGRESS.md` records what is done and the evidence for it, and `docs/decisions.md` logs every answer and default.

## Workflow

- Work only on `main` in this worktree: no feature branches, no extra worktrees, no PRs.
- Make small Conventional Commits scoped by crate or package, for example `feat(engine): …` or `fix(ui): …`. Every commit builds and passes the checks below.
- Work one phase at a time:
  1. Read PLAN, PROGRESS and decisions.
  2. Ask the phase's questions in one batch, then wait for the answers.
  3. Log the answers in `docs/decisions.md` with the date.
- For a small choice, pick the sensible default and log it. For anything expensive to reverse, stop and ask.
- End of phase:
  1. Record the evidence for each exit criterion in `docs/PROGRESS.md`.
  2. Commit, then tag `phase-N` (Phase 5 is `v0.1.0-mvp`) once remote CI is green.
  3. Show the next-phase card and stop.
- Never commit secrets, signing keys or media. Test clips come from `pnpm fetch-test-media`.

## Hard limits

- No GPL, AGPL or LGPL dependencies. `cargo deny check licenses` and `pnpm licenses:check` must pass, and `pnpm licenses:selftest` proves they fail on GPL.
- FFmpeg is the pinned LGPL build from `pnpm setup:ffmpeg`, without `--enable-gpl` or `--enable-nonfree`. It runs only as `ffmpeg` and `ffprobe` child processes of the desktop native side, never linked in.
- The UI never touches media or GPU state. It sends engine commands and renders the snapshots that come back. Raw frames never cross to native code.

## Layout

- `crates/`:
  - `cgv-render`: wgpu, WGSL.
  - `cgv-engine`: clock and scheduler.
  - `cgv-wasm`: the only JS-facing API.
  - `cgv-native`: desktop-only native side.
  - `cgv-time`, `cgv-model`, `cgv-media`, `cgv-audio`.
- `packages/engine-client`: engine worker, comlink client, frame loop and capability probe. Generated bindings go in `src/pkg/` (gitignored).
  - `media/`: Mediabunny demuxing, WebCodecs decoder sessions, the decoder pool, the frame cache, frame-accurate seeks and probes.
  - `jobs/`: the thumbnail and waveform worker.
  - `storage/`: the OPFS cache, the IndexedDB media and project lists, and web project files in OPFS.
  - `project/`: the worker's project session (WASM), autosave timing and recovery decisions.
- `crates/cgv-model`: the project, every edit command, undo/redo and the `.cgvproj` format. `packages/ui/src/project`: opening, saving, autosave, recovery and relinking.
- `crates/cgv-media`: the media library model (Rust, via WASM). `crates/cgv-native`: the cgv-media protocol registry, byte ranges, ffprobe, proxies and the cache folder.
- `packages/ui`: React components.
- `apps/web`: Vite app.
- `apps/desktop/src-tauri`: Tauri 2 shell.

Browser-only Rust dependencies sit under `cfg(target_arch = "wasm32")`, so native workspace builds stay light.

## Commands

```bash
pnpm install && pnpm setup:wasm   # first time: wasm32 target + wasm-bindgen-cli 0.2.129 in .tools/
pnpm setup:ffmpeg                 # pinned LGPL FFmpeg into .tools/ffmpeg (hash and license checked)
pnpm fetch-test-media             # test clips into tests/media (CI sets CGV_REQUIRE_FFMPEG=1)
pnpm dev:web                      # engine (debug) + Vite on http://127.0.0.1:5173, rebuilds on .rs/.wgsl changes
pnpm dev:desktop                  # the same UI in Tauri
pnpm build                        # release WASM + web build (run before typecheck, clippy, e2e, desktop)
```

Checks run in CI (`.github/workflows/ci.yml`). Run them in this order:

```bash
cargo fmt --all --check
pnpm build
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy -p cgv-wasm --target wasm32-unknown-unknown -- -D warnings
cargo test --workspace
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm test:e2e                     # Chrome + Edge on the real GPU; CI uses software GPUs (GPU_TEST_SOFTWARE=1)
pnpm desktop:build && pnpm desktop:smoke
pnpm deny && pnpm licenses:check && pnpm licenses:selftest
```

Gotchas:

- Request the WebGPU device _before_ creating the surface, so a failure leaves the canvas free for WebGL2.
- Never set the canvas size by hand, because wgpu `configure` does it.
- Use a fresh canvas and worker on every retry, because a transferred canvas cannot be transferred again.
- Never report a software-GPU result as hardware performance.
- Decoders have few output surfaces. Close or copy every VideoFrame promptly: the cache keeps sRGB RGBA copies, and at most 5 decoder outputs are held for look-ahead.
- Chrome draws a VideoFrame built from an NV12 buffer with the BT.601 matrix whatever its colour space says. Copy with `copyTo({ format: 'RGBA', colorSpace: 'srgb' })` instead.
- FFmpeg encoders take colour tags from the frames: use `setparams` in a filter graph, because `-color_*` output options are not enough.

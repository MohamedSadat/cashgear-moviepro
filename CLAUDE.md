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
- FFmpeg (from Phase 1) is an LGPL build without `--enable-gpl` or `--enable-nonfree`, dynamically linked, and runs only on the desktop native side.
- The UI never touches media or GPU state. It sends engine commands and renders the snapshots that come back. Raw frames never cross to native code.

## Layout

- `crates/`:
  - `cgv-render`: wgpu, WGSL.
  - `cgv-engine`: clock and scheduler.
  - `cgv-wasm`: the only JS-facing API.
  - `cgv-native`: desktop-only native side.
  - `cgv-time`, `cgv-model`, `cgv-media`, `cgv-audio`.
- `packages/engine-client`: engine worker, comlink client, frame loop and capability probe. Generated bindings go in `src/pkg/` (gitignored).
- `packages/ui`: React components.
- `apps/web`: Vite app.
- `apps/desktop/src-tauri`: Tauri 2 shell.

Browser-only Rust dependencies sit under `cfg(target_arch = "wasm32")`, so native workspace builds stay light.

## Commands

```bash
pnpm install && pnpm setup:wasm   # first time: wasm32 target + wasm-bindgen-cli 0.2.129 in .tools/
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

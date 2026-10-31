# CashGear Video — agent notes

CashGear Video is a browser and desktop video editor built on one Rust/WASM engine. `docs/PLAN.md` holds the phased plan, `docs/PROGRESS.md` records what is done and the evidence for it, `docs/decisions.md` logs every answer and default, and `docs/RELEASE.md` is the release checklist.

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
  - `cgv-effects`: the effect and transition catalogue: JSON schema, registry, shader assembly (`prelude.wgsl`) and settings packing.
  - `cgv-text`: fonts, shaping (rustybuzz), bidi and line breaks, and drawing titles on the CPU (`paint.rs`). No GPU code.
  - `cgv-dsp`: sound effects (filters, dynamics, echo, reverb), level meters, loudness (`ebur128`), ducking curves, time-stretching that keeps pitch (`stretch.rs`, WSOLA), silence detection (`silence.rs`) and beat tracking (`beat.rs`). It knows nothing of projects, so it can be shared with CashGear Audio.
  - `cgv-ai`: the AI tools' arithmetic as a WASM module of its own (`src/pkg/ai/`), run in the AI worker: sound analysis for silences and beats, scene scores and cuts (`scene.rs`), Whisper's 16 kHz resampling and log-mel features (`whisper.rs`), word times from cross-attention (`align.rs`) and the SHA-256 of model downloads. Its results are in media time, cached per file.
  - `cgv-denoise`: noise reduction (`nnnoiseless`) as a WASM module of its own (`src/pkg/denoise/`), run in a worker that starts when a clip first asks for it. It is too big for the engine's budget.
  - `cgv-time`, `cgv-model`, `cgv-media`, `cgv-audio`.
- `assets/`: the built-in pack, embedded at build time. One folder per effect or transition (`effect.json` and `effect.wgsl`, plus any images) in `effects/` and `transitions/`; looks in `luts/`. `assets/README.md` is the authoring guide; `scripts/make-effect-assets.mjs` makes the looks and gradients.
  - `fonts/` (OFL families listed in `fonts.json`, from `pnpm fetch-fonts`), `titles/` (30 templates, from `scripts/make-title-templates.mjs`), `stickers/` (animated WebP and `stickers.json`, from `scripts/make-stickers.mjs`) `sounds/` (music and sound effects as Opus WebM and `sounds.json`, synthesised by `scripts/make-sounds.mjs`) and `templates/` (20 project templates, from `scripts/make-project-templates.mjs`). Title and project templates are bundled into the UI; font, sticker and sound files are build assets, fetched when used, and never inside the WASM.
- `packages/engine-client`: engine worker, comlink client, frame loop and capability probe. Generated bindings go in `src/pkg/` (gitignored).
  - `media/`: Mediabunny demuxing, WebCodecs decoder sessions, the decoder pool, the frame cache, frame-accurate seeks and probes. `reverse-stream.ts` plays a reversed clip by decoding its GOPs from the last one back.
  - `jobs/`: the thumbnail and waveform worker.
  - `storage/`: the OPFS cache, the IndexedDB media and project lists, and web project files in OPFS.
  - `project/`: the worker's project session (WASM), autosave timing and recovery decisions.
  - `playback/`: the playback controller (the one `renderFrame(t)` path, pre-roll, J/K/L, Auto quality) and the worker's sound player.
  - `audio/`: the SharedArrayBuffer ring, its AudioWorklet and the page's AudioContext.
  - `export/`: the export worker (its own engine and copy of the project), encoders, Mediabunny muxing, targets, and pure settings (formats, presets, codec levels, bitrates).
  - `effects/`: catalogue types, pack images and the worker that draws the browser's previews (effects, transitions and titles).
  - `fonts/`: the font catalogue (bundled, imported, installed), the loader that gives each engine the files its titles need, and imported fonts in OPFS.
  - `ai/`: the AI worker (onnxruntime-web: WebGPU, else WASM), the model registry (`models.json`, pinned revisions and hashes) and downloads into OPFS, Whisper (`whisper.ts`, `tokenizer.ts`), background removal (`cutout.ts`, MediaPipe Selfie Segmentation) and its mattes in OPFS (`mattes.ts`), read by the engine and export workers.
- `crates/cgv-model`: the project, every edit command, undo/redo and the `.cgvproj` format, with effects, keyframes (`animation.rs`), transitions, LUTs (`lut.rs`), titles and captions (`title.rs`), speed ramps, reverse and freeze frames (`timing.rs`), masks and blend modes (`masks.rs`), template slots (`FillSlot`), beats, background removal and cutting ranges out (`RemoveRanges`). `packages/ui/src/project`: opening, saving, autosave, recovery and relinking.
- `crates/cgv-engine`: `plan_frame` (what a frame shows), the audio clip plan, transport, Auto quality and playback stats. `crates/cgv-audio`: the block mixer. `crates/cgv-render`: the compositor and WGSL.
- `crates/cgv-media`: the media library model (Rust, via WASM). `crates/cgv-native`: the cgv-media protocol registry, byte ranges, ffprobe, proxies, export files and their GIF and MP3 conversions, the cache folder, installed fonts (`fonts.rs`, fontdb), the machine id for licences (`machine.rs`) and free disk space (`disk.rs`).
- `packages/ui`: React components, on the CG component library (`@cashgear/ui`).
  - `timeline/`: the canvas timeline. `controller.ts` owns the view, drawing and gestures outside React; `geometry.ts` and `draw.ts` are pure.
  - `editing/`: selection, tools, the clipboard and every editing action (`useEditor`), and drag gestures (`Gesture`, one undo step each).
  - `inspector/`: clip fields with stopwatches (`fields.tsx`), the effect stack, the curve lane and the transition inspector.
  - `effects/`: the catalogue hook, the effects and transitions browser, and keyframe helpers. `editing/transitions.ts` finds cuts and transition windows.
  - `titles/` (the browser, templates, animation presets and fonts), `inspector/TitleInspector.tsx` and `stickers/`.
  - `mixer/` (the mixer panel, meters and their ballistics), `voiceover/` (recording) and `sounds/` (the Music and Sounds tabs).
  - `shortcuts/` (the key map, presets and settings dialog), `workspace/` (resizable panels and library tabs) and `settings/` (per-user settings in `localStorage`).
  - `export/`: the export dialog, its form rules and `useExport`.
  - `speed/` (ramp maths and presets; `inspector/SpeedSection.tsx`), `masks/` (mask shapes; `inspector/MaskSection.tsx`) and `layouts/` (picture in picture and split screens; `inspector/LayoutSection.tsx`).
  - `monitor/`: the transport, and `MonitorOverlay.tsx`, the handles over the picture (move, scale, rotate, crop, masks, Ken Burns) and the eyedropper; `geometry.ts` is pure.
  - `templates/`: project templates (loading, placing them, filling slots) and their browser.
  - `ai/` (`useAiTools`: jobs with progress and cancel, silences, beats, scenes, background removal; source-to-timeline timing), `inspector/AiSection.tsx` and `captions/` (the Captions tab, cues from transcripts, SRT and VTT).
  - `licence/` (Pro keys, offline token checks, the grace period and the licence dialog), `updates/` (the desktop's updates), `about/` (About and the third-party notices), `diagnostics/` (reports users may save) and `storage/` (the web's storage warnings).
- `apps/web`: Vite app. `sw.js` is the service worker that `pwa.ts` builds with the build's files; `public/` has the manifest and install icons (`scripts/make-web-icons.mjs`).
- `apps/desktop/src-tauri`: Tauri 2 shell, with the licence machine id (`licence.rs`) and updates (`updates.rs`, the updater plugin).
- `services/licensing`: the reference licence server (Node 24 TypeScript, no dependencies), on CashGear Backup's protocol. Its README covers the protocol, the seller's commands and deploying.
- Release: `scripts/desktop-installer.mjs` (the NSIS installer with FFmpeg and its notice), `sign-windows.mjs`, `installer-test.mjs`, `third-party-notices.mjs`, `release-check.mjs` and `release-assets.mjs`; `.github/workflows/release.yml` runs them on a version tag. `CHANGELOG.md` holds each release's notes.

Browser-only Rust dependencies sit under `cfg(target_arch = "wasm32")`, so native workspace builds stay light.

## Commands

```bash
pnpm install && pnpm setup:wasm   # first time: wasm32 target + wasm-bindgen-cli 0.2.129 in .tools/
pnpm setup:ffmpeg                 # pinned LGPL FFmpeg into .tools/ffmpeg (hash and license checked)
pnpm fetch-test-media             # test clips into tests/media (CI sets CGV_REQUIRE_FFMPEG=1)
pnpm fetch-models [ids]           # AI models into tests/models (CI: whisper-tiny selfie selfie-landscape)
pnpm dev:web                      # engine (debug) + Vite on http://127.0.0.1:5173, rebuilds on .rs/.wgsl changes
pnpm dev:desktop                  # the same UI in Tauri
pnpm build                        # release WASM + web build + third-party notices (run before typecheck, clippy, e2e, desktop)
pnpm desktop:installer            # the Windows installer (after pnpm build), signed when CGV_SIGN_* are set
pnpm desktop:installer-test       # two test installers: installs, updates and uninstalls (about 11 minutes)
pnpm release:check                # one version everywhere, and its CHANGELOG section
```

Checks run in CI (`.github/workflows/ci.yml`). Run them in this order:

```bash
cargo fmt --all --check
pnpm build
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy -p cgv-wasm -p cgv-denoise -p cgv-ai --target wasm32-unknown-unknown -- -D warnings
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
- Chrome converts hardware frames coded larger than they show (1080p H.264 is 1088 rows) with the padding's chroma in their last row. Files whose padding differs from their edge (`paddingShows`, checked on open) are drawn from planes, and exports decode them in software.
- FFmpeg encoders take colour tags from the frames: use `setparams` in a filter graph, because `-color_*` output options are not enough.
- Stop `pnpm dev:web` before `pnpm build`: its watcher rebuilds the debug WASM into the same `src/pkg/`, and a mixed build fails with a LinkError.
- The monitor shows the timeline. `?pattern=1` shows the Phase 0 test pattern for GPU checks.
- Hardware decoders stall the browser's GPU process when a clip ends, so playback decodes up to 1080p in software. wgpu 30 cannot upload a VideoFrame on WebGL2 (it panics), so WebGL2 draws video from planes.
- The main track is magnetic in new projects: edits there land on cuts and settle, so clips there never sit where a command's times alone put them. Model tests that need free placement turn magnetism off (`session()` in `crates/cgv-model/tests/common`).
- A drag previews through `Session::preview`: every step re-applies the whole gesture to the state before it. Never send per-step deltas.
- Keys go through the shortcut map (`shortcuts/keymap.ts`); add an action there rather than a `keydown` listener.
- The CG library's overlays copy `data-cg-theme` from `<html>`; some of its styles read `--cg-color-*` tokens that only `styles.css` defines.
- The sound card is the playback clock. Keep the worker's ticks short, or raise the mix-ahead lead, because starved sound stalls the picture too.
- Exports read the composition back as NV12 (`Engine.read_nv12`), packed four bytes a texel so WebGL2 can read it. Never give the encoder RGB frames: the browser would pick the matrix.
- A hardware encoder `isConfigSupported` accepts may still fail to start (CI's WARP GPU process, where even "no preference" means hardware). `chooseVideoConfig` tries each on one frame; keep `prefer-software` last.
- Windows' AAC encoder refuses more than 192 kbit/s.
- Export PSNR is measured on Y'CbCr 4:2:0 planes with FFmpeg's `psnr` filter. RGB PSNR cannot reach 40 dB at sharp saturated edges in any 4:2:0 file.
- A new effect is a folder in `assets/effects/` and nothing else, plus its fixture in `tests/fixtures/effects.json`. Make its golden with `UPDATE_GOLDEN=1` on the chrome project, then keep only the new PNG.
- Effect shaders must give the same picture on every GPU: use the prelude's `hash`, `time_step`, `seed_step`, `cell_of` and `coverage`, not `sin` hashes or `floor(time * rate)`.
- Golden scenes are made at the project's size: a minified source lets each GPU filter differently.
- Pack images reach the GPU as RGBA bytes (`upload_image`), decoded through a 2D canvas in the worker. Copying grey `ImageBitmap`s failed about one engine start in five on SwiftShader's WebGPU, and wgpu's WebGL2 backend copies bitmaps only at the next submit.
- Effects run at a layer's drawn size. Keyframed layers round it up to sixteenths of an octave, and the texture pool destroys textures unused for 30 frames: never key pooled textures on a size that changes every frame.
- Every engine (monitor, export, previews) loads the pack's images at start.
- An inspector field with a stopwatch is a `div`, not a `label`: a label passes clicks on it to its first button.
- `cgv-model`, `cgv-effects`, `serde_json` and the text crates (rustybuzz, `unicode-bidi`, `unicode-linebreak`) build at `opt-level = "s"` to keep release WASM under 2.25 MB gzipped.
- Titles are drawn on the CPU at the size they show (`drawn_part`), so they stay sharp at any scale. Never draw one at a fixed size and let the GPU scale it.
- Fonts with an optical-size axis (Inter) take the drawn size, as Chrome does. Compare layouts with Chrome at the same pixel size, or widths drift by several percent.
- A new or pasted title clip gives its elements new ids. Tests read element ids from the snapshot.
- Font families match in any case, and a bundled family wins over an imported or installed one of the same name. A test that needs a font no bundle has renames a bundled one in memory (`renamedFont` in `titles.spec.ts`).
- Every Playwright run empties `test-results/`. Copy exports you want to keep (player checks) elsewhere, such as `bench/results/`.
- A clip's media time comes from `Clip::source_at` (`timing.rs`), for ramps, reverse (sampled mid-frame) and freeze frames alike. Never work a source frame out from `start`, `source_in` and speed alone.
- Trims, splits and speed changes keep a clip's content through `cut_start`, `set_end` and `retime`: a reversed clip moves its out point where a forward one moves its in point.
- Sound faster than 4× is silent (`MAX_SOUND_SPEED`). Kept pitch is WSOLA (`cgv-dsp/src/stretch.rs`) over the mixer's `Timing` map, which runs backwards for reversed clips.
- Blend modes mix sRGB-encoded values with the W3C formulas and composite in linear light. Colour dodge and burn take a channel within half a level of 0 or 1 as exact (`BLEND_EDGE`), or software GPUs flip pixels from black to white.
- Masks cut a clip after its effects. Feather and expansion are fractions of the picture's shorter side.
- Template slots are placeholder titles with `slot`. `FillSlot` swaps in media and keeps the clip's place and look; a video shorter than its slot holds its last frame in a freeze clip of the same slot.
- The green-screen set (`tests/e2e/greenscreen.ts`) is drawn and encoded with the pinned FFmpeg during the test. It is not test media.
- onnxruntime-web on WebGPU computes fp16 and int8 models wrongly on the reference GPU's driver (457.51). Every WebGPU load gives the model's known answer first (`check` in `models.json`, recorded on the CPU) and falls back to WASM when it is off. A new model or file needs its check recorded. A fallback adapter (SwiftShader) runs models on the CPU, which is far faster there.
- Whisper tiny's int8 build hallucinates whole windows (59% WER against 23%): the tests use the full-precision one. Long-form decoding prompts each window with the text before it (without the prompt, turbo skipped whole sentences after a speaker change), skips pauses at a window's start, and keeps the likeliest try when every temperature fails, as faster-whisper does, not OpenAI's last one.
- AI tests serve `tests/models` over HTTP and pass it as `?models=` (with `?diagnostic=1`); `?captionModel=whisper-tiny` swaps the caption model. A test whose model is missing skips: turbo's WER runs only where it has been fetched.
- Mattes live in OPFS (`ai-mattes/<media>/selfie/`) on the web and the desktop alike, in two-second chunks. The index's `done` ranges decide whether an export may start; the reader never evicts a chunk playback wants.
- Measure long AI runs against a production build (Playwright's preview): the dev server reloads the page when Rust changes.
- Without a licence server and keys every build has every feature: `development` in other builds, `included` in releases, which hide the licence badge. Builds that are not releases take a test server from the address (`?licenceServer=&licenceKeys=`); release builds (`VITE_CGV_RELEASE=1`: the web deploy and the release workflow) ignore it. The licence tests run `services/licensing` on a free port (`tests/e2e/licensing.ts`).
- The free edition's watermark is a title clip the export worker adds on a new top track of its own copy of the project (`export/watermark.ts`). The preview and the project never have it, and the worker refuses Free exports over 1080p as the dialog does.
- Tauri's `signCommand` is split at spaces and runs in `src-tauri`: keep its script path relative and free of spaces. Bundle resources must exist when any cargo build reads the config, so `desktop-installer.mjs` passes them (and the signing and updater settings) through `--config`, never `tauri.conf.json`.
- `pnpm desktop:installer-test` leaves `target/release/cgv-desktop.exe` built as its test version: run `pnpm --filter @cgv/desktop build` again before the desktop smoke, which expects the version in `tauri.conf.json`.
- Playwright's default contexts are incognito, where Chrome keeps OPFS in the browser process's memory: measure memory (and anything written to OPFS at length) in a profile of its own, as `stress.spec.ts` does.
- The updater uses native TLS (SChannel): its rustls default brings a root store under CDLA-Permissive-2.0, which the licence gate refuses.
- Installed apps read updates from `releases/latest/download/latest.json`. Make data releases (test media) with `--latest=false`, or the feed points at them.
- Playwright's browser contexts are incognito, where nothing installs: `pwa.spec.ts` makes a profile and installs through CDP's `PWA` domain. Edge starts installed apps outside the test's reach, so there the app's page stands in.
- The service worker runs in production builds on the web only. It caches the app shell when it installs and other build files when they are used; a range request is answered from the cached file.
- WebView2 never asks Tauri for the script of a worker started by a worker, so such a worker never loads on the desktop (the browser has no such gap). Start one with `startNestedWorker` (`engine-client/src/nested-worker.ts`), from a `?worker&url` import; `shimNestedWorkers` does the same for a library's own threads (ONNX Runtime's). The desktop smoke covers both.
- A project template's track plays one clip at a time: placing a template overwrites, so overlapping clips on a track cut each other. `make-project-templates.mjs` and the template tests refuse them.
- Shells started by the Claude desktop app run inside its MSIX package. What they write to `AppData` lands in `AppData\Local\Packages\Claude_…\LocalCache`, while `HKCU` and `%TEMP%` writes are real. Run an install meant for the user's own use through `explorer.exe`.

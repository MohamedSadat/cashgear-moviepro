# Decisions

Dated entries, newest first. Every answer to a phase question is recorded here, along with each small default chosen during a phase.

## 2026-10-23: Phase 2 findings and defaults

Small choices made while building the model and the project UI.

- **Ripple scope:** ripple delete, ripple trim and insert shift later clips only on the tracks being edited.
  - Linked partners are always part of the edit, so a clip and its detached sound close their gaps together.
  - Clips on other tracks stay put. Phase 4's magnetic-track answer may add ripple across tracks.
- **Links:**
  - Delete, split, trim, roll, move, slip, slide and speed act on a clip's linked partners too.
  - Linked clips that touch on one track slide as one block. A property test found that sliding them one by one trimmed each other.
  - A slide finds neighbours where the clips stood before it, never among the clips that slide. In CI, the property test found a block that slid up against another linked clip and trimmed it.
  - A link left with one clip is cleared.
  - Overwrite and insert never split a linked partner on another track. A clip they cut into two keeps its link on the left part only.
- **Detach audio:** without a target track, the sound goes on a new track directly below the clip's track, so the picture stays above it.
- **Frame rate changes:** clips keep their times; later edits snap to the new rate. Only the 10 standard rates are allowed, because their frame boundaries are exact in flicks.
- **Numbers:** clip properties are `f64`. `serde_json` uses `float_roundtrip`, so files reload bit for bit. Times stay below 2^53 flicks (about 147 days) to remain exact in JavaScript.
- **Speed:** a reduced fraction from 0.1× to 100×. Changing it keeps the clip's start and source in point; its length follows, rounded down to whole frames. Stills have no speed and cannot be slipped.
- **Undo history:**
  - At most 10,000 steps.
  - Snapshots share unchanged tracks (`Arc`), so a step costs about the tracks it touched.
  - A command that changes nothing leaves no step. A group that ends where it started leaves no step and no unsaved changes.
- **Media bin edits are undoable:** import and remove are commands.
  - Removed files stay open in the engine, so undo brings them back at once.
  - Files no project uses are forgotten when a project opens: their IndexedDB record, OPFS copy and caches. Files remembered after that pass started are kept.
- **Relinking** updates the media in the current state and in every undo step. It is not an undo step itself, but it leaves unsaved changes.
- **Saving** records the generation that was written. A save that finishes after further edits marks the right state as saved.
- **New projects:** two empty tracks.
  - On the web, a new project is saved at once, so it is listed.
  - On desktop, a new project stays in memory until its first save or autosave.
- **Switching projects** with unsaved changes writes an autosave first. The changes are offered as a recovery when that project opens again.
- **Changed files:** a different size, or a different modified time, means a file changed. Browser copies in OPFS compare size only.
- **Phase 1 library:** on first start, remembered media goes into an "Untitled project". The web saves it at once; desktop leaves it for the first save or autosave.

## 2026-10-23: Phase 2 answers

- **Track model:** free tracks, as in Filmora.
  - Any clip type can go on any track. Higher tracks draw on top.
  - A video clip keeps its own sound. "Detach audio" moves the sound to a linked audio clip on another track.
- **Project defaults:** 1920×1080 at 30 fps with 48 kHz stereo audio.
  - Presets: 16:9, 9:16 (1080×1920), 1:1 (1080×1080), 4K UHD and custom.
  - Settings can be changed at any time.
- **Project file:** one versioned JSON `.cgvproj` file that points to media by path.
  - Thumbnails, waveforms and proxies stay in the app cache, linked to each media file, and are rebuilt when missing.
- **Web projects:** stored in the browser's private storage (OPFS), with a recent-projects list.
  - Autosave and recovery work in every browser.
  - Export downloads a `.cgvproj` file and Open imports one; its media then needs relinking.

## 2026-10-23: Phase 2 defaults

Proposed alongside the questions; the user raised no objection.

- **Media library per project:** each project has its own media bin. The Phase 1 library moves into the first project.
- **Time and IDs:**
  - Times are flicks, and every edit snaps to the project's frame boundaries.
  - Tracks, clips and markers get counter IDs within the project, so replays and undo give exactly the same result.
- **Undo history:** in memory only, not saved with the project. There is no small limit, because the exit test needs 1,000 undos.
- **Autosave:**
  - Every 30 s after a change, into app storage: OPFS on the web, the app data folder on desktop. It never overwrites the saved file.
  - On startup the app offers to recover when an autosave is newer than the last save.
- **Relink:**
  - A project with missing media opens a relink dialog that matches files by name, size and duration.
  - A source file that has changed (different size or modified time) drops its old proxy and caches. This closes the Phase 1 gap.
- **UI this phase:**
  - A project bar (New, Open, Save, Save As, Undo, Redo, Settings), the recovery prompt, the relink dialog and an "Add to timeline" action.
  - A plain read-only list of tracks and clips. The canvas timeline comes in Phase 4.
- **Pushing:** commits stay local, and every push needs the user's go-ahead, because each push to `main` redeploys video.cashgearerp.com. The plan is one push near the end of the phase.

## 2026-10-23: Azure Static Web Apps

- **Early web deploy:** the user connected the repository to Azure Static Web Apps ahead of Phase 11. The production host and domain are still the Phase 11 question.
- **Build:** the Azure workflow builds with the same pins as CI (Rust 1.99.1, Node 24, pnpm 12.11.2, wasm-bindgen 0.2.129 from `taiki-e/install-action`) and uploads `apps/web/dist` prebuilt, as `cashgear-fotoeditor` does. Oryx cannot detect or build this workspace.
- **Headers:** `apps/web/public/staticwebapp.config.json` sets COOP, COEP and CORP on every response, serves `.wasm` as `application/wasm`, caches `/assets/*` as immutable and sends `no-cache` for `/` and `/index.html`.

## 2026-10-23: Phase 1 answers

- **Demuxer:** Mediabunny (MPL-2.0), running in the engine worker. Our own WebCodecs decoder wrappers, decoder pool, frame-accurate seek and frame cache sit on top of its packet API.
- **Proxy format:** 720p H.264 MP4 with a keyframe every 0.5 s and AAC audio.
  - The encoder is the OS one where available: Media Foundation `h264_mf` on Windows, VideoToolbox on macOS. NVENC is used when the driver supports it.
- **Web, undecodable codecs:** the import is rejected with a message that names the codec and points to the desktop app. Nothing is uploaded.
- **Web storage:** File System Access handles where the browser has them (Chrome, Edge). Other browsers copy the file into OPFS.
- **FFmpeg on desktop:** `ffmpeg` and `ffprobe` run as child processes of the native side. There are no in-process libav bindings.
- **FFmpeg build:** a pinned BtbN LGPL shared release, fetched by `scripts/build-ffmpeg-lgpl.mjs`.
  - The script verifies the SHA-256 and rejects builds configured with `--enable-gpl` or `--enable-nonfree`.
  - The build is LGPL-3.0, because BtbN configures with `--enable-version3`.
- **Test media:** synthetic clips generated locally by `scripts/make-test-media.mjs` with the LGPL FFmpeg.
  - They are published once as a GitHub release asset, and `pnpm fetch-test-media` downloads them by SHA-256.

## 2026-10-23: Phase 1 findings and defaults

- **Dev machine:** FFmpeg 9.0.1 (`BtbN.FFmpeg.LGPL.Shared.9.0`) is installed with winget.
  - NVENC fails with driver 457.51 ("Cannot load cuMemAllocAsync"). It needs a newer NVIDIA driver.
  - `h264_mf`, `libopenh264`, `libkvazaar` (HEVC), `libvpx-vp9`, `prores_ks` and `libmp3lame` all work.
- **Pinned FFmpeg release:** BtbN `autobuild-2026-08-31-13-27`, 9.0 LGPL shared. BtbN keeps the last build of each month for longer than its daily builds.
- **Proxy encoder order:** `h264_nvenc`, then `h264_mf` (Windows) or `h264_videotoolbox` (macOS), then `libopenh264`.
  - `libopenh264` is a fallback for CI and development only. Before release we check whether shipping it carries H.264 patent obligations.
- **Proxies keep the original's frame grid:** `-fps_mode passthrough`, so frame N of the proxy is frame N of the source. They also keep its orientation (`-noautorotate`, so rotation stays metadata).
- **Decoder surfaces:**
  - The frame cache stores copies in the frame's own format (NV12 or I420), not decoder outputs.
  - At most 5 outputs are held as look-ahead for sequential reads, and frames before the target are closed as they arrive.
  - Holding more stalls hardware decoders: `flush()` never resolved before this change.
- **Chrome colour conversion:**
  - For CPU-backed YUV frames, Chrome's `drawImage` and `copyTo(RGBA)` use the BT.601 matrix even when the frame is tagged BT.709. That covers software-decoded I420 and NV12 copies.
  - Hardware frames convert correctly.
  - So seek tests compare raw I420 bytes with FFmpeg's decode, which is exact. Phase 3 converts YUV on the GPU with each frame's own matrix.
  - Until then, thumbnails of software-decoded video can be slightly off in colour.
- **Test media colour tags:** frames are tagged with `setparams` in the filter graph. FFmpeg encoders take colour metadata from frames, so `-color_*` output options alone left primaries and transfer "unknown".
- **HEVC:**
  - Chrome on this machine decodes HEVC in hardware.
  - WebView2 on Windows 10 needs the HEVC Video Extensions, so the desktop app proxies HEVC there.
  - CI's software Chrome cannot decode HEVC, so the web app refuses it with the codec-named message.
- **Mediabunny pin:** 1.61.3 (released 2026-10-05). Newer releases were days old.
- **Desktop file access:** the `cgv-media` protocol serves only registered ids. Responses are capped at 8 MiB per request, with CORS and `Cross-Origin-Resource-Policy: cross-origin` because the app is cross-origin isolated.

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

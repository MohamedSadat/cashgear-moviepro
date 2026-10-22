> Exported from the Claude Docs plan on 2026-10-22. The doc is the source of truth; progress lives in PROGRESS.md and decisions in decisions.md.

# CashGear Video — Implementation Plan

Oct 22, 2026 · @Sadat

## Overview

CashGear Video is a Filmora-level video editor that runs in the browser and as a desktop app from one Rust engine. Phases 0 to 5 deliver the MVP: import, multitrack timeline, real-time preview and export. Phases 6 to 11 add effects, titles, audio tools, creative tools, AI features and release.

| Decision | Choice | Reason |
| --- | --- | --- |
| Scope | Filmora-level consumer and prosumer editor | Realistic target; no pro color grading, collaboration or XML/EDL exchange |
| Engine | One Rust core compiled to WASM, running in the browser and inside the Tauri webview | One render path for both versions; no video frames sent over IPC |
| GPU | wgpu: WebGPU first, WebGL2 fallback | Same WGSL shaders on web and desktop |
| Preview decoding | WebCodecs (hardware) fed by a demuxer | Fast hardware decode in browsers and WebView2 |
| Native media (desktop) | FFmpeg LGPL build, dynamically linked, called from the Tauri Rust side | Probing, proxies for unsupported codecs, muxing and extra export formats |
| Export encoding | WebCodecs encoders in the engine worker | Hardware encode; only small encoded packets cross to native code |
| UI | React + TypeScript + Vite | Same stack as your other CashGear apps |
| Desktop shell | Tauri 2 | Small installer, Rust native side |
| Name | CashGear Video, repo `cashgear-video` | Matches CashGear Capture and CashGear Audio |
| Dependency licenses | MIT, BSD, Apache, MPL, Zlib, OFL for fonts; FFmpeg LGPL via dynamic linking only | No GPL: no x264, x265 or GPL-enabled FFmpeg builds |

One refinement to the desktop export choice: frames are encoded inside the webview with WebCodecs, and native FFmpeg receives the encoded stream for muxing and extra formats. Sending raw 1080p30 frames over Tauri IPC would mean about 240 MB/s, which is too slow.

Default targets until Phase 0 confirms them: Windows 10/11 x64 first, macOS second; Chrome and Edge first on the web, Safari and Firefox best-effort. Performance target: three stacked 1080p30 tracks play smoothly on a mid-range laptop, with 4K handled through proxies.

## Agent working rules

The agent works only in the main worktree on `main`, asks before every phase, and closes every phase with a next-phase card.

**Git**

- All work happens in the main worktree on the `main` branch. No feature branches, no extra worktrees, no pull requests.
- Small commits in Conventional Commits format, scoped by crate or package: `feat(engine): frame cache with LRU budget`, `fix(ui): snap to playhead`.
- Every commit builds and passes `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, and `pnpm lint && pnpm typecheck && pnpm test`.
- Tag each finished phase: `phase-0`, `phase-1`, and so on. Tag the end of Phase 5 as `v0.1.0-mvp`.
- Never commit secrets, signing keys or large media. Test clips are fetched by `scripts/fetch-test-media`.

**Questions in every phase**

1. At the start of a phase, read `docs/PLAN.md`, `docs/PROGRESS.md` and `docs/decisions.md`.
2. Ask the phase's listed questions, plus any new ones from what earlier phases revealed, in one batch. Use the ask-question card when the tool has one, with a recommended option first.
3. Wait for the answers before writing code. Record every answer in `docs/decisions.md` with the date.
4. During the phase, stop and ask when a choice is expensive to reverse or the plan is unclear. For small choices, pick the sensible default and log it in `docs/decisions.md`.

**End of every phase**

1. Check each exit criterion and record the evidence (test names, benchmark numbers) in `docs/PROGRESS.md`.
2. Commit, then tag the phase.
3. Show a next-phase card in this format:

```text
Phase N complete: <phase name>
Done: <3 to 5 bullets>
Exit criteria: <each one, passed or failed, with evidence>
Known gaps: <anything deferred>
Next: Phase N+1, <phase name>, <one-line goal>
Questions I will ask before starting: <2 or 3 questions>
Reply "go" to start Phase N+1, or tell me what to change.
```

**Hard limits**

- No GPL or AGPL dependencies. `cargo-deny` and an npm license check run in CI and fail the build.
- FFmpeg is LGPL only, dynamically linked, built without `--enable-gpl` or `--enable-nonfree`.
- The UI never touches media or GPU state directly. Every change goes through an engine command so it can be undone.

## Architecture and repo layout

The same WASM engine runs in a Web Worker in both versions; the desktop app only adds a native Rust side for files and FFmpeg jobs.

_Architecture diagram (shared engine and desktop native side): see the original doc, https://claude.ai/artifact/Js5xZycFNS65iRnUYTmeYj._

Raw frames never cross to native code: the native side streams media bytes in and receives only encoded packets for export.

```text
cashgear-video/
  Cargo.toml              Rust workspace
  crates/
    cgv-time/             rational time, frame rates, timecode (flicks)
    cgv-model/            project + timeline model, edit commands, undo/redo (pure Rust, no I/O)
    cgv-media/            demuxing, media info, frame cache, thumbnail and waveform data
    cgv-render/           wgpu compositor, WGSL effects and transitions, text rendering
    cgv-audio/            audio mixing graph, resampling, fades, audio effects
    cgv-engine/           playback clock and scheduler; ties model, media, render and audio
    cgv-wasm/             wasm-bindgen API for the UI and the WebCodecs bridge
    cgv-native/           desktop only: FFmpeg probe/proxy/mux jobs, files, media protocol
  apps/
    web/                  Vite web app (PWA)
    desktop/              Tauri 2 shell; src-tauri depends on cgv-native
  packages/
    ui/                   React components: timeline, monitors, panels, inspector
    engine-client/        TypeScript wrapper around cgv-wasm and worker messaging
  assets/                 transitions, LUTs, fonts, title and project templates
  tests/
    golden/               reference frames and golden render tests
    fixtures/             small test projects
  scripts/                fetch-test-media, build-ffmpeg-lgpl, license checks
  docs/                   PLAN.md, PROGRESS.md, decisions.md
```

**Threads (web and desktop)**

- **Main thread:** React UI only. It sends commands to the engine and draws from state snapshots the engine sends back.
- **Engine worker:** runs `cgv-wasm`. It owns the project model, WebCodecs decoders, the frame cache and the wgpu compositor, and renders to an `OffscreenCanvas` transferred from the program monitor.
- **Audio worklet:** an `AudioWorklet` reads mixed PCM from a `SharedArrayBuffer` ring buffer that the engine fills. The audio clock is the master clock for A/V sync.
- **Background workers:** thumbnails, waveform peaks and AI jobs, so they never block playback.
- `SharedArrayBuffer` requires cross-origin isolation, so COOP and COEP headers are set in the Vite dev server, web hosting and the Tauri config from Phase 0.

**Desktop native side (Tauri commands)**

- File dialogs, project save and load, app cache folders.
- A custom `cgv-media://` protocol that streams local files to the webview with HTTP range requests, so large files are never copied through IPC.
- FFmpeg jobs: probe, proxy transcode, mux encoded packets into the final file, and convert to extra formats.

**Frame path**

UI command, then model update (undoable), then `renderFrame(t)` finds active clips, then the frame cache returns decoded `VideoFrame`s, then the compositor draws them on the GPU, then the result goes to the monitor canvas or to the export encoder. Preview and export use the same `renderFrame(t)`; preview only lowers resolution and may drop frames.

## Phase 0: Scaffold, toolchain, CI

**Goal:** a wgpu canvas rendered from the WASM engine worker shows in both the browser and the Tauri app, with CI enforcing quality and licenses.

**Questions to ask first**

- Confirm the targets: Windows 10/11 first, macOS second, Chrome and Edge first on the web?
- pnpm workspaces and GitHub Actions on your GitHub account, or other tools?
- Minimum hardware for the reference test machine (CPU, GPU, RAM)?

**Tasks**

1. Create the Cargo workspace with all crates as stubs, and the pnpm workspace with `apps/web`, `apps/desktop`, `packages/ui` and `packages/engine-client`.
2. Build `cgv-wasm` with wasm-bindgen and load it in Vite inside a dedicated engine worker.
3. Transfer an `OffscreenCanvas` from the program monitor to the worker; initialise wgpu with WebGPU and a WebGL2 fallback; draw an animated test pattern.
4. Set COOP/COEP headers in Vite dev, a sample production server config and Tauri; prove `SharedArrayBuffer` works in both.
5. Scaffold the Tauri 2 app loading the same UI, with one sample command from `cgv-native`.
6. Startup capability check: WebGPU, WebCodecs, cross-origin isolation; show a clear message when something is missing.
7. CI: fmt, clippy, tests, WASM build, web build, Tauri Windows build, `cargo-deny` and npm license checks.
8. Add `docs/PLAN.md` (this plan), `docs/PROGRESS.md`, `docs/decisions.md` and `scripts/fetch-test-media`.

**Exit criteria**

- [ ] `pnpm dev:web` shows the animated wgpu pattern rendered in the worker.
- [ ] `pnpm dev:desktop` shows the same pattern in Tauri.
- [ ] The capability check reports correctly on WebGPU and WebGL2 paths.
- [ ] CI is green, and adding a GPL test dependency makes it fail.

## Phase 1: Media import, decoding, proxies, thumbnails

**Goal:** any common video, audio or image file can be imported, and the engine can return the exact frame at any time without leaking memory.

**Questions to ask first**

- Demuxer: a pure-Rust MP4/MOV/WebM demuxer inside the engine, or Mediabunny (TypeScript, MPL-2.0) in the worker?
- Proxy format: 720p H.264 with a short keyframe interval, or another choice?
- On the web, what happens with codecs WebCodecs cannot decode: reject with a message, or offer server-side conversion later?
- Web storage: keep files as handles (File System Access API) or copy them into OPFS?

**Tasks**

1. `cgv-time`: integer time in flicks (705,600,000 per second, divisible by all common frame and sample rates), frame-rate types including 23.976 and 29.97, timecode formatting.
2. Media library model: media items with ID, path or handle, duration, streams, codec, resolution, frame rate, rotation, color info.
3. Import by file picker and drag and drop. Desktop paths stream through the `cgv-media://` protocol; web files use handles or OPFS.
4. Demuxing for MP4, MOV and WebM; MP3, WAV, AAC and Opus audio; PNG, JPEG and WebP images.
5. WebCodecs `VideoDecoder` and `AudioDecoder` wrappers with `isConfigSupported` checks and a small decoder pool.
6. Frame-accurate seek: jump to the previous keyframe, decode forward, discard frames until the target timestamp.
7. Frame cache with an LRU memory budget. Wrap every `VideoFrame` so it is always closed; count open frames in a dev overlay.
8. Desktop: FFmpeg probe for every file; automatic proxy transcode for codecs WebCodecs cannot decode (for example ProRes); `scripts/build-ffmpeg-lgpl` to produce the shared libraries.
9. Background jobs: filmstrip thumbnails and audio waveform peaks, cached on disk (desktop) or in OPFS (web).
10. Basic media library panel: thumbnail, name, duration, resolution, codec, proxy status.

**Exit criteria**

- [ ] A test set (H.264 MP4, HEVC MOV, VP9 WebM, ProRes MOV on desktop, MP3, WAV, PNG) imports and shows correct info.
- [ ] Seeking to frame N matches the reference frame extracted by FFmpeg, by checksum or within a small tolerance.
- [ ] Unsupported codecs get proxies on desktop and a clear message on the web.
- [ ] 1,000 random seeks leave zero open `VideoFrame`s and stable memory.

## Phase 2: Project model, timeline core, undo/redo

**Goal:** a fully tested timeline model where every edit is a command that can be undone, saved and reloaded exactly.

**Questions to ask first**

- Track model: Filmora-style free tracks (any clip type on any track) or separate video and audio tracks?
- Default project settings: 1080p30 16:9, with 9:16 and 1:1 presets?
- Project file: a single JSON `.cgvproj` file, or a folder bundle that also holds caches?

**Tasks**

1. `cgv-model` types: project settings (resolution, frame rate, sample rate, aspect presets), media references, tracks (video, audio, overlay), clips (source, in and out points, timeline start, speed, transform, opacity, volume, effects list, keyframes), markers.
2. Edit commands: insert, overwrite, append, ripple delete, split at playhead, trim (ripple and roll), move, slip, slide, link and unlink audio with video, add, remove, lock, mute and hide tracks.
3. Undo and redo stack with grouping, so one drag or one multi-clip action is one undo step.
4. Queries: `clips_at(t)`, track ranges, snap points (clip edges, playhead, markers).
5. Serialization: versioned JSON schema with migrations, autosave every 30 seconds, crash recovery on startup, relink dialog for missing media.
6. Expose commands and snapshots through `cgv-wasm` and `engine-client`.
7. Tests: unit tests per command; property tests with `proptest` (no overlaps on a track, durations stay consistent, undo restores the exact previous state).

**Exit criteria**

- [ ] Every edit command has unit tests and passes the property tests.
- [ ] Save then load produces an identical project.
- [ ] 1,000 random commands followed by 1,000 undos restore the original project exactly.
- [ ] Autosave recovers a project after the app is killed mid-edit.

## Phase 3: GPU compositor, audio engine, real-time playback

**Goal:** the program monitor plays a multitrack timeline in real time with audio and video in sync, using one `renderFrame(t)` that export will reuse.

**Questions to ask first**

- Is the WebGL2 fallback required for the MVP, or can it wait until Phase 11?
- Color scope: Rec.709 SDR only for now, with HDR later?
- Preview quality options: Full, 1/2 and 1/4 resolution, plus an Auto mode?

**Tasks**

1. `cgv-render`: wgpu render graph; import `VideoFrame`s as GPU textures (WebGPU external textures, WebGL2 texture upload); a texture pool reused across frames.
2. Linear-light compositing with premultiplied alpha and sRGB output.
3. Layer stack drawn bottom track first, with transform (position, scale, rotation, anchor), crop, opacity and normal blend.
4. `renderFrame(t)` as a pure function of project and time: same input, same output, at any seek position.
5. Preview resolution scaling and frame dropping when the GPU falls behind.
6. `cgv-audio`: decode audio to f32 PCM, mix clips with gain and fades, resample to the project rate with `rubato`, write to the worklet ring buffer.
7. Playback engine: audio clock as master, video scheduled against it, decoders pre-rolled ahead of the playhead, short audio snippets while scrubbing.
8. Program monitor UI: play and pause, J/K/L shuttle, frame step, timecode, preview quality menu, dev frame-time overlay.
9. Golden render tests: fixture projects rendered to PNG and compared with tolerance, on WebGPU and WebGL2.

**Exit criteria**

- [ ] Three stacked 1080p30 H.264 tracks play in real time at full preview resolution on the reference machine.
- [ ] A/V drift stays under one frame over 10 minutes of playback.
- [ ] Golden tests for transform, crop and opacity pass on both GPU backends.
- [ ] A seek on cached media shows the frame in under 100 ms.

## Phase 4: Timeline UI and editing tools

**Goal:** a Filmora-style editing workspace where a 5-minute edit can be built with mouse and keyboard, staying smooth with hundreds of clips.

**Questions to ask first**

- Magnetic main track (Filmora-style, gaps close automatically) or free placement on all tracks?
- Keyboard shortcut preset: Filmora-like, Premiere-like, or both?
- UI components: reuse your CG component library, or a headless library such as Radix with custom styling?
- Dark theme only at first, or dark and light?

**Tasks**

1. Workspace layout with resizable panels: media library, program monitor, inspector, timeline.
2. Timeline drawn on a canvas for clips, thumbnails and waveforms, with React only for headers, menus and overlays (a DOM node per clip is too slow at scale).
3. Track headers with mute, lock and hide; time ruler with zoom; playhead; clip names, filmstrips and waveforms.
4. Interactions: drag from media library, move, trim handles, split at playhead, ripple delete, multi-select, copy and paste, markers, snapping with visual guides.
5. Inspector: transform, crop, opacity, volume and basic speed for the selected clip.
6. Shortcut map with a settings screen to view and change keys.
7. Every interaction sends an engine command, so everything is undoable; the UI only renders snapshots.
8. Playwright tests for the main editing flows in Chromium.

**Exit criteria**

- [ ] A 5-minute edit with 30 clips can be built without touching code or dev tools.
- [ ] The timeline scrolls and zooms at 60 fps with 500 clips.
- [ ] Every action can be undone and redone.
- [ ] Playwright flows pass in CI.

## Phase 5: Export pipeline (MVP complete)

**Goal:** the timeline exports to a correct, in-sync MP4 that matches the preview, on web and desktop. This phase ends with the `v0.1.0-mvp` tag.

**Questions to ask first**

- Default export: H.264 + AAC MP4, with HEVC, VP9 and AV1 offered only when the hardware supports them?
- Desktop extra formats at launch: MOV, MKV, GIF, MP3, WAV, or a shorter list?
- Free-tier rules for later licensing: watermark, resolution cap, or none in the MVP?

**Tasks**

1. Export dialog with presets (YouTube 1080p and 4K, TikTok 9:16, Instagram 1:1) and custom resolution, frame rate, bitrate or quality, and format.
2. Render loop: `renderFrame(t)` for every frame at full quality, with no frame dropping.
3. Encode with WebCodecs `VideoEncoder` and `AudioEncoder`, choosing codecs by `isConfigSupported`; AAC fallback to Opus where AAC encoding is missing on the web.
4. Web: mux MP4 or WebM in the worker and stream it to a File System Access file or OPFS, then download.
5. Desktop: stream encoded packets to the native side over a Tauri channel; mux with FFmpeg; convert to extra formats with FFmpeg.
6. Progress bar with time remaining, cancel, and background export while editing continues.
7. Round-trip test: export fixture projects, decode the output with FFmpeg, compare frames to preview renders (PSNR above 40 dB) and check audio sync.

**Exit criteria**

- [ ] Exported files play correctly in VLC, Chrome, Windows Media Player and pass a YouTube upload.
- [ ] Preview-to-export PSNR is above 40 dB on all fixture projects.
- [ ] A/V offset in exports is under one frame.
- [ ] A 1-minute 1080p30 project exports faster than real time on the reference machine.

## Phase 6: Effects, transitions, keyframes

**Goal:** any clip property can be animated, and clips can carry stacks of GPU effects and transitions defined as data, so new ones need no engine changes.

**Questions to ask first**

- How many effects and transitions at launch: about 20 of each, or more?
- Should the effect format be designed now as an installable pack format for a future effects store?
- Support `.cube` LUT import in this phase?

**Tasks**

1. Keyframe system: any numeric or color property can be animated; interpolation linear, hold, ease in, ease out and Bezier.
2. Keyframe UI: diamonds on the clip in the timeline and a curve lane in the inspector.
3. Effect framework: an effect is a WGSL shader plus a JSON parameter schema; the inspector UI is generated from the schema.
4. Per-clip effect chains: add, reorder, enable, disable and reset.
5. Built-in effects: brightness and contrast, exposure, saturation, temperature and tint, LUT, Gaussian blur, sharpen, vignette, noise, pixelate, mirror and flip, glitch, old film.
6. Transitions as two-input shaders driven by progress: cross dissolve, dip to black or white, wipes, slide, push, zoom, spin, blur, luma wipes from gradient images.
7. Transition UI: drag onto a cut, drag handles to set duration, default transition shortcut.
8. Adjustment layers: an overlay clip that applies its effects to everything below it.
9. Golden render tests for every effect and transition at fixed parameters.

**Exit criteria**

- [ ] Every built-in effect and transition has a passing golden test.
- [ ] A new effect can be added with only a shader file and a JSON schema.
- [ ] Keyframed transform plays smoothly and exports identically to preview.
- [ ] Five stacked effects on a 1080p clip still play in real time on the reference machine.

## Phase 7: Titles, text engine, overlays, stickers

**Goal:** animated titles render sharply at any size, with correct Arabic and English shaping, and images and stickers can be layered on the video.

**Questions to ask first**

- Which fonts ship with the app (for example a set of OFL Google Fonts with good Arabic coverage)?
- Should the app UI itself be localized to Arabic with a right-to-left layout, and in which phase?
- Sticker format: WebM with alpha and APNG first, with Lottie evaluated later?

**Tasks**

1. Text engine in Rust: shaping with `rustybuzz`, bidirectional text with `unicode-bidi`, line breaking with `unicode-linebreak`, font loading with `fontdb` and system fonts on desktop.
2. GPU text rendering that stays sharp under scale and rotation (signed-distance-field glyph atlas or tessellated outlines; decide and log it).
3. Title clips: font, size, color, stroke, shadow, background box, alignment, line spacing, letter spacing.
4. Title animations as keyframe presets: fade, slide, scale in, typewriter, word-by-word.
5. 30 title templates stored as JSON presets with a browser panel and live previews.
6. Overlays: PNG, JPEG and WebP with alpha, animated GIF and WebP, basic shapes.
7. Stickers as WebM with alpha or APNG, with a sticker browser panel.
8. Golden tests for Arabic, English and mixed text at several sizes and rotations.

**Exit criteria**

- [ ] Mixed Arabic and English titles shape and order correctly, checked against reference renders.
- [ ] Text is sharp at 4K export and at 400% scale.
- [ ] 30 title templates apply with one click and stay editable.
- [ ] Animated overlays play in sync with the timeline.

## Phase 8: Audio features

**Goal:** creators can mix music, dialogue and voiceover with fades, effects and loudness-correct export, without leaving the editor.

**Questions to ask first**

- Where will the built-in royalty-free music and sound effects come from?
- Which audio effects are must-have at launch?
- Should the audio engine share code with CashGear Audio, for example as a shared crate?

**Tasks**

1. Mixer panel: per-track volume, pan, mute and solo; master peak and RMS meters.
2. Clip gain, fade-in and fade-out handles on clips, automatic crossfades on overlapping audio.
3. Volume keyframes drawn as a line on the clip, editable directly in the timeline.
4. Audio effects: EQ, compressor, noise gate, reverb, and noise reduction with `nnnoiseless`.
5. Detach audio from video; audio ducking that lowers music under dialogue.
6. Voiceover recording with the microphone, a countdown, monitoring and placement at the playhead.
7. Loudness normalization on export to a chosen target (for example -14 LUFS) using the `ebur128` crate.
8. Music and sound-effect library panel with preview playback.

**Exit criteria**

- [ ] Recorded voiceover lines up within one frame of the playhead position.
- [ ] Exports hit the loudness target within 1 LU.
- [ ] Meters match a reference meter on test signals.
- [ ] Ducking reduces music under dialogue without clicks.

## Phase 9: Filmora-level creative tools

**Goal:** the creative tools that define a Filmora-style editor (speed ramps, green screen, masks, picture-in-picture and templates) work in preview and export.

**Questions to ask first**

- Which tools are must-have for the first release, and which can wait (stabilization and motion tracking are large on their own)?
- Who designs the project templates and intro/outro templates?
- Should templates be downloadable from a server later, or bundled only?

**Tasks**

1. Speed: constant speed from 0.1x to 100x, reverse, freeze frame, speed ramp curves with presets, pitch-preserving audio time-stretch.
2. Chroma key with key color picker, tolerance, spill suppression and edge feather.
3. Masks: rectangle, ellipse, polygon and Bezier shapes with feather, invert and keyframes.
4. Blend modes: multiply, screen, overlay, soft light, add, darken, lighten.
5. Picture-in-picture and split-screen layout presets.
6. Crop and zoom (Ken Burns) with start and end framing.
7. Project templates with placeholder slots: drop clips in, and titles and transitions stay in place; a template browser panel.
8. Golden tests for every tool; export tests for speed ramps and masks.

**Exit criteria**

- [ ] Speed ramps play smoothly and audio pitch is preserved.
- [ ] Green-screen footage keys cleanly on the test set without visible spill.
- [ ] 20 templates fill from user clips in under 10 seconds each.
- [ ] All tools export identically to preview.

## Phase 10: AI tools

**Goal:** the most-used Filmora AI features run locally: auto captions, background removal, scene and silence detection, and beat markers.

**Questions to ask first**

- Local only, or also cloud AI features later (text-to-speech, generative video) through a CashGear backend?
- Caption languages and priority: Arabic (which dialects), English, others?
- Largest acceptable model download per feature?

**Tasks**

1. Model runtime: ONNX Runtime through the `ort` crate on desktop and onnxruntime-web with WebGPU on the web, behind one Rust interface. Models download on first use.
2. Auto captions with a Whisper model: word timestamps, a caption track, an editor for fixing text and timing, caption styles, burn-in, and SRT/VTT export.
3. Background removal without a green screen using a person-segmentation model; results cached per clip so export reuses them. Verify each model's license allows commercial use before adding it.
4. Scene detection by frame-difference analysis (no model needed) with an "auto split" action.
5. Silence detection with an "auto remove silences" action that creates jump cuts.
6. Beat detection on music clips, adding markers to snap cuts to.
7. All AI jobs run in background workers with progress, cancel and results stored in the project cache.

**Exit criteria**

- [ ] Captions on the Arabic and English test clips need only minor corrections, measured by word error rate against reference transcripts.
- [ ] Background removal previews at 720p on the reference GPU, and export uses cached masks.
- [ ] Scene and silence detection produce correct cuts on the test set.
- [ ] No AI job blocks playback or editing.

## Phase 11: Performance, packaging, licensing, release

**Goal:** a signed, auto-updating desktop app and an installable web app, stable on long projects and connected to the CashGear licensing server.

**Questions to ask first**

- Pricing tiers and free-tier limits (watermark, export resolution, AI minutes)?
- Is macOS part of the first release, and do you have Windows and Apple code-signing certificates?
- Where will the web version be hosted, and on which domain?

**Tasks**

1. Performance pass: frame-time profiling, decoder pool tuning, GPU memory budget, background pre-rendering of heavy sections.
2. Stress tests: a 1-hour timeline with 1,000 clips, 8 hours of continuous playback, 4K proxy workflow.
3. Stability: crash recovery checks, opt-in error reporting, low-disk and out-of-memory handling.
4. Desktop packaging: Tauri bundler, Windows installer, code signing, auto-updater, FFmpeg LGPL libraries shipped as separate files with the LGPL notice and source offer.
5. Web: PWA install, offline app shell, storage quota handling, COOP/COEP on the production host.
6. Licensing: integrate the shared CashGear licensing server (activation, offline validation, free tier and Pro unlock).
7. Third-party license notices screen; final `cargo-deny` and npm license audit.
8. Release checklist, semantic versioning, changelog, `v1.0.0` tag.

**Exit criteria**

- [ ] Signed installer installs, updates and uninstalls cleanly on Windows.
- [ ] Activation and offline license checks work; free tier limits apply.
- [ ] The 1-hour project edits and exports without crashes or memory growth.
- [ ] The web app installs as a PWA and passes the capability check on Chrome and Edge.

## Risks and testing strategy

The biggest risks are codec gaps, frame leaks and webview differences; golden-frame and round-trip tests are the main defence because an agent-built engine needs objective checks.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| WebCodecs cannot decode some codecs (HEVC on some machines, ProRes) | Files fail to import | FFmpeg proxies on desktop; clear message on the web |
| `VideoFrame` leaks | Decoder stalls, crashes | Wrapper that always closes frames; open-frame counter; seek stress tests |
| Webview differences (WKWebView, WebKitGTK lack some WebGPU or WebCodecs support) | macOS and Linux desktop gaps | Windows first; WebGL2 fallback; startup capability check |
| WASM 4 GB memory limit | Long or 4K projects fail | Keep frames in `VideoFrame`s and GPU memory, not the WASM heap; stream files |
| Cross-origin isolation missing | No `SharedArrayBuffer`, no audio ring buffer | Headers set in Phase 0 and checked at startup |
| A/V drift | Out-of-sync playback and exports | Audio clock as master; 10-minute drift test; export sync check |
| FFmpeg license slip (GPL build) | Forced to open-source the app | Scripted LGPL build without `--enable-gpl`; CI check on the shipped libraries |
| Codec patent licensing for a paid product | Legal exposure | Use OS, browser and GPU encoders where possible; get legal advice before `v1.0.0` |
| Agent scope creep or silent design changes | Engine drifts from the plan | Questions every phase; decisions log; exit criteria with evidence |

**Testing layers**

- **Unit and property tests:** every edit command and the time math; `proptest` for timeline invariants and undo.
- **Golden render tests:** fixture projects rendered at fixed times and compared with reference PNGs, per GPU backend, with a tolerance.
- **Round-trip export tests:** export, decode with FFmpeg, compare against preview (PSNR) and check A/V offset.
- **UI tests:** Playwright flows in Chromium with WebGPU for import, edit, undo and export.
- **Benchmarks:** `criterion` for engine hot paths and recorded frame times in CI, failing on regressions over 10%.
- **Stress tests:** random seeks, long playback, 1,000-command undo fuzzing, 1-hour projects.
- **Manual checks:** a short test script per phase, run on the reference machine before the phase tag.

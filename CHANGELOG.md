# Changelog

CashGear Video follows [semantic versioning](https://semver.org). Each release's notes come from its section here: the release workflow copies them into the GitHub release and the update the desktop app shows.

## [1.0.1] - 2026-10-31

- **Every feature, no licence needed:** exports carry no watermark and go up to 4K, on the desktop and the web.
- **Templates:** "Thanks for watching" keeps its thank-you on screen with the subscribe button, instead of losing it after a second. Bold intro plays its riser to the end under the impact, and Before and after shows both labels.

## [1.0.0] - 2026-10-30

The first release: a video editor for Chrome and Edge, and for Windows as a desktop app, from one engine.

- **Editing:** a magnetic multitrack timeline with ripple, roll, slip and slide edits, splits, markers, snapping, linked sound, and undo for every edit. Projects save as `.cgvproj` files, autosave, recover after a crash, and relink moved media.
- **Playback:** real-time preview on the GPU (WebGPU, else WebGL2) with sound as the clock, J/K/L shuttle and automatic preview quality. 4K plays through proxies on the desktop.
- **Effects:** colour, blur, stylise and distortion effects; transitions; looks (LUTs); keyframes on every property, with a curve editor; masks; blend modes; speed ramps, reverse and freeze frames; picture in picture and split screens; green screen.
- **Titles:** 30 templates, Arabic and other right-to-left text, animation presets, stickers, and fonts that are bundled, imported or installed.
- **Sound:** a mixer with meters, sound effects (filters, dynamics, echo, reverb, noise reduction), ducking, loudness normalisation, voiceover recording, and a library of music and sound effects.
- **AI tools, on your computer:** captions in English, Arabic and other languages (Whisper), background removal, scene detection, silence removal and beat detection.
- **Project templates:** 20 templates with slots that fill from your media.
- **Export:** MP4, MOV, WebM and MKV in H.264, HEVC, VP9 and AV1, plus WAV; GIF and MP3 on the desktop. Presets for YouTube, TikTok and Instagram, and loudness targets.
- **Editions:** Free exports carry a small watermark and stop at 1080p. A Pro licence key removes the watermark and allows exports up to 4K, on the web and the desktop. Pro keeps working for 14 days without reaching the licence server.
- **Desktop app:** a per-user Windows installer, signed, that updates itself from the release feed. It runs FFmpeg (LGPL) for probing, proxies and conversions.
- **Web app:** installs as an app from Chrome or Edge, and starts offline once it has loaded.
- **About:** the version, the edition and the third-party notices.

[1.0.1]: https://github.com/MohamedSadat/cashgear-moviepro/releases/tag/v1.0.1
[1.0.0]: https://github.com/MohamedSadat/cashgear-moviepro/releases/tag/v1.0.0

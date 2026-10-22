# Deployment notes

## Web

`pnpm build` writes a static site to `apps/web/dist`. Serve it from the origin root over HTTPS, with these headers on every response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

Serve `.wasm` files as `application/wasm`.

Without the first two headers, the page is not cross-origin isolated. `SharedArrayBuffer` is then unavailable, and the startup capability check blocks the app with a message that names the missing headers.

- **Netlify or Cloudflare Pages:** `apps/web/public/_headers` already sets everything.
- **nginx:**

  ```nginx
  location / {
      add_header Cross-Origin-Opener-Policy same-origin always;
      add_header Cross-Origin-Embedder-Policy require-corp always;
      add_header Cross-Origin-Resource-Policy same-origin always;
      try_files $uri /index.html;
  }
  types { application/wasm wasm; }
  ```

Every asset must be same-origin or send its own CORP/CORS headers. Self-host fonts and other runtime files.

The production host and domain are a Phase 11 decision.

## Desktop

- `pnpm desktop:build` builds `target/release/cgv-desktop.exe`, with no installer yet.
- The Tauri config sets the same three headers and a CSP that allows `'wasm-unsafe-eval'` and same-origin workers. It also allows `connect-src` to the `cgv-media` protocol (`http://cgv-media.localhost` on Windows).
- **FFmpeg:**
  - The app runs `ffmpeg` and `ffprobe` as child processes. It looks for them in `CGV_FFMPEG_DIR`, then in an `ffmpeg` folder next to the executable, then on PATH.
  - It refuses builds configured with `--enable-gpl` or `--enable-nonfree`.
  - For development, `pnpm setup:ffmpeg` puts the pinned LGPL build in `.tools/ffmpeg`.
  - The installer (Phase 11) ships that folder with its `LICENSE.txt` and a source offer.
- **Cache:** proxies, thumbnails and waveform peaks live in the app cache folder: `%LOCALAPPDATA%\com.cashgear.video` on Windows.
- Signed installers and the auto-updater come in Phase 11.

## Diagnostic URLs

| URL                                             | Effect                                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `?gpu=webgl2`                                   | Skip WebGPU and use the WebGL2 renderer.                                                                                                        |
| `?diagnostic=1`                                 | Show the "Simulate device loss" and "Simulate Rust panic" buttons, and expose `window.__cgv` (engine client, media library, platform) to tests. |
| `?dev=1` or Ctrl+Shift+D                        | Show the dev overlay: open VideoFrames, frame cache size, decoders.                                                                             |
| `?diagnostic=1&fault=adapter` or `fault=device` | Make the worker's WebGPU adapter or device request fail, which exercises the WebGL2 fallback.                                                   |

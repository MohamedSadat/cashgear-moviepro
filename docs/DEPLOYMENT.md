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
- The Tauri config sets the same three headers and a CSP that allows `'wasm-unsafe-eval'` and same-origin workers.
- Signed installers and the auto-updater come in Phase 11.

## Diagnostic URLs

| URL                                             | Effect                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `?gpu=webgl2`                                   | Skip WebGPU and use the WebGL2 renderer.                                                      |
| `?diagnostic=1`                                 | Show the "Simulate device loss" and "Simulate Rust panic" buttons.                            |
| `?diagnostic=1&fault=adapter` or `fault=device` | Make the worker's WebGPU adapter or device request fail, which exercises the WebGL2 fallback. |

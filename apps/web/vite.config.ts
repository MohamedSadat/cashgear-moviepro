import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SharedArrayBuffer needs cross-origin isolation. The same headers are set for
// static hosting (public/_headers, public/staticwebapp.config.json) and in the
// Tauri config.
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, headers },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, headers },
  worker: { format: 'es' },
  // onnxruntime-web's build that loads its WASM and script as files of their
  // own: its threads start from that script, which a bundle would not have.
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: {
    target: 'es2022',
    // Pack media (sounds, stickers) stay files, however small: projects name them by path.
    assetsInlineLimit: (file) => (/\/assets\/(sounds|stickers)\//.test(file) ? false : undefined),
  },
});

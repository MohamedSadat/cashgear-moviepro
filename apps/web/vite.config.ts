import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SharedArrayBuffer needs cross-origin isolation. The same headers are set for
// static hosting (public/_headers) and in the Tauri config.
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
  build: { target: 'es2022' },
});

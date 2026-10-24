import { defineConfig } from '@playwright/test';

// CI runners have no GPU: GPU_TEST_SOFTWARE=1 switches to SwiftShader for WebGPU
// and WARP or SwiftShader for WebGL2. Locally the specs run on the real GPU.
// Both use installed Chrome or Edge: Playwright's bundled Chromium has no H.264 or AAC.
// Sound may start without a click, so API-driven tests play with the audio clock too.
const software = process.env.GPU_TEST_SOFTWARE === '1';
const autoplay = '--autoplay-policy=no-user-gesture-required';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: { timeout: 30000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never' }],
        ['json', { outputFile: 'bench/results/browser-tests.json' }],
      ]
    : [['list'], ['json', { outputFile: 'bench/results/browser-tests.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: software
        ? [
            '--enable-unsafe-webgpu',
            '--enable-unsafe-swiftshader',
            '--use-angle=d3d11-warp',
            '--use-webgpu-adapter=swiftshader',
            autoplay,
          ]
        : [autoplay],
    },
  },
  projects: software
    ? [
        { name: 'software-webgpu', use: { channel: 'chrome' } },
        {
          name: 'software-webgl2',
          grep: /WebGL2/,
          use: {
            channel: 'chrome',
            launchOptions: {
              args: [
                '--enable-unsafe-webgpu',
                '--enable-unsafe-swiftshader',
                '--use-angle=swiftshader',
                autoplay,
              ],
            },
          },
        },
      ]
    : [
        { name: 'chrome', use: { channel: 'chrome' } },
        { name: 'edge', use: { channel: 'msedge' } },
      ],
  webServer: {
    command: 'pnpm preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});

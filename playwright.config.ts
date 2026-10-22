import { defineConfig } from '@playwright/test';

// CI runners have no GPU: GPU_TEST_SOFTWARE=1 switches to SwiftShader for WebGPU
// and WARP or SwiftShader for WebGL2. Locally the specs run on the real GPU.
const software = process.env.GPU_TEST_SOFTWARE === '1';
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
          ]
        : [],
    },
  },
  projects: software
    ? [
        { name: 'software-webgpu', use: { channel: 'chromium' } },
        {
          name: 'software-webgl2',
          grep: /WebGL2/,
          use: {
            channel: 'chromium',
            launchOptions: {
              args: [
                '--enable-unsafe-webgpu',
                '--enable-unsafe-swiftshader',
                '--use-angle=swiftshader',
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

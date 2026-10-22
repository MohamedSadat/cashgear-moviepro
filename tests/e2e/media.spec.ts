import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Run `pnpm fetch-test-media` first. The clips carry their frame number as a
// barcode, and the manifest lists FFmpeg's decode of crops of selected frames as
// raw I420 bytes, which the engine's frames must match exactly.
const mediaDir = join(process.cwd(), 'tests/media');
interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Clip {
  file: string;
  frames?: number;
  expect: {
    container: string;
    kind: string;
    codecLabel?: string;
    width?: number;
    height?: number;
    rotation?: number;
    frameRateLabel?: string;
    frameCount?: number;
    audioCodecLabel?: string;
    sampleRate?: number;
    channels?: number;
    webDecodable?: boolean;
  };
  references?: { frame: number; file: string; crop: Crop }[];
}
const manifest = JSON.parse(readFileSync(join(mediaDir, 'manifest.json'), 'utf8')) as {
  clips: Clip[];
};
const clips = manifest.clips;
const videos = clips.filter((clip) => clip.expect.kind === 'video');

interface Item {
  id: string;
  name: string;
  kind: string;
  container: string;
  source: { kind: string };
  status: { state: string; message?: string };
  video: { decodable: boolean; frameCount: number; codecLabel: string } | null;
  audio: { decodable: boolean } | null;
}

async function open(page: Page) {
  await page.goto('/?diagnostic=1');
  await page.waitForFunction(() => {
    const hooks = Reflect.get(window, '__cgv') as { client: unknown } | undefined;
    return !!hooks?.client;
  });
}

async function snapshot(page: Page): Promise<Item[]> {
  return page.evaluate(() => {
    const hooks = Reflect.get(window, '__cgv') as {
      client: { api: { mediaSnapshot(): Promise<unknown> } };
    };
    return hooks.client.api.mediaSnapshot();
  }) as Promise<Item[]>;
}

async function importFiles(page: Page, files: string[]) {
  const before = await page.getByTestId('media-item').count();
  await page
    .getByTestId('media-file-input')
    .setInputFiles(files.map((file) => join(mediaDir, file)));
  await expect(page.getByTestId('media-item')).toHaveCount(before + files.length, {
    timeout: 60000,
  });
  return snapshot(page);
}

/** Reads frame `frame` in the engine worker: its barcode and the raw I420 bytes of `crop` (base64). */
async function readFrame(page: Page, id: string, frame: number, crop?: Crop) {
  return page.evaluate(
    async ({ id, frame, crop }) => {
      const hooks = Reflect.get(window, '__cgv') as {
        client: {
          api: {
            readFrame(
              id: string,
              frame: number,
              crop?: unknown,
            ): Promise<{ barcode: number; yuv?: Uint8Array; format: string | null }>;
          };
        };
      };
      const result = await hooks.client.api.readFrame(id, frame, crop);
      let base64 = '';
      if (result.yuv) {
        let text = '';
        for (let i = 0; i < result.yuv.length; i += 0x8000)
          text += String.fromCharCode(...result.yuv.subarray(i, i + 0x8000));
        base64 = btoa(text);
      }
      return { barcode: result.barcode, yuv: base64, format: result.format };
    },
    { id, frame, crop },
  );
}

/** Decoded I420 bytes against FFmpeg's: how many differ, and by how much at most. */
function compare(yuvBase64: string, referenceFile: string) {
  const actual = Buffer.from(yuvBase64, 'base64');
  const reference = readFileSync(join(mediaDir, referenceFile));
  let differing = 0;
  let largest = 0;
  for (let i = 0; i < reference.length; i++) {
    const difference = Math.abs(actual[i] - reference[i]);
    if (difference) differing++;
    largest = Math.max(largest, difference);
  }
  return {
    bytes: reference.length,
    sameLength: actual.length === reference.length,
    differing,
    largest,
  };
}

test.describe.configure({ timeout: 120000 });

test('imports the test set and shows correct info', async ({ page }, testInfo) => {
  await open(page);
  const items = await importFiles(
    page,
    clips.map((clip) => clip.file),
  );
  for (const clip of clips) {
    const expected = clip.expect;
    const item = items.find((candidate) => candidate.name === clip.file)!;
    expect(item, clip.file).toBeTruthy();
    expect(item.kind).toBe(expected.kind);
    expect(item.container).toBe(expected.container);
    const row = page.locator(`[data-testid="media-item"][data-name="${clip.file}"]`);
    const meta = row.getByTestId('media-meta');
    if (expected.width) await expect(meta).toContainText(`${expected.width}×${expected.height}`);
    if (expected.codecLabel) await expect(meta).toContainText(expected.codecLabel);
    if (expected.frameRateLabel) await expect(meta).toContainText(`${expected.frameRateLabel} fps`);
    if (expected.rotation) await expect(meta).toContainText(`rotated ${expected.rotation}°`);
    if (expected.audioCodecLabel)
      await expect(meta).toContainText(
        `${expected.audioCodecLabel} ${expected.sampleRate! / 1000} kHz ${expected.channels === 1 ? 'Mono' : 'Stereo'}`,
      );
    if (expected.frameCount) expect(item.video!.frameCount).toBe(expected.frameCount);

    // Whatever this browser cannot decode must be refused with a message naming the codec.
    if (item.video && !item.video.decodable) {
      // Only HEVC (hardware-dependent) and ProRes may be refused; H.264 and VP9 must decode.
      expect(
        ['hevc', 'prores'].some((codec) => clip.file.startsWith(codec)),
        clip.file,
      ).toBe(true);
      await expect(row).toHaveAttribute('data-status', 'unsupported');
      await expect(row.getByTestId('media-status')).toContainText(
        `${item.video.codecLabel} can't be decoded in this browser`,
      );
      await expect(row.getByTestId('media-status')).toContainText('desktop app');
    } else {
      await expect(row).toHaveAttribute('data-status', 'ready');
      if (expected.kind !== 'audio')
        await expect(row.getByTestId('media-thumbnail')).toBeVisible({ timeout: 30000 });
    }
    if (expected.kind === 'audio' && item.audio?.decodable)
      await expect(row.getByTestId('media-waveform')).toBeVisible({ timeout: 30000 });
  }
  // ProRes never decodes in a browser.
  const prores = items.find((item) => item.name.startsWith('prores'))!;
  expect(prores.status.state).toBe('unsupported');
  await testInfo.attach('decodability', {
    body: JSON.stringify(
      items.map((i) => ({ name: i.name, video: i.video?.decodable, audio: i.audio?.decodable })),
    ),
    contentType: 'application/json',
  });
});

test('seeks to the exact frame, byte-identical to FFmpeg reference frames', async ({
  page,
}, testInfo) => {
  await open(page);
  const items = await importFiles(
    page,
    videos.map((clip) => clip.file),
  );
  const metrics: Record<string, unknown>[] = [];
  for (const clip of videos) {
    const item = items.find((candidate) => candidate.name === clip.file)!;
    if (!item.video?.decodable) continue;
    // Every reference frame: the barcode says which frame came back, the crop says it looks right.
    for (const reference of clip.references ?? []) {
      const frame = await readFrame(page, item.id, reference.frame, reference.crop);
      expect(frame.barcode, `${clip.file} frame ${reference.frame}`).toBe(reference.frame);
      const result = compare(frame.yuv, reference.file);
      metrics.push({ clip: clip.file, frame: reference.frame, format: frame.format, ...result });
      // Bit-exact: same decoder output as FFmpeg's, byte for byte.
      expect(result.sameLength, `${clip.file} frame ${reference.frame}`).toBe(true);
      expect(result.differing, `${clip.file} frame ${reference.frame}`).toBe(0);
    }
    // And a spread of frames, out of order, for the barcode alone.
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let i = 0; i < 25; i++) {
      const n = Math.floor(random() * clip.frames!);
      expect((await readFrame(page, item.id, n)).barcode, `${clip.file} frame ${n}`).toBe(n);
    }
  }
  expect(metrics.length).toBeGreaterThan(0);
  await testInfo.attach('reference-comparison', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
});

test('1,000 random seeks leave zero open VideoFrames and stable memory', async ({
  page,
}, testInfo) => {
  test.setTimeout(420000);
  await open(page);
  const items = await importFiles(
    page,
    videos.map((clip) => clip.file),
  );
  const decodable = items.filter((item) => item.video?.decodable);
  expect(decodable.length).toBeGreaterThan(0);
  const result = await page.evaluate(
    async (targets) => {
      const hooks = Reflect.get(window, '__cgv') as {
        client: {
          api: {
            readFrame(id: string, frame: number): Promise<{ barcode: number }>;
            mediaStats(): Promise<{
              openFrames: number;
              cacheBytes: number;
              cacheBudgetBytes: number;
            }>;
            releaseFrames(): Promise<void>;
          };
        };
      };
      const api = hooks.client.api;
      const heap = () =>
        (Reflect.get(performance, 'memory') as { usedJSHeapSize: number } | undefined)
          ?.usedJSHeapSize ?? 0;
      let seed = 12345;
      const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      let mismatches = 0;
      let maxOpen = 0;
      let overBudget = 0;
      const heapBefore = heap();
      const started = performance.now();
      for (let i = 0; i < 1000; i++) {
        const target = targets[Math.floor(random() * targets.length)];
        const frame = Math.floor(random() * target.frames);
        if ((await api.readFrame(target.id, frame)).barcode !== frame) mismatches++;
        if (i % 25 === 0) {
          const stats = await api.mediaStats();
          maxOpen = Math.max(maxOpen, stats.openFrames);
          if (stats.cacheBytes > stats.cacheBudgetBytes) overBudget++;
        }
      }
      const elapsed = performance.now() - started;
      const before = await api.mediaStats();
      await api.releaseFrames();
      const after = await api.mediaStats();
      return {
        mismatches,
        maxOpen,
        overBudget,
        before,
        after,
        heapBefore,
        heapAfter: heap(),
        elapsed,
      };
    },
    decodable.map((item) => ({ id: item.id, frames: item.video!.frameCount })),
  );
  await testInfo.attach('stress', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(result.mismatches).toBe(0);
  expect(result.overBudget).toBe(0);
  expect(result.after.openFrames).toBe(0);
  expect(result.after.cacheBytes).toBe(0);
  // The JS heap holds no frame data; allow some noise, not growth with the seek count.
  expect(result.heapAfter - result.heapBefore).toBeLessThan(20 * 1024 * 1024);
});

test('remembers imported media across reloads and forgets removed items', async ({ page }) => {
  await open(page);
  const imported = await importFiles(page, [
    'vp9-720p25-opus.webm',
    'tone-48k-stereo.wav',
    'still-1280x720.webp',
  ]);
  expect(imported.every((item) => item.source.kind === 'opfs')).toBe(true);
  await page.reload();
  await expect(page.getByTestId('media-item')).toHaveCount(3, { timeout: 30000 });
  const restored = await snapshot(page);
  expect(restored.map((item) => item.id).sort()).toEqual(imported.map((item) => item.id).sort());
  await expect(
    page.locator('[data-name="vp9-720p25-opus.webm"]').getByTestId('media-thumbnail'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Remove tone-48k-stereo.wav' }).click();
  await expect(page.getByTestId('media-item')).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId('media-item')).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator('[data-name="tone-48k-stereo.wav"]')).toHaveCount(0);
});

test('imports File System Access handles without copying, and restores them', async ({ page }) => {
  await open(page);
  const bytes = readFileSync(join(mediaDir, 'vp9-720p25-opus.webm')).toString('base64');
  const item = await page.evaluate(async (base64) => {
    // An OPFS handle stands in for one the user granted through the picker.
    const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('picked.webm', { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    const hooks = Reflect.get(window, '__cgv') as {
      library: { importRequests(requests: unknown[]): Promise<void> };
      client: { api: { mediaSnapshot(): Promise<unknown[]> } };
    };
    await hooks.library.importRequests([
      { id: crypto.randomUUID(), source: { kind: 'handle', handle } },
    ]);
    return (await hooks.client.api.mediaSnapshot())[0];
  }, bytes);
  expect((item as Item).source.kind).toBe('handle');
  expect((item as Item).status.state).toBe('ready');
  await page.reload();
  await expect(page.locator('[data-name="picked.webm"]')).toHaveCount(1, { timeout: 30000 });
  expect((await snapshot(page))[0].source.kind).toBe('handle');
});

test('imports dropped files', async ({ page }) => {
  await open(page);
  const bytes = readFileSync(join(mediaDir, 'tone-48k-stereo.wav')).toString('base64');
  const drop = await page.evaluateHandle((base64) => {
    const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], 'dropped.wav', { type: 'audio/wav' }));
    return transfer;
  }, bytes);
  await page.getByTestId('media-library').dispatchEvent('drop', { dataTransfer: drop });
  await expect(page.locator('[data-name="dropped.wav"]')).toHaveAttribute('data-status', 'ready', {
    timeout: 30000,
  });
});

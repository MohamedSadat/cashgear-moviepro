import { expect, test, type Page } from '@playwright/test';
import { FRAME, clear, compare, passes, render, run, setUp, still, tracks } from './golden-tools';

// Nested sequences. A sequence clip draws the same picture as its clips do
// unnested, three levels deep, on both backends: a dissolve, a scaled and
// rotated layer with a blend mode, and an adjustment layer inside. Opening a
// sequence from the timeline shows its tracks, an edit there is one undo step of
// the project, and breaking a sequence clip apart puts its clips back.
const software = process.env.GPU_TEST_SOFTWARE === '1';
const SECOND = 705_600_000;

type Snapshot = {
  undoLabel: string | null;
  project: {
    openSequence?: number | null;
    sequences?: { id: number; name: string }[];
    tracks: { id: number; clips: { id: number; kind?: string; start: number }[] }[];
  };
};

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => Reflect.get(window, '__cgv').client.api.projectSnapshot());
}

/** Where `time` and track `track` meet on screen. */
async function point(page: Page, time: number, track: number): Promise<[number, number]> {
  const canvas = page.getByTestId('timeline-canvas');
  const box = (await canvas.boundingBox())!;
  const { scale, scrollTime } = await canvas.evaluate((element) => ({
    scale: Number((element as HTMLElement).dataset.scale),
    scrollTime: Number((element as HTMLElement).dataset.scrollTime),
  }));
  const header = (await page
    .locator(`[data-testid="track"][data-track-id="${track}"]`)
    .boundingBox())!;
  return [box.x + ((time - scrollTime) / SECOND) * scale, header.y + header.height / 2 + 8];
}

for (const backend of ['WebGPU', 'WebGL2'] as const) {
  test(`${backend} a sequence clip draws what its clips draw unnested, three deep`, async ({
    page,
  }) => {
    const ids = await setUp(page, backend === 'WebGL2' ? '&gpu=webgl2' : '', [
      'sunset.png',
      'city.png',
    ]);
    await expect(page.getByTestId('gpu-backend')).toHaveText(backend);
    const [bottom, middle, top] = await clear(page, 3);
    const [a] = await run(page, {
      type: 'append',
      track: bottom,
      clip: still(ids, 'sunset.png', 30),
    });
    const [b] = await run(page, {
      type: 'append',
      track: bottom,
      clip: still(ids, 'city.png', 30),
    });
    await run(page, {
      type: 'addTransition',
      track: bottom,
      from: a,
      to: b,
      transition: { kind: 'cross-dissolve', duration: 10 * FRAME },
    });
    const [layer] = await run(page, {
      type: 'overwrite',
      track: middle,
      at: 10 * FRAME,
      clip: {
        ...still(ids, 'city.png', 40),
        properties: {
          transform: { x: 60, scaleX: 0.5, scaleY: 0.5, rotation: 12 },
          opacity: 0.7,
          blendMode: 'screen',
        },
      },
    });
    const [adjustment] = await run(page, {
      type: 'overwrite',
      track: top,
      at: 0,
      clip: { kind: 'adjustment', duration: 60 * FRAME },
    });
    await run(page, { type: 'addEffect', clip: adjustment, effect: { kind: 'sepia' } });
    const times = [5, 28, 45].map((frame) => frame * FRAME);
    const flat = [];
    for (const time of times) flat.push(await render(page, time));

    let clips = [a, b, layer, adjustment];
    for (let depth = 1; depth <= 3; depth++) {
      const [outer] = await run(page, { type: 'nest', clips });
      clips = [outer];
      expect((await tracks(page)).flatMap((track) => track.clips)).toHaveLength(1);
      for (const [index, time] of times.entries()) {
        const result = compare(await render(page, time), flat[index]);
        console.log(`${backend} depth ${depth} frame ${time / FRAME}: ${JSON.stringify(result)}`);
        expect(passes(result), JSON.stringify(result)).toBe(true);
        expect(result.mean, JSON.stringify(result)).toBeLessThan(0.05);
        // WARP's WebGL2 leaves a pixel or two off by about 3 for each level; hardware stays at 1.
        expect(result.worst, JSON.stringify(result)).toBeLessThanOrEqual(software ? 16 : 4);
      }
    }
  });
}

test('a sequence opens from the timeline, edits there undo as one step, and it breaks apart', async ({
  page,
}) => {
  const ids = await setUp(page, '', ['sunset.png', 'city.png']);
  const [bottom, upper] = await clear(page, 2);
  const [a] = await run(page, {
    type: 'append',
    track: bottom,
    clip: still(ids, 'sunset.png', 60),
  });
  const [b] = await run(page, {
    type: 'overwrite',
    track: upper,
    at: 15 * FRAME,
    clip: still(ids, 'city.png', 30),
  });
  const [outer, sequence] = await run(page, { type: 'nest', clips: [a, b] });
  await expect(page.getByTestId('sequence-path')).toHaveCount(0);

  // Double-clicking the sequence clip opens its sequence.
  await page.mouse.dblclick(...(await point(page, 30 * FRAME, bottom)));
  await expect(page.getByTestId('sequence-path')).toContainText('Main timeline');
  await expect(page.getByTestId('sequence-path')).toContainText('Sequence 1');
  await expect(page.getByTestId('timeline')).toHaveAttribute('data-sequence', String(sequence));
  let state = await snapshot(page);
  expect(state.project.openSequence).toBe(sequence);
  const inside = state.project.tracks.flatMap((track) => track.clips.map((clip) => clip.id));
  expect(inside.sort()).toEqual([a, b].sort());

  // An edit inside: one undo step, named for itself.
  await run(page, { type: 'move', clips: [b], delta: 15 * FRAME, tracks: 0 });
  state = await snapshot(page);
  expect(state.undoLabel).toBe('Move');
  expect(state.project.tracks[1].clips[0].start).toBe(30 * FRAME);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => (await snapshot(page)).project.tracks[1].clips[0].start)
    .toBe(15 * FRAME);
  expect((await snapshot(page)).undoLabel).toBe('Nest');

  // Back to the main timeline from the path.
  await page.getByTestId('sequence-path').getByRole('button', { name: 'Main timeline' }).click();
  await expect(page.getByTestId('sequence-path')).toHaveCount(0);
  state = await snapshot(page);
  expect(state.project.openSequence ?? null).toBeNull();
  expect(state.project.tracks[0].clips.map((clip) => clip.id)).toEqual([outer]);

  // Selecting the sequence clip and breaking it apart puts copies of its clips back.
  await page.mouse.click(...(await point(page, 30 * FRAME, bottom)));
  await page.keyboard.press('Alt+Shift+G');
  await expect
    .poll(async () =>
      (await snapshot(page)).project.tracks.map((track) =>
        track.clips.map((clip) => [clip.kind ?? 'media', clip.start / FRAME]),
      ),
    )
    .toEqual([[['media', 0]], [['media', 15]]]);
  expect((await snapshot(page)).project.sequences?.map((s) => s.id)).toEqual([sequence]);
});

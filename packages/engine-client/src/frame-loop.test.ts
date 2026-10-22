import { describe, expect, it } from 'vitest';
import { FrameLoop, type FrameScheduler } from './frame-loop';
import type { FrameStats, PhysicalSize } from './types';

function harness(options: { failOnFrame?: number } = {}) {
  const queue: ((now: number) => void)[] = [];
  const scheduler: FrameScheduler = {
    request: (callback) => queue.push(callback),
    cancel: (handle) => {
      queue[handle - 1] = () => {};
    },
  };
  const resizes: PhysicalSize[] = [];
  const stats: FrameStats[] = [];
  const errors: string[] = [];
  let frames = 0;
  let size: PhysicalSize = { width: 0, height: 0 };
  const loop = new FrameLoop(
    {
      resize: (next) => {
        size = next;
        resizes.push(next);
      },
      frame: () => {
        if (options.failOnFrame === frames + 1) throw new Error('GPU surface validation failed');
        frames++;
        return { frames, presented: true, ...size };
      },
    },
    scheduler,
    (s) => stats.push(s),
    (e) => errors.push(e),
    0,
  );
  let now = 0;
  const run = (count = 1) => {
    for (let i = 0; i < count; i++) {
      const pending = queue.splice(0);
      now += 16;
      pending.forEach((callback) => callback(now));
    }
  };
  return { loop, run, queue, resizes, stats, errors };
}

describe('FrameLoop', () => {
  it('renders continuously once started with an area', () => {
    const h = harness();
    h.loop.start({ width: 640, height: 360 });
    h.run(3);
    expect(h.stats.map((s) => s.frames)).toEqual([1, 2, 3]);
    expect(h.resizes).toEqual([{ width: 640, height: 360 }]);
  });

  it('applies only the latest of several resizes before the next frame', () => {
    const h = harness();
    h.loop.start({ width: 640, height: 360 });
    h.run();
    h.loop.resize({ width: 800, height: 450 });
    h.loop.resize({ width: 1280, height: 720 });
    h.run();
    expect(h.resizes).toEqual([
      { width: 640, height: 360 },
      { width: 1280, height: 720 },
    ]);
    expect(h.queue).toHaveLength(1);
  });

  it('pauses at zero size and resumes on the next resize', () => {
    const h = harness();
    h.loop.start({ width: 640, height: 360 });
    h.run(2);
    h.loop.resize({ width: 0, height: 0 });
    h.run(3);
    expect(h.stats.at(-1)).toEqual({ frames: 2, presented: false, width: 0, height: 0 });
    expect(h.queue).toHaveLength(0);
    h.loop.resize({ width: 320, height: 180 });
    h.run();
    expect(h.stats.at(-1)?.frames).toBe(3);
  });

  it('stops on the first error and reports it once', () => {
    const h = harness({ failOnFrame: 2 });
    h.loop.start({ width: 640, height: 360 });
    h.run(4);
    expect(h.errors).toEqual(['GPU surface validation failed']);
    expect(h.queue).toHaveLength(0);
    h.loop.resize({ width: 100, height: 100 });
    expect(h.queue).toHaveLength(0);
  });
});

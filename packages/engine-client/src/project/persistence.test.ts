import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaRef } from './types';
import { Autosaver, fileChanged, planOpen, projectIdOf, referencedMedia } from './persistence';

describe('planOpen', () => {
  it('opens the saved file when there is no autosave', () => {
    expect(planOpen('saved', null)).toEqual({ kind: 'saved', text: 'saved', staleAutosave: false });
  });
  it('asks when the autosave differs from the saved file', () => {
    const autosave = { text: 'newer', modified: 5 };
    expect(planOpen('saved', autosave)).toEqual({ kind: 'ask', saved: 'saved', autosave });
    expect(planOpen(null, autosave)).toEqual({ kind: 'ask', saved: null, autosave });
  });
  it('drops an autosave identical to the saved file', () => {
    expect(planOpen('same', { text: 'same', modified: 1 })).toEqual({
      kind: 'saved',
      text: 'same',
      staleAutosave: true,
    });
  });
  it('reports a project with neither file', () => {
    expect(planOpen(null, null)).toEqual({ kind: 'missing' });
  });
});

describe('project file helpers', () => {
  const file = (id: string, media: string[]) =>
    JSON.stringify({
      format: 'cashgear-video-project',
      version: 1,
      project: { id, media: media.map((m) => ({ id: m })) },
    });

  it('collects media ids from every readable file', () => {
    const ids = referencedMedia([
      file('a', ['m1', 'm2']),
      null,
      'not json',
      file('b', ['m2', 'm3']),
    ]);
    expect([...ids].sort()).toEqual(['m1', 'm2', 'm3']);
  });
  it('reads the project id', () => {
    expect(projectIdOf(file('p-1', []))).toBe('p-1');
    expect(projectIdOf('{}')).toBeNull();
    expect(projectIdOf('nope')).toBeNull();
  });
});

describe('fileChanged', () => {
  const media: MediaRef = {
    id: 'm',
    name: 'clip.mp4',
    kind: 'video',
    duration: 1,
    hasVideo: true,
    hasAudio: false,
    width: 1,
    height: 1,
    frameRate: null,
    size: 100,
    modified: 1000,
    location: { kind: 'browser' },
  };
  const handle = { kind: 'url', url: 'u', path: 'p', name: 'n', size: 100 } as const;
  const copy = { kind: 'opfs', path: 'media/m/clip.mp4' } as const;

  it('notices a new size or modified time', () => {
    expect(fileChanged(media, media, handle)).toBe(false);
    expect(fileChanged(media, { ...media, size: 101 }, handle)).toBe(true);
    expect(fileChanged(media, { ...media, modified: 2000 }, handle)).toBe(true);
    expect(fileChanged(media, { ...media, modified: null }, handle)).toBe(false);
  });
  it('compares browser copies by size only', () => {
    expect(fileChanged(media, { ...media, modified: 2000 }, copy)).toBe(false);
    expect(fileChanged(media, { ...media, size: 99 }, copy)).toBe(true);
  });
});

describe('Autosaver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function target(pending: () => boolean) {
    const writes: number[] = [];
    const errors: unknown[] = [];
    return {
      writes,
      errors,
      target: {
        pending,
        write: vi.fn(async () => {
          writes.push(Date.now());
        }),
        onError: (error: unknown) => errors.push(error),
      },
    };
  }

  it('writes on each interval only while changes are pending', async () => {
    let pending = true;
    const { writes, target: t } = target(() => pending);
    const saver = new Autosaver(t, 30_000);
    saver.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
    pending = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writes).toHaveLength(1);
    pending = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toHaveLength(2);
    saver.stop();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(writes).toHaveLength(2);
  });

  it('flushes at once, one write at a time, and reports failures', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const errors: unknown[] = [];
    const saver = new Autosaver(
      {
        pending: () => true,
        write: () => {
          calls++;
          if (calls === 2) return Promise.reject(new Error('disk full'));
          return new Promise<void>((resolve) => (release = resolve));
        },
        onError: (error) => errors.push(error),
      },
      30_000,
    );
    const first = saver.flush();
    const second = saver.flush();
    expect(calls).toBe(1);
    release();
    await first;
    await second;
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
  });
});

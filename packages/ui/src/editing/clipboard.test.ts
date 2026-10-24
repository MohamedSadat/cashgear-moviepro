import { describe, expect, it } from 'vitest';
import { FLICKS_PER_SECOND, type Clip, type Project, type Track } from '@cgv/engine-client';
import { copyClips, planPaste } from './clipboard';

const S = FLICKS_PER_SECOND;

function clip(id: number, start: number, duration: number, link: number | null = null): Clip {
  return {
    id,
    media: 'm',
    start: start * S,
    duration: duration * S,
    sourceIn: S,
    speed: { num: 2, den: 1 },
    video: true,
    audio: false,
    link,
    transform: { x: 4, y: 0, scaleX: 0.5, scaleY: 0.5, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    opacity: 0.5,
    volumeDb: -3,
  };
}

const track = (id: number, clips: Clip[]): Track => ({
  id,
  name: '',
  locked: false,
  muted: false,
  hidden: false,
  clips,
});

function project(magnetic: boolean): Project {
  return {
    id: 'p',
    name: 'P',
    settings: {
      width: 1920,
      height: 1080,
      frameRate: { num: 30, den: 1 },
      sampleRate: 48000,
      channels: 2,
    },
    media: [],
    // Sound below the main track, an overlay above it.
    tracks: [
      track(10, [clip(5, 2, 3, 50)]),
      track(11, [clip(1, 0, 2), clip(2, 2, 3, 50), clip(3, 5, 4)]),
      track(12, [clip(4, 6, 1)]),
    ],
    mainTrack: 11,
    magnetic,
    markers: [],
    nextId: 60,
  };
}

describe('copy', () => {
  it('keeps each clip, its settings and its place relative to the first', () => {
    const items = copyClips(project(true), [4, 2, 5]);
    expect(items.map((item) => [item.track, item.offset / S, item.group])).toEqual([
      [10, 0, 50],
      [11, 0, 50],
      [12, 4, null],
    ]);
    expect(items[2].clip).toMatchObject({
      sourceIn: S,
      duration: S,
      speed: { num: 2, den: 1 },
      properties: { opacity: 0.5, volumeDb: -3, transform: { x: 4 } },
    });
  });

  it('drops a link when only one of its clips is copied', () => {
    expect(copyClips(project(true), [2]).map((item) => item.group)).toEqual([null]);
  });
});

describe('paste', () => {
  it('inserts main-track copies at the nearest cut, and linked copies follow them', () => {
    const items = copyClips(project(true), [2, 5, 4]);
    // 5.4 s is nearest the cut at 5 s; the overlay keeps its 4 s offset from there.
    const plan = planPaste(project(true), items, 5.4 * S);
    expect(plan.commands).toEqual([
      expect.objectContaining({ type: 'overwrite', track: 10, at: 5 * S }),
      expect.objectContaining({ type: 'insert', track: 11, at: 5 * S }),
      expect.objectContaining({ type: 'overwrite', track: 12, at: 9 * S }),
    ]);
    expect(plan.links).toEqual([[0, 1]]);
  });

  it('places several main-track copies one after another', () => {
    const plan = planPaste(project(true), copyClips(project(true), [1, 3]), 0.4 * S);
    expect(plan.commands.map((command) => command.type === 'insert' && command.at / S)).toEqual([
      0, 2,
    ]);
  });

  it('overwrites everywhere when the main track is not magnetic', () => {
    const at = (12 * S) / 30;
    const plan = planPaste(project(false), copyClips(project(false), [1, 3]), at);
    expect(plan.commands).toEqual([
      expect.objectContaining({ type: 'overwrite', at }),
      expect.objectContaining({ type: 'overwrite', at: at + 5 * S }),
    ]);
  });

  it('puts copies from a deleted track on the main track', () => {
    const items = copyClips(project(true), [4]);
    const without = { ...project(true), tracks: project(true).tracks.slice(0, 2) };
    expect(planPaste(without, items, 3 * S).commands[0]).toMatchObject({
      type: 'insert',
      track: 11,
      at: 2 * S,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { FLICKS_PER_SECOND, type Clip, type Project, type Track } from '@cgv/engine-client';
import {
  aboveRows,
  clampView,
  dropZoneHeight,
  fitScale,
  hitTest,
  layoutRows,
  nearestCut,
  nearestTarget,
  rowAt,
  rulerHeight,
  rulerTicks,
  snapDelta,
  snapTargets,
  timeToX,
  visibleClips,
  xToTime,
  zoomAt,
  type View,
} from './geometry';

const S = FLICKS_PER_SECOND;
const rate = { num: 30, den: 1 };

function clip(id: number, start: number, duration: number): Clip {
  return {
    id,
    media: 'm',
    start: start * S,
    duration: duration * S,
    sourceIn: 0,
    speed: { num: 1, den: 1 },
    video: true,
    audio: true,
    link: null,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    opacity: 1,
    volumeDb: 0,
  };
}

function track(id: number, clips: Clip[]): Track {
  return { id, name: '', locked: false, muted: false, hidden: false, clips };
}

function project(tracks: Track[]): Project {
  return {
    id: 'p',
    name: 'P',
    settings: { width: 1920, height: 1080, frameRate: rate, sampleRate: 48000, channels: 2 },
    media: [],
    tracks,
    mainTrack: tracks[0].id,
    magnetic: true,
    markers: [{ id: 99, time: 12 * S, name: '', color: 'red' }],
    nextId: 100,
  };
}

// 100 px per second, scrolled 2 s in.
const view: View = { scale: 100, scrollTime: 2 * S, scrollTop: 0, width: 1000, height: 400 };

describe('time and pixels', () => {
  it('map both ways', () => {
    expect(timeToX(view, 2 * S)).toBe(0);
    expect(timeToX(view, 5 * S)).toBe(300);
    expect(xToTime(view, 300)).toBe(5 * S);
  });

  it('zoom about the pointer and fit the project', () => {
    const zoomed = zoomAt(view, 2, 300);
    expect(zoomed.scale).toBe(200);
    expect(xToTime(zoomed, 300)).toBeCloseTo(5 * S);
    expect(zoomAt(view, 1e9, 0).scale).toBe(2160);
    expect(fitScale(100 * S, 1050)).toBeCloseTo(10);
    expect(fitScale(1 * S, 1050)).toBeCloseTo(100);
  });

  it('labels ruler ticks at a readable spacing', () => {
    const { major, minor } = rulerTicks(view, rate);
    expect(major[0].label).toBe('00:02');
    expect(major[1].time - major[0].time).toBe(1 * S);
    expect(minor.length).toBe(major.length * 4);
    const close = rulerTicks({ ...view, scale: 2000 }, rate);
    expect(close.major[1].time - close.major[0].time).toBe((2 * S) / 30);
    expect(close.major[1].label).toBe('00:02:02');
  });
});

describe('rows and hits', () => {
  const bottom = track(1, [clip(1, 0, 3), clip(2, 3, 4), clip(3, 10, 1)]);
  const top = track(2, [clip(4, 5, 2)]);
  const p = project([bottom, top]);
  const rows = layoutRows(p.tracks);

  it('lays the top track out first', () => {
    expect(rows.map((row) => row.track.id)).toEqual([2, 1]);
    expect(rows[0].top).toBe(rulerHeight + dropZoneHeight);
    expect(rowAt(rows, view, rows[1].top + 1)?.track.id).toBe(1);
    expect(rowAt(rows, view, 5)).toBeNull();
    expect(aboveRows(rows, view, rulerHeight + 1)).toBe(true);
    expect(aboveRows(rows, view, rows[0].top + 1)).toBe(false);
    expect(clampView({ ...view, scrollTop: 1e6, scrollTime: -5 }, rows)).toMatchObject({
      scrollTop: 0,
      scrollTime: 0,
    });
  });

  it('finds visible clips by binary search', () => {
    expect(visibleClips(bottom.clips, 2.5 * S, 4 * S).map((c) => c.id)).toEqual([1, 2]);
    expect(visibleClips(bottom.clips, 7 * S, 10 * S).map((c) => c.id)).toEqual([]);
    expect(visibleClips(bottom.clips, 7 * S, 10.5 * S).map((c) => c.id)).toEqual([3]);
  });

  it('tells clips from their edges, markers and the ruler', () => {
    const y = rows[1].top + 10;
    // Clip 2 runs from x 100 to 500.
    expect(hitTest(p, rows, view, 300, y)).toMatchObject({ kind: 'clip', edge: null });
    expect(hitTest(p, rows, view, 103, y)).toMatchObject({ kind: 'clip', edge: 'start' });
    expect(hitTest(p, rows, view, 497, y)).toMatchObject({ kind: 'clip', edge: 'end' });
    expect(hitTest(p, rows, view, 504, y)).toMatchObject({ kind: 'clip', edge: 'end' });
    expect(hitTest(p, rows, view, 650, y)).toMatchObject({ kind: 'empty' });
    expect(hitTest(p, rows, view, 1002, 10)).toMatchObject({ kind: 'marker' });
    expect(hitTest(p, rows, view, 300, 10)).toMatchObject({ kind: 'ruler', time: 5 * S });
  });
});

describe('snapping and cuts', () => {
  const p = project([track(1, [clip(1, 0, 3), clip(2, 3, 4)]), track(2, [clip(3, 5, 2)])]);

  it('collects targets, leaving out the clips being moved', () => {
    expect(snapTargets(p, 6 * S, new Set([3]))).toEqual([0, 3 * S, 6 * S, 7 * S, 12 * S]);
  });

  it('snaps to the nearest target within the tolerance', () => {
    const targets = [0, 3 * S, 7 * S];
    expect(nearestTarget(targets, 3.05 * S, 0.1 * S)).toBe(3 * S);
    expect(nearestTarget(targets, 3.5 * S, 0.1 * S)).toBeNull();
    // A clip from 5 to 7 s moved by 0.1 s: its end lands near the target at 7 s.
    expect(snapDelta(targets, [5 * S, 7 * S], 0.1 * S, 0.15 * S)).toEqual({
      delta: 0,
      guide: 7 * S,
    });
    expect(snapDelta(targets, [5 * S, 7 * S], 2.05 * S, 0.1 * S)).toEqual({
      delta: 2 * S,
      guide: 7 * S,
    });
    expect(snapDelta(targets, [5 * S], 1 * S, 0.1 * S)).toEqual({ delta: 1 * S, guide: null });
  });

  it('finds the nearest cut, earlier on a tie', () => {
    const clips = p.tracks[0].clips;
    expect(nearestCut(clips, 1 * S)).toBe(0);
    expect(nearestCut(clips, 1.5 * S)).toBe(0);
    expect(nearestCut(clips, 2 * S)).toBe(3 * S);
    expect(nearestCut(clips, 50 * S)).toBe(7 * S);
  });
});

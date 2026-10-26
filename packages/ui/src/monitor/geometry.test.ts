import { describe, expect, it } from 'vitest';
import {
  apply,
  centredRect,
  framingRect,
  framingTransform,
  invert,
  letterbox,
  pictureToProject,
} from './geometry';

const identity = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 };
const hd = { width: 1920, height: 1080 };

describe('monitor geometry', () => {
  it('places a picture as the renderer does', () => {
    // A 4:3 picture fits the height of a 16:9 frame.
    const m = pictureToProject(hd, { width: 1440, height: 1080 }, identity);
    expect(apply(m, { x: 0, y: 0 })).toEqual({ x: 240, y: 0 });
    expect(apply(m, { x: 1, y: 1 })).toEqual({ x: 1680, y: 1080 });
    // Turned 90° about its centre: its top left comes to the top right.
    const turned = pictureToProject(hd, hd, { ...identity, rotation: 90 });
    const corner = apply(turned, { x: 0, y: 0 });
    expect(corner.x).toBeCloseTo(1500);
    expect(corner.y).toBeCloseTo(-420);
    const back = apply(invert(turned), corner);
    expect(back.x).toBeCloseTo(0);
    expect(back.y).toBeCloseTo(0);
  });

  it('letterboxes the frame on the monitor', () => {
    expect(letterbox({ width: 800, height: 800 }, hd)).toEqual({ x: 0, y: 175, scale: 800 / 1920 });
  });

  it('frames a part of the picture and reads it back', () => {
    const picture = { width: 4000, height: 3000 };
    const start = centredRect(hd, picture, 1);
    // The whole width of a 4:3 picture in a 16:9 frame: 3/4 of its height.
    expect(start).toEqual({ x: 0, y: 0.125, w: 1, h: 0.75 });
    const close = { x: 0.5, y: 0.4, w: 0.3, h: 0.225 };
    const transform = { ...identity, ...framingTransform(hd, picture, close) };
    const rect = framingRect(hd, picture, transform);
    for (const key of ['x', 'y', 'w', 'h'] as const) expect(rect[key]).toBeCloseTo(close[key]);
    // The rect's centre lands in the middle of the frame.
    const m = pictureToProject(hd, picture, transform);
    const centre = apply(m, { x: 0.65, y: 0.5125 });
    expect(centre.x).toBeCloseTo(960);
    expect(centre.y).toBeCloseTo(540);
  });
});

import { describe, expect, it } from 'vitest';
import { apply, pictureToProject } from '../monitor/geometry';
import { cellProperties, pipTransform, splitLayouts } from './layouts';

const hd = { width: 1920, height: 1080 };

describe('layouts', () => {
  it('puts a picture in a corner, a margin in', () => {
    const t = pipTransform(hd, hd, 'bottomRight', 0.25);
    expect(t.scaleX).toBe(0.25);
    const m = pictureToProject(hd, hd, t);
    const corner = apply(m, { x: 1, y: 1 });
    // 4% of the frame's height from the right and bottom edges.
    expect(corner.x).toBeCloseTo(1920 - 43.2, 1);
    expect(corner.y).toBeCloseTo(1080 - 43.2, 1);
    const left = apply(pictureToProject(hd, hd, pipTransform(hd, hd, 'topLeft', 0.5)), {
      x: 0,
      y: 0,
    });
    expect(left.x).toBeCloseTo(43.2, 1);
    expect(left.y).toBeCloseTo(43.2, 1);
  });

  it('fills a cell, cropping what sticks out', () => {
    // A 16:9 picture in the left half: it covers the half's height and is cropped at its sides.
    const half = splitLayouts.find((layout) => layout.id === 'columns-2')!.cells[0];
    const { properties, mask } = cellProperties(hd, hd, half);
    expect(mask).toBeNull();
    const t = { rotation: 0, anchorX: 0.5, anchorY: 0.5, ...properties.transform } as Parameters<
      typeof pictureToProject
    >[2];
    const m = pictureToProject(hd, hd, t);
    const crop = properties.crop!;
    const left = apply(m, { x: crop.left!, y: 0 });
    const right = apply(m, { x: 1 - crop.right!, y: 1 });
    expect(left.x).toBeCloseTo(0, 6);
    expect(right.x).toBeCloseTo(960, 6);
    expect(left.y).toBeCloseTo(0, 6);
    expect(right.y).toBeCloseTo(1080, 6);
  });

  it('every layout covers the frame, and slanted cells get masks', () => {
    for (const layout of splitLayouts) {
      const area = layout.cells.reduce((sum, cell) => sum + cell.w * cell.h, 0);
      if (!layout.cells.some((cell) => cell.polygon)) expect(area).toBeCloseTo(1, 9);
      for (const cell of layout.cells) {
        const { mask } = cellProperties(hd, hd, cell);
        expect(!!mask).toBe(!!cell.polygon);
        mask?.points?.forEach((point) => {
          expect(Math.abs(point.x)).toBeLessThanOrEqual(0.5 + 1e-9);
          expect(Math.abs(point.y)).toBeLessThanOrEqual(0.5 + 1e-9);
        });
      }
    }
    expect(splitLayouts.length).toBe(10);
  });
});

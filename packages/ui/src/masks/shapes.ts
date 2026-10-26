import type { Mask, MaskPoint, MaskShape } from '@cgv/engine-client';

/** What the masks panel can add. A polygon and a pen mask are both paths. */
export type MaskTool = 'rectangle' | 'ellipse' | 'polygon' | 'pen';

export const maskTools: { tool: MaskTool; label: string }[] = [
  { tool: 'rectangle', label: 'Rectangle' },
  { tool: 'ellipse', label: 'Ellipse' },
  { tool: 'polygon', label: 'Polygon' },
  { tool: 'pen', label: 'Pen' },
];

/** A circle's Bézier handle length, as a fraction of its radius. */
const kappa = 0.5523;

/** The points of a regular polygon of `sides` in a mask's box, pointing up. */
export function polygonPoints(sides: number): MaskPoint[] {
  return Array.from({ length: sides }, (_, i) => {
    const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
    return { x: round(Math.cos(angle) / 2), y: round(Math.sin(angle) / 2) };
  });
}

/** A round Bézier path of four points, to reshape on the monitor. */
export function penPoints(): MaskPoint[] {
  const h = round(kappa / 2);
  return [
    { x: 0, y: -0.5, inX: -h, outX: h },
    { x: 0.5, y: 0, inY: -h, outY: h },
    { x: 0, y: 0.5, inX: h, outX: -h },
    { x: -0.5, y: 0, inY: h, outY: -h },
  ];
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** A new mask of `tool` in the middle of the picture, half its size. */
export function newMask(tool: MaskTool): Mask {
  const shape: MaskShape = tool === 'polygon' || tool === 'pen' ? 'path' : tool;
  return {
    id: 0,
    shape,
    mode: 'add',
    x: 0.5,
    y: 0.5,
    width: 0.5,
    height: 0.5,
    rotation: 0,
    roundness: 0,
    feather: 0,
    expansion: 0,
    opacity: 1,
    points: tool === 'polygon' ? polygonPoints(5) : tool === 'pen' ? penPoints() : undefined,
  };
}

/** A mask's name in the panel. */
export function maskName(mask: Mask, index: number): string {
  const kind =
    mask.shape === 'path'
      ? mask.points?.some((p) => p.inX || p.inY || p.outX || p.outY)
        ? 'Pen'
        : 'Polygon'
      : mask.shape === 'ellipse'
        ? 'Ellipse'
        : 'Rectangle';
  return `${kind} ${index + 1}`;
}

/** The keyframe property of mask `id`'s `setting`, as the model names it. */
export const maskProperty = (id: number, setting: string) => `masks.${id}.${setting}`;

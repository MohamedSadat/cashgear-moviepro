import type { ClipProperties, Mask, Transform } from '@cgv/engine-client';
import { fitScale, type Size } from '../monitor/geometry';

// Picture-in-picture and split-screen presets. They only write ordinary
// transform, crop and mask values, so everything they set stays editable.

export type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export const corners: { corner: Corner; label: string }[] = [
  { corner: 'topLeft', label: 'Top left' },
  { corner: 'topRight', label: 'Top right' },
  { corner: 'bottomLeft', label: 'Bottom left' },
  { corner: 'bottomRight', label: 'Bottom right' },
];

/** Picture-in-picture sizes, as fractions of the frame's width. */
export const pipSizes = [
  { id: 'small', label: 'Small', fraction: 0.25 },
  { id: 'medium', label: 'Medium', fraction: 1 / 3 },
  { id: 'large', label: 'Large', fraction: 0.5 },
] as const;

/** The gap between an inset picture and the frame's edges, as a fraction of its height. */
const margin = 0.04;

/** A picture `fraction` of the frame wide in `corner`, a margin in from its edges. */
export function pipTransform(
  project: Size,
  picture: Size,
  corner: Corner,
  fraction: number,
): Transform {
  const fit = fitScale(project, picture);
  const scale = (project.width * fraction) / (picture.width * fit);
  const width = picture.width * fit * scale;
  const height = picture.height * fit * scale;
  const gap = project.height * margin;
  const dx = project.width / 2 - gap - width / 2;
  const dy = project.height / 2 - gap - height / 2;
  const right = corner === 'topRight' || corner === 'bottomRight';
  const bottom = corner === 'bottomLeft' || corner === 'bottomRight';
  return {
    x: round(right ? dx : -dx),
    y: round(bottom ? dy : -dy),
    scaleX: round(scale, 5),
    scaleY: round(scale, 5),
    rotation: 0,
    anchorX: 0.5,
    anchorY: 0.5,
  };
}

const round = (value: number, places = 2) => Number(value.toFixed(places));

/** A cell of a layout: a box of the frame (fractions), or a polygon for slanted splits. */
export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corners of a slanted cell, as fractions of the frame, inside its box. */
  polygon?: [number, number][];
}

export interface SplitLayout {
  id: string;
  label: string;
  cells: Cell[];
}

const box = (x: number, y: number, w: number, h: number): Cell => ({ x, y, w, h });
const third = 1 / 3;

/** Split screens, filled from the selected clips in order. */
export const splitLayouts: SplitLayout[] = [
  { id: 'columns-2', label: 'Side by side', cells: [box(0, 0, 0.5, 1), box(0.5, 0, 0.5, 1)] },
  { id: 'rows-2', label: 'Top and bottom', cells: [box(0, 0, 1, 0.5), box(0, 0.5, 1, 0.5)] },
  {
    id: 'columns-3',
    label: 'Three columns',
    cells: [box(0, 0, third, 1), box(third, 0, third, 1), box(2 * third, 0, third, 1)],
  },
  {
    id: 'rows-3',
    label: 'Three rows',
    cells: [box(0, 0, 1, third), box(0, third, 1, third), box(0, 2 * third, 1, third)],
  },
  {
    id: 'grid-4',
    label: 'Grid of four',
    cells: [
      box(0, 0, 0.5, 0.5),
      box(0.5, 0, 0.5, 0.5),
      box(0, 0.5, 0.5, 0.5),
      box(0.5, 0.5, 0.5, 0.5),
    ],
  },
  {
    id: 'big-left',
    label: 'One and two',
    cells: [
      box(0, 0, 2 * third, 1),
      box(2 * third, 0, third, 0.5),
      box(2 * third, 0.5, third, 0.5),
    ],
  },
  {
    id: 'big-top',
    label: 'One over two',
    cells: [box(0, 0, 1, 0.5), box(0, 0.5, 0.5, 0.5), box(0.5, 0.5, 0.5, 0.5)],
  },
  {
    id: 'grid-6',
    label: 'Grid of six',
    cells: [0, 1].flatMap((row) =>
      [0, 1, 2].map((column) => box(column * third, row * 0.5, third, 0.5)),
    ),
  },
  {
    id: 'diagonal',
    label: 'Diagonal',
    cells: [
      {
        ...box(0, 0, 0.6, 1),
        polygon: [
          [0, 0],
          [0.6, 0],
          [0.4, 1],
          [0, 1],
        ],
      },
      {
        ...box(0.4, 0, 0.6, 1),
        polygon: [
          [0.6, 0],
          [1, 0],
          [1, 1],
          [0.4, 1],
        ],
      },
    ],
  },
  {
    id: 'diagonal-3',
    label: 'Three slants',
    cells: [
      {
        ...box(0, 0, 0.42, 1),
        polygon: [
          [0, 0],
          [0.42, 0],
          [0.25, 1],
          [0, 1],
        ],
      },
      {
        ...box(0.25, 0, 0.5, 1),
        polygon: [
          [0.42, 0],
          [0.75, 0],
          [0.58, 1],
          [0.25, 1],
        ],
      },
      {
        ...box(0.58, 0, 0.42, 1),
        polygon: [
          [0.75, 0],
          [1, 0],
          [1, 1],
          [0.58, 1],
        ],
      },
    ],
  },
];

/**
 * What puts a picture in `cell`: scaled to cover its box, centred on it, and
 * cropped to it; a slanted cell adds a polygon mask (in picture coordinates).
 */
export function cellProperties(
  project: Size,
  picture: Size,
  cell: Cell,
): { properties: ClipProperties; mask: Mask | null } {
  const fit = fitScale(project, picture);
  const cellWidth = cell.w * project.width;
  const cellHeight = cell.h * project.height;
  const scale = Math.max(cellWidth / (picture.width * fit), cellHeight / (picture.height * fit));
  const width = picture.width * fit * scale;
  const height = picture.height * fit * scale;
  // What sticks out of the box is cropped evenly from both sides.
  const sideX = Math.max(0, (width - cellWidth) / 2 / width);
  const sideY = Math.max(0, (height - cellHeight) / 2 / height);
  const properties: ClipProperties = {
    transform: {
      x: round((cell.x + cell.w / 2) * project.width - project.width / 2),
      y: round((cell.y + cell.h / 2) * project.height - project.height / 2),
      scaleX: round(scale, 5),
      scaleY: round(scale, 5),
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    crop: {
      left: round(sideX, 5),
      right: round(sideX, 5),
      top: round(sideY, 5),
      bottom: round(sideY, 5),
    },
  };
  if (!cell.polygon) return { properties, mask: null };
  // Frame fractions to the picture's own fractions: the box spans the picture's
  // uncropped middle.
  const toPicture = ([fx, fy]: [number, number]) => ({
    u: 0.5 + ((fx - (cell.x + cell.w / 2)) * project.width) / width,
    v: 0.5 + ((fy - (cell.y + cell.h / 2)) * project.height) / height,
  });
  const points = cell.polygon.map(toPicture);
  return {
    properties,
    mask: {
      id: 0,
      shape: 'path',
      mode: 'add',
      x: 0.5,
      y: 0.5,
      width: 1,
      height: 1,
      opacity: 1,
      points: points.map(({ u, v }) => ({ x: round(u - 0.5, 5), y: round(v - 0.5, 5) })),
    },
  };
}

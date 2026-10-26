import type { Clip, Project, Transform } from '@cgv/engine-client';

// Where a clip's picture lands on the monitor, as crates/cgv-render/src/geometry.rs
// places it: the picture fits the frame, then the clip's transform moves, scales
// and turns it about its anchor. Upright picture coordinates (u, v) run from 0
// to 1 across the picture; project coordinates are pixels from the frame's top left.

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export const apply = (m: Affine, p: Point): Point => ({
  x: m.a * p.x + m.c * p.y + m.tx,
  y: m.b * p.x + m.d * p.y + m.ty,
});

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c || 1e-12;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    tx: (m.c * m.ty - m.d * m.tx) / det,
    ty: (m.b * m.tx - m.a * m.ty) / det,
  };
}

/** The scale that fits `picture` inside the frame, keeping its shape: transform scale 1. */
export function fitScale(project: Size, picture: Size): number {
  return Math.min(project.width / picture.width, project.height / picture.height);
}

/** Upright (u, v) of `picture` to project pixels under `transform`. */
export function pictureToProject(project: Size, picture: Size, transform: Transform): Affine {
  const fit = fitScale(project, picture);
  const w = picture.width * fit;
  const h = picture.height * fit;
  const pivotX = project.width / 2 + transform.x + (transform.anchorX - 0.5) * w;
  const pivotY = project.height / 2 + transform.y + (transform.anchorY - 0.5) * h;
  const angle = (transform.rotation * Math.PI) / 180;
  const [sin, cos] = [Math.sin(angle), Math.cos(angle)];
  const a = cos * transform.scaleX * w;
  const b = sin * transform.scaleX * w;
  const c = -sin * transform.scaleY * h;
  const d = cos * transform.scaleY * h;
  return {
    a,
    b,
    c,
    d,
    tx: pivotX - (a * transform.anchorX + c * transform.anchorY),
    ty: pivotY - (b * transform.anchorX + d * transform.anchorY),
  };
}

/** The frame's place on a monitor of `monitor` pixels: the largest fit, centred. */
export function letterbox(monitor: Size, project: Size): { x: number; y: number; scale: number } {
  const scale = Math.min(monitor.width / project.width, monitor.height / project.height);
  return {
    x: (monitor.width - project.width * scale) / 2,
    y: (monitor.height - project.height * scale) / 2,
    scale,
  };
}

/** A part of the picture: left, top, width and height as fractions of it. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Ken Burns: the transform that fills the frame with `rect` of the picture
 * (`rect` has the frame's shape). The anchor stays in the middle.
 */
export function framingTransform(
  project: Size,
  picture: Size,
  rect: Rect,
): Pick<Transform, 'x' | 'y' | 'scaleX' | 'scaleY'> {
  const fit = fitScale(project, picture);
  const scale = project.width / (rect.w * picture.width * fit);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    x: -(cx - 0.5) * picture.width * fit * scale,
    y: -(cy - 0.5) * picture.height * fit * scale,
    scaleX: scale,
    scaleY: scale,
  };
}

/** The inverse of [`framingTransform`]: the part of the picture the frame shows. */
export function framingRect(project: Size, picture: Size, transform: Transform): Rect {
  const fit = fitScale(project, picture);
  const w = project.width / (transform.scaleX * picture.width * fit);
  const h = project.height / (transform.scaleY * picture.height * fit);
  const cx = 0.5 - transform.x / (picture.width * fit * transform.scaleX);
  const cy = 0.5 - transform.y / (picture.height * fit * transform.scaleY);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** The frame-shaped part of the picture `fraction` of its size, centred. */
export function centredRect(project: Size, picture: Size, fraction: number): Rect {
  const aspect = project.width / project.height / (picture.width / picture.height);
  // As much of the picture as the frame's shape allows.
  const w = aspect >= 1 ? 1 : aspect;
  const h = aspect >= 1 ? 1 / aspect : 1;
  return {
    x: 0.5 - (w * fraction) / 2,
    y: 0.5 - (h * fraction) / 2,
    w: w * fraction,
    h: h * fraction,
  };
}

/** The picture a clip shows, upright: its media's, or the frame for a title. */
export function pictureOf(project: Project, clip: Clip, rotations: Map<string, number>): Size {
  const frame = { width: project.settings.width, height: project.settings.height };
  if (clip.kind === 'title' || clip.kind === 'adjustment') return frame;
  const media = project.media.find((item) => item.id === clip.media);
  if (!media?.width || !media.height) return frame;
  const turned = (rotations.get(media.id) ?? 0) % 180 === 90;
  return turned
    ? { width: media.height, height: media.width }
    : { width: media.width, height: media.height };
}

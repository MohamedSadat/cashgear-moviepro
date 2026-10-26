import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  Clip,
  Command,
  EngineClient,
  Mask,
  MaskPoint,
  Project,
  Transform,
} from '@cgv/engine-client';
import type { Gesture } from '../editing/gesture';
import type { EditorState } from '../editing/useEditor';
import { isAnimated, numberAt } from '../effects/animation';
import { clamp, keyContext, usePausedTime } from '../inspector/fields';
import { maskName, maskProperty } from '../masks/shapes';
import { frameDuration } from '../timeline/geometry';
import {
  apply,
  centredRect,
  framingRect,
  framingTransform,
  invert,
  letterbox,
  pictureToProject,
  type Affine,
  type Point,
  type Rect,
  type Size,
} from './geometry';

export type OverlayMode = 'transform' | 'crop' | 'mask' | 'kenBurns';

const modes: { mode: OverlayMode; label: string }[] = [
  { mode: 'transform', label: 'Transform' },
  { mode: 'crop', label: 'Crop' },
  { mode: 'mask', label: 'Masks' },
  { mode: 'kenBurns', label: 'Ken Burns' },
];

const transformKeys = ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'anchorX', 'anchorY'] as const;
const cropKeys = ['left', 'top', 'right', 'bottom'] as const;
const maskKeys = [
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'roundness',
  'feather',
  'expansion',
  'opacity',
] as const;

/** The clip's transform at `offset`, keyframes applied. */
function transformAt(clip: Clip, offset: number): Transform {
  const out = { ...clip.transform };
  for (const key of transformKeys) out[key] = numberAt(clip, `transform.${key}`, offset, out[key]);
  return out;
}

function cropAt(clip: Clip, offset: number) {
  const out = { ...clip.crop };
  for (const key of cropKeys) out[key] = numberAt(clip, `crop.${key}`, offset, out[key]);
  return out;
}

/** A mask at `offset`, its settings and points keyframes applied. */
export function maskAt(clip: Clip, mask: Mask, offset: number): Mask {
  const out: Mask = { ...mask, points: mask.points?.map((point) => ({ ...point })) };
  for (const key of maskKeys)
    (out as unknown as Record<string, number>)[key] = numberAt(
      clip,
      maskProperty(mask.id, key),
      offset,
      (mask[key] as number | undefined) ?? (key === 'opacity' ? 1 : 0),
    );
  out.points?.forEach((point, i) => {
    point.x = numberAt(clip, maskProperty(mask.id, `point${i}.x`), offset, point.x);
    point.y = numberAt(clip, maskProperty(mask.id, `point${i}.y`), offset, point.y);
  });
  return out;
}

/**
 * Commands that set `values` (keyframe property names to numbers) at `offset`:
 * keyframes for animated properties, static values for the rest, as one step.
 */
function setValues(
  clip: Clip,
  offset: number,
  values: Record<string, number>,
  stat: (values: Record<string, number>) => Command | null,
): Command {
  const commands: Command[] = [];
  const statics: Record<string, number> = {};
  for (const [property, value] of Object.entries(values)) {
    if (isAnimated(clip, property))
      commands.push({ type: 'setKeyframe', clip: clip.id, property, time: offset, value });
    else statics[property] = value;
  }
  const rest = Object.keys(statics).length ? stat(statics) : null;
  if (rest) commands.unshift(rest);
  return commands.length === 1 ? commands[0] : { type: 'batch', commands };
}

/** The picture a clip shows, upright: its media's, or the frame for a title. */
function pictureOf(project: Project, clip: Clip, rotations: Map<string, number>): Size {
  const frame = { width: project.settings.width, height: project.settings.height };
  if (clip.kind === 'title' || clip.kind === 'adjustment') return frame;
  const media = project.media.find((item) => item.id === clip.media);
  if (!media?.width || !media.height) return frame;
  const turned = (rotations.get(media.id) ?? 0) % 180 === 90;
  return turned
    ? { width: media.height, height: media.width }
    : { width: media.width, height: media.height };
}

/** The ellipse or rounded box of a mask as an SVG path in screen pixels. */
function maskPath(mask: Mask, picture: Size, toScreen: (p: Point) => Point): string {
  const cx = mask.x * picture.width;
  const cy = mask.y * picture.height;
  const hw = (mask.width * picture.width) / 2;
  const hh = (mask.height * picture.height) / 2;
  const angle = ((mask.rotation ?? 0) * Math.PI) / 180;
  const [sin, cos] = [Math.sin(angle), Math.cos(angle)];
  const place = (lx: number, ly: number) =>
    toScreen({
      x: (cx + cos * lx - sin * ly) / picture.width,
      y: (cy + sin * lx + cos * ly) / picture.height,
    });
  const points: Point[] = [];
  if (mask.shape === 'ellipse') {
    for (let i = 0; i < 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      points.push(place(Math.cos(t) * hw, Math.sin(t) * hh));
    }
  } else if (mask.shape === 'rectangle') {
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ])
      points.push(place(x * hw, y * hh));
  } else {
    const list = mask.points ?? [];
    list.forEach((a, i) => {
      const b = list[(i + 1) % list.length];
      for (let s = 0; s < 12; s++) {
        const t = s / 12;
        const u = 1 - t;
        const bez = (p0: number, c1: number, c2: number, p3: number) =>
          u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p3;
        const x = bez(a.x, a.x + (a.outX ?? 0), b.x + (b.inX ?? 0), b.x);
        const y = bez(a.y, a.y + (a.outY ?? 0), b.y + (b.inY ?? 0), b.y);
        points.push(place(x * 2 * hw, y * 2 * hh));
      }
    });
  }
  return (
    points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + 'Z'
  );
}

type Drag = {
  gesture: Gesture;
  start: Point;
  /** Project pixels to the picture's (u, v) as it was when the drag began. */
  inverse: Affine;
  /** What the drag does with the pointer's project-pixel position. */
  move(project: Point, picture: Point, event: ReactPointerEvent): Command | null;
};

/**
 * Handles over the program monitor for the selected clip: its box to move,
 * scale and turn; its crop; its masks (boxes, points and Bézier handles); and
 * the start and end framing of a Ken Burns move. Every drag is one undo step,
 * and animated properties take keyframes at the playhead.
 */
export function MonitorOverlay({
  editor,
  rotations,
  client,
}: {
  editor: EditorState;
  /** Clockwise degrees each video shows upright with. */
  rotations: Map<string, number>;
  client: EngineClient | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [mode, setMode] = useState<OverlayMode>('transform');
  const [activeMask, setActiveMask] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const playhead = usePausedTime(editor.playback);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const project = editor.project.snapshot?.project;
  const clip = editor.focused;
  const playing = !!editor.playback.state?.playing;
  const picking = editor.picking;
  useEffect(() => {
    if (!picking) return;
    const cancel = (event: KeyboardEvent) => event.key === 'Escape' && editor.setPicking(null);
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [picking, editor]);
  // The eyedropper: a click on the frame picks the clip's own colour there.
  if (picking && project) {
    const box = letterbox(size, { width: project.settings.width, height: project.settings.height });
    const pick = async (event: ReactMouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = (event.clientX - rect.left - box.x) / (project.settings.width * box.scale);
      const y = (event.clientY - rect.top - box.y) / (project.settings.height * box.scale);
      editor.setPicking(null);
      if (!client || x < 0 || y < 0 || x > 1 || y > 1) return;
      const color = await client.api.pickColor(playhead, x, y, picking.clip);
      if (color) await editor.project.execute(picking.command(color));
      else editor.project.notice('The clip shows nothing there to pick a colour from.');
    };
    return (
      <div
        ref={host}
        className="cgv-monitor-overlay"
        data-testid="monitor-overlay"
        data-mode="pick"
      >
        <div
          className="cgv-overlay-picker"
          data-testid="overlay-picker"
          title="Click the colour to pick; Escape cancels"
          onClick={(event) => void pick(event)}
        />
      </div>
    );
  }
  const show = !!project && !!clip && clip.video && clip.kind !== 'adjustment' && !playing;
  if (!show || !project || !clip)
    return <div ref={host} className="cgv-monitor-overlay" data-testid="monitor-overlay" />;

  const frame = frameDuration(project.settings.frameRate);
  const { offset } = keyContext(clip, playhead, frame);
  const frameSize = { width: project.settings.width, height: project.settings.height };
  const picture = pictureOf(project, clip, rotations);
  const transform = transformAt(clip, offset);
  const crop = cropAt(clip, offset);
  const box = letterbox(size, frameSize);
  const toPixels = pictureToProject(frameSize, picture, transform);
  const fromPixels = invert(toPixels);
  const screen = (p: Point) => ({ x: box.x + p.x * box.scale, y: box.y + p.y * box.scale });
  const uvToScreen = (uv: Point) => screen(apply(toPixels, uv));
  const toProject = (event: { clientX: number; clientY: number }): Point => {
    const rect = host.current!.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - box.x) / box.scale,
      y: (event.clientY - rect.top - box.y) / box.scale,
    };
  };
  const masks = (clip.masks ?? []).map((mask) => maskAt(clip, mask, offset));
  const active = masks.find((mask) => mask.id === activeMask) ?? masks[0];

  const begin = (event: ReactPointerEvent, label: string, move: Drag['move']) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const gesture = editor.project.gesture(label);
    if (!gesture) return;
    // The handle keeps the pointer; its moves bubble up to the overlay.
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    drag.current = { gesture, start: toProject(event), inverse: fromPixels, move };
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    const at = toProject(event);
    const command = current.move(at, apply(current.inverse, at), event);
    if (command) current.gesture.step(command);
  };
  const onUp = async () => {
    const current = drag.current;
    drag.current = null;
    if (current) await editor.project.finish(current.gesture);
  };

  const setTransform = (values: Partial<Transform>) =>
    setValues(
      clip,
      offset,
      Object.fromEntries(Object.entries(values).map(([k, v]) => [`transform.${k}`, v as number])),
      (statics) => ({
        type: 'setClipProperties',
        clip: clip.id,
        properties: {
          transform: Object.fromEntries(
            Object.entries(statics).map(([k, v]) => [k.slice('transform.'.length), v]),
          ),
        },
      }),
    );

  // ---- Transform ----
  const visible = [
    { x: crop.left, y: crop.top },
    { x: 1 - crop.right, y: crop.top },
    { x: 1 - crop.right, y: 1 - crop.bottom },
    { x: crop.left, y: 1 - crop.bottom },
  ];
  const corners = visible.map(uvToScreen);
  const outline = corners.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + 'Z';
  const pivot = apply(toPixels, { x: transform.anchorX, y: transform.anchorY });
  const topMiddle = uvToScreen({ x: (crop.left + 1 - crop.right) / 2, y: crop.top });
  const centre = screen(pivot);
  const away = Math.hypot(topMiddle.x - centre.x, topMiddle.y - centre.y) || 1;
  const rotateHandle = {
    x: topMiddle.x + ((topMiddle.x - centre.x) / away) * 24,
    y: topMiddle.y + ((topMiddle.y - centre.y) / away) * 24,
  };
  const moveClip = (event: ReactPointerEvent) => {
    const start = transform;
    const from = toProject(event);
    begin(event, 'Move clip', (at) =>
      setTransform({
        x: Number((start.x + at.x - from.x).toFixed(1)),
        y: Number((start.y + at.y - from.y).toFixed(1)),
      }),
    );
  };
  const scaleClip = (event: ReactPointerEvent) => {
    const start = transform;
    const from = toProject(event);
    const reach = Math.hypot(from.x - pivot.x, from.y - pivot.y) || 1;
    begin(event, 'Scale clip', (at) => {
      const factor = Math.hypot(at.x - pivot.x, at.y - pivot.y) / reach;
      return setTransform({
        scaleX: Number(clamp(start.scaleX * factor, 0.01, 100).toFixed(4)),
        scaleY: Number(clamp(start.scaleY * factor, 0.01, 100).toFixed(4)),
      });
    });
  };
  const rotateClip = (event: ReactPointerEvent) => {
    const start = transform;
    const from = toProject(event);
    const angle0 = Math.atan2(from.y - pivot.y, from.x - pivot.x);
    begin(event, 'Rotate clip', (at, _uv, move) => {
      let degrees =
        start.rotation + ((Math.atan2(at.y - pivot.y, at.x - pivot.x) - angle0) * 180) / Math.PI;
      if (move.shiftKey) degrees = Math.round(degrees / 15) * 15;
      return setTransform({ rotation: Number(degrees.toFixed(2)) });
    });
  };

  // ---- Crop ----
  const cropSide = (side: (typeof cropKeys)[number]) => (event: ReactPointerEvent) =>
    begin(event, 'Crop clip', (_at, uv) => {
      const value =
        side === 'left' ? uv.x : side === 'right' ? 1 - uv.x : side === 'top' ? uv.y : 1 - uv.y;
      const other = { left: crop.right, right: crop.left, top: crop.bottom, bottom: crop.top }[
        side
      ];
      const next = clamp(value, 0, Math.min(0.95, 0.99 - other));
      return setValues(clip, offset, { [`crop.${side}`]: Number(next.toFixed(4)) }, () => ({
        type: 'setClipProperties',
        clip: clip.id,
        properties: { crop: { [side]: Number(next.toFixed(4)) } },
      }));
    });
  const cropHandles = [
    { side: 'left' as const, at: { x: crop.left, y: (crop.top + 1 - crop.bottom) / 2 } },
    { side: 'right' as const, at: { x: 1 - crop.right, y: (crop.top + 1 - crop.bottom) / 2 } },
    { side: 'top' as const, at: { x: (crop.left + 1 - crop.right) / 2, y: crop.top } },
    { side: 'bottom' as const, at: { x: (crop.left + 1 - crop.right) / 2, y: 1 - crop.bottom } },
  ];
  const whole = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ]
    .map(uvToScreen)
    .map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`)
    .join(' ');

  // ---- Masks ----
  const maskCommand = (mask: Mask, values: Record<string, number>, points?: MaskPoint[]) => {
    const original = clip.masks?.find((m) => m.id === mask.id) ?? mask;
    // A point moved on an animated path keys the whole shape, as editors key a path.
    const animatedPoints = (original.points ?? []).some((_, i) =>
      ['x', 'y'].some((axis) => isAnimated(clip, maskProperty(mask.id, `point${i}.${axis}`))),
    );
    const keyed: Record<string, number> = {};
    for (const [setting, value] of Object.entries(values))
      keyed[maskProperty(mask.id, setting)] = value;
    if (points && animatedPoints)
      points.forEach((point, i) => {
        keyed[maskProperty(mask.id, `point${i}.x`)] = point.x;
        keyed[maskProperty(mask.id, `point${i}.y`)] = point.y;
      });
    return setValues(clip, offset, keyed, (statics) => {
      const patch: Record<string, number> = {};
      for (const [name, value] of Object.entries(statics)) patch[name.split('.').pop()!] = value;
      const staticPoints =
        points && !animatedPoints
          ? points
          : original.points?.map((point, i) => ({
              ...point,
              ...(statics[maskProperty(mask.id, `point${i}.x`)] !== undefined && {
                x: statics[maskProperty(mask.id, `point${i}.x`)],
              }),
              ...(statics[maskProperty(mask.id, `point${i}.y`)] !== undefined && {
                y: statics[maskProperty(mask.id, `point${i}.y`)],
              }),
            }));
      const { x, y, width, height, rotation, roundness, feather, expansion, opacity } = patch;
      return {
        type: 'setMask',
        clip: clip.id,
        mask: {
          ...original,
          ...(x !== undefined && { x }),
          ...(y !== undefined && { y }),
          ...(width !== undefined && { width }),
          ...(height !== undefined && { height }),
          ...(rotation !== undefined && { rotation }),
          ...(roundness !== undefined && { roundness }),
          ...(feather !== undefined && { feather }),
          ...(expansion !== undefined && { expansion }),
          ...(opacity !== undefined && { opacity }),
          points: staticPoints,
        },
      };
    });
  };
  // The mask's box in picture pixels.
  const maskFrame = (mask: Mask) => {
    const angle = ((mask.rotation ?? 0) * Math.PI) / 180;
    return {
      cx: mask.x * picture.width,
      cy: mask.y * picture.height,
      hw: (mask.width * picture.width) / 2,
      hh: (mask.height * picture.height) / 2,
      sin: Math.sin(angle),
      cos: Math.cos(angle),
    };
  };
  const maskLocal = (mask: Mask, uv: Point) => {
    const f = maskFrame(mask);
    const px = uv.x * picture.width - f.cx;
    const py = uv.y * picture.height - f.cy;
    return { x: f.cos * px + f.sin * py, y: -f.sin * px + f.cos * py };
  };
  const maskScreen = (mask: Mask, lx: number, ly: number) => {
    const f = maskFrame(mask);
    return uvToScreen({
      x: (f.cx + f.cos * lx - f.sin * ly) / picture.width,
      y: (f.cy + f.sin * lx + f.cos * ly) / picture.height,
    });
  };
  const moveMask = (mask: Mask) => (event: ReactPointerEvent) => {
    setActiveMask(mask.id);
    const fromUv = apply(fromPixels, toProject(event));
    begin(event, 'Move mask', (_at, uv) =>
      maskCommand(mask, {
        x: Number((mask.x + uv.x - fromUv.x).toFixed(5)),
        y: Number((mask.y + uv.y - fromUv.y).toFixed(5)),
      }),
    );
  };
  const resizeMask = (mask: Mask) => (event: ReactPointerEvent) =>
    begin(event, 'Resize mask', (_at, uv) => {
      const local = maskLocal(mask, uv);
      return maskCommand(mask, {
        width: Number(clamp((2 * Math.abs(local.x)) / picture.width, 0.005, 4).toFixed(5)),
        height: Number(clamp((2 * Math.abs(local.y)) / picture.height, 0.005, 4).toFixed(5)),
      });
    });
  const rotateMask = (mask: Mask) => (event: ReactPointerEvent) =>
    begin(event, 'Rotate mask', (_at, uv, move) => {
      const px = uv.x * picture.width - mask.x * picture.width;
      const py = uv.y * picture.height - mask.y * picture.height;
      let degrees = (Math.atan2(py, px) * 180) / Math.PI + 90;
      if (move.shiftKey) degrees = Math.round(degrees / 15) * 15;
      return maskCommand(mask, { rotation: Number(degrees.toFixed(2)) });
    });
  const movePoint =
    (mask: Mask, index: number, part: 'point' | 'in' | 'out') => (event: ReactPointerEvent) => {
      if (event.altKey && part === 'point') {
        event.stopPropagation();
        if ((mask.points?.length ?? 0) > 3)
          void editor.project.execute({
            type: 'setMask',
            clip: clip.id,
            mask: {
              ...(clip.masks?.find((m) => m.id === mask.id) ?? mask),
              points: mask.points?.filter((_, i) => i !== index),
            },
          });
        return;
      }
      begin(event, part === 'point' ? 'Move mask point' : 'Shape mask curve', (_at, uv) => {
        const local = maskLocal(mask, uv);
        const bx = clamp(local.x / (2 * maskFrame(mask).hw || 1), -2, 2);
        const by = clamp(local.y / (2 * maskFrame(mask).hh || 1), -2, 2);
        const points = (mask.points ?? []).map((point) => ({ ...point }));
        const point = points[index];
        if (part === 'point') {
          point.x = Number(bx.toFixed(5));
          point.y = Number(by.toFixed(5));
        } else {
          // Smooth points keep their handles opposite.
          const dx = Number((bx - point.x).toFixed(5));
          const dy = Number((by - point.y).toFixed(5));
          if (part === 'out') [point.outX, point.outY, point.inX, point.inY] = [dx, dy, -dx, -dy];
          else [point.inX, point.inY, point.outX, point.outY] = [dx, dy, -dx, -dy];
        }
        return maskCommand(mask, {}, points);
      });
    };
  const addPoint = (mask: Mask) => (event: ReactMouseEvent) => {
    if (mask.shape !== 'path' || (mask.points?.length ?? 0) >= 32) return;
    const uv = apply(fromPixels, toProject(event));
    const local = maskLocal(mask, uv);
    const f = maskFrame(mask);
    const point = { x: local.x / (2 * f.hw || 1), y: local.y / (2 * f.hh || 1) };
    const list = mask.points ?? [];
    // After the corner nearest along the outline.
    let best = 0;
    let bestDistance = Infinity;
    list.forEach((a, i) => {
      const b = list[(i + 1) % list.length];
      const d =
        Math.hypot(point.x - a.x, point.y - a.y) +
        Math.hypot(point.x - b.x, point.y - b.y) -
        Math.hypot(a.x - b.x, a.y - b.y);
      if (d < bestDistance) [best, bestDistance] = [i, d];
    });
    const points = [...list.slice(0, best + 1), point, ...list.slice(best + 1)];
    void editor.project.execute({
      type: 'setMask',
      clip: clip.id,
      mask: { ...(clip.masks?.find((m) => m.id === mask.id) ?? mask), points },
    });
  };

  // ---- Ken Burns ----
  const end = Math.max(0, clip.duration - frame);
  const kenBurnsKeys = ['transform.x', 'transform.y', 'transform.scaleX', 'transform.scaleY'];
  const keyed = kenBurnsKeys.every((key) => (clip.keyframes?.[key]?.length ?? 0) >= 2);
  const startRect = keyed
    ? framingRect(frameSize, picture, transformAt(clip, 0))
    : centredRect(frameSize, picture, 1);
  const endRect = keyed
    ? framingRect(frameSize, picture, transformAt(clip, end))
    : centredRect(frameSize, picture, 0.8);
  const kenBurns = (first: Rect, last: Rect): Command => {
    const a = framingTransform(frameSize, picture, first);
    const b = framingTransform(frameSize, picture, last);
    const keys = (key: keyof typeof a) => [
      { time: 0, value: Number(a[key].toFixed(5)), interpolation: { kind: 'easeInOut' as const } },
      {
        time: end,
        value: Number(b[key].toFixed(5)),
        interpolation: { kind: 'easeInOut' as const },
      },
    ];
    return {
      type: 'batch',
      commands: (['x', 'y', 'scaleX', 'scaleY'] as const).map((key) => ({
        type: 'setKeyframes' as const,
        clip: clip.id,
        property: `transform.${key}`,
        keys: keys(key),
      })),
    };
  };
  // A rect keeps the frame's shape: its height follows its width.
  const shape = (frameSize.height / frameSize.width) * (picture.width / picture.height);
  const moveRect = (which: 'start' | 'end') => (event: ReactPointerEvent) => {
    const fromUv = apply(fromPixels, toProject(event));
    const rect = which === 'start' ? startRect : endRect;
    begin(event, 'Ken Burns', (_at, uv) => {
      const moved = { ...rect, x: rect.x + uv.x - fromUv.x, y: rect.y + uv.y - fromUv.y };
      return which === 'start' ? kenBurns(moved, endRect) : kenBurns(startRect, moved);
    });
  };
  const sizeRect = (which: 'start' | 'end') => (event: ReactPointerEvent) => {
    const rect = which === 'start' ? startRect : endRect;
    begin(event, 'Ken Burns', (_at, uv) => {
      const w = clamp(uv.x - rect.x, 0.02, 4);
      const resized = { ...rect, w, h: w * shape };
      return which === 'start' ? kenBurns(resized, endRect) : kenBurns(startRect, resized);
    });
  };
  // The rects sit on the picture as it shows at the playhead: at the clip's
  // start the start rect fills the frame, at its end the end rect.
  const fitted = toPixels;
  const rectPath = (rect: Rect) =>
    [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ]
      .map((p) => screen(apply(fitted, p)))
      .map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`)
      .join(' ') + 'Z';

  return (
    <div
      ref={host}
      className="cgv-monitor-overlay"
      data-testid="monitor-overlay"
      data-mode={mode}
      onPointerMove={onMove}
      onPointerUp={() => void onUp()}
      onPointerCancel={() => void onUp()}
    >
      <div className="cgv-overlay-modes" role="group" aria-label="Monitor handles">
        {modes.map((item) => (
          <button
            key={item.mode}
            type="button"
            aria-pressed={mode === item.mode}
            data-testid={`overlay-mode-${item.mode}`}
            onClick={() => setMode(item.mode)}
          >
            {item.label}
          </button>
        ))}
        {mode === 'kenBurns' && keyed && (
          <button
            type="button"
            onClick={() =>
              void editor.project.execute({
                type: 'batch',
                commands: kenBurnsKeys.map((property) => ({
                  type: 'clearKeyframes' as const,
                  clip: clip.id,
                  property,
                  at: offset,
                })),
              })
            }
          >
            Remove move
          </button>
        )}
      </div>
      <svg className="cgv-overlay-svg" width={size.width} height={size.height}>
        {mode === 'transform' && (
          <g className="cgv-overlay-transform">
            <path
              className="cgv-overlay-box"
              d={outline}
              onPointerDown={moveClip}
              data-testid="overlay-box"
            />
            <line x1={topMiddle.x} y1={topMiddle.y} x2={rotateHandle.x} y2={rotateHandle.y} />
            <circle
              className="cgv-overlay-handle"
              cx={rotateHandle.x}
              cy={rotateHandle.y}
              r={6}
              data-testid="overlay-rotate"
              onPointerDown={rotateClip}
            />
            {corners.map((p, i) => (
              <rect
                key={i}
                className="cgv-overlay-handle"
                x={p.x - 5}
                y={p.y - 5}
                width={10}
                height={10}
                data-testid="overlay-scale"
                onPointerDown={scaleClip}
              />
            ))}
            <circle className="cgv-overlay-pivot" cx={centre.x} cy={centre.y} r={3} />
          </g>
        )}
        {mode === 'crop' && (
          <g className="cgv-overlay-crop">
            <path className="cgv-overlay-ghost" d={whole + 'Z'} />
            <path className="cgv-overlay-box" d={outline} />
            {cropHandles.map(({ side, at }) => {
              const p = uvToScreen(at);
              return (
                <rect
                  key={side}
                  className="cgv-overlay-handle"
                  x={p.x - 6}
                  y={p.y - 6}
                  width={12}
                  height={12}
                  data-testid={`overlay-crop-${side}`}
                  onPointerDown={cropSide(side)}
                />
              );
            })}
          </g>
        )}
        {mode === 'mask' &&
          masks.map((mask, index) => {
            const selected = mask.id === active?.id;
            const f = maskFrame(mask);
            const handle = (lx: number, ly: number) => maskScreen(mask, lx, ly);
            return (
              <g
                key={mask.id}
                className={selected ? 'cgv-overlay-mask is-active' : 'cgv-overlay-mask'}
              >
                <path
                  className="cgv-overlay-box"
                  d={maskPath(mask, picture, uvToScreen)}
                  onPointerDown={moveMask(mask)}
                  onDoubleClick={addPoint(mask)}
                  data-testid="overlay-mask"
                >
                  <title>{maskName(mask, index)}</title>
                </path>
                {selected && mask.shape !== 'path' && (
                  <>
                    <rect
                      className="cgv-overlay-handle"
                      x={handle(f.hw, f.hh).x - 5}
                      y={handle(f.hw, f.hh).y - 5}
                      width={10}
                      height={10}
                      data-testid="overlay-mask-size"
                      onPointerDown={resizeMask(mask)}
                    />
                    <circle
                      className="cgv-overlay-handle"
                      cx={handle(0, -f.hh - 24 / box.scale).x}
                      cy={handle(0, -f.hh - 24 / box.scale).y}
                      r={6}
                      onPointerDown={rotateMask(mask)}
                    />
                  </>
                )}
                {selected &&
                  mask.shape === 'path' &&
                  (mask.points ?? []).map((point, i) => {
                    const at = handle(point.x * 2 * f.hw, point.y * 2 * f.hh);
                    const curve = point.inX || point.inY || point.outX || point.outY;
                    const end = (dx: number, dy: number) =>
                      handle((point.x + dx) * 2 * f.hw, (point.y + dy) * 2 * f.hh);
                    const inEnd = end(point.inX ?? 0, point.inY ?? 0);
                    const outEnd = end(point.outX ?? 0, point.outY ?? 0);
                    return (
                      <g key={i}>
                        {curve && (
                          <>
                            <line x1={inEnd.x} y1={inEnd.y} x2={outEnd.x} y2={outEnd.y} />
                            <circle
                              className="cgv-overlay-curve"
                              cx={inEnd.x}
                              cy={inEnd.y}
                              r={4}
                              onPointerDown={movePoint(mask, i, 'in')}
                            />
                            <circle
                              className="cgv-overlay-curve"
                              cx={outEnd.x}
                              cy={outEnd.y}
                              r={4}
                              onPointerDown={movePoint(mask, i, 'out')}
                            />
                          </>
                        )}
                        <rect
                          className="cgv-overlay-handle"
                          x={at.x - 5}
                          y={at.y - 5}
                          width={10}
                          height={10}
                          data-testid="overlay-mask-point"
                          onPointerDown={movePoint(mask, i, 'point')}
                        >
                          <title>
                            Drag to move; Alt-click to remove; double-click the outline to add a
                            point
                          </title>
                        </rect>
                      </g>
                    );
                  })}
              </g>
            );
          })}
        {mode === 'kenBurns' && (
          <g className="cgv-overlay-kenburns">
            {(['start', 'end'] as const).map((which) => {
              const rect = which === 'start' ? startRect : endRect;
              const corner = screen(apply(fitted, { x: rect.x + rect.w, y: rect.y + rect.h }));
              const label = screen(apply(fitted, { x: rect.x, y: rect.y }));
              return (
                <g key={which} className={`cgv-kenburns-${which}`}>
                  <path
                    className="cgv-overlay-box"
                    d={rectPath(rect)}
                    data-testid={`overlay-kenburns-${which}`}
                    onPointerDown={moveRect(which)}
                  />
                  <text x={label.x + 4} y={label.y + 14}>
                    {which === 'start' ? 'Start' : 'End'}
                  </text>
                  <rect
                    className="cgv-overlay-handle"
                    x={corner.x - 5}
                    y={corner.y - 5}
                    width={10}
                    height={10}
                    onPointerDown={sizeRect(which)}
                  />
                </g>
              );
            })}
          </g>
        )}
      </svg>
    </div>
  );
}

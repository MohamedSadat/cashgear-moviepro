// Renders the effects browser's previews in a worker of its own: an engine on an
// off-screen canvas draws each effect and transition on two sample pictures, so
// the previews show what the shaders really do without touching the monitor.
import { expose } from 'comlink';
import initWasm, { Engine, ProjectSession } from '../pkg/cgv_wasm';
import type { FramePlan, LayerPlan, LutPlan, PlanStep } from '../playback/types';
import { loadPackImages, lookText } from './assets';
import type { PreviewRequest, PreviewWorkerApi } from './previews';

/** A sunset: warm sky, a sun, hills and a lake with a reflection. */
function drawWarm(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) {
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, '#1f3b73');
  sky.addColorStop(0.55, '#e0735a');
  sky.addColorStop(1, '#f7c46c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff1c2';
  ctx.beginPath();
  ctx.arc(w * 0.68, h * 0.5, h * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3c5a2e';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.62);
  for (let x = 0; x <= w; x += w / 16)
    ctx.lineTo(x, h * (0.56 + 0.05 * Math.sin((x / w) * 9) + 0.02 * Math.sin((x / w) * 31)));
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.fill();
  const lake = ctx.createLinearGradient(0, h * 0.74, 0, h);
  lake.addColorStop(0, '#2f6f9a');
  lake.addColorStop(1, '#173a57');
  ctx.fillStyle = lake;
  ctx.fillRect(0, h * 0.74, w, h * 0.26);
  ctx.fillStyle = 'rgba(255, 233, 170, 0.6)';
  ctx.fillRect(w * 0.6, h * 0.76, w * 0.16, h * 0.02);
  ctx.fillRect(w * 0.63, h * 0.81, w * 0.1, h * 0.015);
}

/** A night city: a cool sky, a moon and lit buildings. */
function drawCool(ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#0b1026');
  sky.addColorStop(0.7, '#3a2a6b');
  sky.addColorStop(1, '#7a3f7d');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#e8ecff';
  ctx.beginPath();
  ctx.arc(w * 0.22, h * 0.24, h * 0.08, 0, Math.PI * 2);
  ctx.fill();
  let x = 0;
  let i = 0;
  while (x < w) {
    const width = w * (0.06 + 0.04 * ((i * 37) % 5) * 0.25);
    const height = h * (0.3 + 0.35 * (((i * 53) % 7) / 7));
    ctx.fillStyle = i % 2 ? '#141a33' : '#1c2447';
    ctx.fillRect(x, h - height, width, height);
    ctx.fillStyle = '#ffd36b';
    for (let wy = h - height + 6; wy < h - 6; wy += 9)
      for (let wx = x + 4; wx < x + width - 4; wx += 7)
        if ((wx * 13 + wy * 7 + i) % 5 < 2) ctx.fillRect(wx, wy, 3, 4);
    x += width + 2;
    i++;
  }
}

async function sample(draw: typeof drawWarm, w: number, h: number): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  draw(ctx, w, h);
  return createImageBitmap(canvas);
}

function layer(clip: number, media: string): LayerPlan {
  return {
    clip,
    track: 1,
    media,
    still: true,
    sourceTime: 0,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5 },
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    opacity: 1,
    clipStart: 0,
    clipEnd: 1,
    sourceIn: 0,
    speed: { num: 1, den: 1 },
    // The middle of a two-second clip: animated effects show a typical frame.
    clipSeconds: 1,
    seed: 0.37 * clip,
    effects: [],
  };
}

const api: PreviewWorkerApi = {
  async render(requests: PreviewRequest[], size: { width: number; height: number }) {
    await initWasm({ module_or_path: new URL('../pkg/cgv_wasm_bg.wasm', import.meta.url) });
    const engine = await Engine.create(new OffscreenCanvas(16, 16), 'auto', () => {});
    const session = new ProjectSession('previews', 'Previews');
    try {
      await loadPackImages(engine);
      const { width, height } = size;
      for (const [key, draw] of [
        ['sample-a', drawWarm],
        ['sample-b', drawCool],
      ] as const) {
        const bitmap = await sample(draw, width, height);
        try {
          engine.upload_still(key, bitmap);
        } finally {
          bitmap.close();
        }
      }
      // The LUT effect previews a built-in look.
      const outcome = JSON.parse(session.import_lut('Teal & Orange', await lookText('teal-orange')));
      const lutId = outcome.created[0] as number;
      const values = session.lut_values(lutId);
      if (values) engine.upload_lut('preview-look', '3d', 17, values);
      const look: LutPlan = {
        id: lutId,
        key: 'preview-look',
        shape: '3d',
        size: 17,
        domainMin: [0, 0, 0],
        domainMax: [1, 1, 1],
      };
      const images: (Blob | null)[] = [];
      for (const request of requests) {
        try {
          const params = { ...request.params };
          let layers: LayerPlan[];
          let steps: PlanStep[];
          if (request.type === 'transition') {
            layers = [layer(1, 'sample-a'), layer(2, 'sample-b')];
            steps = [
              {
                kind: 'transition',
                from: 0,
                to: 1,
                transition: { pack: request.pack, kind: request.kind, params },
                progress: request.progress ?? 0.5,
              },
            ];
          } else {
            if (request.lut) params[request.lut] = `lut-${lutId}`;
            const one = layer(1, 'sample-a');
            one.effects = [{ pack: request.pack, kind: request.kind, params }];
            layers = [one];
            steps = [{ kind: 'layer', layer: 0 }];
          }
          const plan: FramePlan = {
            frame: 0,
            time: 0,
            width,
            height,
            layers,
            steps,
            luts: [look],
          };
          engine.begin(JSON.stringify(plan));
          layers.forEach((entry, index) =>
            engine.set_layer_still(index, entry.media, width, height),
          );
          engine.compose(1, false);
          const pixels = (await engine.read_pixels()) as {
            width: number;
            height: number;
            data: Uint8Array;
          };
          const canvas = new OffscreenCanvas(pixels.width, pixels.height);
          const ctx = canvas.getContext('2d')!;
          ctx.putImageData(
            new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height),
            0,
            0,
          );
          images.push(await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 }));
        } catch (error) {
          console.warn(`No preview for ${request.kind}:`, error);
          images.push(null);
        }
      }
      return images;
    } finally {
      session.free();
      engine.dispose();
      engine.free();
    }
  },
};
expose(api);

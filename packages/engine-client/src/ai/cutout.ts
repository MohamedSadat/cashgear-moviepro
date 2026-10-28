import { install, modelInfo, readModelFile, type ModelId } from './models';
import { createSession, ort } from './runtime';

// Background removal with MediaPipe Selfie Segmentation (Apache-2.0): a frame
// in, a soft matte of the people in it out. Landscape frames go through its
// 256×144 model, others through the 256×256 one. Both are small enough to run
// faster than real time on the CPU, which leaves the GPU to playback and sidesteps
// drivers that compute models wrongly.

/** The model and size for an upright picture of `width` by `height`. */
export function cutoutSize(width: number, height: number) {
  return width > height
    ? { model: 'selfie-landscape' as ModelId, width: 256, height: 144 }
    : { model: 'selfie' as ModelId, width: 256, height: 256 };
}

/**
 * A 3×3 box blur: twice over, close to a Gaussian of one texel. The matte is a
 * few times smaller than the picture it cuts, and this keeps its edges from
 * showing as steps once stretched.
 */
function soften(values: Float32Array, width: number, height: number): Float32Array {
  const across = new Float32Array(values.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const row = y * width;
      const left = values[row + Math.max(0, x - 1)];
      const right = values[row + Math.min(width - 1, x + 1)];
      across[row + x] = (left + values[row + x] + right) / 3;
    }
  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const up = across[Math.max(0, y - 1) * width + x];
      const down = across[Math.min(height - 1, y + 1) * width + x];
      out[y * width + x] = (up + across[y * width + x] + down) / 3;
    }
  return out;
}

export class Cutout {
  private constructor(private readonly session: ort.InferenceSession) {}

  /** Downloads the model (half a megabyte) when needed and loads it. */
  static async load(model: ModelId, check: () => void): Promise<Cutout> {
    const info = modelInfo(model);
    await install(info, () => {}, check);
    const role = info.files[0].role;
    return new Cutout(await createSession(await readModelFile(info, role), 'wasm'));
  }

  async release() {
    await this.session.release();
  }

  /**
   * The matte of an RGBA picture already at the model's size: one byte of
   * coverage a pixel, row after row.
   */
  async matte(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
    const plane = width * height;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      input[i] = rgba[i * 4] / 255;
      input[plane + i] = rgba[i * 4 + 1] / 255;
      input[2 * plane + i] = rgba[i * 4 + 2] / 255;
    }
    const outputs = await this.session.run({
      [this.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, height, width]),
    });
    try {
      const alpha = (await outputs[this.session.outputNames[0]].getData()) as Float32Array;
      const soft = soften(soften(alpha, width, height), width, height);
      const matte = new Uint8Array(plane);
      for (let i = 0; i < plane; i++)
        matte[i] = Math.round(Math.min(1, Math.max(0, soft[i])) * 255);
      return matte;
    } finally {
      for (const tensor of Object.values(outputs)) tensor.dispose();
    }
  }
}

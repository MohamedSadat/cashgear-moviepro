// Waveform peaks: per bucket of samples, the lowest and highest sample across
// all channels, quantized to int8. 100 buckets per second is enough for the
// media library and for drawing clips on the timeline at normal zoom.

export const peaksPerSecond = 100;

export class PeakAccumulator {
  private readonly bucketSize: number;
  private min = Infinity;
  private max = -Infinity;
  private filled = 0;
  private peaks: number[] = [];

  constructor(sampleRate: number) {
    this.bucketSize = Math.max(1, Math.round(sampleRate / peaksPerSecond));
  }

  /** Adds `frames` samples from each planar channel. */
  add(channels: ArrayLike<number>[], frames: number) {
    for (let i = 0; i < frames; i++) {
      for (const channel of channels) {
        const sample = channel[i];
        if (sample < this.min) this.min = sample;
        if (sample > this.max) this.max = sample;
      }
      if (++this.filled === this.bucketSize) this.emit();
    }
  }

  /** The peaks as [min, max] int8 pairs, including a final partial bucket. */
  finish(): Int8Array {
    if (this.filled > 0) this.emit();
    return Int8Array.from(this.peaks);
  }

  private emit() {
    const quantize = (value: number) => Math.max(-127, Math.min(127, Math.round(value * 127)));
    this.peaks.push(quantize(this.min), quantize(this.max));
    this.min = Infinity;
    this.max = -Infinity;
    this.filled = 0;
  }
}

/**
 * Decodes interleaved PCM bytes into planar float channels. `codec` is a
 * Mediabunny PCM codec name such as `pcm-s16` or `pcm-f32be`.
 */
export function decodePcm(codec: string, bytes: Uint8Array, channels: number): Float32Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const littleEndian = !codec.endsWith('be');
  const kind = codec.replace(/^pcm-/, '').replace(/be$/, '');
  const width = { u8: 1, s8: 1, s16: 2, s24: 3, s32: 4, f32: 4, f64: 8, ulaw: 1, alaw: 1 }[
    codec === 'ulaw' || codec === 'alaw' ? codec : kind
  ];
  if (!width) throw new Error(`Unsupported PCM format ${codec}`);
  const frames = Math.floor(bytes.byteLength / (width * channels));
  const output = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const offset = (frame * channels + channel) * width;
      let value: number;
      switch (codec === 'ulaw' || codec === 'alaw' ? codec : kind) {
        case 'u8':
          value = (view.getUint8(offset) - 128) / 128;
          break;
        case 's8':
          value = view.getInt8(offset) / 128;
          break;
        case 's16':
          value = view.getInt16(offset, littleEndian) / 32768;
          break;
        case 's24': {
          const b0 = view.getUint8(offset);
          const b1 = view.getUint8(offset + 1);
          const b2 = view.getUint8(offset + 2);
          const raw = littleEndian ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
          value = ((raw << 8) >> 8) / 8388608;
          break;
        }
        case 's32':
          value = view.getInt32(offset, littleEndian) / 2147483648;
          break;
        case 'f32':
          value = view.getFloat32(offset, littleEndian);
          break;
        case 'f64':
          value = view.getFloat64(offset, littleEndian);
          break;
        case 'ulaw':
          value = ulaw(view.getUint8(offset));
          break;
        default:
          value = alaw(view.getUint8(offset));
      }
      output[channel][frame] = value;
    }
  }
  return output;
}

function ulaw(byte: number) {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 7;
  const magnitude = (((u & 0x0f) << 3) + 0x84) << exponent;
  return ((u & 0x80 ? 0x84 - magnitude : magnitude - 0x84) / 32768) as number;
}

function alaw(byte: number) {
  const a = byte ^ 0x55;
  const exponent = (a >> 4) & 7;
  let magnitude = (a & 0x0f) << 4;
  magnitude = exponent === 0 ? magnitude + 8 : (magnitude + 0x108) << (exponent - 1);
  return (a & 0x80 ? magnitude : -magnitude) / 32768;
}

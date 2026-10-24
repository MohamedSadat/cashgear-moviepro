/** A CPU frame's pixels, ready for `Engine.set_layer_planes`. */
export interface FramePlanes {
  format: 'I420' | 'NV12' | 'RGBA';
  /** Visible size of the planes. */
  codedWidth: number;
  codedHeight: number;
  data: Uint8Array;
  /** Offset and stride of each plane, flattened. */
  layout: Uint32Array;
  colorSpace: VideoColorSpaceInit;
  /** Display size (pixel aspect applied), before rotation. */
  displayWidth: number;
  displayHeight: number;
}

const native = new Set(['I420', 'NV12', 'RGBA', 'RGBX']);

/**
 * Copies a frame's visible pixels in its own format, with no colour conversion,
 * so the compositor converts Y'CbCr with the frame's own matrix. Formats the
 * compositor does not read (10-bit, alpha planes, BGRA) are converted to RGBA by
 * the browser.
 */
export async function copyPlanes(frame: VideoFrame): Promise<FramePlanes> {
  const rect = frame.visibleRect!;
  const keep = frame.format !== null && native.has(frame.format);
  const options: VideoFrameCopyToOptions = keep ? {} : { format: 'RGBA', colorSpace: 'srgb' };
  const data = new Uint8Array(frame.allocationSize(options));
  const layout = await frame.copyTo(data, options);
  const format = keep ? frame.format! : 'RGBA';
  return {
    format: format === 'RGBX' ? 'RGBA' : (format as FramePlanes['format']),
    codedWidth: rect.width,
    codedHeight: rect.height,
    data,
    layout: Uint32Array.from(layout.flatMap((plane) => [plane.offset, plane.stride])),
    colorSpace: keep
      ? frame.colorSpace.toJSON()
      : { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true },
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
  };
}

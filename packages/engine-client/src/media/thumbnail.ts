/** Draws a frame, rotated for display, into a JPEG of the given height. */
export async function encodeThumbnail(
  frame: VideoFrame,
  rotation: number,
  height: number,
): Promise<Uint8Array> {
  const turned = rotation % 180 !== 0;
  const sourceWidth = frame.displayWidth;
  const sourceHeight = frame.displayHeight;
  const width = Math.max(
    1,
    Math.round(
      (height * (turned ? sourceHeight : sourceWidth)) / (turned ? sourceWidth : sourceHeight),
    ),
  );
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas is unavailable');
  context.translate(width / 2, height / 2);
  context.rotate((rotation * Math.PI) / 180);
  const drawWidth = turned ? height : width;
  const drawHeight = turned ? width : height;
  context.drawImage(frame, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Evenly spaced sample times (seconds) for a filmstrip: one per 2 s, 1 to 20 of them. */
export function filmstripTimes(durationSeconds: number, firstTimestamp = 0): number[] {
  const count = Math.max(1, Math.min(20, Math.ceil(durationSeconds / 2)));
  const step = durationSeconds / count;
  return Array.from({ length: count }, (_, i) => firstTimestamp + step * (i + 0.5));
}

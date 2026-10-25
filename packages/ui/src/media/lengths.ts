import { FLICKS_PER_SECOND, type MediaRef } from '@cgv/engine-client';

const stillDuration = 5 * FLICKS_PER_SECOND;

/**
 * A new clip of an image: a still lasts 5 s; an animated one lasts one loop, in
 * whole frames, and at least a second.
 */
export function imageDuration(media: MediaRef, frame: number): number {
  if (media.duration <= 0) return stillDuration;
  const loop = Math.max(frame, Math.round(media.duration / frame) * frame);
  return Math.max(loop, Math.ceil(FLICKS_PER_SECOND / frame) * frame);
}

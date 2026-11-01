import type { MediaSourceRef } from '../media/types';
import type { Originals } from './frames';
import type { ExportEvents, ExportJob, OriginalInfo } from './types';

/**
 * Desktop: an export reads media that plays through a proxy from its original,
 * which FFmpeg decodes at its own size and bit depth. Sessions open on the first
 * frame each original gives, and close with `close`.
 */
export function nativeOriginals(
  job: ExportJob,
  events: ExportEvents,
): (Originals & { close(): Promise<void> }) | null {
  const { originalOpen, originalFrame, originalClose } = events;
  if (job.platform !== 'desktop' || !originalOpen || !originalFrame) return null;
  // The registry id is the last part of a registered file's cgv-media address.
  const registered = new Map<string, { id: string; source: MediaSourceRef }>();
  for (const { id, source, proxy } of job.media)
    if (proxy && source.kind === 'url' && source.path)
      registered.set(id, { id: source.url.slice(source.url.lastIndexOf('/') + 1), source });
  if (!registered.size) return null;
  const sessions = new Map<string, Promise<OriginalInfo>>();
  return {
    has: (media) => registered.has(media),
    async frame(media, frame, seconds, duration) {
      let session = sessions.get(media);
      if (!session) {
        session = originalOpen(registered.get(media)!.id);
        sessions.set(media, session);
      }
      const info = await session;
      const data = await originalFrame(info.id, frame, seconds, duration);
      const source = registered.get(media)!.source;
      const color = source.kind === 'url' ? source.probe?.video?.color : undefined;
      return {
        format: info.format as never,
        codedWidth: info.width,
        codedHeight: info.height,
        data,
        layout: Uint32Array.from(info.planes.flat()),
        colorSpace: {
          primaries: (color?.primaries ?? 'bt709') as VideoColorPrimaries,
          transfer: (color?.transfer ?? 'bt709') as VideoTransferCharacteristics,
          matrix: (color?.matrix ?? 'bt709') as VideoMatrixCoefficients,
          fullRange: color?.fullRange ?? false,
        },
        displayWidth: info.width,
        displayHeight: info.height,
      };
    },
    async close() {
      const opened = await Promise.allSettled(sessions.values());
      for (const result of opened)
        if (result.status === 'fulfilled') await originalClose?.(result.value.id).catch(() => {});
      sessions.clear();
    },
  };
}

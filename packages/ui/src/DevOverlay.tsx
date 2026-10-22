import { useEffect, useState } from 'react';
import type { EngineClient, MediaStats } from '@cgv/engine-client';

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** Engine resource counters for development: open VideoFrames, frame cache, decoders. */
export function DevOverlay({ client }: { client: EngineClient | null }) {
  const [stats, setStats] = useState<MediaStats | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const poll = () =>
      client.api
        .mediaStats()
        .then((next) => live && setStats(next))
        .catch(() => {});
    void poll();
    const timer = setInterval(poll, 500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client]);
  return (
    <div
      className="cgv-dev-overlay"
      data-testid="dev-overlay"
      data-open-frames={stats?.openFrames ?? ''}
    >
      {stats ? (
        <>
          <span>Open frames {stats.openFrames}</span>
          <span>
            Cache {megabytes(stats.cacheBytes)} / {megabytes(stats.cacheBudgetBytes)} MB (
            {stats.cachedFrames} frames)
          </span>
          <span>Decoders {stats.decoders}</span>
        </>
      ) : (
        <span>Engine stats unavailable</span>
      )}
    </div>
  );
}

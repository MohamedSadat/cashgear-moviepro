import { useEffect, useRef, useState } from 'react';
import type { EngineClient, MediaStats, PlaybackStatsReport } from '@cgv/engine-client';

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const ms = (value: number | null | undefined) => (value ?? 0).toFixed(1);
const levels = ['Full', '1/2', '1/4'];

/**
 * Engine counters for development: open VideoFrames, the frame cache and
 * decoders, and playback frame times, drops, GPU time, sound buffer and A/V
 * offset (frame on screen minus sound heard).
 */
export function DevOverlay({ client }: { client: EngineClient | null }) {
  const [stats, setStats] = useState<MediaStats | null>(null);
  const [playback, setPlayback] = useState<PlaybackStatsReport | null>(null);
  const [fps, setFps] = useState(0);
  const last = useRef<{ presented: number; at: number } | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    const poll = async () => {
      try {
        const [media, frames] = await Promise.all([
          client.api.mediaStats(),
          client.api.playbackStats(),
        ]);
        if (!live) return;
        setStats(media);
        setPlayback(frames);
        const now = performance.now();
        const before = last.current;
        if (before && frames.presented >= before.presented)
          setFps(((frames.presented - before.presented) * 1000) / (now - before.at));
        last.current = { presented: frames.presented, at: now };
      } catch {
        // The engine is restarting.
      }
    };
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
      {playback && (
        <>
          <span data-testid="dev-frame-times">
            {fps.toFixed(1)} fps · render {ms(playback.renderMs.mean)} (max{' '}
            {ms(playback.renderMs.max)}) ms · GPU latency {ms(playback.gpuMs.mean)} ms
          </span>
          <span>
            Shown {playback.presented} · dropped {playback.dropped} · late {playback.late} · streams{' '}
            {playback.streams}
          </span>
          <span>
            A/V {ms(playback.offset.lastMs)} ms (max {ms(playback.offset.maxAbsMs)}) · clock{' '}
            {playback.clock ?? 'stopped'}
          </span>
          {playback.audio && (
            <span>
              Sound {ms(playback.audio.bufferedMs)} ms buffered · {playback.audio.underruns}{' '}
              underruns · latency {ms(playback.audio.outputLatencyMs)} ms
            </span>
          )}
          <span>
            Quality {playback.quality} ({levels[playback.level]}) · {playback.compositionFormat} ·
            vsync {ms(playback.vsyncMs)} ms
          </span>
        </>
      )}
    </div>
  );
}

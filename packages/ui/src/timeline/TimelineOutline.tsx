import { FLICKS_PER_SECOND, type Clip, type Track } from '@cgv/engine-client';
import { formatTime } from '../project/format';
import type { ProjectState } from '../project/useProject';

/** The shortest span the outline shows, so a few clips do not fill it edge to edge. */
const minimumSpan = 30 * FLICKS_PER_SECOND;

function trackLabel(track: Track, index: number) {
  return track.name || `Track ${index + 1}`;
}

function Toggle({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  onClick(): void;
  children: string;
}) {
  return (
    <button
      type="button"
      className="cgv-track-toggle"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * A read-only outline of the timeline: each track with its clips at scale. The
 * editing timeline (canvas, drag and trim) replaces it in Phase 4.
 */
export function TimelineOutline({ project }: { project: ProjectState }) {
  const snapshot = project.snapshot;
  if (!snapshot) return null;
  const { tracks, media, markers } = snapshot.project;
  const end = Math.max(
    0,
    ...tracks.flatMap((track) => track.clips.map((c) => c.start + c.duration)),
  );
  const span = Math.max(end, minimumSpan);
  const names = new Map(media.map((m) => [m.id, m.name]));
  const missing = new Set(project.missing.map((m) => m.id));
  const percent = (time: number) => `${(time / span) * 100}%`;
  const clipClass = (clip: Clip) =>
    [
      'cgv-clip',
      clip.video ? 'cgv-clip-video' : 'cgv-clip-audio',
      missing.has(clip.media) && 'cgv-clip-offline',
      clip.link !== null && 'cgv-clip-linked',
    ]
      .filter(Boolean)
      .join(' ');
  return (
    <section className="cgv-timeline" data-testid="timeline" aria-label="Timeline">
      <header className="cgv-timeline-header">
        <h2>Timeline</h2>
        <span className="cgv-muted" data-testid="timeline-duration">
          {formatTime(end)}
        </span>
        <button
          type="button"
          onClick={() => void project.execute({ type: 'addTrack', index: tracks.length })}
        >
          Add track
        </button>
      </header>
      <div className="cgv-markers" aria-label="Markers">
        {markers.map((marker) => (
          <span
            key={marker.id}
            className={`cgv-marker cgv-marker-${marker.color}`}
            style={{ left: percent(marker.time) }}
            title={`${marker.name || 'Marker'} ${formatTime(marker.time)}`}
            data-testid="marker"
          />
        ))}
      </div>
      <ol className="cgv-tracks">
        {tracks
          .map((track, index) => ({ track, index }))
          .reverse()
          .map(({ track, index }) => (
            <li
              key={track.id}
              className={'cgv-track' + (track.hidden ? ' cgv-track-hidden' : '')}
              data-testid="track"
              data-track-id={track.id}
              data-locked={track.locked}
            >
              <div className="cgv-track-header">
                <span className="cgv-track-name">{trackLabel(track, index)}</span>
                <Toggle
                  label={`${track.locked ? 'Unlock' : 'Lock'} ${trackLabel(track, index)}`}
                  pressed={track.locked}
                  onClick={() =>
                    void project.execute({
                      type: 'setTrackLocked',
                      track: track.id,
                      locked: !track.locked,
                    })
                  }
                >
                  L
                </Toggle>
                <Toggle
                  label={`${track.muted ? 'Unmute' : 'Mute'} ${trackLabel(track, index)}`}
                  pressed={track.muted}
                  onClick={() =>
                    void project.execute({
                      type: 'setTrackMuted',
                      track: track.id,
                      muted: !track.muted,
                    })
                  }
                >
                  M
                </Toggle>
                <Toggle
                  label={`${track.hidden ? 'Show' : 'Hide'} ${trackLabel(track, index)}`}
                  pressed={track.hidden}
                  onClick={() =>
                    void project.execute({
                      type: 'setTrackHidden',
                      track: track.id,
                      hidden: !track.hidden,
                    })
                  }
                >
                  H
                </Toggle>
              </div>
              <div className="cgv-track-lane">
                {track.clips.map((clip) => (
                  <div
                    key={clip.id}
                    className={clipClass(clip)}
                    style={{ left: percent(clip.start), width: percent(clip.duration) }}
                    title={`${names.get(clip.media) ?? clip.media} · ${formatTime(clip.start)}–${formatTime(clip.start + clip.duration)}`}
                    data-testid="clip"
                    data-clip-id={clip.id}
                    data-start={clip.start}
                    data-duration={clip.duration}
                  >
                    <span>{names.get(clip.media) ?? clip.media}</span>
                  </div>
                ))}
              </div>
            </li>
          ))}
      </ol>
    </section>
  );
}

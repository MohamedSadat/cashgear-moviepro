import type { QualityMode } from '@cgv/engine-client';
import { usePlaybackState, type PlaybackControls } from './usePlayback';

const qualities: { mode: QualityMode; label: string }[] = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'full', label: 'Full' },
  { mode: 'half', label: '1/2' },
  { mode: 'quarter', label: '1/4' },
];
const levelLabels = ['Full', '1/2', '1/4'];

/**
 * The program monitor's controls: transport buttons, timecode, a scrub bar and
 * the preview quality.
 */
export function TransportBar({ playback }: { playback: PlaybackControls }) {
  const state = usePlaybackState(playback);
  const disabled = !state || state.duration <= 0;
  const playing = state?.playing ?? false;
  const shuttling = playing && state && state.rate !== 1;
  return (
    <div
      className="cgv-transport"
      data-testid="transport"
      data-playing={String(playing)}
      data-starting={String(state?.starting ?? false)}
      data-rate={state?.rate ?? 0}
      data-frame={state?.frame ?? 0}
      data-clock={state?.clock ?? ''}
      data-level={state?.level ?? 0}
    >
      <div className="cgv-transport-buttons">
        <button
          type="button"
          aria-label="Go to start"
          disabled={disabled}
          onClick={playback.toStart}
        >
          ⏮
        </button>
        <button
          type="button"
          aria-label="Previous frame"
          disabled={disabled}
          onClick={() => playback.step(-1)}
        >
          ◀︎|
        </button>
        <button
          type="button"
          className="cgv-play"
          aria-label={playing ? 'Pause' : 'Play'}
          data-testid="play-toggle"
          disabled={disabled}
          onClick={playback.toggle}
        >
          {playing ? '❚❚' : '▶︎'}
        </button>
        <button
          type="button"
          aria-label="Next frame"
          disabled={disabled}
          onClick={() => playback.step(1)}
        >
          |▶︎
        </button>
        <button type="button" aria-label="Go to end" disabled={disabled} onClick={playback.toEnd}>
          ⏭
        </button>
      </div>
      <span className="cgv-timecode" data-testid="timecode" aria-label="Playhead timecode">
        {state?.timecode ?? '00:00:00:00'}
      </span>
      <input
        className="cgv-scrub"
        type="range"
        aria-label="Playhead"
        data-testid="scrub"
        min={0}
        max={state?.lastFrame ?? 0}
        step={1}
        value={Math.min(state?.frame ?? 0, state?.lastFrame ?? 0)}
        disabled={disabled}
        onChange={(event) => playback.seekFrame(Number(event.currentTarget.value), true)}
      />
      <span className="cgv-timecode cgv-duration" data-testid="duration">
        {state?.durationTimecode ?? '00:00:00:00'}
      </span>
      {playback.soundError && (
        <span className="cgv-sound-warning" role="status" data-testid="sound-error">
          No sound: {playback.soundError}
        </span>
      )}
      {shuttling && (
        <span className="cgv-shuttle" data-testid="shuttle-rate">
          {state.rate > 0 ? '▶︎' : '◀︎'} {Math.abs(state.rate)}×
        </span>
      )}
      <label className="cgv-quality">
        <span>Quality</span>
        <select
          aria-label="Preview quality"
          data-testid="quality"
          value={state?.quality ?? 'auto'}
          onChange={(event) => playback.setQuality(event.currentTarget.value as QualityMode)}
        >
          {qualities.map(({ mode, label }) => (
            <option key={mode} value={mode}>
              {mode === 'auto' && state?.quality === 'auto'
                ? `Auto (${levelLabels[state.level] ?? 'Full'})`
                : label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

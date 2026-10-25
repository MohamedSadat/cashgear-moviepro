import { levelDb } from '@cgv/engine-client';
import { meterPosition } from '../mixer/ballistics';
import type { VoiceoverState } from './useVoiceover';

const clock = (seconds: number) => {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/**
 * The voiceover panel over the monitor: the microphone and its level, hearing
 * yourself, and Record or Stop. The countdown shows large over the picture.
 */
export function VoiceoverPanel({ voiceover }: { voiceover: VoiceoverState }) {
  const { phase } = voiceover;
  if (phase === 'closed' && !voiceover.error) return null;
  const busy = phase === 'countdown' || phase === 'recording' || phase === 'saving';
  const peak = levelDb(voiceover.level, -60);
  return (
    <>
      {phase === 'countdown' && (
        <div className="cgv-countdown" data-testid="voiceover-countdown" aria-live="assertive">
          {voiceover.count}
        </div>
      )}
      <section
        className="cgv-voiceover"
        aria-label="Voiceover"
        data-testid="voiceover-panel"
        data-phase={phase}
      >
        <header className="cgv-voiceover-head">
          <span className={phase === 'recording' ? 'cgv-recording-dot' : 'cgv-mic-dot'} />
          <h3>Voiceover</h3>
          <button
            type="button"
            className="cgv-icon-button"
            aria-label="Close the voiceover panel"
            disabled={busy}
            onClick={voiceover.close}
          >
            ×
          </button>
        </header>
        {voiceover.error && (
          <p role="alert" className="cgv-warning" data-testid="voiceover-error">
            {voiceover.error}
          </p>
        )}
        {phase === 'opening' && <p className="cgv-muted">Opening the microphone…</p>}
        {phase !== 'closed' && phase !== 'opening' && (
          <>
            <label className="cgv-voiceover-device">
              <span className="cgv-muted">Microphone</span>
              <select
                aria-label="Microphone"
                value={voiceover.deviceId}
                disabled={busy}
                onChange={(event) => void voiceover.chooseDevice(event.currentTarget.value)}
              >
                {voiceover.devices.map((device, index) => (
                  <option key={device.deviceId || index} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
                {!voiceover.devices.length && <option value="">Default microphone</option>}
              </select>
            </label>
            <div
              className="cgv-input-meter"
              role="meter"
              aria-label="Input level"
              aria-valuemin={-60}
              aria-valuemax={0}
              aria-valuenow={Math.round(peak)}
              data-testid="voiceover-level"
              data-db={peak.toFixed(1)}
            >
              <div style={{ width: `${meterPosition(peak) * 100}%` }} />
            </div>
            <label className="cgv-check">
              <input
                type="checkbox"
                checked={voiceover.monitoring}
                onChange={(event) => voiceover.setMonitoring(event.currentTarget.checked)}
              />
              Hear myself (use headphones)
            </label>
            <p className="cgv-muted" data-testid="voiceover-status">
              {phase === 'ready' && 'Recording starts at the playhead after a 3-second countdown.'}
              {phase === 'countdown' && 'Get ready…'}
              {phase === 'recording' && `Recording ${clock(voiceover.elapsed)}. Space stops.`}
              {phase === 'saving' && 'Saving the recording…'}
            </p>
            <div className="cgv-voiceover-actions">
              {phase === 'ready' && (
                <button
                  type="button"
                  className="cgv-record-button"
                  data-testid="voiceover-record"
                  onClick={voiceover.record}
                >
                  Record
                </button>
              )}
              {(phase === 'countdown' || phase === 'recording') && (
                <>
                  <button
                    type="button"
                    className="cgv-record-button"
                    data-testid="voiceover-stop"
                    onClick={() => void voiceover.stop()}
                  >
                    Stop
                  </button>
                  <button type="button" onClick={voiceover.cancel}>
                    Discard
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineClient, PlaybackState, QualityMode } from '@cgv/engine-client';
import type { ProjectState } from '../project/useProject';

export interface PlaybackControls {
  state: PlaybackState | null;
  /** Why there is no sound, if sound could not start. Playback then runs silent. */
  soundError: string | null;
  toggle(): void;
  shuttle(key: 'j' | 'k' | 'l'): void;
  /** Moves the playhead to frame `frame`; `scrub` plays a short snippet of sound. */
  seekFrame(frame: number, scrub?: boolean): void;
  step(frames: number): void;
  toStart(): void;
  toEnd(): void;
  setQuality(mode: QualityMode): void;
}

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * The program monitor's transport: the playhead state the engine reports, sound
 * at the project's rate, and the commands the monitor's buttons and keys send.
 * Space plays and pauses, J/K/L shuttle, the arrow keys step a frame (ten with
 * Shift), Home and End jump to the ends.
 */
export function usePlayback(client: EngineClient | null, project: ProjectState): PlaybackControls {
  const [state, setState] = useState<PlaybackState | null>(null);
  const [soundError, setSoundError] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const settings = project.snapshot?.project.settings;
  const sampleRate = settings?.sampleRate;
  const channels = settings?.channels;
  const frameRate = settings?.frameRate;

  useEffect(() => {
    if (!client) {
      setState(null);
      return;
    }
    client.onPlayback(setState);
    void client.api
      .playbackState()
      .then(setState)
      .catch(() => {});
    return () => client.onPlayback(null);
  }, [client]);

  useEffect(() => {
    if (!client || !sampleRate || !channels) return;
    // Without sound the playhead follows the wall clock; the monitor still plays.
    void client
      .configureAudio(sampleRate, channels)
      .then(() => setSoundError(null))
      .catch((error) => setSoundError(error instanceof Error ? error.message : String(error)));
  }, [client, sampleRate, channels]);

  const seekFrame = useCallback(
    (frame: number, scrub = false) => {
      if (!client || !frameRate) return;
      // The middle of the frame, so rounding never lands on the one before.
      const duration = (705_600_000 * frameRate.den) / frameRate.num;
      void client.api.seek(Math.max(0, frame) * duration + duration / 2, { scrub });
    },
    [client, frameRate],
  );

  const controls = useMemo<PlaybackControls>(
    () => ({
      state,
      soundError,
      toggle: () => void client?.togglePlay(),
      shuttle: (key) => void client?.shuttle(key),
      seekFrame,
      step: (frames) => void client?.api.step(frames),
      toStart: () => void client?.api.seek(0),
      toEnd: () => void client?.api.seek(stateRef.current?.lastFrameTime ?? 0),
      setQuality: (mode) => void client?.api.setQuality(mode),
    }),
    [client, seekFrame, soundError, state],
  );
  const controlsRef = useRef(controls);
  controlsRef.current = controls;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || editable(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const run = controlsRef.current;
      const key = event.key.toLowerCase();
      if (event.type === 'keyup') {
        // A focused button would otherwise click on Space as well.
        if (key === ' ') event.preventDefault();
        return;
      }
      if (event.repeat && (key === ' ' || ['j', 'k', 'l'].includes(key))) return;
      if (key === ' ') run.toggle();
      else if (key === 'j' || key === 'k' || key === 'l') run.shuttle(key);
      else if (key === 'arrowleft') run.step(event.shiftKey ? -10 : -1);
      else if (key === 'arrowright') run.step(event.shiftKey ? 10 : 1);
      else if (key === 'home') run.toStart();
      else if (key === 'end') run.toEnd();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  return controls;
}

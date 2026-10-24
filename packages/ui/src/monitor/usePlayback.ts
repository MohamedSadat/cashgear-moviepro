import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { EngineClient, PlaybackState, QualityMode } from '@cgv/engine-client';
import type { ProjectState } from '../project/useProject';

export interface PlaybackControls {
  /**
   * The latest playhead and transport. Reading it does not re-render anything;
   * components that show it use `usePlaybackState`.
   */
  readonly state: PlaybackState | null;
  /** Hears every change of `state` (about 30 times a second while playing). */
  subscribe(listener: () => void): () => void;
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

/** The playhead state, re-rendering the caller whenever it changes. */
export function usePlaybackState(playback: PlaybackControls): PlaybackState | null {
  return useSyncExternalStore(playback.subscribe, () => playback.state);
}

/**
 * The program monitor's transport: the playhead state the engine reports, sound
 * at the project's rate, and the commands the monitor's buttons send. Keys reach
 * these through the shortcut map.
 *
 * The state lives outside React state, so playing re-renders only what shows the
 * playhead, never the whole workspace.
 */
export function usePlayback(client: EngineClient | null, project: ProjectState): PlaybackControls {
  const store = useRef({ state: null as PlaybackState | null, listeners: new Set<() => void>() });
  const [soundError, setSoundError] = useState<string | null>(null);
  const publish = useCallback((next: PlaybackState | null) => {
    store.current.state = next;
    for (const listener of store.current.listeners) listener();
  }, []);
  const settings = project.snapshot?.project.settings;
  const sampleRate = settings?.sampleRate;
  const channels = settings?.channels;
  const frameRate = settings?.frameRate;

  useEffect(() => {
    if (!client) {
      publish(null);
      return;
    }
    client.onPlayback(publish);
    void client.api
      .playbackState()
      .then(publish)
      .catch(() => {});
    return () => client.onPlayback(null);
  }, [client, publish]);

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
      get state() {
        return store.current.state;
      },
      subscribe: (listener) => {
        store.current.listeners.add(listener);
        return () => void store.current.listeners.delete(listener);
      },
      soundError,
      toggle: () => void client?.togglePlay(),
      shuttle: (key) => void client?.shuttle(key),
      seekFrame,
      step: (frames) => void client?.api.step(frames),
      toStart: () => void client?.api.seek(0),
      toEnd: () => void client?.api.seek(store.current.state?.lastFrameTime ?? 0),
      setQuality: (mode) => void client?.api.setQuality(mode),
    }),
    [client, seekFrame, soundError],
  );
  return controls;
}

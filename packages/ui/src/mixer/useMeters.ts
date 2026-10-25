import { useEffect, useMemo, useRef } from 'react';
import type { EngineClient, MeterReading } from '@cgv/engine-client';

/**
 * The mixer's meters as the engine reports them while sound plays. The latest
 * reading lives outside React state, so meters update without re-rendering the
 * workspace; they subscribe and draw themselves.
 */
export interface MeterStore {
  /** The latest reading, or null when sound is not playing. */
  readonly latest: MeterReading | null;
  subscribe(listener: () => void): () => void;
  /** Tests: every reading since the last call (kept only with `?diagnostic=1`). */
  take(): MeterReading[];
}

export function useMeters(client: EngineClient | null, diagnostic: boolean): MeterStore {
  const state = useRef({
    latest: null as MeterReading | null,
    listeners: new Set<() => void>(),
    history: [] as MeterReading[],
  });
  useEffect(() => {
    if (!client) return;
    client.onMeters((reading) => {
      const current = state.current;
      current.latest = reading;
      if (diagnostic && reading) {
        current.history.push(reading);
        if (current.history.length > 2000) current.history.splice(0, 1000);
      }
      for (const listener of current.listeners) listener();
    });
    return () => client.onMeters(null);
  }, [client, diagnostic]);
  return useMemo<MeterStore>(
    () => ({
      get latest() {
        return state.current.latest;
      },
      subscribe(listener) {
        state.current.listeners.add(listener);
        return () => void state.current.listeners.delete(listener);
      },
      take() {
        const taken = state.current.history;
        state.current.history = [];
        return taken;
      },
    }),
    [],
  );
}

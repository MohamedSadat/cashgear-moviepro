import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MediaPlatform, UpdateInfo } from '../platform';

// Desktop updates: the release feed is checked a little after start and every six
// hours. A newer version waits for the user, who installs it from the header.

const firstCheckMs = 10_000;
const checkEveryMs = 6 * 3600_000;

export interface UpdatesState {
  /** The newer version waiting, or null. */
  available: UpdateInfo | null;
  /** While installing: the download so far, 0 to 1 (null while unknown). */
  installing: { fraction: number | null } | null;
  error: string | null;
  /** Checks the feed now; resolves with what it offers. */
  check(): Promise<UpdateInfo | null>;
  /** Downloads and installs the waiting version; the app closes for the installer. */
  install(): Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useUpdates(platform: MediaPlatform): UpdatesState {
  const updates = platform.updates;
  const [available, setAvailable] = useState<UpdateInfo | null>(null);
  const [installing, setInstalling] = useState<UpdatesState['installing']>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    if (!updates) return null;
    const found = await updates.check();
    setAvailable(found);
    return found;
  }, [updates]);

  useEffect(() => {
    if (!updates) return;
    // A feed that cannot be reached is no news: the next check tries again.
    const quiet = () => void check().catch((cause) => console.warn('Update check:', cause));
    const first = setTimeout(quiet, firstCheckMs);
    const timer = setInterval(quiet, checkEveryMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [updates, check]);

  const install = useCallback(async () => {
    if (!updates) return;
    setError(null);
    setInstalling({ fraction: null });
    try {
      await updates.install((received, total) =>
        setInstalling({ fraction: total ? received / total : null }),
      );
    } catch (cause) {
      setError(message(cause));
      setInstalling(null);
    }
  }, [updates]);

  return useMemo(
    () => ({ available, installing, error, check, install }),
    [available, installing, error, check, install],
  );
}

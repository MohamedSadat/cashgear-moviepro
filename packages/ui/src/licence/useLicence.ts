import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaPlatform } from '../platform';
import {
  PRODUCT,
  REFRESH_AFTER_MS,
  baseStatus,
  evaluate,
  licenceConfig,
  verifyToken,
  type LicenceConfig,
  type LicenceStatus,
  type TokenPayload,
} from './licence';

// The licence of this browser profile or app install: its token in local storage,
// activation and deactivation, and refreshes while the app runs (at start, every
// hour, and when the connection comes back).

const storageKey = 'cgv.licence.v1';

interface Stored {
  token: string;
  /**
   * The latest time the app has seen since the last check, so a clock set back
   * cannot stretch the grace period.
   */
  seen: number;
}

function readStored(): Stored | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<Stored> | null;
    return value && typeof value.token === 'string'
      ? { token: value.token, seen: Number(value.seen) || 0 }
      : null;
  } catch {
    return null;
  }
}

function writeStored(value: Stored | null) {
  try {
    if (value) localStorage.setItem(storageKey, JSON.stringify(value));
    else localStorage.removeItem(storageKey);
  } catch {
    // Blocked storage: the licence holds for this session only.
  }
}

interface Answer {
  status: number;
  token?: string;
  error?: string;
  code?: string;
}

async function call(server: string, route: string, body: object): Promise<Answer> {
  const response = await fetch(`${server}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const answer = (await response.json().catch(() => ({}))) as Omit<Answer, 'status'>;
  return { ...answer, status: response.status };
}

const unreachable = "The licence server couldn't be reached. Check the connection and try again.";
/** Refusals after which the stored token is worth nothing. */
const final = new Set(['revoked', 'expired', 'not-activated', 'invalid-key', 'wrong-product']);

export interface LicenceApi {
  config: LicenceConfig;
  status: LicenceStatus;
  busy: boolean;
  /** The last activation or refresh problem, as a sentence. */
  error: string | null;
  activate(key: string): Promise<boolean>;
  deactivate(): Promise<boolean>;
  /** Asks the licence server again now. */
  refresh(): Promise<void>;
}

export function useLicence(platform: MediaPlatform): LicenceApi {
  const config = useMemo(() => licenceConfig(import.meta.env, location.search), []);
  const [status, setStatus] = useState<LicenceStatus>(() => baseStatus(config));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const machine = useRef<Promise<string> | null>(null);
  const payload = useRef<TokenPayload | null>(null);
  const machineId = useCallback(() => (machine.current ??= platform.machineId()), [platform]);

  /** Reads the stored token again and works out what it allows now. */
  const load = useCallback(async () => {
    const stored = readStored();
    const now = Math.max(Date.now(), stored?.seen ?? 0);
    if (stored) writeStored({ ...stored, seen: now });
    payload.current = stored ? await verifyToken(stored.token, config.keys) : null;
    setStatus(evaluate(config, payload.current, await machineId(), now));
    return payload.current;
  }, [config, machineId]);

  const forget = useCallback(async () => {
    writeStored(null);
    await load();
  }, [load]);

  /** Keeps a token from the server when it is for this app and this machine. */
  const accept = useCallback(
    async (token: string) => {
      const verified = await verifyToken(token, config.keys);
      if (!verified || verified.product !== PRODUCT || verified.machine !== (await machineId())) {
        return false;
      }
      // The server's clock is the one to trust: a clock once set ahead must not
      // make fresh tokens look old.
      writeStored({ token, seen: Date.parse(verified.issuedAt) });
      await load();
      return true;
    },
    [config.keys, load, machineId],
  );

  const check = useCallback(
    async (force: boolean) => {
      const current = payload.current ?? (await load());
      if (!config.server || !current) return;
      if (!force && Date.now() - Date.parse(current.issuedAt) < REFRESH_AFTER_MS) return;
      let answer: Answer;
      try {
        answer = await call(config.server, 'refresh', {
          licenceId: current.licenceId,
          machine: await machineId(),
        });
      } catch {
        // Offline: the grace period covers it.
        if (force) setError(unreachable);
        return;
      }
      if (answer.token && (await accept(answer.token))) {
        setError(null);
      } else if (answer.code && final.has(answer.code)) {
        setError(answer.error ?? 'This licence is no longer valid.');
        await forget();
      } else if (force) {
        setError(answer.error ?? unreachable);
      }
    },
    [config.server, accept, forget, load, machineId],
  );

  const activate = useCallback(
    async (key: string) => {
      if (!config.server || !config.keys.length) {
        setError('Licensing is not set up in this build.');
        return false;
      }
      setBusy(true);
      setError(null);
      try {
        const answer = await call(config.server, 'activate', {
          key: key.trim(),
          machine: await machineId(),
          product: PRODUCT,
          version: import.meta.env.VITE_CGV_VERSION ?? '',
        });
        if (answer.token) {
          if (await accept(answer.token)) return true;
          setError('The licence server answered with a licence this app cannot check.');
        } else {
          setError(answer.error ?? `The licence server refused (${answer.status}).`);
        }
        return false;
      } catch {
        setError(unreachable);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [config, accept, machineId],
  );

  const deactivate = useCallback(async () => {
    const current = payload.current;
    if (!config.server || !current) return false;
    setBusy(true);
    setError(null);
    try {
      const answer = await call(config.server, 'deactivate', {
        licenceId: current.licenceId,
        machine: await machineId(),
      });
      if (answer.status >= 500) {
        setError(unreachable);
        return false;
      }
      // A refusal means the server does not count this machine either.
      await forget();
      return true;
    } catch {
      setError(unreachable);
      return false;
    } finally {
      setBusy(false);
    }
  }, [config.server, forget, machineId]);

  useEffect(() => {
    const later = () => void load().then(() => check(false));
    later();
    const timer = setInterval(later, 3600_000);
    window.addEventListener('online', later);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', later);
    };
  }, [load, check]);

  const refresh = useCallback(() => check(true), [check]);
  return { config, status, busy, error, activate, deactivate, refresh };
}

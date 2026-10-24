import { useCallback, useRef, useState } from 'react';
import { readShortcuts, type ShortcutSettings } from '../shortcuts/keymap';

/** Per-user settings: kept in this browser or app profile, never in a project. */
export interface AppSettings {
  shortcuts: ShortcutSettings;
  snapping: boolean;
  /** Panel sizes by splitter, as the CG splitter reports them. */
  layout: Record<string, unknown>;
}

const key = 'cgv.settings.v1';

function load(): AppSettings {
  let stored: Partial<AppSettings>;
  try {
    stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<AppSettings>;
  } catch {
    stored = {};
  }
  return {
    shortcuts: readShortcuts(stored.shortcuts),
    snapping: stored.snapping !== false,
    layout: stored.layout && typeof stored.layout === 'object' ? stored.layout : {},
  };
}

export interface AppSettingsState {
  settings: AppSettings;
  update(change: Partial<AppSettings>): void;
  /** Remembers panel sizes without re-rendering: the splitters already show them. */
  saveLayout(layout: Record<string, unknown>): void;
}

function store(settings: AppSettings) {
  try {
    localStorage.setItem(key, JSON.stringify(settings));
  } catch {
    // Storage may be full or blocked; the settings still apply this session.
  }
}

export function useAppSettings(): AppSettingsState {
  const [settings, setSettings] = useState(load);
  const latest = useRef(settings);
  latest.current = settings;
  const update = useCallback((change: Partial<AppSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...change };
      latest.current = next;
      store(next);
      return next;
    });
  }, []);
  const saveLayout = useCallback((layout: Record<string, unknown>) => {
    latest.current = { ...latest.current, layout };
    store(latest.current);
  }, []);
  return { settings, update, saveLayout };
}

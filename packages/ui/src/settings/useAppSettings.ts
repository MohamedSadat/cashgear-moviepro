import { useCallback, useRef, useState } from 'react';
import { readShortcuts, type ShortcutSettings } from '../shortcuts/keymap';

/**
 * Desktop proxies for media over 1080p, at half, a quarter or all of its height
 * (never under 720 rows); off plays such media from its original. Media the
 * webview cannot decode always gets one.
 */
export type ProxySize = 'half' | 'quarter' | 'full' | 'off';
const proxySizes: ProxySize[] = ['half', 'quarter', 'full', 'off'];

/** Per-user settings: kept in this browser or app profile, never in a project. */
export interface AppSettings {
  shortcuts: ShortcutSettings;
  snapping: boolean;
  proxies: ProxySize;
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
    proxies: proxySizes.includes(stored.proxies as ProxySize)
      ? (stored.proxies as ProxySize)
      : 'half',
    layout: stored.layout && typeof stored.layout === 'object' ? stored.layout : {},
  };
}

/** The proxy size as last saved, for code outside React. */
export function storedProxySize(): ProxySize {
  return load().proxies;
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

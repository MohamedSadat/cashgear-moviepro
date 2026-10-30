import { useEffect, useRef } from 'react';
import { keepStorage, storageUse, storageWarning } from '@cgv/engine-client';
import type { ProjectState } from '../project/useProject';

// The web keeps projects, autosaves and copies of dropped media in the browser's
// storage. Once a project has media, the browser is asked to keep that storage
// under pressure, and a warning shows once whenever it is nearly full.

const checkEveryMs = 5 * 60_000;

export function useStorageWatch(enabled: boolean, project: ProjectState) {
  const warned = useRef(false);
  const items = project.library.items.length;
  const { notice } = project;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const check = async () => {
      const warning = storageWarning(await storageUse().catch(() => null));
      if (!live) return;
      if (warning && !warned.current) notice(warning);
      warned.current = !!warning;
    };
    void check();
    const timer = setInterval(check, checkEveryMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled, items, notice]);
  const hasMedia = items > 0;
  useEffect(() => {
    if (enabled && hasMedia) void keepStorage();
  }, [enabled, hasMedia]);
}

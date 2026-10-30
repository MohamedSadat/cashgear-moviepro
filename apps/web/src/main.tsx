import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { AppShell, recordProblems } from '@cgv/ui';
import { desktopPlatform } from './platform/desktop';
import { webPlatform } from './platform/web';

const platform = isTauri() ? desktopPlatform : webPlatform;
// Errors and warnings from here on go into the diagnostic report a user may save.
recordProblems();

// The web app works offline once it has loaded (apps/web/sw.js). The desktop app's
// files are on disk already, and development builds change too often to cache.
if (!isTauri() && import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js')
    .catch((error) => console.warn('Offline use is unavailable:', error));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell platform={platform} />
  </StrictMode>,
);

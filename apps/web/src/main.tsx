import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '@cgv/ui';
import { loadNativeInfo } from './native';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell loadNativeInfo={loadNativeInfo} />
  </StrictMode>,
);

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  evaluateCapabilities,
  probeCapabilities,
  type BackendPreference,
  type CapabilityProbe,
  type EngineClient,
  type EngineGpu,
  type GpuFault,
} from '@cgv/engine-client';
import { BlockedScreen, CapabilityNotice, CapabilityStrip } from './CapabilityReport';
import { DevOverlay } from './DevOverlay';
import { MediaLibraryPanel } from './media/MediaLibraryPanel';
import { useMediaLibrary, type MediaLibraryState } from './media/useMediaLibrary';
import type { MediaPlatform, NativeInfo } from './platform';
import { ProgramMonitor, type MonitorState } from './ProgramMonitor';
import './styles.css';

interface Props {
  platform: MediaPlatform;
}

/** What `?diagnostic=1` exposes to browser and desktop tests as `window.__cgv`. */
export interface DiagnosticHooks {
  client: EngineClient | null;
  library: MediaLibraryState;
  platform: MediaPlatform;
}

// Rust startup errors that mean no GPU backend could be created at all.
const noGpu =
  /No usable WebGPU or WebGL2 adapter|WebGL2 surface unavailable|GPU device unavailable/;

function readOptions(search: string) {
  const params = new URLSearchParams(search);
  const diagnostic = params.get('diagnostic') === '1';
  const fault = params.get('fault');
  return {
    backend: (params.get('gpu') === 'webgl2' ? 'webgl2' : 'auto') as BackendPreference,
    diagnostic,
    dev: params.get('dev') === '1',
    gpuFault:
      diagnostic && (fault === 'adapter' || fault === 'device') ? (fault as GpuFault) : undefined,
  };
}

export function AppShell({ platform }: Props) {
  const options = useMemo(() => readOptions(location.search), []);
  const [generation, setGeneration] = useState(0);
  const [engine, setEngine] = useState<MonitorState>({ status: 'starting' });
  const [client, setClient] = useState<EngineClient | null>(null);
  const [probe, setProbe] = useState<CapabilityProbe>();
  const [native, setNative] = useState<NativeInfo>();
  const [devOverlay, setDevOverlay] = useState(options.dev);
  const onState = useCallback((state: MonitorState) => setEngine(state), []);
  const library = useMediaLibrary(client, platform);

  useEffect(() => {
    let live = true;
    void probeCapabilities().then((result) => live && setProbe(result));
    void platform
      .nativeInfo()
      .then((info) => live && setNative(info))
      .catch(() => live && setNative(undefined));
    return () => {
      live = false;
    };
  }, [platform]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setDevOverlay((shown) => !shown);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!options.diagnostic) return;
    const hooks: DiagnosticHooks = { client, library, platform };
    Reflect.set(window, '__cgv', hooks);
  }, [options.diagnostic, client, library, platform]);

  const gpu: EngineGpu =
    engine.status === 'ready'
      ? {
          state: 'ready',
          backend: engine.info.backend,
          forced: options.backend === 'webgl2',
        }
      : engine.status === 'error' && engine.duringStartup && noGpu.test(engine.message)
        ? { state: 'failed' }
        : { state: 'pending' };
  const report = evaluateCapabilities(
    probe,
    engine.status === 'ready' ? engine.sharedMemory : undefined,
    gpu,
  );

  return (
    <div className="cgv-app">
      <header className="cgv-header">
        <h1>CashGear Video</h1>
        {options.diagnostic && engine.status === 'ready' && engine.fault && (
          <div className="cgv-diagnostics">
            <button type="button" onClick={() => engine.fault?.('device-loss')}>
              Simulate device loss
            </button>
            <button type="button" onClick={() => engine.fault?.('panic')}>
              Simulate Rust panic
            </button>
          </div>
        )}
      </header>
      <div className="cgv-workspace">
        <MediaLibraryPanel library={library} />
        <main className="cgv-stage">
          <CapabilityNotice report={report} />
          {engine.status === 'error' && (
            <div className="cgv-error" role="alert" data-testid="engine-error">
              <p>{engine.message}</p>
              <button type="button" onClick={() => setGeneration((value) => value + 1)}>
                Retry engine
              </button>
              {options.backend !== 'webgl2' && <a href="?gpu=webgl2">Try the WebGL2 renderer</a>}
            </div>
          )}
          <div className="cgv-monitor-area">
            <ProgramMonitor
              generation={generation}
              backend={options.backend}
              diagnostic={options.diagnostic}
              gpuFault={options.gpuFault}
              onState={onState}
              onClient={setClient}
            />
          </div>
        </main>
      </div>
      <CapabilityStrip engine={engine} probe={probe} report={report} native={native} />
      {devOverlay && <DevOverlay client={client} />}
      {report.status === 'blocked' && <BlockedScreen report={report} />}
    </div>
  );
}

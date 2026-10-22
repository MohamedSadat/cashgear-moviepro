import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  evaluateCapabilities,
  probeCapabilities,
  type BackendPreference,
  type CapabilityProbe,
  type EngineGpu,
  type GpuFault,
} from '@cgv/engine-client';
import {
  BlockedScreen,
  CapabilityNotice,
  CapabilityStrip,
  type NativeInfo,
} from './CapabilityReport';
import { ProgramMonitor, type MonitorState } from './ProgramMonitor';
import './styles.css';

interface Props {
  /** Desktop only: asks the native side who it is. Resolves to undefined on the web. */
  loadNativeInfo?: () => Promise<NativeInfo | undefined>;
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
    gpuFault:
      diagnostic && (fault === 'adapter' || fault === 'device') ? (fault as GpuFault) : undefined,
  };
}

export function AppShell({ loadNativeInfo }: Props) {
  const options = useMemo(() => readOptions(location.search), []);
  const [generation, setGeneration] = useState(0);
  const [engine, setEngine] = useState<MonitorState>({ status: 'starting' });
  const [probe, setProbe] = useState<CapabilityProbe>();
  const [native, setNative] = useState<NativeInfo>();
  const onState = useCallback((state: MonitorState) => setEngine(state), []);

  useEffect(() => {
    let live = true;
    void probeCapabilities().then((result) => live && setProbe(result));
    void loadNativeInfo?.()
      .then((info) => live && setNative(info))
      .catch(() => live && setNative(undefined));
    return () => {
      live = false;
    };
  }, [loadNativeInfo]);

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
          />
        </div>
      </main>
      <CapabilityStrip engine={engine} probe={probe} report={report} native={native} />
      {report.status === 'blocked' && <BlockedScreen report={report} />}
    </div>
  );
}

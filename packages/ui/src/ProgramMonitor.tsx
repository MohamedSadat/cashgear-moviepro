import { useEffect, useRef, type ReactNode } from 'react';
import {
  createEngineClient,
  type BackendPreference,
  type EngineClient,
  type DiagnosticFault,
  type EngineInfo,
  type GpuFault,
  type PhysicalSize,
} from '@cgv/engine-client';

export type MonitorState =
  | { status: 'starting' }
  | {
      status: 'ready';
      info: EngineInfo;
      sharedMemory?: boolean;
      fault?: (kind: DiagnosticFault) => void;
    }
  | { status: 'error'; message: string; duringStartup: boolean };

interface Props {
  /** Bump to tear the engine down and start a fresh worker and canvas. */
  generation: number;
  backend: BackendPreference;
  diagnostic: boolean;
  gpuFault?: GpuFault;
  /** Show the Phase 0 test pattern instead of the timeline (GPU checks). */
  pattern?: boolean;
  /** Diagnostics: force playback decoders to software or hardware. */
  decode?: 'auto' | 'software' | 'hardware';
  onState: (state: MonitorState) => void;
  /** The engine worker behind this monitor, for media and diagnostics; null once it is gone. */
  onClient: (client: EngineClient | null) => void;
  /** Drawn over the picture: the monitor's handles. */
  children?: ReactNode;
}

const startupTimeout = 30000;

/**
 * The program monitor: a canvas whose rendering lives entirely in the engine
 * worker. Each mount owns one worker; Retry (a new `generation`) starts another.
 */
export function ProgramMonitor({
  generation,
  backend,
  diagnostic,
  gpuFault,
  pattern = false,
  decode = 'auto',
  onState,
  onClient,
  children,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = host.current!;
    // Every effect owns a fresh DOM canvas. StrictMode, HMR and Retry must never
    // transfer an already-transferred canvas or reuse a failed GPU context.
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', 'Program monitor');
    canvas.dataset.testid = 'program-monitor';
    canvas.dataset.frames = '0';
    container.prepend(canvas);
    let disposed = false;
    let ready = false;
    let failed = false;
    let dprQuery: MediaQueryList | undefined;
    const fail = (message: string) => {
      if (disposed || failed) return;
      failed = true;
      clearTimeout(timeout);
      onState({ status: 'error', message, duringStartup: !ready });
      onClient(null);
      client.dispose();
    };
    const client = createEngineClient(fail);
    client.onStats((stats) => {
      canvas.dataset.frames = String(stats.frames);
      canvas.dataset.presented = String(stats.presented);
      canvas.dataset.renderWidth = String(stats.width);
      canvas.dataset.renderHeight = String(stats.height);
    });
    onClient(client);
    function measure(): PhysicalSize {
      const rect = container.getBoundingClientRect();
      const size = {
        width: Math.max(0, Math.round(rect.width * devicePixelRatio)),
        height: Math.max(0, Math.round(rect.height * devicePixelRatio)),
      };
      canvas.dataset.width = String(size.width);
      canvas.dataset.height = String(size.height);
      if (ready) void client.api.resize(size).catch((error) => fail(String(error)));
      return size;
    }
    function watchDpr() {
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = matchMedia('(resolution: ' + devicePixelRatio + 'dppx)');
      dprQuery.addEventListener('change', onDprChange);
    }
    function onDprChange() {
      measure();
      watchDpr();
    }
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    watchDpr();
    onState({ status: 'starting' });
    const initialSize = measure();
    const offscreen = canvas.transferControlToOffscreen();
    const timeout = setTimeout(
      () => fail('The graphics engine did not start. Retry, or try the WebGL2 renderer.'),
      startupTimeout,
    );
    void client
      .init(offscreen, {
        ...initialSize,
        backend,
        diagnostic,
        simulateGpuFailure: gpuFault,
        pattern,
        decode,
      })
      .then(async (info) => {
        clearTimeout(timeout);
        if (disposed || failed) return;
        ready = true;
        canvas.dataset.backend = info.backend;
        const fault = diagnostic
          ? (kind: DiagnosticFault) =>
              void client.api.diagnosticFault(kind).catch((error) => fail(String(error)))
          : undefined;
        onState({ status: 'ready', info, fault });
        // The size may have changed while the engine was starting.
        measure();
        const sharedMemory = await client.checkSharedMemory().catch(() => false);
        if (!disposed && !failed) onState({ status: 'ready', info, fault, sharedMemory });
      })
      .catch((error) => fail(error instanceof Error ? error.message : String(error)));
    return () => {
      disposed = true;
      clearTimeout(timeout);
      observer.disconnect();
      dprQuery?.removeEventListener('change', onDprChange);
      onClient(null);
      client.dispose();
      canvas.remove();
    };
  }, [generation, backend, diagnostic, gpuFault, pattern, decode, onState, onClient]);
  // The engine adds its canvas first; the overlay stays above it.
  return (
    <div className="cgv-monitor" ref={host}>
      {children}
    </div>
  );
}

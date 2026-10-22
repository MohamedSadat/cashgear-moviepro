import type { CapabilityProbe, CapabilityReport as Report } from '@cgv/engine-client';
import type { NativeInfo } from './platform';
import type { MonitorState } from './ProgramMonitor';

interface StripProps {
  engine: MonitorState;
  probe: CapabilityProbe | undefined;
  report: Report;
  native: NativeInfo | undefined;
}

const engineLabel = { starting: 'Starting engine', ready: 'Engine ready', error: 'Engine error' };

function adapterTitle(engine: MonitorState, probe: CapabilityProbe | undefined) {
  if (engine.status === 'ready' && engine.info.adapter) return engine.info.adapter;
  const adapter = probe?.gpuAdapter;
  if (engine.status === 'ready' && engine.info.backend === 'WebGPU' && adapter)
    return [adapter.vendor, adapter.architecture, adapter.description].filter(Boolean).join(' ');
  return '';
}

/** A yes/no fact that reads "checking" until it is known. */
function Fact(props: { id: string; ok: boolean | undefined; label: [string, string, string] }) {
  const [checking, yes, no] = props.label;
  return (
    <span data-testid={props.id} data-ok={props.ok === undefined ? undefined : String(props.ok)}>
      {props.ok === undefined ? checking : props.ok ? yes : no}
    </span>
  );
}

/** One line of facts about the engine and the platform, along the bottom of the window. */
export function CapabilityStrip({ engine, probe, report, native }: StripProps) {
  const sharedMemory = engine.status === 'ready' ? engine.sharedMemory : undefined;
  const codecs = probe && Object.values(probe.webcodecs).every(Boolean);
  return (
    <footer className="cgv-strip" data-testid="capability-strip" data-status={report.status}>
      <span data-testid="engine-status" data-state={engine.status}>
        {engineLabel[engine.status]}
      </span>
      <span data-testid="gpu-backend" title={adapterTitle(engine, probe)}>
        {engine.status === 'ready' ? engine.info.backend : '—'}
      </span>
      <Fact
        id="isolation"
        ok={probe?.crossOriginIsolated}
        label={['Isolation: checking', 'Cross-origin isolated', 'Not isolated']}
      />
      <Fact
        id="shared-memory"
        ok={sharedMemory}
        label={['Shared memory: checking', 'Shared memory OK', 'Shared memory unavailable']}
      />
      <Fact
        id="webcodecs"
        ok={codecs}
        label={['WebCodecs: checking', 'WebCodecs OK', 'WebCodecs missing']}
      />
      <span data-testid="native-info">
        {native ? `Desktop ${native.version} · ${native.os} ${native.arch}` : 'Web'}
      </span>
    </footer>
  );
}

/** Shown in front of everything when the editor cannot work in this browser. */
export function BlockedScreen({ report }: { report: Report }) {
  const blockers = report.issues.filter((issue) => issue.severity === 'blocker');
  return (
    <div
      className="cgv-blocked"
      role="alertdialog"
      aria-labelledby="cgv-blocked-title"
      data-testid="capability-blocked"
    >
      <div className="cgv-blocked-card">
        <h2 id="cgv-blocked-title">CashGear Video can’t run here</h2>
        <ul>
          {blockers.map((issue) => (
            <li key={issue.id} data-issue={issue.id}>
              {issue.message}
            </li>
          ))}
        </ul>
        <p>
          CashGear Video supports current Chrome and Edge on Windows and macOS, and the desktop app.
        </p>
      </div>
    </div>
  );
}

/** A note above the monitor for warnings such as the WebGL2 fallback. */
export function CapabilityNotice({ report }: { report: Report }) {
  const warnings = report.issues.filter((issue) => issue.severity === 'warning');
  if (!warnings.length) return null;
  return (
    <div className="cgv-notice" role="status" data-testid="capability-notice">
      {warnings.map((issue) => (
        <p key={issue.id} data-issue={issue.id}>
          {issue.message}
        </p>
      ))}
    </div>
  );
}

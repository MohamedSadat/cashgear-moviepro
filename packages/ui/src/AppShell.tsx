import { useCallback, useEffect, useMemo, useState } from 'react';
import '@cashgear/ui/styles.css';
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
import { useCatalog } from './effects/catalog';
import { EffectsBrowser } from './effects/EffectsBrowser';
import { usePreviews } from './effects/usePreviews';
import { StickersBrowser } from './stickers/StickersBrowser';
import { TitlesBrowser } from './titles/TitlesBrowser';
import { useTitlePreviews } from './titles/useTitlePreviews';
import { useEditor, type EditorState } from './editing/useEditor';
import { ExportDialog } from './export/ExportDialog';
import { useExport, type ExportState } from './export/useExport';
import { icons } from './icons';
import { Inspector } from './inspector/Inspector';
import { MediaLibraryPanel } from './media/MediaLibraryPanel';
import { TransportBar } from './monitor/TransportBar';
import { usePlayback, type PlaybackControls } from './monitor/usePlayback';
import type { MediaLibraryState } from './media/useMediaLibrary';
import type { MediaPlatform, NativeInfo } from './platform';
import { ProgramMonitor, type MonitorState } from './ProgramMonitor';
import { ProjectBar } from './project/ProjectBar';
import {
  ProjectsDialog,
  RecoveryDialog,
  RelinkDialog,
  SettingsDialog,
} from './project/ProjectDialogs';
import { useProject, type ProjectState } from './project/useProject';
import { useAppSettings } from './settings/useAppSettings';
import { effectiveKeymap } from './shortcuts/keymap';
import { ShortcutsDialog } from './shortcuts/ShortcutsDialog';
import { useShortcuts } from './shortcuts/useShortcuts';
import { Timeline } from './timeline/Timeline';
import { LibraryTabs } from './workspace/LibraryTabs';
import { Workspace } from './workspace/Workspace';
import './styles.css';

interface Props {
  platform: MediaPlatform;
}

/** What `?diagnostic=1` exposes to browser and desktop tests as `window.__cgv`. */
export interface DiagnosticHooks {
  client: EngineClient | null;
  library: MediaLibraryState;
  project: ProjectState;
  playback: PlaybackControls;
  editor: EditorState;
  exporter: ExportState;
  platform: MediaPlatform;
}

const defaultAutosaveMs = 30_000;

// Rust startup errors that mean no GPU backend could be created at all.
const noGpu =
  /No usable WebGPU or WebGL2 adapter|WebGL2 surface unavailable|GPU device unavailable/;

function readOptions(search: string) {
  const params = new URLSearchParams(search);
  const diagnostic = params.get('diagnostic') === '1';
  const fault = params.get('fault');
  // Tests shorten the autosave interval; nobody else can.
  const autosave = Number(params.get('autosave'));
  return {
    backend: (params.get('gpu') === 'webgl2' ? 'webgl2' : 'auto') as BackendPreference,
    diagnostic,
    autosaveMs: diagnostic && autosave >= 100 ? autosave : defaultAutosaveMs,
    dev: params.get('dev') === '1',
    pattern: params.get('pattern') === '1',
    decode: (diagnostic && ['software', 'hardware'].includes(params.get('decode') ?? '')
      ? params.get('decode')
      : 'auto') as 'auto' | 'software' | 'hardware',
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
  const project = useProject(client, platform, { autosaveMs: options.autosaveMs });
  const library = project.library;
  const playback = usePlayback(client, project);
  const { settings, update, saveLayout } = useAppSettings();
  const catalog = useCatalog(client);
  const editor = useEditor(project, playback, {
    snapping: settings.snapping,
    onSnapping: (snapping) => update({ snapping }),
    catalog,
  });
  const exporter = useExport(client, project, platform, {
    backend: options.backend,
    decode: options.decode,
  });
  // Previews render once someone opens the effects or transitions.
  const [browsing, setBrowsing] = useState(false);
  const previews = usePreviews(browsing ? catalog : null);
  const [titling, setTitling] = useState(false);
  const titlePreviews = useTitlePreviews(titling);
  const keymap = useMemo(() => effectiveKeymap(settings.shortcuts), [settings.shortcuts]);
  const [dialog, setDialog] = useState<'projects' | 'settings' | 'shortcuts' | 'export' | null>(
    null,
  );
  const editorRun = editor.run;
  const runAction = useCallback(
    (action: Parameters<typeof editorRun>[0]) =>
      action === 'exportVideo' ? setDialog('export') : editorRun(action),
    [editorRun],
  );
  useShortcuts(keymap, runAction);

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

  // Dark and compact everywhere, including menus the CG library opens outside the app.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.cgTheme = 'dark';
    root.dataset.cgDensity = 'compact';
  }, []);

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
    const hooks: DiagnosticHooks = {
      client,
      library,
      project,
      playback,
      editor,
      exporter,
      platform,
    };
    Reflect.set(window, '__cgv', hooks);
  }, [options.diagnostic, client, library, project, playback, editor, exporter, platform]);

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

  const monitor = (
    <main className="cgv-stage">
      <CapabilityNotice report={report} />
      {project.notices.map((text, index) => (
        <div key={index} className="cgv-notice" role="alert" data-testid="project-notice">
          {text}
          <button type="button" aria-label="Dismiss" onClick={() => project.dismissNotice(index)}>
            ×
          </button>
        </div>
      ))}
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
          pattern={options.pattern}
          decode={options.decode}
          onState={onState}
          onClient={setClient}
        />
      </div>
      <TransportBar playback={playback} />
    </main>
  );

  return (
    <div className="cgv-app">
      <header className="cgv-header">
        <h1>CashGear Video</h1>
        <ProjectBar
          project={project}
          onOpenProjects={() => setDialog('projects')}
          onOpenSettings={() => setDialog('settings')}
        />
        {exporter.status.state !== 'idle' && dialog !== 'export' && (
          <ExportChip exporter={exporter} onOpen={() => setDialog('export')} />
        )}
        <button
          type="button"
          className="cgv-primary"
          data-testid="open-export"
          title="Export video (Ctrl+E)"
          disabled={!project.snapshot}
          onClick={() => setDialog('export')}
        >
          Export
        </button>
        <button
          type="button"
          className="cgv-icon-button"
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
          data-testid="open-shortcuts"
          onClick={() => setDialog('shortcuts')}
        >
          {icons.keyboard}
        </button>
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
      <Workspace
        library={
          <LibraryTabs
            onSelect={(id) =>
              id === 'titles' ? setTitling(true) : id !== 'media' && setBrowsing(true)
            }
            tabs={[
              {
                id: 'media',
                label: 'Media',
                render: () => <MediaLibraryPanel project={project} />,
              },
              {
                id: 'titles',
                label: 'Titles',
                render: () => <TitlesBrowser editor={editor} previews={titlePreviews} />,
              },
              {
                id: 'stickers',
                label: 'Stickers',
                render: () => <StickersBrowser editor={editor} />,
              },
              {
                id: 'effects',
                label: 'Effects',
                render: () => <EffectsBrowser kind="effect" editor={editor} previews={previews} />,
              },
              {
                id: 'transitions',
                label: 'Transitions',
                render: () => (
                  <EffectsBrowser kind="transition" editor={editor} previews={previews} />
                ),
              },
            ]}
          />
        }
        monitor={monitor}
        inspector={<Inspector editor={editor} />}
        timeline={<Timeline editor={editor} diagnostic={options.diagnostic} />}
        layout={settings.layout}
        onLayout={saveLayout}
      />
      <CapabilityStrip engine={engine} probe={probe} report={report} native={native} />
      {devOverlay && <DevOverlay client={client} />}
      {dialog === 'projects' && (
        <ProjectsDialog project={project} onClose={() => setDialog(null)} />
      )}
      {dialog === 'settings' && project.snapshot && (
        <SettingsDialog project={project} onClose={() => setDialog(null)} />
      )}
      {dialog === 'export' && project.snapshot && (
        <ExportDialog
          project={project}
          exporter={exporter}
          platform={platform.kind}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'shortcuts' && (
        <ShortcutsDialog
          shortcuts={settings.shortcuts}
          onChange={(shortcuts) => update({ shortcuts })}
          onClose={() => setDialog(null)}
        />
      )}
      {project.recovery && <RecoveryDialog project={project} />}
      {project.relinking && !project.recovery && <RelinkDialog project={project} />}
      {report.status === 'blocked' && <BlockedScreen report={report} />}
    </div>
  );
}

/** Shows a running or finished export while its dialog is hidden. */
function ExportChip({ exporter, onOpen }: { exporter: ExportState; onOpen(): void }) {
  const status = exporter.status;
  const label =
    status.state === 'running'
      ? status.converting !== null
        ? `Converting ${Math.round(status.converting * 100)}%`
        : `Exporting ${Math.round((status.progress?.fraction ?? 0) * 100)}%`
      : status.state === 'done'
        ? 'Export finished'
        : status.state === 'failed'
          ? 'Export failed'
          : 'Export cancelled';
  return (
    <button
      type="button"
      className={'cgv-export-chip' + (status.state === 'failed' ? ' cgv-export-chip-failed' : '')}
      data-testid="export-chip"
      data-state={status.state}
      onClick={onOpen}
    >
      {label}
    </button>
  );
}

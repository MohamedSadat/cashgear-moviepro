import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  audioCodecLabels,
  exportPresets,
  fitNotice,
  FLICKS_PER_SECOND,
  formatInfo,
  formatsFor,
  frameCount,
  loudnessTargets,
  probeEncoders,
  remainingLabel,
  videoCodecLabels,
  withinFreeSize,
  type EncoderSupport,
  type ProjectSettings,
} from '@cgv/engine-client';
import { Dialog } from '../project/Dialog';
import { projectEnd } from '../timeline/controller';
import { formatRate, formatTime } from '../project/format';
import type { ProjectState } from '../project/useProject';
import {
  applyFormat,
  applyPreset,
  estimateBytes,
  exportSettings,
  fitCodecs,
  formatBytes,
  frameRateOf,
  initialForm,
  usableCodecs,
  type ExportForm,
} from './form';
import type { ExportState } from './useExport';

interface Props {
  project: ProjectState;
  exporter: ExportState;
  platform: 'web' | 'desktop';
  /** The free edition: a watermark, and 1080p at most. */
  free: boolean;
  /** Opens the licence dialog. */
  onLicence(): void;
  /** Hides the dialog; a running export carries on. */
  onClose(): void;
}

const rates = [
  { num: 10, den: 1 },
  { num: 12, den: 1 },
  { num: 15, den: 1 },
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
];
const mp3Rates = [128, 192, 256, 320];

/** Export settings, then the export's progress, result or error. */
export function ExportDialog(props: Props) {
  const { project, exporter, onClose } = props;
  const status = exporter.status;
  if (status.state === 'idle' || !project.snapshot) return <ExportSettingsView {...props} />;
  const footer = (main: ReactNode) => (
    <>
      {main}
      <button type="button" onClick={onClose}>
        {status.state === 'running' ? 'Hide' : 'Close'}
      </button>
    </>
  );
  if (status.state === 'running') {
    const progress = status.progress;
    const converting = status.converting;
    const fraction = converting ?? progress?.fraction ?? 0;
    const fps = project.snapshot
      ? project.snapshot.project.settings.frameRate.num /
        project.snapshot.project.settings.frameRate.den
      : 30;
    let line = 'Opening the media…';
    if (converting !== null) line = `Converting with FFmpeg: ${Math.round(converting * 100)}%`;
    else if (progress?.phase === 'measuring')
      line = `Measuring loudness: ${Math.round(progress.fraction * 100)}%`;
    else if (progress?.phase === 'rendering')
      line = `Frame ${progress.frame.toLocaleString()} of ${progress.frames.toLocaleString()}`;
    else if (progress?.phase === 'finishing') line = 'Finishing the file…';
    return (
      <Dialog
        title={`Exporting ${status.name}`}
        onClose={onClose}
        testId="export-dialog"
        footer={footer(
          <button type="button" data-testid="export-cancel" onClick={exporter.cancel}>
            Cancel export
          </button>,
        )}
      >
        <div
          className="cgv-progress"
          role="progressbar"
          aria-label="Export progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          data-testid="export-progress"
          data-phase={converting !== null ? 'converting' : (progress?.phase ?? 'preparing')}
        >
          <div className="cgv-progress-bar" style={{ width: `${fraction * 100}%` }} />
        </div>
        <p>{line}</p>
        {progress?.phase === 'rendering' && converting === null && (
          <p className="cgv-muted">
            {remainingLabel(progress.remainingMs)}
            {progress.speed !== null && ` · ${(progress.speed / fps).toFixed(1)}× real time`}
          </p>
        )}
        <p className="cgv-muted">
          You can keep editing: the export uses the project as it was when it started.
        </p>
      </Dialog>
    );
  }
  const back = (
    <button type="button" onClick={exporter.dismiss}>
      {status.state === 'done' ? 'Export again' : 'Back'}
    </button>
  );
  if (status.state === 'done') {
    const { result } = status;
    const seconds = Math.round(result.elapsedMs / 1000);
    return (
      <Dialog
        title="Export finished"
        onClose={onClose}
        testId="export-dialog"
        footer={footer(back)}
      >
        <p data-testid="export-done">
          <strong>{status.name}</strong> is saved
          {status.location === 'Downloads' ? ' to your downloads' : ''}.
        </p>
        {status.location !== 'Downloads' && status.location !== status.name && (
          <p className="cgv-muted cgv-export-path">{status.location}</p>
        )}
        <p className="cgv-muted">
          {formatBytes(result.bytes)} · {formatTime(result.durationSeconds * FLICKS_PER_SECOND)}
          {' · '}made in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
        </p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title={status.state === 'failed' ? 'Export failed' : 'Export cancelled'}
      onClose={onClose}
      testId="export-dialog"
      footer={footer(back)}
    >
      {status.state === 'failed' ? (
        <p role="alert" data-testid="export-error">
          {status.message}
        </p>
      ) : (
        <p data-testid="export-cancelled">The export was cancelled and its file removed.</p>
      )}
    </Dialog>
  );
}

function ExportSettingsView({ project, exporter, platform, free, onLicence, onClose }: Props) {
  const snapshot = project.snapshot!;
  const settings: ProjectSettings = snapshot.project.settings;
  const [form, setForm] = useState<ExportForm>(() => initialForm(settings, free));
  const [support, setSupport] = useState<EncoderSupport | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rate = frameRateOf(form, settings);
  const fps = rate.num / rate.den;

  // What this browser encodes at this size and rate.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void probeEncoders(form.width, form.height, fps, settings.sampleRate, settings.channels).then(
        (found) => live && setSupport(found),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [form.width, form.height, fps, settings.sampleRate, settings.channels]);

  // Codecs the browser turns out not to have are swapped for ones it has.
  useEffect(() => {
    if (support) setForm((value) => fitCodecs(value, support));
  }, [support]);

  const info = formatInfo(form.format);
  const usable = usableCodecs(form.format, support);
  const result = exportSettings(form, settings);
  const duration = projectEnd(snapshot.project);
  const frames = frameCount(duration, rate);
  const notice = info.video.length ? fitNotice(settings, result) : null;
  const missing = project.missing.length;
  const update = (change: Partial<ExportForm>) => setForm((value) => ({ ...value, ...change }));
  const size = (value: string) => Math.max(0, Math.round(Number(value)) || 0);
  const tooBig = free && info.video.length > 0 && !withinFreeSize(result.width, result.height);
  const blocked =
    duration <= 0
      ? 'The timeline is empty.'
      : tooBig
        ? 'The free edition exports up to 1080p. A Pro licence allows larger sizes.'
        : info.video.length && !usable.video.includes(form.videoCodec)
          ? `This browser cannot encode ${info.label} video at this size.`
          : result.audio && !usable.audio.includes(form.audioCodec)
            ? `This browser cannot encode ${audioCodecLabels[form.audioCodec]} sound.`
            : null;

  const start = async () => {
    setStarting(true);
    setProblem(null);
    try {
      await exporter.start(result);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  };

  const presetOptions = useMemo(() => {
    const pro = (width: number, height: number) => free && !withinFreeSize(width, height);
    return [
      ...exportPresets.map((preset) => ({
        id: preset.id,
        label: `${preset.label} (${preset.width}×${preset.height})`,
        pro: pro(preset.width, preset.height),
      })),
      {
        id: 'project',
        label: `Project size (${settings.width}×${settings.height})`,
        pro: pro(settings.width, settings.height),
      },
      { id: 'custom', label: 'Custom', pro: false },
    ];
  }, [free, settings.width, settings.height]);

  return (
    <Dialog
      title="Export video"
      onClose={onClose}
      testId="export-dialog"
      wide
      footer={
        <>
          <button
            type="button"
            className="cgv-primary"
            data-testid="export-start"
            disabled={!!blocked || starting}
            onClick={() => void start()}
          >
            {platform === 'desktop' || 'showSaveFilePicker' in window ? 'Export…' : 'Export'}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="cgv-form">
        <div className="cgv-form-row">
          <label>
            Format
            <select
              data-testid="export-format"
              value={form.format}
              onChange={(event) =>
                setForm(
                  applyFormat(form, event.target.value as ExportForm['format'], settings, support),
                )
              }
            >
              {formatsFor(platform).map((format) => (
                <option key={format.id} value={format.id}>
                  {format.label}
                </option>
              ))}
            </select>
          </label>
          {info.video.length > 0 && form.format !== 'gif' && (
            <label>
              Preset
              <select
                data-testid="export-preset"
                value={form.preset}
                onChange={(event) => setForm(applyPreset(form, event.target.value, settings))}
              >
                {presetOptions.map((option) => (
                  <option key={option.id} value={option.id} disabled={option.pro}>
                    {option.label}
                    {option.pro ? ' (Pro)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {info.video.length > 0 && (
          <>
            <div className="cgv-form-row">
              <label>
                Width
                <input
                  type="number"
                  min={16}
                  max={8192}
                  step={2}
                  data-testid="export-width"
                  value={form.width}
                  onChange={(event) =>
                    update({ width: size(event.target.value), preset: 'custom' })
                  }
                />
              </label>
              <label>
                Height
                <input
                  type="number"
                  min={16}
                  max={8192}
                  step={2}
                  data-testid="export-height"
                  value={form.height}
                  onChange={(event) =>
                    update({ height: size(event.target.value), preset: 'custom' })
                  }
                />
              </label>
            </div>
            <div className="cgv-form-row">
              <label>
                Frame rate
                <select
                  data-testid="export-rate"
                  value={form.rate}
                  onChange={(event) => update({ rate: event.target.value })}
                >
                  <option value="project">Project ({formatRate(settings.frameRate)} fps)</option>
                  {rates.map((option) => (
                    <option
                      key={`${option.num}/${option.den}`}
                      value={`${option.num}/${option.den}`}
                    >
                      {formatRate(option)} fps
                    </option>
                  ))}
                </select>
              </label>
              {form.format !== 'gif' && (
                <label>
                  Video codec
                  <select
                    data-testid="export-codec"
                    value={form.videoCodec}
                    onChange={(event) =>
                      update({ videoCodec: event.target.value as ExportForm['videoCodec'] })
                    }
                  >
                    {info.video.map((codec) => (
                      <option key={codec} value={codec} disabled={!usable.video.includes(codec)}>
                        {videoCodecLabels[codec]}
                        {support && !support.video[codec] ? ' (not available)' : ''}
                        {support?.video[codec] === 'hardware' ? ' (hardware)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {form.format !== 'gif' && (
              <div className="cgv-form-row">
                <label>
                  Quality
                  <select
                    data-testid="export-quality"
                    value={form.quality}
                    onChange={(event) =>
                      update({ quality: event.target.value as ExportForm['quality'] })
                    }
                  >
                    {exportPresets.some((preset) => preset.id === form.preset) && (
                      <option value="recommended">Recommended for the preset</option>
                    )}
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                    <option value="custom">Custom bitrate</option>
                  </select>
                </label>
                {form.quality === 'custom' ? (
                  <label>
                    Bitrate (Mbit/s)
                    <input
                      type="number"
                      min={0.1}
                      max={400}
                      step={0.5}
                      data-testid="export-bitrate"
                      value={form.bitrateMbps}
                      onChange={(event) => update({ bitrateMbps: Number(event.target.value) || 0 })}
                    />
                  </label>
                ) : (
                  <span className="cgv-form-note">
                    {((result.video?.bitrate ?? 0) / 1e6).toFixed(1)} Mbit/s
                  </span>
                )}
              </div>
            )}
          </>
        )}
        {info.audio.length > 0 && (
          <div className="cgv-form-row">
            {info.video.length > 0 ? (
              <label className="cgv-check">
                <input
                  type="checkbox"
                  data-testid="export-audio"
                  checked={form.audio}
                  onChange={(event) => update({ audio: event.target.checked })}
                />
                Sound
              </label>
            ) : (
              <span />
            )}
            {form.format === 'mp3' ? (
              <label>
                Bitrate
                <select
                  value={form.mp3Kbps}
                  onChange={(event) => update({ mp3Kbps: Number(event.target.value) })}
                >
                  {mp3Rates.map((kbps) => (
                    <option key={kbps} value={kbps}>
                      {kbps} kbit/s
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              info.audio.length > 1 &&
              form.audio && (
                <label>
                  Sound codec
                  <select
                    data-testid="export-audio-codec"
                    value={form.audioCodec}
                    onChange={(event) =>
                      update({ audioCodec: event.target.value as ExportForm['audioCodec'] })
                    }
                  >
                    {info.audio.map((codec) => (
                      <option key={codec} value={codec} disabled={!usable.audio.includes(codec)}>
                        {audioCodecLabels[codec]}
                        {support && !support.audio[codec] ? ' (not available)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )
            )}
          </div>
        )}
        {result.audio && (
          <div className="cgv-form-row">
            <label>
              Loudness
              <select
                data-testid="export-loudness"
                value={String(form.loudness)}
                onChange={(event) =>
                  update({
                    loudness: event.target.value === 'off' ? 'off' : Number(event.target.value),
                  })
                }
              >
                {loudnessTargets.map((target) => (
                  <option key={target.value} value={target.value}>
                    {target.label}
                  </option>
                ))}
                <option value="off">Off: keep the mix as it is</option>
              </select>
            </label>
            {form.loudness !== 'off' && (
              <span className="cgv-form-note">Peaks stay under -1 dBTP</span>
            )}
          </div>
        )}
        {notice && <p className="cgv-form-note">{notice}</p>}
        {free && info.video.length > 0 && (
          <p className="cgv-form-note" data-testid="export-watermark">
            Free edition: the video carries a small CashGear Video watermark and stops at 1080p.{' '}
            <button type="button" className="cgv-inline-button" onClick={onLicence}>
              Licence…
            </button>
          </p>
        )}
        {missing > 0 && (
          <p className="cgv-form-note cgv-warning">
            {missing === 1 ? 'One file is' : `${missing} files are`} missing: their clips export as
            black and silent.
          </p>
        )}
        {form.format === 'gif' && (
          <p className="cgv-form-note">GIFs have no sound. FFmpeg makes them after the export.</p>
        )}
        <p className="cgv-muted" data-testid="export-summary">
          {formatTime(duration)}
          {info.video.length > 0 && ` · ${frames.toLocaleString()} frames`}
          {form.format !== 'gif' &&
            ` · about ${formatBytes(estimateBytes(result, settings, duration / FLICKS_PER_SECOND))}`}
        </p>
        {(blocked || problem) && (
          <p role="alert" className="cgv-warning" data-testid="export-problem">
            {problem ?? blocked}
          </p>
        )}
      </div>
    </Dialog>
  );
}

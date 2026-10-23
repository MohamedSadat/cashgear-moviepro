import { useState } from 'react';
import type { FrameRate, ProjectSettings } from '@cgv/engine-client';
import { Dialog } from './Dialog';
import { formatRate, formatTime, formatWhen } from './format';
import type { ProjectState } from './useProject';

/** The project list: open, delete (web) or forget (desktop), and open a file. */
export function ProjectsDialog({ project, onClose }: { project: ProjectState; onClose(): void }) {
  const close = (run: () => Promise<void>) => () => {
    onClose();
    void run();
  };
  return (
    <Dialog
      title="Projects"
      onClose={onClose}
      testId="projects-dialog"
      wide
      footer={
        <>
          <button type="button" onClick={close(project.openFile)}>
            {project.savesInPlace ? 'Import file…' : 'Open file…'}
          </button>
          <button type="button" onClick={close(project.newProject)}>
            New project
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {project.entries.length === 0 ? (
        <p className="cgv-muted">No projects yet.</p>
      ) : (
        <ul className="cgv-project-list">
          {project.entries.map((entry) => {
            const open = entry.id === project.entry?.id;
            return (
              <li key={entry.id} data-testid="project-entry" data-project-id={entry.id}>
                <div className="cgv-project-list-text">
                  <strong>{entry.name}</strong>
                  <span className="cgv-muted">
                    {entry.path ??
                      (entry.savedAt ? `Saved ${formatWhen(entry.savedAt)}` : 'Not saved yet')}
                  </span>
                </div>
                <button type="button" disabled={open} onClick={close(() => project.open(entry))}>
                  {open ? 'Open now' : 'Open'}
                </button>
                <button
                  type="button"
                  disabled={open}
                  aria-label={`${project.savesInPlace ? 'Delete' : 'Forget'} ${entry.name}`}
                  onClick={() => void project.remove(entry)}
                >
                  {project.savesInPlace ? 'Delete' : 'Forget'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

const rates: FrameRate[] = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 48, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
  { num: 120, den: 1 },
];

/** Resolution, frame rate and audio format. */
export function SettingsDialog({ project, onClose }: { project: ProjectState; onClose(): void }) {
  const current = project.snapshot!.project.settings;
  const [settings, setSettings] = useState<ProjectSettings>(current);
  const preset = project.presets.find(
    (candidate) => candidate.width === settings.width && candidate.height === settings.height,
  );
  const update = (change: Partial<ProjectSettings>) =>
    setSettings((value) => ({ ...value, ...change }));
  const size = (value: string) => Math.max(0, Math.round(Number(value)) || 0);
  return (
    <Dialog
      title="Project settings"
      onClose={onClose}
      testId="settings-dialog"
      footer={
        <>
          <button
            type="button"
            onClick={() => {
              onClose();
              void project.setSettings(settings);
            }}
          >
            Apply
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="cgv-form">
        <label>
          Format
          <select
            value={preset?.id ?? 'custom'}
            onChange={(event) => {
              const chosen = project.presets.find(
                (candidate) => candidate.id === event.target.value,
              );
              if (chosen) update({ width: chosen.width, height: chosen.height });
            }}
          >
            {project.presets.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label} ({candidate.width}×{candidate.height})
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </label>
        <div className="cgv-form-row">
          <label>
            Width
            <input
              type="number"
              min={16}
              max={8192}
              step={2}
              value={settings.width}
              onChange={(event) => update({ width: size(event.target.value) })}
            />
          </label>
          <label>
            Height
            <input
              type="number"
              min={16}
              max={8192}
              step={2}
              value={settings.height}
              onChange={(event) => update({ height: size(event.target.value) })}
            />
          </label>
        </div>
        <label>
          Frame rate
          <select
            value={`${settings.frameRate.num}/${settings.frameRate.den}`}
            onChange={(event) => {
              const [num, den] = event.target.value.split('/').map(Number);
              update({ frameRate: { num, den } });
            }}
          >
            {rates.map((rate) => (
              <option key={`${rate.num}/${rate.den}`} value={`${rate.num}/${rate.den}`}>
                {formatRate(rate)} fps
              </option>
            ))}
          </select>
        </label>
        <div className="cgv-form-row">
          <label>
            Sample rate
            <select
              value={settings.sampleRate}
              onChange={(event) => update({ sampleRate: Number(event.target.value) })}
            >
              <option value={48000}>48 kHz</option>
              <option value={44100}>44.1 kHz</option>
            </select>
          </label>
          <label>
            Channels
            <select
              value={settings.channels}
              onChange={(event) => update({ channels: Number(event.target.value) })}
            >
              <option value={2}>Stereo</option>
              <option value={1}>Mono</option>
            </select>
          </label>
        </div>
        <p className="cgv-muted">Clips keep their place when the frame rate changes.</p>
      </div>
    </Dialog>
  );
}

/** Offered when a project has an autosave newer than its saved file. */
export function RecoveryDialog({ project }: { project: ProjectState }) {
  const prompt = project.recovery!;
  const when = formatWhen(prompt.modified);
  return (
    <Dialog
      title="Recover unsaved changes?"
      testId="recovery-dialog"
      footer={
        <>
          <button type="button" onClick={() => void project.recover('recover')}>
            Recover
          </button>
          <button type="button" onClick={() => void project.recover('discard')}>
            {prompt.unsaved ? 'Delete' : 'Discard'}
          </button>
        </>
      }
    >
      <p>
        <strong>{prompt.name}</strong> has changes that were not saved
        {when ? `, autosaved ${when}` : ''}. CashGear Video may have closed unexpectedly.
      </p>
      <p className="cgv-muted">
        {prompt.unsaved
          ? 'This project was never saved: deleting the autosave deletes the project.'
          : 'Discarding opens the last saved version.'}
      </p>
    </Dialog>
  );
}

/** Lists media whose files are missing and finds them again. */
export function RelinkDialog({ project }: { project: ProjectState }) {
  return (
    <Dialog
      title="Missing media"
      onClose={() => project.showRelink(false)}
      testId="relink-dialog"
      wide
      footer={
        <>
          {project.canSearchFolder && (
            <button type="button" onClick={() => void project.searchFolder()}>
              Search a folder…
            </button>
          )}
          <button type="button" onClick={() => project.showRelink(false)}>
            Later
          </button>
        </>
      }
    >
      <p>
        These files could not be found. Clips that use them stay in place and show as offline until
        you locate them.
      </p>
      <ul className="cgv-relink-list">
        {project.missing.map((media) => (
          <li key={media.id} data-testid="missing-media" data-media-id={media.id}>
            <div className="cgv-project-list-text">
              <strong>{media.name}</strong>
              <span className="cgv-muted">
                {[
                  media.kind,
                  media.kind !== 'image' && formatTime(media.duration),
                  `${Math.max(1, Math.round(media.size / 1024))} KB`,
                  media.location.kind === 'path' && media.location.path,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void project.locate(media)}
              aria-label={`Locate ${media.name}`}
            >
              Locate…
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

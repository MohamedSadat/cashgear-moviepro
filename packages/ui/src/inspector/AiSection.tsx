import { CgButton, CgNumericEdit } from '@cashgear/ui';
import type { Clip } from '@cgv/engine-client';
import { beatTimes, soundClipOf, tempoOf } from '../ai/timing';
import type { AiJob, AiToolsState } from '../ai/useAiTools';
import type { EditorState } from '../editing/useEditor';
import { Section } from './AnimatedField';

/** A running AI job: what it does, how far it is, and its cancel button. */
export function AiJobRow({ job }: { job: AiJob }) {
  return (
    <div className="cgv-ai-job" data-testid="ai-job" role="status">
      <span>{job.label}</span>
      <div
        className="cgv-progress"
        role="progressbar"
        aria-label={job.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.progress === null ? undefined : Math.round(job.progress * 100)}
      >
        <div className="cgv-progress-bar" style={{ width: `${(job.progress ?? 0) * 100}%` }} />
      </div>
      <CgButton appearance="ghost" size="small" onClick={job.cancel}>
        Cancel
      </CgButton>
    </div>
  );
}

/**
 * The AI tools for the selected clip: cutting silences out as jump cuts, and
 * marking beats for cuts to snap to. Each runs in the AI worker and undoes as
 * one step.
 */
export function AiSection({
  editor,
  ai,
  clip,
  disabled,
}: {
  editor: EditorState;
  ai: AiToolsState;
  clip: Clip;
  disabled: boolean;
}) {
  const project = editor.project.snapshot?.project;
  const sound = project ? soundClipOf(project, clip.id) : null;
  const moving =
    clip.video && project?.media.find((media) => media.id === clip.media)?.kind === 'video';
  const beats = sound ? beatTimes(sound) : [];
  const tempo = tempoOf(beats);
  const settings = ai.silenceSettings;
  const set = (patch: Partial<typeof settings>) => ai.setSilenceSettings({ ...settings, ...patch });
  return (
    <Section title="AI tools">
      {ai.jobs.map((job) => (
        <AiJobRow key={job.id} job={job} />
      ))}
      {moving && (
        <>
          <h4 className="cgv-subhead">Scenes</h4>
          <p className="cgv-muted">Split the clip wherever its picture cuts to a new shot.</p>
          <CgButton
            size="small"
            data-testid="split-scenes"
            disabled={disabled}
            onClick={() => void ai.splitScenes(clip.id)}
          >
            Split at scene changes
          </CgButton>
        </>
      )}
      {sound && (
        <>
          <h4 className="cgv-subhead">Silences</h4>
          <label className="cgv-check-row">
            <input
              type="checkbox"
              data-testid="silence-auto"
              checked={settings.thresholdDb === null}
              onChange={(event) => set({ thresholdDb: event.currentTarget.checked ? null : -40 })}
            />
            Find the threshold from the recording
          </label>
          {settings.thresholdDb !== null && (
            <label className="cgv-field" data-testid="silence-threshold">
              <span className="cgv-field-label">Quieter than</span>
              <CgNumericEdit
                size="small"
                aria-label="Silence threshold"
                value={settings.thresholdDb}
                min={-80}
                max={-10}
                step={1}
                precision={0}
                commitMode="blur"
                suffix="dB"
                onValueChange={(value) => {
                  if (value !== null) set({ thresholdDb: value });
                }}
              />
            </label>
          )}
          <label className="cgv-field" data-testid="silence-min-length">
            <span className="cgv-field-label">At least</span>
            <CgNumericEdit
              size="small"
              aria-label="Shortest silence"
              value={settings.minLength}
              min={0.1}
              max={10}
              step={0.1}
              precision={2}
              commitMode="blur"
              suffix="s"
              onValueChange={(value) => {
                if (value !== null) set({ minLength: value });
              }}
            />
          </label>
          <label className="cgv-field" data-testid="silence-padding">
            <span className="cgv-field-label">Keep</span>
            <CgNumericEdit
              size="small"
              aria-label="Quiet kept beside the sound"
              value={settings.padding}
              min={0}
              max={2}
              step={0.05}
              precision={2}
              commitMode="blur"
              suffix="s"
              onValueChange={(value) => {
                if (value !== null) set({ padding: value });
              }}
            />
          </label>
          <CgButton
            size="small"
            data-testid="remove-silences"
            disabled={disabled}
            onClick={() => void ai.removeSilences(clip.id)}
          >
            Remove silences
          </CgButton>
          <h4 className="cgv-subhead">Beats</h4>
          <p className="cgv-muted" data-testid="beat-summary">
            {beats.length
              ? `${beats.length} beats${tempo ? ` at ${Math.round(tempo)} BPM` : ''}; cuts snap to them.`
              : 'Mark the beats of the sound for cuts to snap to.'}
          </p>
          <div className="cgv-inspector-row">
            <CgButton
              size="small"
              data-testid="detect-beats"
              disabled={disabled}
              onClick={() => void ai.detectBeats(clip.id)}
            >
              Detect beats
            </CgButton>
            {!!sound.beats?.length && (
              <CgButton
                appearance="ghost"
                size="small"
                data-testid="clear-beats"
                disabled={disabled}
                onClick={() => void ai.clearBeats(clip.id)}
              >
                Clear beats
              </CgButton>
            )}
          </div>
        </>
      )}
      {!sound && !moving && !ai.jobs.length && (
        <p className="cgv-muted">The AI tools work on video and sound clips.</p>
      )}
    </Section>
  );
}

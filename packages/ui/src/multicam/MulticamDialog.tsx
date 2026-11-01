import { useMemo, useState } from 'react';
import { CgButton } from '@cashgear/ui';
import { FLICKS_PER_SECOND, type Clip } from '@cgv/engine-client';
import type { AiToolsState } from '../ai/useAiTools';
import type { EditorState } from '../editing/useEditor';
import { Dialog } from '../project/Dialog';
import { findClip } from '../timeline/controller';

type SyncBy = 'sound' | 'timecode' | 'in';

/** Sound sync looks at this much of each clip, from its in point. */
const syncSeconds = 300;
/** Below this the sound of two angles hardly matches: the user hears about it. */
const unsure = 0.1;

const choices: { value: SyncBy; label: string; note: string }[] = [
  {
    value: 'sound',
    label: 'Sound',
    note: 'Matches what the cameras heard, to a fraction of a frame. It looks at the first five minutes of each clip.',
  },
  {
    value: 'timecode',
    label: 'Timecode',
    note: 'Lines up the start timecodes the files carry, for cameras that share a clock.',
  },
  { value: 'in', label: 'In points', note: 'Lines up the first frame each clip shows.' },
];

/** The clips to make angles of, in order: a bottom track first; video clips only. */
export function angleClips(editor: EditorState): Clip[] {
  const current = editor.project.snapshot?.project;
  if (!current) return [];
  return editor.selection
    .flatMap((id) => {
      const found = findClip(current, id);
      return found ? [found] : [];
    })
    .filter(({ clip }) => (clip.kind ?? 'media') === 'media' && clip.video)
    .sort((a, b) => a.index - b.index || a.clip.start - b.clip.start)
    .map(({ clip }) => clip);
}

/**
 * Makes a multicam clip of the selected clips: each becomes an angle, synced by
 * their sound, their timecode or their in points.
 */
export function MulticamDialog({
  editor,
  ai,
  onClose,
}: {
  editor: EditorState;
  ai: AiToolsState;
  onClose(): void;
}) {
  const project = editor.project;
  const clips = useMemo(() => angleClips(editor), [editor]);
  const media = project.snapshot?.project.media ?? [];
  const nameOf = (clip: Clip) => media.find((item) => item.id === clip.media)?.name ?? clip.media;
  const [syncBy, setSyncBy] = useState<SyncBy>('sound');
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** The media time, in flicks, of one moment in each clip's media; null if it can't be found. */
  const syncPoints = async (): Promise<number[] | null> => {
    if (syncBy === 'in') return clips.map((clip) => clip.sourceIn);
    const sources = clips.map((clip) => project.library.source(clip.media));
    const missing = clips.find((_, index) => !sources[index]);
    if (missing) {
      setProblem(`${nameOf(missing)} has no file to read.`);
      return null;
    }
    if (syncBy === 'timecode') {
      const codes = await Promise.all(sources.map((source) => ai.client().timecode(source!)));
      const lacking = clips.find((_, index) => !codes[index]);
      if (lacking) {
        setProblem(`${nameOf(lacking)} has no timecode. Sync by sound or by in points instead.`);
        return null;
      }
      // The moment every camera's clock has reached.
      const latest = Math.max(...codes.map((code) => code!.seconds));
      return codes.map((code) => Math.round((latest - code!.seconds) * FLICKS_PER_SECOND));
    }
    const stretches = clips.map((clip, index) => ({
      source: sources[index]!,
      start: clip.sourceIn / FLICKS_PER_SECOND,
      end: (clip.sourceIn + clip.duration) / FLICKS_PER_SECOND,
    }));
    const results = await ai.run('Syncing angles by their sound', (signal, progress) =>
      ai.client().syncSound(stretches, syncSeconds, progress, signal),
    );
    if (!results) return null;
    const silent = clips.find((_, index) => !results[index]);
    if (silent) {
      setProblem(`${nameOf(silent)} has no sound to sync by. Try timecode or in points.`);
      return null;
    }
    const doubtful = clips.find((_, index) => results[index]!.confidence < unsure);
    if (doubtful)
      project.notice(
        `The sound of ${nameOf(doubtful)} hardly matches the first angle's: check it.`,
      );
    return results.map(
      (result) => clips[0].sourceIn + Math.round(result!.offset * FLICKS_PER_SECOND),
    );
  };

  const make = async () => {
    setWorking(true);
    setProblem(null);
    try {
      const sync = await syncPoints();
      if (!sync) return;
      const outcome = await project.execute({
        type: 'makeMulticam',
        clips: clips.map((clip) => clip.id),
        sync,
      });
      if (outcome) {
        editor.select([outcome.created[0]]);
        onClose();
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog
      title="Make multicam clip"
      onClose={onClose}
      testId="multicam-dialog"
      footer={
        <>
          <CgButton appearance="ghost" onClick={onClose}>
            Cancel
          </CgButton>
          <CgButton
            appearance="solid"
            disabled={working || clips.length < 2 || clips.length > 4}
            data-testid="multicam-make"
            onClick={() => void make()}
          >
            {working ? 'Syncing…' : 'Make multicam clip'}
          </CgButton>
        </>
      }
    >
      <ol className="cgv-multicam-angles">
        {clips.map((clip, index) => (
          <li key={clip.id}>
            Angle {index + 1}: {nameOf(clip)}
          </li>
        ))}
      </ol>
      <label className="cgv-field">
        <span className="cgv-field-label">Sync by</span>
        <select
          data-testid="multicam-sync"
          value={syncBy}
          disabled={working}
          onChange={(event) => setSyncBy(event.currentTarget.value as SyncBy)}
        >
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <p className="cgv-muted">{choices.find((choice) => choice.value === syncBy)?.note}</p>
      {problem && (
        <p role="alert" className="cgv-dialog-error" data-testid="multicam-problem">
          {problem}
        </p>
      )}
    </Dialog>
  );
}

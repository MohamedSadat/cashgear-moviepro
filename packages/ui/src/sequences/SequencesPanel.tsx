import { useState } from 'react';
import { FLICKS_PER_SECOND, type SequenceInfo } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { formatTime } from '../project/format';
import { frameDuration } from '../timeline/geometry';

/** An empty sequence goes on the timeline this long, to fill later. */
const emptySeconds = 5;

/**
 * The project's sequences: make one, open one in the timeline, put one on the
 * timeline at the playhead as a sequence clip, rename or delete one. Nesting
 * clips (the timeline's menu) makes them too.
 */
export function SequencesPanel({ editor }: { editor: EditorState }) {
  const project = editor.project;
  const current = project.snapshot?.project ?? null;
  const [renaming, setRenaming] = useState<number | null>(null);
  const sequences = current?.sequences ?? [];
  const open = current?.openSequence ?? null;

  const add = async () => {
    const outcome = await project.execute({
      type: 'addSequence',
      name: `Sequence ${sequences.length + 1}`,
    });
    if (outcome) setRenaming(outcome.created[0]);
  };
  const place = (sequence: SequenceInfo) => {
    if (!current) return;
    const frame = frameDuration(current.settings.frameRate);
    const length = sequence.duration || emptySeconds * FLICKS_PER_SECOND;
    void project.execute({
      type: 'insert',
      track: current.mainTrack,
      at: editor.playhead(),
      clip: {
        kind: 'sequence',
        sequence: sequence.id,
        duration: Math.max(frame, Math.round(length / frame) * frame),
      },
    });
  };
  const rename = (sequence: SequenceInfo, name: string) => {
    setRenaming(null);
    if (name.trim() && name.trim() !== sequence.name)
      void project.execute({ type: 'renameSequence', sequence: sequence.id, name });
  };

  return (
    <section className="cgv-library" data-testid="sequences" aria-label="Sequences">
      <header className="cgv-library-header">
        <h2>Sequences</h2>
        <button type="button" onClick={() => void add()} disabled={!current}>
          New sequence
        </button>
      </header>
      {sequences.length === 0 ? (
        <p className="cgv-library-empty">
          Make one here, or select clips on the timeline and choose Nest from their menu.
        </p>
      ) : (
        <ul className="cgv-library-items">
          {sequences.map((sequence) => (
            <li
              key={sequence.id}
              className={'cgv-sequence-item' + (sequence.id === open ? ' cgv-sequence-open' : '')}
              data-testid="sequence-item"
              data-sequence-id={sequence.id}
              data-name={sequence.name}
            >
              {renaming === sequence.id ? (
                <input
                  className="cgv-track-name-input"
                  aria-label={`Name of ${sequence.name}`}
                  defaultValue={sequence.name}
                  autoFocus
                  maxLength={200}
                  onBlur={(event) => rename(sequence, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') rename(sequence, event.currentTarget.value);
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <p
                  className="cgv-media-name"
                  title="Double-click to rename"
                  onDoubleClick={() => setRenaming(sequence.id)}
                >
                  {sequence.name}
                </p>
              )}
              <p className="cgv-media-meta">
                {formatTime(sequence.duration)} · {sequence.tracks} track
                {sequence.tracks === 1 ? '' : 's'}
              </p>
              <div className="cgv-sequence-actions">
                <button
                  type="button"
                  onClick={() => void editor.openSequence(sequence.id)}
                  disabled={sequence.id === open}
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => place(sequence)}
                  disabled={sequence.id === open || editor.path.includes(sequence.id)}
                >
                  Add at playhead
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void project.execute({ type: 'removeSequence', sequence: sequence.id })
                  }
                  disabled={editor.path.includes(sequence.id)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

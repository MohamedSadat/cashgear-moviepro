import type { MediaColour } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { Section } from './AnimatedField';

const matrices = [
  { value: 'bt601', label: 'BT.601' },
  { value: 'bt709', label: 'BT.709' },
  { value: 'bt2020', label: 'BT.2020' },
];
const ranges = [
  { value: 'limited', label: 'Limited' },
  { value: 'full', label: 'Full' },
];
const transfers = [
  { value: 'sdr', label: 'SDR' },
  { value: 'pq', label: 'PQ' },
  { value: 'hlg', label: 'HLG' },
];

/**
 * How a video file's colour is read, for files whose tags are wrong or missing. It
 * belongs to the file, so every clip of the file changes with it.
 */
export function FileColourSection({ editor, media }: { editor: EditorState; media: string }) {
  const colour = editor.project.snapshot?.project.mediaColour?.[media] ?? {};
  const set = (change: MediaColour) => {
    const next = { ...colour, ...change };
    void editor.project.execute({
      type: 'setMediaColour',
      media,
      colour: Object.values(next).some((value) => value !== undefined) ? next : null,
    });
  };
  const select = (
    label: string,
    value: string | undefined,
    options: { value: string; label: string }[],
    change: (value: string | undefined) => void,
  ) => (
    <label className="cgv-field" data-testid={`file-colour-${label.toLowerCase()}`}>
      <span className="cgv-field-label">{label}</span>
      <select
        aria-label={`File colour ${label.toLowerCase()}`}
        value={value ?? ''}
        onChange={(event) => change(event.currentTarget.value || undefined)}
      >
        <option value="">From the file</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
  const range = colour.fullRange === undefined ? undefined : colour.fullRange ? 'full' : 'limited';
  return (
    <Section title="File colour">
      {select('Matrix', colour.matrix, matrices, (matrix) =>
        set({ matrix: matrix as MediaColour['matrix'] }),
      )}
      {select('Range', range, ranges, (value) =>
        set({ fullRange: value === undefined ? undefined : value === 'full' }),
      )}
      {select('Transfer', colour.transfer, transfers, (transfer) =>
        set({ transfer: transfer as MediaColour['transfer'] }),
      )}
    </Section>
  );
}

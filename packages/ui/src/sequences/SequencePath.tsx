import type { EditorState } from '../editing/useEditor';

/**
 * Where the timeline is: the main timeline, then each sequence opened inside the
 * one before. Each one back is a button that returns to it.
 */
export function SequencePath({
  editor,
  names,
}: {
  editor: EditorState;
  names: Map<number, string>;
}) {
  const crumbs: { id: number | null; name: string }[] = [
    { id: null, name: 'Main timeline' },
    ...editor.path.map((id) => ({ id, name: names.get(id) ?? 'Sequence' })),
  ];
  return (
    <nav className="cgv-sequence-path" aria-label="Open sequence" data-testid="sequence-path">
      {crumbs.map((crumb, index) => (
        <span key={crumb.id ?? 'main'} className="cgv-sequence-crumb">
          {index > 0 && (
            <span className="cgv-muted" aria-hidden="true">
              ›
            </span>
          )}
          {index === crumbs.length - 1 ? (
            <strong aria-current="location">{crumb.name}</strong>
          ) : (
            <button type="button" onClick={() => void editor.openSequence(crumb.id)}>
              {crumb.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

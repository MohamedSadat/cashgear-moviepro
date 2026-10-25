import { useMemo, useState } from 'react';
import type { EditorState } from '../editing/useEditor';
import { draggedEffect, effectDragType } from '../effects/dragging';
import { shapes, templates, type TitleTemplate } from './templates';

function startDrag(event: React.DragEvent, template: TitleTemplate) {
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(effectDragType, `title:${template.id}`);
  draggedEffect.current = { kind: 'title', template };
}

function endDrag() {
  draggedEffect.current = null;
}

/** Every template and shape, in the order the browser lists them. */
export const titleItems: TitleTemplate[] = [...templates, ...shapes];

/**
 * Title templates and shapes, by category, each previewed by the engine. Drag
 * one onto the timeline, or double-click it to add it at the playhead.
 */
export function TitlesBrowser({
  editor,
  previews,
}: {
  editor: EditorState;
  previews: Record<string, string>;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const words = query.trim().toLowerCase();
    const matching = words
      ? titleItems.filter((item) =>
          [
            item.name,
            item.category,
            ...item.title.elements.map((e) => (e.type === 'text' ? e.text : '')),
          ]
            .join(' ')
            .toLowerCase()
            .includes(words),
        )
      : titleItems;
    const byCategory = new Map<string, TitleTemplate[]>();
    for (const item of matching) {
      const list = byCategory.get(item.category) ?? [];
      list.push(item);
      byCategory.set(item.category, list);
    }
    return [...byCategory];
  }, [query]);
  const add = (template: TitleTemplate) => void editor.addTitle(template);
  return (
    <section className="cgv-effects" data-testid="title-browser" aria-label="Titles">
      <input
        className="cgv-effects-search"
        type="search"
        placeholder="Search titles"
        aria-label="Search titles"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {groups.map(([category, list]) => (
        <div key={category} className="cgv-effects-group">
          <h3>{category}</h3>
          <ul className="cgv-effects-grid">
            {list.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="cgv-effect-item"
                  draggable
                  data-testid="title-item"
                  data-key={item.id}
                  title={`${item.name}. Drag onto the timeline, or double-click to add it at the playhead.`}
                  onDragStart={(event) => startDrag(event, item)}
                  onDragEnd={endDrag}
                  onDoubleClick={() => add(item)}
                  onKeyDown={(event) => event.key === 'Enter' && add(item)}
                >
                  {previews[item.id] ? (
                    <img className="cgv-effect-thumb" src={previews[item.id]} alt="" />
                  ) : (
                    <span className="cgv-effect-thumb" aria-hidden />
                  )}
                  <span className="cgv-effect-name">{item.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!groups.length && <p className="cgv-muted">Nothing matches.</p>}
    </section>
  );
}

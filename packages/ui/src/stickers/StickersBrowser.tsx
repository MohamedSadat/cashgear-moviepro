import { useMemo, useState } from 'react';
import type { EditorState } from '../editing/useEditor';
import { draggedEffect, effectDragType } from '../effects/dragging';
import { stickers, type Sticker } from './catalog';

function startDrag(event: React.DragEvent, sticker: Sticker) {
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(effectDragType, `sticker:${sticker.id}`);
  draggedEffect.current = { kind: 'sticker', sticker };
}

function endDrag() {
  draggedEffect.current = null;
}

/**
 * The built-in stickers, by category, each playing in its tile. Drag one onto the
 * timeline, or double-click it to add it at the playhead.
 */
export function StickersBrowser({ editor }: { editor: EditorState }) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const words = query.trim().toLowerCase();
    const matching = words
      ? stickers.filter((s) => `${s.name} ${s.category}`.toLowerCase().includes(words))
      : stickers;
    const byCategory = new Map<string, Sticker[]>();
    for (const sticker of matching) {
      const list = byCategory.get(sticker.category) ?? [];
      list.push(sticker);
      byCategory.set(sticker.category, list);
    }
    return [...byCategory];
  }, [query]);
  const add = (sticker: Sticker) => void editor.addSticker(sticker);
  return (
    <section className="cgv-effects" data-testid="sticker-browser" aria-label="Stickers">
      <input
        className="cgv-effects-search"
        type="search"
        placeholder="Search stickers"
        aria-label="Search stickers"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {groups.map(([category, list]) => (
        <div key={category} className="cgv-effects-group">
          <h3>{category}</h3>
          <ul className="cgv-sticker-grid">
            {list.map((sticker) => (
              <li key={sticker.id}>
                <button
                  type="button"
                  className="cgv-sticker"
                  draggable
                  data-testid="sticker-item"
                  data-key={sticker.id}
                  title={`${sticker.name}. Drag onto the timeline, or double-click to add it at the playhead.`}
                  onDragStart={(event) => startDrag(event, sticker)}
                  onDragEnd={endDrag}
                  onDoubleClick={() => add(sticker)}
                  onKeyDown={(event) => event.key === 'Enter' && add(sticker)}
                >
                  <img src={sticker.url} alt={sticker.name} loading="lazy" draggable={false} />
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

import { useMemo, useState } from 'react';
import type { EditorState } from '../editing/useEditor';
import type { CatalogItem } from './catalog';
import { draggedEffect, effectDragType, type DraggedEffect } from './dragging';

interface Props {
  kind: 'effect' | 'transition';
  editor: EditorState;
  previews: Record<string, string>;
}

function startDrag(event: React.DragEvent, dragged: DraggedEffect) {
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(
    effectDragType,
    dragged.kind === 'item' ? dragged.item.key : 'adjustment',
  );
  draggedEffect.current = dragged;
}

function endDrag() {
  draggedEffect.current = null;
}

/**
 * Effects or transitions, by category, each previewed by the engine. Drag one
 * onto a clip (an effect) or a cut (a transition), or double-click it to apply
 * it to the selected clips or the cut nearest the playhead.
 */
export function EffectsBrowser({ kind, editor, previews }: Props) {
  const [query, setQuery] = useState('');
  const catalog = editor.catalog;
  const items = useMemo(() => {
    const all = kind === 'effect' ? (catalog?.effects ?? []) : (catalog?.transitions ?? []);
    const words = query.trim().toLowerCase();
    return words
      ? all.filter((item) =>
          `${item.name} ${item.entry.category} ${item.entry.name}`.toLowerCase().includes(words),
        )
      : all;
  }, [catalog, kind, query]);
  const groups = useMemo(() => {
    const byCategory = new Map<string, CatalogItem[]>();
    for (const item of items) {
      const list = byCategory.get(item.entry.category) ?? [];
      list.push(item);
      byCategory.set(item.entry.category, list);
    }
    return [...byCategory];
  }, [items]);
  const apply = (item: CatalogItem) =>
    void (kind === 'effect' ? editor.applyEffect(item) : editor.applyTransition(item));
  const label = kind === 'effect' ? 'Effects' : 'Transitions';
  return (
    <section className="cgv-effects" data-testid={`${kind}-browser`} aria-label={label}>
      <input
        className="cgv-effects-search"
        type="search"
        placeholder={`Search ${label.toLowerCase()}`}
        aria-label={`Search ${label.toLowerCase()}`}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {!catalog && <p className="cgv-muted">Loading…</p>}
      {kind === 'effect' && catalog && !query && (
        <div className="cgv-effects-group">
          <h3>Layers</h3>
          <ul className="cgv-effects-grid">
            <li>
              <button
                type="button"
                className="cgv-effect-item"
                draggable
                data-testid="effect-item"
                data-key="adjustment"
                title="An adjustment layer applies its effects to every track below it. Drag it onto the timeline, or double-click to add it at the playhead."
                onDragStart={(event) => startDrag(event, { kind: 'adjustment' })}
                onDragEnd={endDrag}
                onDoubleClick={() => void editor.addAdjustmentLayer()}
                onKeyDown={(event) => event.key === 'Enter' && void editor.addAdjustmentLayer()}
              >
                <span className="cgv-effect-thumb cgv-effect-thumb-adjustment" aria-hidden />
                <span className="cgv-effect-name">Adjustment layer</span>
              </button>
            </li>
          </ul>
        </div>
      )}
      {groups.map(([category, list]) => (
        <div key={category} className="cgv-effects-group">
          <h3>{category}</h3>
          <ul className="cgv-effects-grid">
            {list.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  className="cgv-effect-item"
                  draggable
                  data-testid={`${kind}-item`}
                  data-key={item.key}
                  title={`${item.entry.description ?? item.name}. Drag onto ${
                    kind === 'effect' ? 'a clip' : 'a cut'
                  }, or double-click to apply.`}
                  onDragStart={(event) => startDrag(event, { kind: 'item', item })}
                  onDragEnd={endDrag}
                  onDoubleClick={() => apply(item)}
                  onKeyDown={(event) => event.key === 'Enter' && apply(item)}
                >
                  {previews[item.key] ? (
                    <img className="cgv-effect-thumb" src={previews[item.key]} alt="" />
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
      {catalog && !items.length && <p className="cgv-muted">Nothing matches.</p>}
    </section>
  );
}

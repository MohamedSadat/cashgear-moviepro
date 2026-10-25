import { useEffect, useMemo, useState } from 'react';
import type { EngineClient } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { draggedEffect, effectDragType } from '../effects/dragging';
import { soundLength, sounds, type Sound } from './catalog';

function startDrag(event: React.DragEvent, sound: Sound) {
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(effectDragType, `sound:${sound.id}`);
  draggedEffect.current = { kind: 'sound', sound };
}

function endDrag() {
  draggedEffect.current = null;
}

/**
 * The built-in music (`kind` music) or sound effects, by category. Each plays
 * a preview from its button; drag one onto the timeline, or double-click it to
 * add it at the playhead.
 */
export function SoundsBrowser({
  editor,
  client,
  kind,
}: {
  editor: EditorState;
  client: EngineClient | null;
  kind: 'music' | 'effect';
}) {
  const [query, setQuery] = useState('');
  const [playing, setPlaying] = useState<string | null>(null);
  const groups = useMemo(() => {
    const words = query.trim().toLowerCase();
    const matching = sounds.filter(
      (s) => s.kind === kind && (!words || `${s.name} ${s.category}`.toLowerCase().includes(words)),
    );
    const byCategory = new Map<string, Sound[]>();
    for (const sound of matching) {
      const list = byCategory.get(sound.category) ?? [];
      list.push(sound);
      byCategory.set(sound.category, list);
    }
    return [...byCategory];
  }, [query, kind]);

  // Leaving the tab stops the preview.
  useEffect(() => () => void client?.previewSound(null).catch(() => {}), [client]);

  const preview = (sound: Sound) => {
    if (!client) return;
    if (playing === sound.id) {
      setPlaying(null);
      void client.previewSound(null);
      return;
    }
    setPlaying(sound.id);
    void client
      .previewSound(sound.url, () =>
        setPlaying((current) => (current === sound.id ? null : current)),
      )
      .catch(() => setPlaying(null));
  };
  const add = (sound: Sound) => void editor.addSound(sound);
  const label = kind === 'music' ? 'Music' : 'Sound effects';
  return (
    <section className="cgv-effects" data-testid={`${kind}-browser`} aria-label={label}>
      <input
        className="cgv-effects-search"
        type="search"
        placeholder={kind === 'music' ? 'Search music' : 'Search sounds'}
        aria-label={kind === 'music' ? 'Search music' : 'Search sounds'}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {groups.map(([category, list]) => (
        <div key={category} className="cgv-effects-group">
          <h3>{category}</h3>
          <ul className="cgv-sound-list">
            {list.map((sound) => (
              <li
                key={sound.id}
                className="cgv-sound"
                draggable
                data-testid="sound-item"
                data-key={sound.id}
                title={`${sound.name}. Drag onto the timeline, or double-click to add it at the playhead.`}
                onDragStart={(event) => startDrag(event, sound)}
                onDragEnd={endDrag}
                onDoubleClick={() => add(sound)}
              >
                <button
                  type="button"
                  className="cgv-sound-play"
                  aria-label={`${playing === sound.id ? 'Stop' : 'Play'} ${sound.name}`}
                  aria-pressed={playing === sound.id}
                  data-testid="sound-preview"
                  onClick={() => preview(sound)}
                >
                  {playing === sound.id ? '■' : '▶'}
                </button>
                <button
                  type="button"
                  className="cgv-sound-name"
                  onKeyDown={(event) => event.key === 'Enter' && add(sound)}
                >
                  {sound.name}
                </button>
                <span className="cgv-muted cgv-sound-length">
                  {sound.bpm ? `${sound.bpm} BPM · ` : ''}
                  {soundLength(sound.seconds)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!groups.length && <p className="cgv-muted">Nothing matches.</p>}
      <p className="cgv-muted cgv-sound-note">
        Made for CashGear Video and free to use in your videos.
      </p>
    </section>
  );
}

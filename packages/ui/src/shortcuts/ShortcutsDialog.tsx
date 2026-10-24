import { useEffect, useState } from 'react';
import { Dialog } from '../project/Dialog';
import {
  actions,
  bind,
  comboOf,
  effectiveKeymap,
  formatCombo,
  presets,
  unbind,
  type ActionGroup,
  type ActionId,
  type PresetId,
  type ShortcutSettings,
} from './keymap';

interface Props {
  shortcuts: ShortcutSettings;
  onChange(shortcuts: ShortcutSettings): void;
  onClose(): void;
}

const groups: ActionGroup[] = ['Playback', 'Editing', 'Timeline', 'File'];
const label = (id: ActionId) => actions.find((action) => action.id === id)?.label ?? id;

/** Lists every action's keys; a key can be recorded for any action, or cleared. */
export function ShortcutsDialog({ shortcuts, onChange, onClose }: Props) {
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const keymap = effectiveKeymap(shortcuts);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      // Recording takes the next combination, Escape included only with a modifier.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        setRecording(null);
        return;
      }
      const combo = comboOf(event);
      if (!combo) return;
      const { settings, displaced } = bind(shortcuts, recording, combo);
      onChange(settings);
      setNote(
        displaced.length
          ? `${formatCombo(combo)} moved from “${displaced.map(label).join('”, “')}” to “${label(recording)}”.`
          : null,
      );
      setRecording(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onChange, recording, shortcuts]);

  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={recording ? undefined : onClose}
      testId="shortcuts-dialog"
      wide
      footer={
        <>
          <button type="button" onClick={() => onChange({ ...shortcuts, overrides: {} })}>
            Reset to {presets[shortcuts.preset].label}
          </button>
          <button type="button" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <label className="cgv-form-row">
        Preset
        <select
          aria-label="Shortcut preset"
          value={shortcuts.preset}
          onChange={(event) => {
            // A new preset starts from its own keys.
            onChange({ preset: event.currentTarget.value as PresetId, overrides: {} });
            setNote(null);
          }}
        >
          {(Object.keys(presets) as PresetId[]).map((id) => (
            <option key={id} value={id}>
              {presets[id].label}
            </option>
          ))}
        </select>
      </label>
      <p className="cgv-muted" role="status">
        {recording
          ? `Press the keys for “${label(recording)}”, or Esc to keep the old ones.`
          : (note ?? 'Choose Change to give an action a new key. Ctrl means Cmd on a Mac.')}
      </p>
      <div className="cgv-shortcuts">
        {groups.map((group) => (
          <section key={group} aria-label={group}>
            <h3>{group}</h3>
            <table>
              <tbody>
                {actions
                  .filter((action) => action.group === group)
                  .map((action) => (
                    <tr key={action.id} data-testid="shortcut" data-action={action.id}>
                      <th scope="row">{action.label}</th>
                      <td className="cgv-shortcut-keys" data-testid="shortcut-keys">
                        {keymap[action.id].length ? (
                          keymap[action.id].map((combo) => (
                            <kbd key={combo}>{formatCombo(combo)}</kbd>
                          ))
                        ) : (
                          <span className="cgv-muted">None</span>
                        )}
                      </td>
                      <td className="cgv-shortcut-actions">
                        <button
                          type="button"
                          aria-label={`Change the key for ${action.label}`}
                          aria-pressed={recording === action.id}
                          onClick={() => setRecording(action.id)}
                        >
                          {recording === action.id ? 'Press keys…' : 'Change'}
                        </button>
                        <button
                          type="button"
                          aria-label={`Clear the keys for ${action.label}`}
                          disabled={!keymap[action.id].length}
                          onClick={() => onChange(unbind(shortcuts, action.id))}
                        >
                          Clear
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

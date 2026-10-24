import { useEffect, useRef } from 'react';
import { actionsByCombo, comboOf, type ActionId, type Keymap } from './keymap';

/** Actions that do not repeat while their key is held down. */
const once = new Set<ActionId>([
  'playPause',
  'shuttleBack',
  'shuttleStop',
  'shuttleForward',
  'save',
  'saveAs',
  'split',
  'delete',
  'rippleDelete',
  'copy',
  'cut',
  'paste',
  'addMarker',
  'toggleSnapping',
  'toggleMagnetic',
  'selectTool',
  'bladeTool',
  'trimStartToPlayhead',
  'trimEndToPlayhead',
]);

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** True while a dialog or menu has the keyboard. */
const overlayOpen = () =>
  !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');

/**
 * Runs the action of each key press anywhere in the app, except while typing in
 * a field or while a dialog or menu is open.
 */
export function useShortcuts(keymap: Keymap, run: (action: ActionId) => void) {
  const map = useRef(actionsByCombo(keymap));
  map.current = actionsByCombo(keymap);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || editable(event.target) || overlayOpen()) return;
      const combo = comboOf(event);
      if (!combo) return;
      const action = map.current.get(combo);
      if (event.type === 'keyup') {
        // A focused button would otherwise click on Space as well.
        if (action && combo === 'Space') event.preventDefault();
        return;
      }
      if (!action) return;
      event.preventDefault();
      if (event.repeat && once.has(action)) return;
      runRef.current(action);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);
}

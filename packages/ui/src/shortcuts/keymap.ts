/** Every action a key can trigger. */
export type ActionId =
  | 'playPause'
  | 'shuttleBack'
  | 'shuttleStop'
  | 'shuttleForward'
  | 'previousFrame'
  | 'nextFrame'
  | 'back10Frames'
  | 'forward10Frames'
  | 'goToStart'
  | 'goToEnd'
  | 'previousEdit'
  | 'nextEdit'
  | 'undo'
  | 'redo'
  | 'save'
  | 'saveAs'
  | 'exportVideo'
  | 'split'
  | 'delete'
  | 'rippleDelete'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'selectAll'
  | 'deselect'
  | 'trimStartToPlayhead'
  | 'trimEndToPlayhead'
  | 'addTransition'
  | 'addMarker'
  | 'toggleSnapping'
  | 'toggleMagnetic'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomToFit'
  | 'selectTool'
  | 'bladeTool';

export type ActionGroup = 'Playback' | 'Editing' | 'Timeline' | 'File';

export interface ActionInfo {
  id: ActionId;
  label: string;
  group: ActionGroup;
}

/** The actions in the order the shortcut settings list them. */
export const actions: readonly ActionInfo[] = [
  { id: 'playPause', label: 'Play or pause', group: 'Playback' },
  { id: 'shuttleBack', label: 'Play backwards (faster each press)', group: 'Playback' },
  { id: 'shuttleStop', label: 'Stop', group: 'Playback' },
  { id: 'shuttleForward', label: 'Play forwards (faster each press)', group: 'Playback' },
  { id: 'previousFrame', label: 'Previous frame', group: 'Playback' },
  { id: 'nextFrame', label: 'Next frame', group: 'Playback' },
  { id: 'back10Frames', label: 'Back 10 frames', group: 'Playback' },
  { id: 'forward10Frames', label: 'Forward 10 frames', group: 'Playback' },
  { id: 'goToStart', label: 'Go to start', group: 'Playback' },
  { id: 'goToEnd', label: 'Go to end', group: 'Playback' },
  { id: 'previousEdit', label: 'Previous edit point', group: 'Playback' },
  { id: 'nextEdit', label: 'Next edit point', group: 'Playback' },
  { id: 'split', label: 'Split at the playhead', group: 'Editing' },
  { id: 'delete', label: 'Delete', group: 'Editing' },
  { id: 'rippleDelete', label: 'Ripple delete', group: 'Editing' },
  { id: 'copy', label: 'Copy', group: 'Editing' },
  { id: 'cut', label: 'Cut', group: 'Editing' },
  { id: 'paste', label: 'Paste at the playhead', group: 'Editing' },
  { id: 'selectAll', label: 'Select all clips', group: 'Editing' },
  { id: 'deselect', label: 'Select nothing', group: 'Editing' },
  { id: 'trimStartToPlayhead', label: 'Trim start to the playhead', group: 'Editing' },
  { id: 'trimEndToPlayhead', label: 'Trim end to the playhead', group: 'Editing' },
  { id: 'addTransition', label: 'Add the default transition at the playhead', group: 'Editing' },
  { id: 'undo', label: 'Undo', group: 'Editing' },
  { id: 'redo', label: 'Redo', group: 'Editing' },
  { id: 'addMarker', label: 'Add a marker', group: 'Timeline' },
  { id: 'toggleSnapping', label: 'Snapping on or off', group: 'Timeline' },
  { id: 'toggleMagnetic', label: 'Magnetic main track on or off', group: 'Timeline' },
  { id: 'zoomIn', label: 'Zoom in', group: 'Timeline' },
  { id: 'zoomOut', label: 'Zoom out', group: 'Timeline' },
  { id: 'zoomToFit', label: 'Zoom to fit', group: 'Timeline' },
  { id: 'selectTool', label: 'Select tool', group: 'Timeline' },
  { id: 'bladeTool', label: 'Blade tool', group: 'Timeline' },
  { id: 'save', label: 'Save', group: 'File' },
  { id: 'saveAs', label: 'Save as', group: 'File' },
  { id: 'exportVideo', label: 'Export video', group: 'File' },
];

export type PresetId = 'filmora' | 'premiere';
export type Keymap = Record<ActionId, string[]>;

/** Keys both presets share. */
const common = {
  playPause: ['Space'],
  shuttleBack: ['J'],
  shuttleStop: ['K'],
  shuttleForward: ['L'],
  previousFrame: ['ArrowLeft'],
  nextFrame: ['ArrowRight'],
  back10Frames: ['Shift+ArrowLeft'],
  forward10Frames: ['Shift+ArrowRight'],
  goToStart: ['Home'],
  goToEnd: ['End'],
  previousEdit: ['ArrowUp'],
  nextEdit: ['ArrowDown'],
  undo: ['Ctrl+Z'],
  save: ['Ctrl+S'],
  saveAs: ['Ctrl+Shift+S'],
  delete: ['Delete', 'Backspace'],
  rippleDelete: ['Shift+Delete', 'Shift+Backspace'],
  copy: ['Ctrl+C'],
  cut: ['Ctrl+X'],
  paste: ['Ctrl+V'],
  selectAll: ['Ctrl+A'],
  deselect: ['Escape'],
  addMarker: ['M'],
  addTransition: ['Ctrl+D'],
  toggleMagnetic: [],
  selectTool: ['V'],
  bladeTool: ['C'],
} satisfies Partial<Keymap>;

/**
 * The shipped key sets. Filmora-like keys follow Filmora's Windows defaults where
 * they are known; Premiere-like keys follow Premiere Pro's. Ctrl means Cmd on a Mac.
 */
export const presets: Record<PresetId, { label: string; keys: Keymap }> = {
  filmora: {
    label: 'Filmora-like',
    keys: {
      ...common,
      redo: ['Ctrl+Y', 'Ctrl+Shift+Z'],
      exportVideo: ['Ctrl+E'],
      split: ['Ctrl+B'],
      trimStartToPlayhead: ['Alt+['],
      trimEndToPlayhead: ['Alt+]'],
      toggleSnapping: ['N'],
      zoomIn: ['Ctrl+='],
      zoomOut: ['Ctrl+-'],
      zoomToFit: ['Shift+Z'],
    },
  },
  premiere: {
    label: 'Premiere-like',
    keys: {
      ...common,
      redo: ['Ctrl+Shift+Z', 'Ctrl+Y'],
      exportVideo: ['Ctrl+M'],
      split: ['Ctrl+K'],
      trimStartToPlayhead: ['Q'],
      trimEndToPlayhead: ['W'],
      toggleSnapping: ['S'],
      zoomIn: ['='],
      zoomOut: ['-'],
      zoomToFit: ['\\'],
    },
  },
};

/** What the user chose: a preset, and actions whose keys they changed. */
export interface ShortcutSettings {
  preset: PresetId;
  overrides: Partial<Keymap>;
}

export const defaultShortcuts: ShortcutSettings = { preset: 'filmora', overrides: {} };

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const named: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Esc: 'Escape',
  Del: 'Delete',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  '+': '=',
  _: '-',
};

/**
 * The combination a key press makes, such as "Ctrl+Shift+Z": Ctrl (or Cmd), Alt
 * and Shift in that order, then the key. Null for a modifier on its own.
 */
export function comboOf(event: KeyLike): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS', 'Dead'].includes(event.key))
    return null;
  let key = named[event.key] ?? event.key;
  if (key.length === 1) key = key.toUpperCase();
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

const symbols: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: '⌫',
};

/** A combination as the settings show it: "Shift+←". */
export function formatCombo(combo: string): string {
  return combo
    .split('+')
    .map((part, index, all) => (index === all.length - 1 ? (symbols[part] ?? part) : part))
    .join('+');
}

/** The keys of every action: the preset's, with the user's changes. */
export function effectiveKeymap(settings: ShortcutSettings): Keymap {
  const base = presets[settings.preset]?.keys ?? presets.filmora.keys;
  const keys = { ...base };
  for (const [action, combos] of Object.entries(settings.overrides) as [ActionId, string[]][])
    if (action in keys) keys[action] = [...combos];
  return keys;
}

/** The action each combination triggers. */
export function actionsByCombo(keymap: Keymap): Map<string, ActionId> {
  const map = new Map<string, ActionId>();
  for (const { id } of actions)
    for (const combo of keymap[id]) if (!map.has(combo)) map.set(combo, id);
  return map;
}

/**
 * Gives `combo` to `action`, replacing its keys (or adding to them), and takes it
 * away from any other action that had it. Returns the new settings and the
 * actions that lost the key.
 */
export function bind(
  settings: ShortcutSettings,
  action: ActionId,
  combo: string,
  mode: 'replace' | 'add' = 'replace',
): { settings: ShortcutSettings; displaced: ActionId[] } {
  const keymap = effectiveKeymap(settings);
  const overrides: Partial<Keymap> = { ...settings.overrides };
  const displaced: ActionId[] = [];
  for (const { id } of actions) {
    if (id === action || !keymap[id].includes(combo)) continue;
    overrides[id] = keymap[id].filter((other) => other !== combo);
    displaced.push(id);
  }
  const current = mode === 'add' ? keymap[action].filter((other) => other !== combo) : [];
  overrides[action] = [...current, combo];
  return { settings: { ...settings, overrides }, displaced };
}

/** Removes every key from `action`. */
export function unbind(settings: ShortcutSettings, action: ActionId): ShortcutSettings {
  return { ...settings, overrides: { ...settings.overrides, [action]: [] } };
}

/** Reads stored settings, keeping only what this build knows. */
export function readShortcuts(value: unknown): ShortcutSettings {
  if (!value || typeof value !== 'object') return defaultShortcuts;
  const { preset, overrides } = value as { preset?: unknown; overrides?: unknown };
  const known = new Set<string>(actions.map((action) => action.id));
  const clean: Partial<Keymap> = {};
  if (overrides && typeof overrides === 'object')
    for (const [action, combos] of Object.entries(overrides))
      if (known.has(action) && Array.isArray(combos))
        clean[action as ActionId] = combos.filter((combo) => typeof combo === 'string');
  return {
    preset: preset === 'premiere' ? 'premiere' : 'filmora',
    overrides: clean,
  };
}

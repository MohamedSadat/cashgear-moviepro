import { describe, expect, it } from 'vitest';
import {
  actions,
  actionsByCombo,
  bind,
  comboOf,
  defaultShortcuts,
  effectiveKeymap,
  formatCombo,
  presets,
  readShortcuts,
  unbind,
  type PresetId,
} from './keymap';

const press = (
  key: string,
  modifiers: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', boolean>> = {},
) => ({
  key,
  ctrlKey: !!modifiers.ctrl,
  altKey: !!modifiers.alt,
  shiftKey: !!modifiers.shift,
  metaKey: !!modifiers.meta,
});

describe('key combinations', () => {
  it('names presses with their modifiers in a fixed order', () => {
    expect(comboOf(press('z', { ctrl: true, shift: true }))).toBe('Ctrl+Shift+Z');
    expect(comboOf(press('Z', { shift: true, ctrl: true }))).toBe('Ctrl+Shift+Z');
    expect(comboOf(press(' '))).toBe('Space');
    expect(comboOf(press('ArrowLeft', { shift: true }))).toBe('Shift+ArrowLeft');
    expect(comboOf(press('b', { meta: true }))).toBe('Ctrl+B');
    expect(comboOf(press('[', { alt: true }))).toBe('Alt+[');
    expect(comboOf(press('+', { ctrl: true, shift: true }))).toBe('Ctrl+Shift+=');
    expect(comboOf(press('Shift', { shift: true }))).toBeNull();
    expect(comboOf(press('Control', { ctrl: true }))).toBeNull();
  });

  it('shows arrows and a few keys as symbols', () => {
    expect(formatCombo('Shift+ArrowLeft')).toBe('Shift+←');
    expect(formatCombo('Ctrl+Shift+Z')).toBe('Ctrl+Shift+Z');
    expect(formatCombo('Delete')).toBe('Del');
  });
});

describe('presets', () => {
  for (const id of Object.keys(presets) as PresetId[])
    it(`${presets[id].label} gives every key to one action at most`, () => {
      const keys = presets[id].keys;
      const seen = new Map<string, string>();
      for (const { id: action } of actions)
        for (const combo of keys[action]) {
          expect(seen.get(combo), `${combo} is used twice`).toBeUndefined();
          seen.set(combo, action);
        }
      expect(Object.keys(keys).sort()).toEqual(actions.map((action) => action.id).sort());
    });

  it('keeps the playback and file keys the earlier phases used', () => {
    for (const id of Object.keys(presets) as PresetId[]) {
      const map = actionsByCombo(presets[id].keys);
      expect(map.get('Space')).toBe('playPause');
      expect(map.get('J')).toBe('shuttleBack');
      expect(map.get('Ctrl+Z')).toBe('undo');
      expect(map.get('Ctrl+Y')).toBe('redo');
      expect(map.get('Ctrl+Shift+Z')).toBe('redo');
      expect(map.get('Ctrl+S')).toBe('save');
      expect(map.get('Home')).toBe('goToStart');
    }
  });

  it('differ where the two editors differ', () => {
    expect(actionsByCombo(presets.filmora.keys).get('Ctrl+B')).toBe('split');
    expect(actionsByCombo(presets.premiere.keys).get('Ctrl+K')).toBe('split');
    expect(actionsByCombo(presets.premiere.keys).get('Q')).toBe('trimStartToPlayhead');
    expect(actionsByCombo(presets.filmora.keys).get('Q')).toBeUndefined();
  });
});

describe('changing keys', () => {
  it('moves a key from the action that had it', () => {
    const { settings, displaced } = bind(defaultShortcuts, 'addMarker', 'Ctrl+B');
    expect(displaced).toEqual(['split']);
    const keymap = effectiveKeymap(settings);
    expect(keymap.addMarker).toEqual(['Ctrl+B']);
    expect(keymap.split).toEqual([]);
    expect(actionsByCombo(keymap).get('Ctrl+B')).toBe('addMarker');
    expect(actionsByCombo(keymap).get('M')).toBeUndefined();
  });

  it('adds a second key, and clears an action', () => {
    let { settings } = bind(defaultShortcuts, 'split', 'S', 'add');
    expect(effectiveKeymap(settings).split).toEqual(['Ctrl+B', 'S']);
    settings = unbind(settings, 'split');
    expect(effectiveKeymap(settings).split).toEqual([]);
    expect(effectiveKeymap({ ...settings, overrides: {} }).split).toEqual(['Ctrl+B']);
  });

  it('reads stored settings defensively', () => {
    expect(readShortcuts(null)).toEqual(defaultShortcuts);
    expect(
      readShortcuts({ preset: 'premiere', overrides: { split: ['S', 3], bogus: ['X'] } }),
    ).toEqual({
      preset: 'premiere',
      overrides: { split: ['S'] },
    });
    expect(readShortcuts({ preset: 'other' }).preset).toBe('filmora');
  });
});

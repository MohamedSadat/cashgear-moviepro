import { describe, expect, it } from 'vitest';
import type { Clip, ProjectSettings, TitleElement } from '@cgv/engine-client';
import { animateCommands, animationKeys } from './animations';
import { fontGroups, missingFonts } from './fonts';
import { fitTitle, templateSpec, templates, titleName } from './templates';

const second = 705_600_000;
const frame = second / 30;
const canvas = { width: 1920, height: 1080 };
const heading: TitleElement = {
  id: 7,
  x: 0,
  y: 300,
  fill: { r: 1, g: 1, b: 1, a: 1 },
  type: 'text',
  text: 'Hello',
  font: { family: 'Inter' },
  size: 96,
};
const base = { element: heading, seconds: 0.5, duration: 5 * second, frame, canvas };

describe('title animations', () => {
  it('fades in from transparent to the element’s own opacity', () => {
    const { keyframes } = animationKeys({ ...base, which: 'in', preset: 'fade' });
    expect(keyframes['title.7.opacity']).toEqual([
      { time: 0, value: 0, interpolation: { kind: 'easeOut' } },
      { time: 15 * frame, value: 1, interpolation: { kind: 'linear' } },
    ]);
    // Only the settings a preset moves get keys.
    expect(Object.keys(keyframes)).toEqual(['title.7.opacity']);
  });

  it('keeps an entrance when an exit is added, and replaces a preset in its stretch', () => {
    const entrance = animationKeys({ ...base, which: 'in', preset: 'slideUp' }).keyframes;
    expect(entrance['title.7.y'][0].value).toBeCloseTo(300 + 1080 * 0.08);
    const both = animationKeys({ ...base, which: 'out', preset: 'fade', keyframes: entrance });
    const opacity = both.keyframes['title.7.opacity'];
    expect(opacity.map((key) => key.time)).toEqual([0, 15 * frame, 134 * frame, 149 * frame]);
    expect(opacity.map((key) => key.value)).toEqual([0, 1, 1, 0]);
    // A fade in its place clears the slide's y keys.
    const keyed = { ...entrance, ...both.keyframes };
    const swapped = animationKeys({ ...base, which: 'in', preset: 'fade', keyframes: keyed });
    expect(swapped.keyframes['title.7.y']).toEqual([]);
    expect(swapped.keyframes['title.7.opacity'].map((key) => key.value)).toEqual([0, 1, 1, 0]);
  });

  it('reveals letters or words, waits for a delay and overshoots a pop', () => {
    const typed = animationKeys({ ...base, which: 'in', preset: 'typewriter', delay: 1 });
    expect(typed.revealBy).toBe('letter');
    expect(typed.keyframes['title.7.reveal'].map((key) => [key.time, key.value])).toEqual([
      [30 * frame, 0],
      [45 * frame, 1],
    ]);
    expect(animationKeys({ ...base, which: 'in', preset: 'words' }).revealBy).toBe('word');
    const pop = animationKeys({ ...base, which: 'in', preset: 'pop' }).keyframes['title.7.scale'];
    expect(pop[0].interpolation).toMatchObject({ kind: 'bezier', y1: 1.56 });
    // Shapes have nothing to reveal.
    const shape: TitleElement = {
      ...heading,
      type: 'shape',
      kind: 'star',
      width: 100,
      height: 100,
    };
    const none = animationKeys({ ...base, element: shape, which: 'in', preset: 'typewriter' });
    expect(none.keyframes).toEqual({});
  });

  it('becomes one batch of commands for a clip', () => {
    const clip = {
      id: 3,
      kind: 'title',
      keyframes: {},
      title: { elements: [heading] },
    } as unknown as Clip;
    const commands = animateCommands(clip, { ...base, which: 'in', preset: 'words' });
    expect(commands[0]).toMatchObject({ type: 'setTitle', clip: 3 });
    expect(commands[1]).toMatchObject({ type: 'setKeyframes', property: 'title.7.reveal' });
  });
});

describe('title templates', () => {
  const settings: ProjectSettings = {
    width: 1920,
    height: 1080,
    frameRate: { num: 30, den: 1 },
    sampleRate: 48_000,
    channels: 2,
  };

  it('ships 30 templates whose animations name their elements', () => {
    expect(templates).toHaveLength(30);
    for (const template of templates) {
      const ids = new Set(template.title.elements.map((e) => e.id));
      expect(ids.size, template.id).toBe(template.title.elements.length);
      for (const animation of template.animations) expect(ids.has(animation.element)).toBe(true);
      const spec = templateSpec(template, settings);
      expect(spec.kind).toBe('title');
      expect(spec.duration % frame).toBe(0);
      for (const name of Object.keys(spec.keyframes ?? {})) {
        const id = Number(name.split('.')[1]);
        expect(ids.has(id), `${template.id} ${name}`).toBe(true);
      }
    }
    expect(templates[0].category).toBe('Basic');
  });

  it('fits a design to the project and names a clip by its text', () => {
    const portrait = fitTitle({ elements: [heading] }, 1080, 1920);
    const fitted = portrait.elements[0];
    expect(fitted.y).toBeCloseTo(300 * 0.5625);
    expect(fitted.type === 'text' && fitted.size).toBeCloseTo(54);
    expect(titleName({ elements: [heading] })).toBe('Hello');
    expect(titleName(undefined)).toBe('Title');
  });
});

describe('font picker groups', () => {
  it('lists bundled families by script, then imported, then installed', () => {
    expect(
      fontGroups([
        { family: 'Inter', script: 'latin', origin: 'bundled' },
        { family: 'Amiri', script: 'arabic', origin: 'bundled' },
        { family: 'Noto Emoji', script: 'emoji', origin: 'bundled' },
        { family: 'Mine', script: 'other', origin: 'imported' },
        { family: 'Arial', script: 'other', origin: 'system' },
        { family: 'Calibri', script: 'other', origin: 'system' },
      ]),
    ).toEqual([
      { name: 'Latin', families: ['Inter'] },
      { name: 'Arabic', families: ['Amiri'] },
      { name: 'Emoji', families: ['Noto Emoji'] },
      { name: 'Imported', families: ['Mine'] },
      { name: 'Installed', families: ['Arial', 'Calibri'] },
    ]);
  });
});

describe('missing fonts', () => {
  it('names each family titles use that the catalogue lacks, once', () => {
    const text = (family: string) => ({ type: 'text', font: { family } }) as TitleElement;
    const project = {
      tracks: [
        { clips: [{ title: { elements: [text('Inter'), text('Brand Sans')] } }, {}] },
        { clips: [{ title: { elements: [text('brand sans'), text('Arial')] } }] },
      ],
    };
    const families = [{ family: 'Inter', script: 'latin', origin: 'bundled' } as const];
    expect(missingFonts(project, families)).toEqual(['Arial', 'Brand Sans']);
    expect(
      missingFonts(project, [
        ...families,
        { family: 'Brand Sans', script: 'other', origin: 'imported' },
        { family: 'Arial', script: 'other', origin: 'system' },
      ]),
    ).toEqual([]);
  });
});

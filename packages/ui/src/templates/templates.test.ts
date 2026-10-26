import { describe, expect, it, vi } from 'vitest';
import type { Clip, Command, Project, ProjectSettings } from '@cgv/engine-client';
import { sounds } from '../sounds/catalog';
import { stickers } from '../stickers/catalog';
import { templates as titleTemplates } from '../titles/templates';
import { clipSpec, fillCommands, packRequests, placeTemplate, slotsOf } from './apply';
import { projectTemplates, templateSettings, templateSummary } from './templates';

// The sound and sticker catalogues make absolute URLs against the page.
vi.hoisted(() => {
  Object.assign(globalThis, { location: new URL('http://127.0.0.1:5173/') });
});

interface Manifest {
  id: string;
  params: { id: string }[];
}

const manifests = import.meta.glob<Manifest>(
  '../../../../assets/{effects,transitions}/*/effect.json',
  {
    eager: true,
    import: 'default',
  },
);
const catalogue = (folder: string) =>
  new Map(
    Object.entries(manifests)
      .filter(([path]) => path.includes(`/assets/${folder}/`))
      .map(([, manifest]) => [manifest.id, new Set(manifest.params.map((param) => param.id))]),
  );
const effects = catalogue('effects');
const transitions = catalogue('transitions');

const second = 705_600_000;
const frame = second / 30;
const base: ProjectSettings = {
  width: 1920,
  height: 1080,
  frameRate: { num: 30, den: 1 },
  sampleRate: 48000,
  channels: 2,
} as ProjectSettings;

function emptyProject(settings: ProjectSettings): Project {
  return {
    name: 'Untitled project',
    settings,
    media: [],
    tracks: [
      { id: 1, clips: [], transitions: [] },
      { id: 2, clips: [], transitions: [] },
    ],
    mainTrack: 1,
    magnetic: true,
  } as unknown as Project;
}

describe('project templates', () => {
  it('has twenty, in every category', () => {
    expect(projectTemplates).toHaveLength(20);
    expect(new Set(projectTemplates.map((t) => t.category))).toEqual(
      new Set(['Slideshows', 'Vlog', 'Promo', 'Social', 'Arabic', 'Intros', 'Outros']),
    );
    for (const template of projectTemplates) {
      expect(template.pack).toBe('builtin');
      expect(template.version).toBeGreaterThanOrEqual(1);
    }
  });

  it.each(projectTemplates.map((t) => [t.id, t] as const))(
    '%s uses only what the app has',
    (_, template) => {
      const slots: number[] = [];
      let end = 0;
      for (const track of template.tracks) {
        for (const clip of track.clips) {
          end = Math.max(end, clip.at + clip.seconds);
          if (clip.type === 'slot') slots.push(clip.slot);
          if (clip.type === 'title')
            expect(titleTemplates.map((t) => t.id)).toContain(clip.template);
          if (clip.type === 'sticker') expect(stickers.map((s) => s.id)).toContain(clip.sticker);
          if (clip.type === 'sound') expect(sounds.map((s) => s.id)).toContain(clip.sound);
          const used = 'effects' in clip ? (clip.effects ?? []) : [];
          for (const effect of used) {
            expect(effects.has(effect.kind), effect.kind).toBe(true);
            for (const param of Object.keys(effect.params ?? {}))
              expect(effects.get(effect.kind)?.has(param), `${effect.kind}.${param}`).toBe(true);
          }
        }
        for (const transition of track.transitions ?? []) {
          expect(transitions.has(transition.kind), transition.kind).toBe(true);
          for (const param of Object.keys(transition.params ?? {}))
            expect(transitions.get(transition.kind)?.has(param)).toBe(true);
          // Transitions sit on cuts between touching clips, or on a free edge.
          const from = transition.from === null ? null : track.clips[transition.from];
          const to = transition.to === null ? null : track.clips[transition.to];
          expect(from ?? to).toBeTruthy();
          if (from && to) expect(from.at + from.seconds).toBeCloseTo(to.at);
        }
      }
      // Slots count from 1 with no gaps, as the browser fills them.
      expect([...new Set(slots)].sort((a, b) => a - b)).toEqual(
        Array.from({ length: template.slots }, (_, i) => i + 1),
      );
      expect(template.seconds).toBeCloseTo(end);
      // The first track is the main track: its clips play back to back from 0.
      let at = 0;
      for (const clip of template.tracks[0].clips) {
        expect(clip.at).toBeCloseTo(at);
        at += clip.seconds;
      }
      // Every clip makes a spec at the template's size.
      const settings = templateSettings(template, base);
      for (const clip of template.tracks.flatMap((track) => track.clips)) {
        const spec = clipSpec(clip, settings, frame);
        expect(spec.duration).toBeGreaterThan(0);
        expect(spec.duration % frame).toBe(0);
      }
      expect(templateSummary(template)).toMatch(/^\d+ slots? · [\d.]+ s · /);
    },
  );

  it('places a project template in an empty project, overlays on the spare track first', async () => {
    const template = projectTemplates.find((t) => t.id === 'travel-slideshow')!;
    const project = emptyProject(templateSettings(template, base));
    const commands: Command[] = [];
    let next = 100;
    await placeTemplate(template, project, 0, async (command) => {
      commands.push(command);
      return [next++];
    });
    const inserts = commands.filter((c) => c.type === 'insert');
    expect(inserts).toHaveLength(template.tracks[0].clips.length);
    // Each main-track clip goes at the end of the one before.
    expect(inserts.map((c) => c.type === 'insert' && c.at)).toEqual(
      template.tracks[0].clips.map((clip) => Math.round((clip.at * second) / frame) * frame),
    );
    expect(inserts.every((c) => c.type === 'insert' && c.track === 1)).toBe(true);
    // The second template track reuses track 2; the rest get new tracks.
    const added = commands.filter((c) => c.type === 'addTrack');
    expect(added).toHaveLength(template.tracks.length - 2);
    expect(commands).toContainEqual({
      type: 'renameTrack',
      track: 2,
      name: template.tracks[1].name,
    });
    const slotClips = inserts.flatMap((c) => (c.type === 'insert' ? [c.clip] : []));
    expect(slotClips.map((clip) => clip.slot)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(slotClips[0].keyframes?.['transform.scaleX']).toHaveLength(2);
    // Transitions refer to the clips just made.
    const transition = commands.find((c) => c.type === 'addTransition');
    expect(transition).toMatchObject({ type: 'addTransition', track: 1, from: 100, to: 101 });
  });

  it('puts an intro at the cut nearest the playhead on a magnetic main track', async () => {
    const template = projectTemplates.find((t) => t.kind === 'intro')!;
    const project = emptyProject(base);
    const clip = { id: 9, start: 0, duration: 4 * second, slot: 2 } as Clip;
    project.tracks[0].clips.push(clip);
    const commands: Command[] = [];
    await placeTemplate(template, project, 3 * second, async (command) => {
      commands.push(command);
      return [commands.length];
    });
    const first = commands.find((c) => c.type === 'insert');
    expect(first).toMatchObject({ at: 4 * second });
    // Its slots follow the project's own.
    const slots = commands.flatMap((c) =>
      c.type === 'insert' && c.clip.slot ? [c.clip.slot] : [],
    );
    expect(slots[0]).toBe(3);
    // Intros never take a project's tracks: each of theirs is new, on top.
    expect(commands.filter((c) => c.type === 'renameTrack')).toHaveLength(0);
  });

  it('asks for the stickers and sounds a project lacks, once each', () => {
    const template = projectTemplates.find((t) =>
      t.tracks.some((track) => track.clips.some((clip) => clip.type === 'sound')),
    )!;
    const requests = packRequests(template, emptyProject(base));
    expect(requests.length).toBeGreaterThan(0);
    expect(new Set(requests.map((r) => JSON.stringify(r))).size).toBe(requests.length);
  });

  it('fills slots in order, main track first, each slot once', () => {
    const project = emptyProject(base);
    const slot = (id: number, start: number, number: number, track = 0) =>
      project.tracks[track].clips.push({ id, start, duration: second, slot: number } as Clip);
    slot(1, 0, 2);
    slot(2, second, 1);
    slot(3, 2 * second, 3);
    // A held last frame shares its slot; only the slot's first clip is filled.
    slot(4, 3 * second, 3);
    slot(5, 0, 4, 1);
    expect([...slotsOf(project).keys()]).toEqual([1, 2, 3, 4]);
    expect(fillCommands(project, ['a', 'b', 'c'])).toEqual([
      { type: 'fillSlot', clip: 2, media: 'a' },
      { type: 'fillSlot', clip: 1, media: 'b' },
      { type: 'fillSlot', clip: 3, media: 'c' },
    ]);
  });
});

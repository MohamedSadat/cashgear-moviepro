import { CgButton } from '@cashgear/ui';
import {
  FLICKS_PER_SECOND,
  type BlendMode,
  type Clip,
  type ClipProperties,
  type Command,
} from '@cgv/engine-client';
import type { AiToolsState } from '../ai/useAiTools';
import type { EditorState } from '../editing/useEditor';
import { frameDuration } from '../timeline/geometry';
import { AiSection } from './AiSection';
import { AnimatedField, Section, type PropertyField } from './AnimatedField';
import { EffectStack } from './EffectStack';
import { ScrubField, keyContext, usePausedTime } from './fields';
import { LayoutSection } from './LayoutSection';
import { MaskSection } from './MaskSection';
import { SpeedSection } from './SpeedSection';
import { TitleInspector } from './TitleInspector';
import { TransitionInspector } from './TransitionInspector';
import { titleName } from '../titles/templates';

/** Blend modes in the order editors list them. */
export const blendModes: { mode: BlendMode; label: string }[] = [
  { mode: 'normal', label: 'Normal' },
  { mode: 'darken', label: 'Darken' },
  { mode: 'multiply', label: 'Multiply' },
  { mode: 'colorBurn', label: 'Colour burn' },
  { mode: 'lighten', label: 'Lighten' },
  { mode: 'screen', label: 'Screen' },
  { mode: 'colorDodge', label: 'Colour dodge' },
  { mode: 'add', label: 'Add' },
  { mode: 'overlay', label: 'Overlay' },
  { mode: 'softLight', label: 'Soft light' },
  { mode: 'hardLight', label: 'Hard light' },
  { mode: 'difference', label: 'Difference' },
  { mode: 'exclusion', label: 'Exclusion' },
];

/**
 * The selected clip's picture, sound, speed and effects, or the selected
 * transition. Every change is an undoable command; animated properties take
 * keyframes at the playhead.
 */
export function Inspector({ editor, ai }: { editor: EditorState; ai: AiToolsState }) {
  const playhead = usePausedTime(editor.playback);
  const clip: Clip | null = editor.focused;
  const snapshot = editor.project.snapshot;
  if (editor.transition && snapshot)
    return (
      <aside className="cgv-inspector" data-testid="inspector" aria-label="Inspector">
        <h2>Transition</h2>
        <TransitionInspector editor={editor} />
      </aside>
    );
  if (!clip || !snapshot)
    return (
      <aside className="cgv-inspector" data-testid="inspector" aria-label="Inspector">
        <h2>Inspector</h2>
        <p className="cgv-muted">Select a clip to change its picture, sound, speed and effects.</p>
      </aside>
    );
  const adjustment = clip.kind === 'adjustment';
  const title = clip.kind === 'title';
  const media = snapshot.project.media.find((item) => item.id === clip.media);
  const still = media?.kind === 'image' || adjustment || title;
  const locked = snapshot.project.tracks.some(
    (track) => track.locked && track.clips.some((c) => c.id === clip.id),
  );
  const frame = frameDuration(snapshot.project.settings.frameRate);
  const context = keyContext(clip, playhead, frame);
  const set = (properties: ClipProperties): Command => ({
    type: 'setClipProperties',
    clip: clip.id,
    properties,
  });
  const field = (props: PropertyField) => (
    <AnimatedField
      key={props.testId}
      editor={editor}
      context={context}
      field={props}
      disabled={locked}
    />
  );
  const transform = clip.transform;
  const crop = clip.crop;
  const opacity = field({
    label: 'Opacity',
    properties: ['opacity'],
    base: clip.opacity,
    display: 100,
    min: 0,
    max: 1,
    step: 0.5,
    precision: 1,
    unit: '%',
    testId: 'field-opacity',
    set: (opacity) => set({ opacity }),
  });
  return (
    <aside
      className="cgv-inspector"
      data-testid="inspector"
      data-clip-id={clip.id}
      aria-label="Inspector"
    >
      <h2 title={media?.name}>
        {adjustment
          ? 'Adjustment layer'
          : title && clip.slot !== undefined
            ? `Slot ${clip.slot}`
            : title
              ? `Title: ${titleName(clip.title)}`
              : (media?.name ?? 'Clip')}
      </h2>
      {locked && <p className="cgv-muted">This clip is on a locked track.</p>}
      {clip.slot !== undefined && (
        <p className="cgv-muted" data-testid="slot-note">
          {title
            ? `Template slot ${clip.slot}: drop a photo or video on it, or fill it from Templates.`
            : `Template slot ${clip.slot}: drop another photo or video on it to replace this one.`}
        </p>
      )}
      {adjustment && (
        <Section title="Adjustment">
          <p className="cgv-muted">Its effects apply to every track below it.</p>
          {opacity}
        </Section>
      )}
      {title && (
        <TitleInspector
          key={clip.id}
          editor={editor}
          clip={clip}
          context={context}
          canvas={snapshot.project.settings}
          frame={frame}
          disabled={locked}
        />
      )}
      {clip.video && !adjustment && (
        <Section title={title ? 'Whole title' : 'Transform'}>
          {field({
            label: 'Position X',
            properties: ['transform.x'],
            base: transform.x,
            display: 1,
            min: -100000,
            max: 100000,
            step: 1,
            precision: 1,
            unit: 'px',
            testId: 'field-x',
            set: (x) => set({ transform: { x } }),
          })}
          {field({
            label: 'Position Y',
            properties: ['transform.y'],
            base: transform.y,
            display: 1,
            min: -100000,
            max: 100000,
            step: 1,
            precision: 1,
            unit: 'px',
            testId: 'field-y',
            set: (y) => set({ transform: { y } }),
          })}
          {field({
            label: 'Scale',
            properties: ['transform.scaleX', 'transform.scaleY'],
            base: transform.scaleX,
            display: 100,
            min: 0.01,
            max: 100,
            step: 0.5,
            precision: 1,
            unit: '%',
            testId: 'field-scale',
            set: (scale) => set({ transform: { scaleX: scale, scaleY: scale } }),
          })}
          {field({
            label: 'Rotation',
            properties: ['transform.rotation'],
            base: transform.rotation,
            display: 1,
            min: -3600,
            max: 3600,
            step: 0.5,
            precision: 1,
            unit: '°',
            testId: 'field-rotation',
            set: (rotation) => set({ transform: { rotation } }),
          })}
          {opacity}
          {!adjustment && (
            <label className="cgv-field" data-testid="field-blend-mode">
              <span className="cgv-field-label">Blend</span>
              <select
                aria-label="Blend mode"
                value={clip.blendMode ?? 'normal'}
                disabled={locked}
                onChange={(event) =>
                  void editor.project.execute(
                    set({ blendMode: event.currentTarget.value as BlendMode }),
                  )
                }
              >
                {blendModes.map(({ mode, label }) => (
                  <option key={mode} value={mode}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <CgButton
            appearance="ghost"
            size="small"
            disabled={locked}
            onClick={() =>
              void editor.project.execute(
                set({
                  transform: {
                    x: 0,
                    y: 0,
                    scaleX: 1,
                    scaleY: 1,
                    rotation: 0,
                    anchorX: 0.5,
                    anchorY: 0.5,
                  },
                  opacity: 1,
                }),
              )
            }
          >
            Reset transform
          </CgButton>
        </Section>
      )}
      {clip.video && !adjustment && <LayoutSection editor={editor} clip={clip} disabled={locked} />}
      {clip.video && !adjustment && (
        <Section title="Crop">
          {(['left', 'top', 'right', 'bottom'] as const).map((side) =>
            field({
              label: side[0].toUpperCase() + side.slice(1),
              properties: [`crop.${side}`],
              base: crop[side],
              display: 100,
              min: 0,
              max: 0.95,
              step: 0.25,
              precision: 1,
              unit: '%',
              testId: `field-crop-${side}`,
              set: (value) => set({ crop: { [side]: value } }),
            }),
          )}
        </Section>
      )}
      {clip.audio && (
        <Section title="Audio">
          {field({
            label: 'Volume',
            properties: ['volumeDb'],
            base: clip.volumeDb,
            display: 1,
            min: -96,
            max: 24,
            step: 0.1,
            precision: 1,
            unit: 'dB',
            testId: 'field-volume',
            set: (volumeDb) => set({ volumeDb }),
          })}
          {(['fadeIn', 'fadeOut'] as const).map((edge) => {
            const other = edge === 'fadeIn' ? (clip.fadeOut ?? 0) : (clip.fadeIn ?? 0);
            const room = Math.max(0, clip.duration - other);
            return (
              <ScrubField
                key={edge}
                label={edge === 'fadeIn' ? 'Fade in' : 'Fade out'}
                value={(clip[edge] ?? 0) / FLICKS_PER_SECOND}
                min={0}
                max={room / FLICKS_PER_SECOND}
                step={0.01}
                precision={2}
                unit="s"
                testId={edge === 'fadeIn' ? 'field-fade-in' : 'field-fade-out'}
                editor={editor}
                disabled={locked}
                // Whole frames, as the fade handles on the timeline move.
                command={(seconds) =>
                  set({
                    [edge]: Math.min(
                      room,
                      Math.round((seconds * FLICKS_PER_SECOND) / frame) * frame,
                    ),
                  })
                }
              />
            );
          })}
          <ScrubField
            label="Noise reduction"
            value={(clip.denoise ?? 0) * 100}
            min={0}
            max={100}
            step={1}
            precision={0}
            unit="%"
            testId="field-denoise"
            editor={editor}
            disabled={locked}
            command={(percent) => set({ denoise: percent / 100 })}
          />
        </Section>
      )}
      {clip.audio && <EffectStack editor={editor} context={context} disabled={locked} audio />}
      {!still && (
        <SpeedSection
          editor={editor}
          clip={clip}
          playhead={playhead}
          frame={frame}
          disabled={locked}
        />
      )}
      {clip.video && <EffectStack editor={editor} context={context} disabled={locked} />}
      {clip.video && !adjustment && (
        <MaskSection editor={editor} context={context} disabled={locked} />
      )}
      {!adjustment && !title && <AiSection editor={editor} ai={ai} clip={clip} disabled={locked} />}
    </aside>
  );
}

import { useState } from 'react';
import { CgButton } from '@cashgear/ui';
import type { Clip, Command } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import {
  cellProperties,
  corners,
  pipSizes,
  pipTransform,
  splitLayouts,
  type SplitLayout,
} from '../layouts/layouts';
import { pictureOf } from '../monitor/geometry';
import { findClip } from '../timeline/controller';
import { Section } from './AnimatedField';

/** A layout's cells as a small picture. */
function LayoutIcon({ layout }: { layout: SplitLayout }) {
  return (
    <svg className="cgv-layout-icon" viewBox="0 0 32 18" aria-hidden>
      {layout.cells.map((cell, i) =>
        cell.polygon ? (
          <polygon key={i} points={cell.polygon.map(([x, y]) => `${x * 32},${y * 18}`).join(' ')} />
        ) : (
          <rect key={i} x={cell.x * 32} y={cell.y * 18} width={cell.w * 32} height={cell.h * 18} />
        ),
      )}
    </svg>
  );
}

/**
 * Picture-in-picture corners and split screens. They set ordinary transform,
 * crop and mask values, so everything stays editable; a split screen fills its
 * cells with the selected clips, first selected first.
 */
export function LayoutSection({
  editor,
  clip,
  disabled,
}: {
  editor: EditorState;
  clip: Clip;
  disabled: boolean;
}) {
  const [size, setSize] = useState<(typeof pipSizes)[number]['id']>('medium');
  const project = editor.project.snapshot?.project;
  if (!project) return null;
  const frame = { width: project.settings.width, height: project.settings.height };
  const rotations = new Map(
    editor.project.library.items.map((item) => [item.id, item.video?.rotation ?? 0]),
  );
  const picture = (target: Clip) => pictureOf(project, target, rotations);
  const fraction = pipSizes.find((item) => item.id === size)!.fraction;
  const selected = editor.selection
    .map((id) => findClip(project, id)?.clip)
    .filter((target): target is Clip => !!target?.video && target.kind !== 'adjustment');
  const split = (layout: SplitLayout) => {
    const commands: Command[] = [];
    layout.cells.forEach((cell, i) => {
      const target = selected[i];
      if (!target) return;
      const { properties, mask } = cellProperties(frame, picture(target), cell);
      commands.push({ type: 'setClipProperties', clip: target.id, properties });
      if (mask) commands.push({ type: 'addMask', clip: target.id, mask });
    });
    if (commands.length) void editor.project.executeGroup(`${layout.label} layout`, commands);
  };
  return (
    <Section title="Layout">
      <div className="cgv-inspector-row" role="group" aria-label="Picture in picture">
        <span className="cgv-field-label">In a corner</span>
        <select
          aria-label="Picture-in-picture size"
          value={size}
          disabled={disabled}
          onChange={(event) => setSize(event.currentTarget.value as typeof size)}
        >
          {pipSizes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        {corners.map(({ corner, label }) => (
          <CgButton
            key={corner}
            appearance="ghost"
            size="small"
            data-testid={`pip-${corner}`}
            aria-label={`Picture in picture, ${label.toLowerCase()}`}
            title={label}
            disabled={disabled}
            onClick={() =>
              void editor.project.execute({
                type: 'setClipProperties',
                clip: clip.id,
                properties: {
                  transform: pipTransform(frame, picture(clip), corner, fraction),
                  crop: { left: 0, top: 0, right: 0, bottom: 0 },
                },
              })
            }
          >
            {{ topLeft: '◰', topRight: '◳', bottomLeft: '◱', bottomRight: '◲' }[corner]}
          </CgButton>
        ))}
      </div>
      <div className="cgv-layout-grid" role="group" aria-label="Split screen">
        {splitLayouts.map((layout) => (
          <button
            key={layout.id}
            type="button"
            className="cgv-layout"
            data-testid={`split-${layout.id}`}
            title={`${layout.label}: fills ${layout.cells.length} cells with the selected clips`}
            aria-label={`${layout.label} split screen`}
            disabled={disabled || selected.length === 0}
            onClick={() => split(layout)}
          >
            <LayoutIcon layout={layout} />
          </button>
        ))}
      </div>
      <p className="cgv-muted">
        {selected.length > 1
          ? `A split screen fills its cells with the ${selected.length} selected clips, first selected first.`
          : 'Select clips on stacked tracks, then pick a split screen to fill with them.'}
      </p>
    </Section>
  );
}

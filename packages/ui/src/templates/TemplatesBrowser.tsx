import { useMemo, useState } from 'react';
import { CgButton } from '@cashgear/ui';
import { FLICKS_PER_SECOND, type Project } from '@cgv/engine-client';
import type { EditorState } from '../editing/useEditor';
import { fillTargets, slotsOf } from './apply';
import { projectTemplates, templateSummary, type ProjectTemplate } from './templates';

/** The template's first track as a strip of its clips, slots highlighted. */
function Storyboard({ template }: { template: ProjectTemplate }) {
  const clips = template.tracks[0]?.clips ?? [];
  const shape = template.aspect ?? 'landscape';
  return (
    <span className={`cgv-storyboard cgv-storyboard-${shape}`} aria-hidden>
      {clips.map((clip, index) => (
        <span
          key={index}
          className={clip.type === 'slot' ? 'cgv-storyboard-slot' : 'cgv-storyboard-fixed'}
          style={{ flexGrow: clip.seconds }}
        >
          {clip.type === 'slot' ? clip.slot : ''}
        </span>
      ))}
    </span>
  );
}

/** Picture media of the project, in the order the media library lists them. */
function pictureMedia(project: Project) {
  return project.media.filter(
    (media) => media.hasVideo && !media.id.startsWith('sticker-') && media.kind !== 'audio',
  );
}

/**
 * The open project's slots: pick media in order, then fill. A slot also fills
 * when media is dropped on it in the timeline.
 */
function SlotFiller({ editor, project }: { editor: EditorState; project: Project }) {
  const slots = [...slotsOf(project)];
  const media = pictureMedia(project);
  const [picked, setPicked] = useState<string[]>([]);
  const chosen = picked.filter((id) => media.some((m) => m.id === id));
  const toggle = (id: string) =>
    setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const names = new Map(project.media.map((m) => [m.id, m.name]));
  const targets = fillTargets(project).length;
  const count = Math.min(chosen.length, targets);
  return (
    <div className="cgv-effects-group cgv-slots" data-testid="template-slots">
      <h3>Slots</h3>
      <ol className="cgv-slot-list">
        {slots.map(([slot, clip]) => (
          <li key={slot} data-testid="template-slot" data-filled={!!clip.media}>
            <span className="cgv-slot-number">{slot}</span>
            <span className="cgv-slot-name">
              {clip.media ? (names.get(clip.media) ?? clip.media) : 'Empty'}
            </span>
            <span className="cgv-muted">
              {Number((clip.duration / FLICKS_PER_SECOND).toFixed(1))} s
            </span>
          </li>
        ))}
      </ol>
      {media.length ? (
        <>
          <p className="cgv-muted cgv-slot-help">
            Pick clips in the order they should play, or drop one on a slot in the timeline.
          </p>
          <ul className="cgv-slot-media">
            {media.map((item) => {
              const order = chosen.indexOf(item.id);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className="cgv-slot-pick"
                    aria-pressed={order >= 0}
                    data-testid="template-pick"
                    data-key={item.id}
                    onClick={() => toggle(item.id)}
                  >
                    <span className="cgv-slot-number">{order >= 0 ? order + 1 : ''}</span>
                    <span className="cgv-slot-name">{item.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="cgv-slot-actions">
            <CgButton
              size="small"
              appearance="solid"
              data-testid="template-fill"
              disabled={!count}
              onClick={() => {
                void editor.fillSlots(chosen.slice(0, count));
                setPicked([]);
              }}
            >
              {count ? `Fill ${count} ${count === 1 ? 'slot' : 'slots'}` : 'Fill slots'}
            </CgButton>
            <CgButton
              size="small"
              appearance="ghost"
              data-testid="template-fill-all"
              onClick={() => void editor.fillSlots(media.slice(0, targets).map((m) => m.id))}
            >
              Fill with all media
            </CgButton>
          </div>
        </>
      ) : (
        <p className="cgv-muted cgv-slot-help">Import photos or videos to fill the slots.</p>
      )}
    </div>
  );
}

/**
 * Project templates by category, each previewed by its headline over a sample
 * picture: start a new project from one, or put an intro or outro at the
 * playhead. Then fill its slots with your own clips.
 */
export function TemplatesBrowser({
  editor,
  previews,
}: {
  editor: EditorState;
  previews: Record<string, string>;
}) {
  const [query, setQuery] = useState('');
  const project = editor.project.snapshot?.project ?? null;
  const hasSlots = !!project && slotsOf(project).size > 0;
  const groups = useMemo(() => {
    const words = query.trim().toLowerCase();
    const matching = words
      ? projectTemplates.filter((t) =>
          `${t.name} ${t.category} ${t.description}`.toLowerCase().includes(words),
        )
      : projectTemplates;
    const byCategory = new Map<string, ProjectTemplate[]>();
    for (const template of matching) {
      const list = byCategory.get(template.category) ?? [];
      list.push(template);
      byCategory.set(template.category, list);
    }
    return [...byCategory];
  }, [query]);
  return (
    <section className="cgv-effects" data-testid="template-browser" aria-label="Templates">
      {hasSlots && project && <SlotFiller editor={editor} project={project} />}
      <input
        className="cgv-effects-search"
        type="search"
        placeholder="Search templates"
        aria-label="Search templates"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {groups.map(([category, list]) => (
        <div key={category} className="cgv-effects-group">
          <h3>{category}</h3>
          <ul className="cgv-template-list">
            {list.map((template) => (
              <li
                key={template.id}
                className="cgv-template"
                data-testid="template-item"
                data-key={template.id}
              >
                {previews[template.id] ? (
                  <img className="cgv-template-thumb" src={previews[template.id]} alt="" />
                ) : (
                  <span className="cgv-template-thumb" aria-hidden />
                )}
                <span className="cgv-template-text">
                  <span className="cgv-template-name">{template.name}</span>
                  <span className="cgv-muted cgv-template-summary">
                    {templateSummary(template)}
                  </span>
                </span>
                <span className="cgv-muted cgv-template-description">{template.description}</span>
                <span className="cgv-template-foot">
                  <Storyboard template={template} />
                  <CgButton
                    size="small"
                    appearance={template.kind === 'project' ? 'solid' : 'outline'}
                    data-testid="template-use"
                    title={
                      template.kind === 'project'
                        ? 'Start a new project from this template'
                        : 'Add it at the playhead'
                    }
                    onClick={() => void editor.applyTemplate(template)}
                  >
                    {template.kind === 'project' ? 'Use' : 'Add'}
                  </CgButton>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {!groups.length && <p className="cgv-muted">Nothing matches.</p>}
    </section>
  );
}

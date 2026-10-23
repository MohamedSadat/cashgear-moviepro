import { useState } from 'react';
import { formatWhen } from './format';
import type { ProjectState } from './useProject';

interface Props {
  project: ProjectState;
  onOpenProjects(): void;
  onOpenSettings(): void;
}

function SaveState({ project }: { project: ProjectState }) {
  const snapshot = project.snapshot;
  if (!snapshot) return null;
  if (snapshot.dirty)
    return (
      <span
        className="cgv-save-state cgv-save-state-dirty"
        data-testid="save-state"
        data-state="dirty"
      >
        {snapshot.needsAutosave ? 'Unsaved changes' : 'Unsaved changes (autosaved)'}
      </span>
    );
  const when = formatWhen(project.entry?.savedAt);
  return (
    <span className="cgv-save-state" data-testid="save-state" data-state="saved">
      {when ? `Saved ${when}` : 'Saved'}
    </span>
  );
}

/** Project name, save state, and the project and undo commands. */
export function ProjectBar({ project, onOpenProjects, onOpenSettings }: Props) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const snapshot = project.snapshot;
  const disabled = !snapshot || project.busy;
  const commit = () => {
    setEditing(false);
    if (snapshot && name.trim() && name.trim() !== snapshot.project.name) void project.rename(name);
  };
  return (
    <div className="cgv-project-bar" data-testid="project-bar" data-busy={project.busy}>
      {editing ? (
        <input
          className="cgv-project-name-input"
          aria-label="Project name"
          value={name}
          autoFocus
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="cgv-project-name"
          data-testid="project-name"
          title="Rename project"
          disabled={!snapshot}
          onClick={() => {
            setName(snapshot?.project.name ?? '');
            setEditing(true);
          }}
        >
          {snapshot?.project.name ?? 'Opening…'}
        </button>
      )}
      <SaveState project={project} />
      <div className="cgv-toolbar" role="toolbar" aria-label="Project">
        <button type="button" onClick={() => void project.newProject()} disabled={disabled}>
          New
        </button>
        <button type="button" onClick={onOpenProjects} disabled={project.busy}>
          Open…
        </button>
        <button
          type="button"
          onClick={() => void project.save()}
          disabled={disabled}
          title="Save (Ctrl+S)"
        >
          Save
        </button>
        {project.savesInPlace ? (
          project.canExport && (
            <button type="button" onClick={() => void project.exportFile()} disabled={disabled}>
              Export file
            </button>
          )
        ) : (
          <button
            type="button"
            onClick={() => void project.saveAs()}
            disabled={disabled}
            title="Save as (Ctrl+Shift+S)"
          >
            Save as…
          </button>
        )}
        <span className="cgv-toolbar-gap" />
        <button
          type="button"
          onClick={() => void project.undo()}
          disabled={!snapshot?.canUndo}
          title={snapshot?.undoLabel ? `Undo ${snapshot.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}
          data-testid="undo"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => void project.redo()}
          disabled={!snapshot?.canRedo}
          title={snapshot?.redoLabel ? `Redo ${snapshot.redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)'}
          data-testid="redo"
        >
          Redo
        </button>
        <span className="cgv-toolbar-gap" />
        <button type="button" onClick={onOpenSettings} disabled={disabled}>
          Settings
        </button>
      </div>
    </div>
  );
}

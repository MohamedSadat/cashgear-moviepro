import { useState } from 'react';
import { Dialog } from '../project/Dialog';
import type { ProjectState } from '../project/useProject';
import type { UpdatesState } from './useUpdates';

/** A newer version: what it is, and installing it once the project is safe. */
export function UpdateDialog({
  updates,
  project,
  exporting,
  onClose,
}: {
  updates: UpdatesState;
  project: ProjectState;
  /** An export is running: installing would stop it. */
  exporting: boolean;
  onClose(): void;
}) {
  const [saving, setSaving] = useState(false);
  const { available, installing, error } = updates;
  if (!available) return null;
  const dirty = !!project.snapshot?.dirty;
  const install = async () => {
    if (dirty) {
      setSaving(true);
      const saved = await project.save().finally(() => setSaving(false));
      if (!saved) return;
    }
    await updates.install();
  };
  return (
    <Dialog
      title="Update CashGear Video"
      onClose={installing ? undefined : onClose}
      testId="update-dialog"
      footer={
        <>
          <button
            type="button"
            className="cgv-primary"
            data-testid="update-install"
            disabled={!!installing || saving || exporting}
            onClick={() => void install()}
          >
            {dirty ? 'Save and install' : 'Install and restart'}
          </button>
          {!installing && (
            <button type="button" onClick={onClose}>
              Later
            </button>
          )}
        </>
      }
    >
      <p>
        Version <strong>{available.version}</strong> is ready. Installing it closes CashGear Video
        and opens the new version.
      </p>
      {available.notes && <p className="cgv-muted cgv-update-notes">{available.notes}</p>}
      {exporting && <p className="cgv-warning">Install it once the export has finished.</p>}
      {installing && (
        <div
          className="cgv-progress"
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((installing.fraction ?? 0) * 100)}
        >
          <div
            className="cgv-progress-bar"
            style={{ width: `${(installing.fraction ?? 0) * 100}%` }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="cgv-warning" data-testid="update-error">
          The update failed: {error}
        </p>
      )}
    </Dialog>
  );
}

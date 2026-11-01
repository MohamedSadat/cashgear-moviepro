import { useEffect, useState } from 'react';
import { CgButton } from '@cashgear/ui';
import {
  exportTimeline,
  type EngineClient,
  type ExportedTimeline,
  type TimelineFormat,
} from '@cgv/engine-client';
import type { ProjectState } from '../project/useProject';
import { Dialog } from '../project/Dialog';

const formats: { value: TimelineFormat; label: string; note: string }[] = [
  {
    value: 'otio',
    label: 'OpenTimelineIO (.otio)',
    note: 'For DaVinci Resolve and newer versions of Premiere Pro.',
  },
  {
    value: 'fcp7',
    label: 'FCP7 XML (.xml)',
    note: 'For Premiere Pro and DaVinci Resolve, and most other editors.',
  },
];

/** What a timeline leaves behind, in words. */
function LeftOut({ items, heading }: { items: string[]; heading: string }) {
  if (!items.length) return null;
  return (
    <>
      <p className="cgv-muted">{heading}</p>
      <ul className="cgv-exchange-left-out" data-testid="exchange-left-out">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * Sends the timeline on show to another editor: picks a format, says what it
 * can't hold (titles, effects, masks), and saves the file.
 */
export function ExportTimelineDialog({
  client,
  project,
  onClose,
}: {
  client: EngineClient | null;
  project: ProjectState;
  onClose(): void;
}) {
  const [format, setFormat] = useState<TimelineFormat>('otio');
  const [exported, setExported] = useState<ExportedTimeline | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const current = project.snapshot?.project;
  const sequence = current?.openSequence ?? null;
  const shown = current?.sequences?.find((item) => item.id === sequence)?.name ?? current?.name;

  useEffect(() => {
    let live = true;
    setExported(null);
    void (async () => {
      try {
        const saved = await client!.api.projectSave();
        const made = await exportTimeline(saved.text, sequence, format);
        if (live) setExported(made);
      } catch (error) {
        if (live) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [client, format, sequence]);

  const save = async () => {
    if (!exported) return;
    const saved = await project.saveTimeline(shown ?? 'Timeline', format, exported.text);
    if (saved) onClose();
  };

  return (
    <Dialog
      title="Export timeline"
      onClose={onClose}
      testId="export-timeline-dialog"
      footer={
        <>
          <CgButton appearance="ghost" onClick={onClose}>
            Cancel
          </CgButton>
          <CgButton
            appearance="solid"
            disabled={!exported}
            data-testid="export-timeline-save"
            onClick={() => void save()}
          >
            Export
          </CgButton>
        </>
      }
    >
      <p className="cgv-muted">
        Sends the cut of {shown} to another editor, with links to its media.
      </p>
      <label className="cgv-field">
        <span className="cgv-field-label">Format</span>
        <select
          data-testid="export-timeline-format"
          value={format}
          onChange={(event) => setFormat(event.currentTarget.value as TimelineFormat)}
        >
          {formats.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p className="cgv-muted">{formats.find((option) => option.value === format)?.note}</p>
      {problem && (
        <p role="alert" className="cgv-dialog-error">
          {problem}
        </p>
      )}
      <LeftOut items={exported?.leftOut ?? []} heading="These stay behind:" />
    </Dialog>
  );
}

/** Says what an imported timeline could not bring with it. */
export function ImportReportDialog({ leftOut, onClose }: { leftOut: string[]; onClose(): void }) {
  return (
    <Dialog
      title="Timeline imported"
      onClose={onClose}
      testId="import-report-dialog"
      footer={
        <CgButton appearance="solid" onClick={onClose}>
          OK
        </CgButton>
      }
    >
      <LeftOut items={leftOut} heading="These could not be shown:" />
    </Dialog>
  );
}

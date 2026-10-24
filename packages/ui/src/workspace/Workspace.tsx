import type { ReactNode } from 'react';
import { CgSplitter, type CgSplitterState } from '@cashgear/ui';

interface Props {
  library: ReactNode;
  monitor: ReactNode;
  inspector: ReactNode;
  timeline: ReactNode;
  /** Saved panel sizes by splitter. */
  layout: Record<string, unknown>;
  onLayout(layout: Record<string, unknown>): void;
}

function saved(layout: Record<string, unknown>, key: string): CgSplitterState | undefined {
  const state = layout[key] as CgSplitterState | undefined;
  return state && state.version === 1 && Array.isArray(state.panes) ? state : undefined;
}

/**
 * The editing workspace: media library, program monitor and inspector side by
 * side above the timeline. Every divider can be dragged (or moved with the arrow
 * keys), and the sizes are remembered for this user.
 */
export function Workspace({ library, monitor, inspector, timeline, layout, onLayout }: Props) {
  const keep = (key: string) => (state: CgSplitterState) => onLayout({ ...layout, [key]: state });
  const top = (
    <CgSplitter
      className="cgv-workspace-top"
      orientation="horizontal"
      gutterSize="6px"
      defaultState={saved(layout, 'top')}
      onStateChange={keep('top')}
      panes={[
        {
          key: 'library',
          size: '22%',
          minimumSize: '200px',
          className: 'cgv-pane',
          ariaLabel: 'Media library panel',
          renderContent: () => library,
        },
        {
          key: 'monitor',
          minimumSize: '320px',
          className: 'cgv-pane',
          ariaLabel: 'Program monitor panel',
          renderContent: () => monitor,
        },
        {
          key: 'inspector',
          size: '22%',
          minimumSize: '220px',
          className: 'cgv-pane',
          ariaLabel: 'Inspector panel',
          renderContent: () => inspector,
        },
      ]}
    />
  );
  return (
    <CgSplitter
      className="cgv-workspace"
      orientation="vertical"
      gutterSize="6px"
      defaultState={saved(layout, 'main')}
      onStateChange={keep('main')}
      panes={[
        {
          key: 'top',
          minimumSize: '220px',
          className: 'cgv-pane',
          ariaLabel: 'Media and monitor',
          renderContent: () => top,
        },
        {
          key: 'timeline',
          size: '42%',
          minimumSize: '160px',
          className: 'cgv-pane',
          ariaLabel: 'Timeline panel',
          renderContent: () => timeline,
        },
      ]}
    />
  );
}

import { useState, type ReactNode } from 'react';

export interface LibraryTab {
  id: string;
  label: string;
  render(): ReactNode;
}

/**
 * A panel's tabs: the left panel's media, effects and transitions, as in
 * Filmora, or the right panel's inspector and mixer. `name` prefixes ids.
 */
export function LibraryTabs({
  tabs,
  onSelect,
  label = 'Library',
  name = 'library',
}: {
  tabs: LibraryTab[];
  onSelect?(id: string): void;
  label?: string;
  name?: string;
}) {
  const [active, setActive] = useState(tabs[0].id);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  return (
    <div className="cgv-library-tabs">
      <div className="cgv-tab-bar" role="tablist" aria-label={label}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${name}-tab-${tab.id}`}
            aria-selected={tab.id === current.id}
            aria-controls={`${name}-panel-${tab.id}`}
            data-testid={`${name}-tab-${tab.id}`}
            className="cgv-tab"
            onClick={() => {
              setActive(tab.id);
              onSelect?.(tab.id);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        className="cgv-tab-panel"
        role="tabpanel"
        id={`${name}-panel-${current.id}`}
        aria-labelledby={`${name}-tab-${current.id}`}
      >
        {current.render()}
      </div>
    </div>
  );
}

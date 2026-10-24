import { useState, type ReactNode } from 'react';

export interface LibraryTab {
  id: string;
  label: string;
  render(): ReactNode;
}

/** The left panel's tabs: media, effects and transitions, as in Filmora. */
export function LibraryTabs({
  tabs,
  onSelect,
}: {
  tabs: LibraryTab[];
  onSelect?(id: string): void;
}) {
  const [active, setActive] = useState(tabs[0].id);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  return (
    <div className="cgv-library-tabs">
      <div className="cgv-tab-bar" role="tablist" aria-label="Library">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`library-tab-${tab.id}`}
            aria-selected={tab.id === current.id}
            aria-controls={`library-panel-${tab.id}`}
            data-testid={`library-tab-${tab.id}`}
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
        id={`library-panel-${current.id}`}
        aria-labelledby={`library-tab-${current.id}`}
      >
        {current.render()}
      </div>
    </div>
  );
}

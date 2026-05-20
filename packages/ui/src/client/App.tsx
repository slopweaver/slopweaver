import { type ReactElement, useState } from 'react';
import './App.css';
import { Diagnostics } from './pages/Diagnostics.tsx';
import { Stakeholders } from './pages/Stakeholders.tsx';

type Tab = 'diagnostics' | 'stakeholders';

/**
 * Top-level shell. Single-process tab state via `useState` — no
 * router, no URL sync.
 *
 * Note: PR #61 (Evidence) and PR #63 (Calibration) also add parallel
 * tab arms. When all three merge, dedupe the tab list + switch arms
 * + the tab-nav CSS block.
 */
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'stakeholders', label: 'Stakeholders' },
];

export function App(): ReactElement {
  const [activeTab, setActiveTab] = useState<Tab>('diagnostics');
  return (
    <div className="flight-deck">
      <nav className="flight-deck__tabs" aria-label="primary">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`flight-deck__tab${tab.id === activeTab ? ' flight-deck__tab--active' : ''}`}
            onClick={() => {
              setActiveTab(tab.id);
            }}
            aria-current={tab.id === activeTab ? 'page' : undefined}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {renderActiveTab(activeTab)}
    </div>
  );
}

function renderActiveTab(tab: Tab): ReactElement {
  switch (tab) {
    case 'diagnostics':
      return <Diagnostics />;
    case 'stakeholders':
      return <Stakeholders />;
  }
}

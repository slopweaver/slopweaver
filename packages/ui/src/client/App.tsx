import { type ReactElement, useState } from 'react';
import './App.css';
import { Calibration } from './pages/Calibration.tsx';
import { Diagnostics } from './pages/Diagnostics.tsx';

type Tab = 'diagnostics' | 'calibration';

/**
 * Top-level shell. Single-process tab state via `useState` — no
 * router, no URL sync (page count too small for either to pay back).
 *
 * Adding a new tab: append to `TABS`, create the matching page
 * component, add the switch arm in `renderActiveTab`.
 *
 * Note: PR #61 (flight-deck Evidence tab) ships a parallel tab arm.
 * When both merge, resolve the conflict by combining both tab lists +
 * both switch arms.
 */
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'calibration', label: 'Calibration' },
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
    case 'calibration':
      return <Calibration />;
  }
}

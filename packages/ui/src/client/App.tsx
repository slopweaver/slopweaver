import { type ReactElement, useState } from 'react';
import './App.css';
import { Calibration } from './pages/Calibration.tsx';
import { Diagnostics } from './pages/Diagnostics.tsx';
import { Evidence } from './pages/Evidence.tsx';
import { Stakeholders } from './pages/Stakeholders.tsx';

type Tab = 'diagnostics' | 'evidence' | 'calibration' | 'stakeholders';

/**
 * Top-level shell for the flight-deck UI. Single-process tab state
 * via `useState`. No router, no URL sync. The page count stays small
 * enough that the cost of bringing in react-router doesn't pay back.
 *
 * Adding a new tab: append to `TABS`, create the matching page
 * component, add the switch arm in `renderActiveTab`. Three files
 * touched per tab.
 */
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'calibration', label: 'Calibration' },
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
    case 'evidence':
      return <Evidence />;
    case 'calibration':
      return <Calibration />;
    case 'stakeholders':
      return <Stakeholders />;
  }
}

import type { ReactElement } from 'react';
import './App.css';
import { Diagnostics } from './pages/Diagnostics.tsx';

/**
 * Top-level React component for the Diagnostics SPA. Renders the single
 * Diagnostics page — there is no router; this app has exactly one screen.
 */
export function App(): ReactElement {
  return <Diagnostics />;
}

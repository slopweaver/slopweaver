import { type ReactElement, useEffect, useState } from 'react';
import { fetchStakeholders, type StakeholdersResponse } from '../api/stakeholders.ts';

const POLL_INTERVAL_MS = 30_000;

/**
 * Stakeholders tab. Ships a ranked list of identifiers ordered by
 * interaction volume in `evidence_log`, with a relative-size dot next
 * to each entry to convey "who do I talk to most" at a glance.
 *
 * The originating issue's framing was a *graph* (edges between
 * stakeholders by co-occurrence on the same evidence row, with a
 * force-directed layout). That's deferred: the ranked list is the
 * shippable, useful-today subset of the same data, and a denser
 * interaction graph plus a graph library can land later without
 * changing the underlying aggregation. This page is intentionally
 * named "Stakeholders" rather than "Stakeholder graph" so the title
 * matches what's on screen.
 */
export function Stakeholders(): ReactElement {
  const [data, setData] = useState<StakeholdersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetchStakeholders();
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const id = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (loading && data === null && error === null) {
    return (
      <main className="diagnostics">
        <p>Loading stakeholders...</p>
      </main>
    );
  }

  return (
    <main className="diagnostics">
      <header>
        <h1>Stakeholders</h1>
        <p className="hint">
          {data ? `Top ${data.entries.length} of ${data.total} stakeholders by interaction volume` : 'No data yet'}
        </p>
      </header>
      {error !== null && (
        <div role="alert" className="banner banner--error">
          /api/stakeholders: {error}
        </div>
      )}
      {data !== null && data.entries.length === 0 && (
        <p className="empty">
          No stakeholders inferred from <code>evidence_log</code> yet. Connect an MCP server (Slack, GitHub) and run
          <code> /session-start</code> to populate.
        </p>
      )}
      {data !== null && data.entries.length > 0 && <StakeholderList entries={data.entries} />}
    </main>
  );
}

function StakeholderList({
  entries,
}: {
  entries: ReadonlyArray<{ identifier: string; interactions: number; last_seen: string }>;
}): ReactElement {
  const max = entries[0]?.interactions ?? 1;
  return (
    <ul className="stakeholder-list">
      {entries.map((entry) => {
        const size = Math.max(8, Math.round(8 + (entry.interactions / max) * 32));
        return (
          <li key={entry.identifier} className="stakeholder-list__item">
            <span
              className="stakeholder-list__dot"
              style={{ width: `${size}px`, height: `${size}px` }}
              aria-hidden="true"
            />
            <span className="stakeholder-list__identifier">{entry.identifier}</span>
            <span className="stakeholder-list__count">{entry.interactions}</span>
            <span className="stakeholder-list__time">{new Date(entry.last_seen).toLocaleDateString()}</span>
          </li>
        );
      })}
    </ul>
  );
}

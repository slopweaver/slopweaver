import { type ReactElement, useEffect, useState } from 'react';
import { fetchStakeholders, type StakeholdersResponse } from '../api/stakeholders.ts';

const POLL_INTERVAL_MS = 30_000;

/**
 * Stakeholders tab. v1.1 first cut: a ranked list with relative-size
 * circles next to each entry. Not a real force-graph layout yet —
 * that's a v1.2 follow-up once we have a denser interaction graph to
 * lay out. For now the relative-size visual conveys the same "who do
 * I talk to most" answer without pulling in a graph library.
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

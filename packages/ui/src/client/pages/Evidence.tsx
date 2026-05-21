import { type ReactElement, useEffect, useState } from 'react';
import { fetchEvidenceTail, type EvidenceTailResponse, type EvidenceTailRow } from '../api/evidence.ts';

const POLL_INTERVAL_MS = 10_000;

/**
 * Live tail of `evidence_log`. Polls `/api/evidence` every 10s and
 * renders the most-recent N rows. Title is hyperlinked when the row
 * has a citation_url, plain text otherwise. The integration + kind
 * pair shows as a compact prefix chip.
 *
 * Matches the polling discipline of the existing Diagnostics page:
 * skip overlapping requests, clean cancellation on unmount, top-of-
 * page error banner when the fetch itself fails.
 */
export function Evidence(): ReactElement {
  const [data, setData] = useState<EvidenceTailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetchEvidenceTail();
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
        <p>Loading evidence tail...</p>
      </main>
    );
  }

  return (
    <main className="diagnostics">
      <header>
        <h1>Evidence tail</h1>
        <p className="hint">
          {data
            ? `Showing ${data.rows.length} of ${data.total_in_db} rows · updated ${new Date(data.generated_at).toLocaleTimeString()}`
            : 'No data yet'}
        </p>
      </header>
      {error !== null && (
        <div role="alert" className="banner banner--error">
          /api/evidence: {error}
        </div>
      )}
      {data !== null && (
        <section>
          {data.rows.length === 0 ? (
            <p className="empty">No evidence rows yet. Run a /session-start or wait for a poll to populate.</p>
          ) : (
            <ul className="evidence-list">
              {data.rows.map((row) => (
                <EvidenceItem key={row.id} row={row} />
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

function EvidenceItem({ row }: { row: EvidenceTailRow }): ReactElement {
  return (
    <li className="evidence-item">
      <span className="evidence-item__chip">
        <code>
          {row.integration}/{row.kind}
        </code>
      </span>
      <span className="evidence-item__title">
        {row.citation_url !== null ? (
          <a href={row.citation_url} target="_blank" rel="noreferrer">
            {row.title}
          </a>
        ) : (
          row.title
        )}
      </span>
      <span className="evidence-item__time">{new Date(row.occurred_at).toLocaleString()}</span>
    </li>
  );
}

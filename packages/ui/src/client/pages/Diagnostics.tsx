import { useEffect, useState } from 'react';
import { fetchDiagnostics } from '../api/diagnostics.ts';
import type { DiagnosticsResponse, EnvCheck, IntegrationStatus } from '../api/diagnostics.ts';

const POLL_INTERVAL_MS = 30_000;

export function Diagnostics() {
  const [data, setData] = useState<DiagnosticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async (): Promise<void> => {
      // Skip overlapping requests so a slow earlier fetch can't overwrite the
      // newer state when its response finally arrives.
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetchDiagnostics();
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
        <p>Loading diagnostics...</p>
      </main>
    );
  }

  return (
    <main className="diagnostics">
      <header>
        <h1>SlopWeaver Diagnostics</h1>
        <p className="hint">
          {data ? `Updated ${new Date(data.generatedAtMs).toLocaleTimeString()}` : 'No data yet'}
        </p>
      </header>
      {error !== null && (
        <div role="alert" className="banner banner--error">
          /api/diagnostics: {error}
        </div>
      )}
      {data && <DiagnosticsBody data={data} />}
    </main>
  );
}

function DiagnosticsBody({ data }: { data: DiagnosticsResponse }) {
  return (
    <>
      <section>
        <h2>Environment</h2>
        <CheckRow check={data.env.node} />
        <CheckRow check={data.env.pnpm} />
        <CheckRow check={data.env.dataDir} />
      </section>
      <section>
        <h2>Server</h2>
        <p>
          Listening on{' '}
          <code>
            http://{data.server.host}:{data.server.port}
          </code>
        </p>
      </section>
      <section>
        <h2>Integrations</h2>
        {data.integrations.length === 0 ? (
          <p className="empty">No integrations connected yet.</p>
        ) : (
          <IntegrationsTable rows={data.integrations} />
        )}
      </section>
      <section>
        <h2>MCP clients</h2>
        <p>
          {data.mcpClients.count} client(s) over <code>{data.mcpClients.transport}</code>
          {data.mcpClients.tracked ? '' : ' (count not tracked yet)'}.
        </p>
      </section>
    </>
  );
}

function CheckRow({ check }: { check: EnvCheck }) {
  return (
    <p className={`check check--${check.status}`}>
      <span className="check__name">{check.name}</span>
      <span className={`badge badge--${check.status}`}>{check.status}</span>
      <span className="check__detail">{check.detail}</span>
    </p>
  );
}

function IntegrationsTable({ rows }: { rows: IntegrationStatus[] }) {
  return (
    <table className="integrations">
      <thead>
        <tr>
          <th>integration</th>
          <th>last started</th>
          <th>last completed</th>
          <th>status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const status =
            r.lastPollCompletedAtMs === null ? 'never run' : r.stale ? 'stale' : 'fresh';
          const badge = status === 'fresh' ? 'ok' : status === 'never run' ? 'warn' : 'fail';
          return (
            <tr key={r.integration}>
              <td>
                <code>{r.integration}</code>
              </td>
              <td>{formatTime({ ms: r.lastPollStartedAtMs })}</td>
              <td>{formatTime({ ms: r.lastPollCompletedAtMs })}</td>
              <td>
                <span className={`badge badge--${badge}`}>{status}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function formatTime({ ms }: { ms: number | null }): string {
  return ms === null ? '—' : new Date(ms).toLocaleString();
}

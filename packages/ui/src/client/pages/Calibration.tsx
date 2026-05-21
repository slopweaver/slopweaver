import { type ReactElement, useEffect, useState } from 'react';
import {
  fetchCalibration,
  type CalibrationBreakdown,
  type CalibrationPoint,
  type CalibrationResponse,
} from '../api/calibration.ts';

const POLL_INTERVAL_MS = 30_000;

/**
 * Calibration tab — visualizes the `/lock-in` walk-feedback log.
 * Acceptance / edit / rejection rates as numeric tiles, a daily ratio
 * chart rendered as inline SVG (no chart library — keeps bundle tight),
 * two per-axis breakdown tables (integration, kind), and a horizontal
 * bar list of the top friction tags.
 *
 * Empty state covers two conditions: the source log is missing **or**
 * the log exists but has no walks/items yet. Both render the same
 * "run a /lock-in walk" pointer.
 */
export function Calibration(): ReactElement {
  const [data, setData] = useState<CalibrationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await fetchCalibration();
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
        <p>Loading calibration data...</p>
      </main>
    );
  }

  const isEmpty = data !== null && (!data.source_present || data.total_walks === 0 || data.total_items === 0);

  return (
    <main className="diagnostics">
      <header>
        <h1>Calibration</h1>
        <p className="hint">
          {data
            ? `Window: ${new Date(data.window_start).toLocaleDateString()} → ${new Date(data.window_end).toLocaleDateString()} · ${data.total_walks} walks · ${data.total_items} items`
            : 'No data yet'}
        </p>
      </header>
      {error !== null && (
        <div role="alert" className="banner banner--error">
          /api/calibration: {error}
        </div>
      )}
      {data !== null && isEmpty && (
        <p className="empty">
          No walks recorded at <code>{data.source_path}</code> yet. Run a <code>/lock-in</code> walk to start populating
          it.
        </p>
      )}
      {data !== null && !isEmpty && <CalibrationBody data={data} />}
    </main>
  );
}

function CalibrationBody({ data }: { data: CalibrationResponse }): ReactElement {
  return (
    <>
      <section>
        <h2>Rates</h2>
        <div className="calibration-tiles">
          <RateTile label="Acceptance" value={data.acceptance_rate} tone="ok" />
          <RateTile label="Edit" value={data.edit_rate} tone="warn" />
          <RateTile label="Rejection" value={data.rejection_rate} tone="fail" />
        </div>
      </section>
      <section>
        <h2>Daily outcomes</h2>
        <DailyChart points={data.daily} />
      </section>
      <section>
        <h2>By integration</h2>
        <BreakdownTable rows={data.by_integration} columnLabel="Integration" />
      </section>
      <section>
        <h2>By kind</h2>
        <BreakdownTable rows={data.by_kind} columnLabel="Kind" />
      </section>
      <section>
        <h2>Top friction tags</h2>
        {data.top_friction_tags.length === 0 ? (
          <p className="empty">No friction tags yet.</p>
        ) : (
          <ul className="friction-tags">
            {data.top_friction_tags.map((tag) => (
              <li key={tag.tag}>
                <code>{tag.tag}</code>
                <span className="friction-tags__count">× {tag.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function RateTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'warn' | 'fail';
}): ReactElement {
  return (
    <div className={`calibration-tile calibration-tile--${tone}`}>
      <span className="calibration-tile__label">{label}</span>
      <span className="calibration-tile__value">{(value * 100).toFixed(1)}%</span>
    </div>
  );
}

function BreakdownTable({
  rows,
  columnLabel,
}: {
  rows: ReadonlyArray<CalibrationBreakdown>;
  columnLabel: string;
}): ReactElement {
  if (rows.length === 0) {
    return <p className="empty">No data yet.</p>;
  }
  return (
    <table className="calibration-breakdown">
      <thead>
        <tr>
          <th scope="col">{columnLabel}</th>
          <th scope="col">Accept</th>
          <th scope="col">Edit</th>
          <th scope="col">Reject</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">
              <code>{row.key}</code>
            </th>
            <td>{row.accept}</td>
            <td>{row.edit}</td>
            <td>{row.reject}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const CHART_WIDTH = 480;
const CHART_HEIGHT = 120;
const CHART_PADDING = 8;

function DailyChart({ points }: { points: ReadonlyArray<CalibrationPoint> }): ReactElement {
  if (points.length === 0) {
    return <p className="empty">No outcomes recorded yet.</p>;
  }
  const hasData = points.some((p) => p.total > 0);
  if (!hasData) return <p className="empty">No outcomes recorded yet.</p>;

  const innerWidth = CHART_WIDTH - CHART_PADDING * 2;
  const innerHeight = CHART_HEIGHT - CHART_PADDING * 2;
  const barWidth = innerWidth / points.length;
  return (
    <svg
      role="img"
      aria-label={`Daily outcome chart, ${points.length} days`}
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      className="calibration-chart"
    >
      <title>Daily outcome ratios</title>
      {points.map((point, i) => {
        const x = CHART_PADDING + i * barWidth;
        // y-axis is 0 → 1 (100%). Days with zero events stack to a
        // visible-but-empty column so the time series isn't punctured.
        const segments: ReactElement[] = [];
        let y = CHART_HEIGHT - CHART_PADDING;
        for (const seg of RATIO_SEGMENTS) {
          const ratio = point[seg.key];
          if (ratio <= 0) continue;
          const h = ratio * innerHeight;
          y -= h;
          segments.push(
            <rect
              key={`${point.day}-${seg.key}`}
              x={x + 1}
              y={y}
              width={Math.max(0, barWidth - 2)}
              height={h}
              fill={seg.color}
            >
              <title>{`${point.day} · ${seg.label} ${(ratio * 100).toFixed(0)}% (${ratioCount({ point, key: seg.key })}/${point.total})`}</title>
            </rect>,
          );
        }
        return (
          <g key={point.day}>
            {segments}
            <title>{`${point.day} · ${point.total} items`}</title>
          </g>
        );
      })}
    </svg>
  );
}

type RatioKey = 'accept_ratio' | 'edit_ratio' | 'reject_ratio';
type RatioSegment = { key: RatioKey; label: string; color: string };

// Order matches the rate tiles (accept → edit → reject) so visual
// correspondence is consistent across the page.
const RATIO_SEGMENTS: ReadonlyArray<RatioSegment> = [
  { key: 'accept_ratio', label: 'accept', color: '#16a34a' },
  { key: 'edit_ratio', label: 'edit', color: '#eab308' },
  { key: 'reject_ratio', label: 'reject', color: '#dc2626' },
];

function ratioCount({ point, key }: { point: CalibrationPoint; key: RatioKey }): number {
  switch (key) {
    case 'accept_ratio':
      return point.approved;
    case 'edit_ratio':
      return point.edited;
    case 'reject_ratio':
      return point.rejected;
  }
}

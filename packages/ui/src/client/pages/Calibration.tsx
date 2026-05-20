import { type ReactElement, useEffect, useState } from 'react';
import { fetchCalibration, type CalibrationPoint, type CalibrationResponse } from '../api/calibration.ts';

const POLL_INTERVAL_MS = 30_000;

/**
 * Calibration tab — visualizes the `/lock-in` walk-feedback log.
 * Acceptance / edit / rejection rates as numeric tiles, a tiny daily
 * trend chart rendered as inline SVG (no chart library — keeps bundle
 * tight), and a horizontal bar list of the top friction tags.
 *
 * The chart uses absolute counts per day (stacked bars: approved /
 * edited / rejected). When the source log is missing we render an
 * empty state with a one-liner explaining how to populate it.
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
      {data !== null && !data.source_present && (
        <p className="empty">
          No walk-feedback log at <code>{data.source_path}</code> yet. Run a <code>/lock-in</code> walk to start
          populating it.
        </p>
      )}
      {data !== null && data.source_present && <CalibrationBody data={data} />}
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

const CHART_WIDTH = 480;
const CHART_HEIGHT = 120;
const CHART_PADDING = 8;

function DailyChart({ points }: { points: ReadonlyArray<CalibrationPoint> }): ReactElement {
  if (points.length === 0) {
    return <p className="empty">No outcomes recorded yet.</p>;
  }
  const max = points.reduce(
    (acc, p) => Math.max(acc, p.approved + p.edited + p.rejected + p.deferred + p.dropped + p.noted),
    0,
  );
  if (max === 0) return <p className="empty">No outcomes recorded yet.</p>;
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
      <title>Daily outcome chart</title>
      {points.map((point, i) => {
        const x = CHART_PADDING + i * barWidth;
        const total = point.approved + point.edited + point.rejected + point.deferred + point.dropped + point.noted;
        const scale = innerHeight / max;
        let y = CHART_HEIGHT - CHART_PADDING;
        const segments: ReactElement[] = [];
        for (const [key, color] of SEGMENTS) {
          const h = point[key] * scale;
          if (h <= 0) continue;
          y -= h;
          segments.push(
            <rect key={`${point.day}-${key}`} x={x + 1} y={y} width={Math.max(0, barWidth - 2)} height={h} fill={color}>
              <title>{`${point.day} · ${key} × ${point[key]}`}</title>
            </rect>,
          );
        }
        return (
          <g key={point.day}>
            {segments}
            <title>{`${point.day} · ${total} items`}</title>
          </g>
        );
      })}
    </svg>
  );
}

type NumericCalibrationKey = 'approved' | 'edited' | 'rejected' | 'deferred' | 'dropped' | 'noted';

const SEGMENTS: ReadonlyArray<[NumericCalibrationKey, string]> = [
  ['approved', '#16a34a'],
  ['edited', '#eab308'],
  ['rejected', '#dc2626'],
  ['deferred', '#94a3b8'],
  ['dropped', '#cbd5e1'],
  ['noted', '#a5b4fc'],
];

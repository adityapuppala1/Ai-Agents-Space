import React, { useEffect, useMemo, useState } from "react";
import { Clock3 } from "lucide-react";
import {
  apiFetch,
  useApi,
  formatElapsed,
  formatTime,
  RUN_STATUS_LABELS,
  isActiveRun,
} from "../hooks/useApi.js";
import ProviderBadge from "../components/ProviderBadge.jsx";
import Provenance from "../components/Provenance.jsx";

const LANE = 26;
const LEFT = 190;

/**
 * Runs as horizontal bars over time (SVG) with a replay scrubber. Selecting a
 * run fetches its recorded events; the slider sets a moment and the list
 * shows every event up to it. Replay uses recorded events only.
 * @param {{
 *   workspaceId: string,
 *   runs?: any[],            // optional; falls back to GET /api/workspaces/:id/runs
 *   onOpenRun?: (runId: string) => void,
 *   presentation?: boolean
 * }} props
 */
export default function TimelineView({
  workspaceId,
  runs: givenRuns,
  onOpenRun,
}) {
  const fetched = useApi(
    givenRuns ? null : `/workspaces/${encodeURIComponent(workspaceId)}/runs`,
    { interval: 5000 },
  );
  const runs = useMemo(() => {
    const source =
      givenRuns ??
      (Array.isArray(fetched.data) ? fetched.data : (fetched.data?.runs ?? []));
    return [...source]
      .filter((r) => r.startedAt)
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
      .slice(-60);
  }, [givenRuns, fetched.data]);
  const [selectedId, setSelectedId] = useState(null);
  const [events, setEvents] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const anyActive = runs.some(isActiveRun);
    if (!anyActive) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runs]);

  const selected = runs.find((r) => r.id === selectedId) ?? null;
  useEffect(() => {
    if (!selectedId) return undefined;
    let stopped = false;
    apiFetch(`/runs/${encodeURIComponent(selectedId)}`)
      .then((data) => {
        if (stopped) return;
        const list = [...(data?.events ?? [])].sort(
          (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
        );
        setEvents(list);
        setCursor(list.length ? list[list.length - 1].timestamp : 0);
      })
      .catch(() => !stopped && setEvents([]));
    return () => {
      stopped = true;
    };
  }, [selectedId]);

  const start = runs.length
    ? Math.min(...runs.map((r) => new Date(r.startedAt).getTime()))
    : now - 60000;
  const end = Math.max(
    now,
    ...runs.map((r) => (r.endedAt ? new Date(r.endedAt).getTime() : now)),
  );
  const span = Math.max(end - start, 60000);
  const width = 900;
  const x = (t) => LEFT + ((t - start) / span) * (width - LEFT - 12);
  const height = Math.max(runs.length, 1) * LANE + 40;
  const ticks = 6;

  const eventMin = events.length ? events[0].timestamp : 0;
  const eventMax = events.length ? events[events.length - 1].timestamp : 0;
  const visible = events.filter((e) => e.timestamp <= cursor);

  return (
    <section className="as-timeline" aria-label="Run timeline">
      <header className="as-section-head">
        <h3>
          <Clock3 size={14} aria-hidden="true" /> Timeline
        </h3>
        <span className="as-muted">
          {runs.length} runs · {formatElapsed(span)} window
        </span>
      </header>
      {fetched.error ? (
        <div className="form-error" role="alert">
          {fetched.error.message}
        </div>
      ) : null}
      {runs.length === 0 ? (
        <div className="empty-state">
          <Clock3 size={28} aria-hidden="true" />
          <h3>No runs yet</h3>
          <p>Runs appear here as bars once an agent starts working.</p>
        </div>
      ) : null}
      {runs.length > 0 ? (
        <div className="as-timeline-scroll">
          <svg
            className="as-timeline-svg"
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            height={height}
            role="img"
            aria-label="Runs over time"
          >
            {Array.from({ length: ticks + 1 }, (_, i) => {
              const t = start + (span * i) / ticks;
              return (
                <g key={i}>
                  <line
                    x1={x(t)}
                    x2={x(t)}
                    y1={18}
                    y2={height - 10}
                    className="as-tl-grid"
                  />
                  <text
                    x={x(t)}
                    y={12}
                    textAnchor="middle"
                    className="as-tl-tick"
                  >
                    {formatTime(t)}
                  </text>
                </g>
              );
            })}
            {runs.map((run, i) => {
              const s = new Date(run.startedAt).getTime();
              const e = run.endedAt ? new Date(run.endedAt).getTime() : now;
              const y = 24 + i * LANE;
              const isSel = run.id === selectedId;
              return (
                <g
                  key={run.id}
                  className={`as-tl-row as-tl-${run.status} ${isSel ? "selected" : ""}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${run.title ?? run.id.slice(0, 8)}, ${RUN_STATUS_LABELS[run.status] ?? run.status}, ${formatElapsed(e - s)}`}
                  onClick={() => setSelectedId(run.id)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      setSelectedId(run.id);
                    }
                  }}
                >
                  <text x={4} y={y + 14} className="as-tl-label">
                    {(run.title ?? run.label ?? run.id.slice(0, 8)).slice(
                      0,
                      26,
                    )}
                  </text>
                  <rect
                    x={x(s)}
                    y={y + 3}
                    width={Math.max(3, x(e) - x(s))}
                    height={LANE - 8}
                    rx={4}
                    className="as-tl-bar"
                  />
                  <text x={x(s) + 5} y={y + 15} className="as-tl-bar-text">
                    {RUN_STATUS_LABELS[run.status] ?? run.status}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      ) : null}
      {selected ? (
        <div className="as-replay">
          <div className="as-row as-wrap">
            <ProviderBadge provider={selected.provider} mode={selected.mode} />
            <strong>{selected.title ?? selected.id.slice(0, 8)}</strong>
            <span className="as-tag">replay uses recorded events only</span>
            {onOpenRun ? (
              <button
                type="button"
                className="text-button"
                onClick={() => onOpenRun(selected.id)}
              >
                Open run
              </button>
            ) : null}
          </div>
          <label className="as-scrubber">
            Replay position: {cursor ? formatTime(cursor) : "—"} (
            {visible.length}/{events.length} events)
            <input
              type="range"
              min={eventMin}
              max={eventMax || eventMin + 1}
              step={1}
              value={cursor}
              onChange={(e) => setCursor(Number(e.target.value))}
              disabled={events.length === 0}
              aria-valuetext={cursor ? formatTime(cursor) : "no events"}
            />
          </label>
          <ol
            className="as-events as-events-replay"
            aria-label="Replayed events"
          >
            {visible.length === 0 ? (
              <li className="as-muted">
                No recorded events before this point.
              </li>
            ) : null}
            {visible.slice(-200).map((event) => (
              <li key={event.id} className="as-event">
                <time dateTime={new Date(event.timestamp).toISOString()}>
                  {formatTime(event.timestamp)}
                </time>
                <span className="as-event-kind">{event.kind}</span>
                <span className="as-event-msg">
                  {event.message ?? event.summary}
                </span>
                <span className="as-event-meta">
                  <Provenance value={event.provenance} />
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

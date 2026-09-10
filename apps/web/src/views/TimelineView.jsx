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
import EmptyState from "../components/EmptyState.jsx";
import VirtualList from "../components/VirtualList.jsx";
import EventLink from "../components/EventLink.jsx";
import { useSelection, FilterChips } from "../components/SelectionProvider.jsx";

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
 *   onOpenEvent?: (ref: { runId:string, eventId:string, event:any }) => void,
 *   presentation?: boolean
 * }} props
 *
 * Selection and filters come from SelectionProvider, so the run selected here
 * is the run selected on the Board, in the Office and on the Dependency Map.
 */
export default function TimelineView({
  workspaceId,
  runs: givenRuns,
  onOpenRun,
  onOpenEvent,
}) {
  const selection = useSelection();
  const fetched = useApi(
    givenRuns ? null : `/workspaces/${encodeURIComponent(workspaceId)}/runs`,
    { interval: 5000 },
  );
  const runs = useMemo(() => {
    const source =
      givenRuns ??
      (Array.isArray(fetched.data) ? fetched.data : (fetched.data?.runs ?? []));
    return [...source]
      .filter((r) => r.startedAt && selection.matchesRun(r))
      .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
      .slice(-60);
  }, [givenRuns, fetched.data, selection]);
  const [localSelectedId, setLocalSelectedId] = useState(null);
  const selectedId = selection.selectedRunId ?? localSelectedId;
  const setSelectedId = (runId) => {
    setLocalSelectedId(runId);
    const run = runs.find((entry) => entry.id === runId) ?? null;
    selection.selectRun?.(runId, {
      taskId: run?.taskId ?? undefined,
      agentId: run?.agentId ?? undefined,
    });
  };
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
      <FilterChips label="Filters shared with every view" />
      {fetched.error ? (
        <EmptyState
          compact
          title="Runs could not be loaded"
          error={fetched.error}
          missingRoutes={["GET /api/workspaces/:id/runs"]}
        />
      ) : null}
      {runs.length === 0 ? (
        <EmptyState
          icon={<Clock3 size={28} />}
          title="No runs to place on the timeline"
          description="Runs appear here as bars once an agent starts working. If a filter is active, clear it to see the rest."
          actions={[
            {
              label: "Clear filters",
              onClick: () => selection.clearFilters?.(),
            },
          ]}
        />
      ) : null}
      {runs.length > 0 ? (
        <div className="as-timeline-scroll">
          <svg
            className="as-timeline-svg"
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            height={height}
            // role="group", not "img": an img is a leaf, so browsers prune its
            // whole subtree — which hid every focusable run bar and its
            // aria-label from the accessibility tree.
            role="group"
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
          {visible.length === 0 ? (
            <p className="as-muted">No recorded events before this point.</p>
          ) : (
            <VirtualList
              items={visible}
              itemHeight={26}
              height={260}
              label="Replayed events"
              className="as-events as-events-replay"
              getKey={(event) => event.id}
              stickToBottom
              renderItem={(event) => (
                <span className="as-event">
                  <time dateTime={new Date(event.timestamp).toISOString()}>
                    {formatTime(event.timestamp)}
                  </time>
                  <span className="as-event-kind">{event.kind}</span>
                  <span className="as-event-msg">
                    {event.message ?? event.summary}
                  </span>
                  <span className="as-event-meta">
                    <Provenance value={event.provenance} />
                    <EventLink
                      size="small"
                      event={event}
                      runId={selected.id}
                      label="open"
                      showProvenance={false}
                      onOpenEvent={onOpenEvent}
                    />
                  </span>
                </span>
              )}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}

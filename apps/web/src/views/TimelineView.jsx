import React, { useEffect, useMemo, useRef, useState } from "react";
import { Clock3 } from "lucide-react";
import {
  apiFetch,
  useApi,
  formatElapsed,
  formatTime,
  providerLabel,
  RUN_STATUS_LABELS,
  isActiveRun,
  eventKindLabel,
} from "../hooks/useApi.js";
import { useLocalStorage } from "../hooks/useLocalStorage.js";
import ProviderBadge from "../components/ProviderBadge.jsx";
import Provenance from "../components/Provenance.jsx";
import EmptyState from "../components/EmptyState.jsx";
import VirtualList from "../components/VirtualList.jsx";
import EventLink from "../components/EventLink.jsx";
import { useSelection, FilterChips } from "../components/SelectionProvider.jsx";
import {
  TIMELINE_WINDOWS,
  TIMELINE_ROW_LIMIT,
  placeRuns,
  timeTicks,
  timelineRange,
} from "./timelineLogic.js";

const WINDOW_KEY = "agent-space-timeline-window";

const runTitle = (run) =>
  run.title ?? run.label ?? `Run ${String(run.id).slice(0, 8)}`;

/**
 * Runs as bars over a chosen time window, with a replay scrubber for the
 * selected run. Each row names the run in full (title, provider, status,
 * duration) beside its bar, so a short run is never reduced to an unreadable
 * sliver with its words painted over it. The axis names the day once the
 * window crosses midnight; the right edge is now. Replay uses recorded
 * events only.
 *
 * Selection and filters come from SelectionProvider, so the run selected here
 * is the run selected on the Board, in the Office and on the Dependency Map.
 *
 * @param {{
 *   workspaceId: string,
 *   runs?: any[],            // optional; falls back to GET /api/workspaces/:id/runs
 *   onOpenRun?: (runId: string) => void,
 *   onOpenEvent?: (ref: { runId:string, eventId:string, event:any }) => void,
 *   presentation?: boolean
 * }} props
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
  const allRuns = useMemo(() => {
    const source =
      givenRuns ??
      (Array.isArray(fetched.data) ? fetched.data : (fetched.data?.runs ?? []));
    return source.filter((r) => r.startedAt && selection.matchesRun(r));
  }, [givenRuns, fetched.data, selection]);
  const [windowId, setWindowId] = useLocalStorage(WINDOW_KEY, "24h");
  const windowChoice =
    TIMELINE_WINDOWS.find((entry) => entry.id === windowId) ??
    TIMELINE_WINDOWS[2];

  // The right edge is now: tick each second while a run is live, otherwise
  // every half minute so the window still moves.
  const [now, setNow] = useState(Date.now());
  const anyActive = allRuns.some(isActiveRun);
  useEffect(() => {
    const timer = setInterval(
      () => setNow(Date.now()),
      anyActive ? 1000 : 30000,
    );
    return () => clearInterval(timer);
  }, [anyActive]);

  const range = useMemo(
    () => timelineRange(allRuns, windowChoice.id, now),
    [allRuns, windowChoice.id, now],
  );
  const placed = useMemo(
    () => placeRuns(allRuns, { ...range, now }),
    [allRuns, range, now],
  );
  // Tick density follows the chart's own width, so a phone gets three or
  // four labels that fit and a wide screen gets up to eight.
  const chartRef = useRef(null);
  const [chartWidth, setChartWidth] = useState(900);
  useEffect(() => {
    const node = chartRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) =>
      setChartWidth(entry.contentRect.width),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [placed.rows.length > 0]);
  const narrow = chartWidth <= 560;
  const trackWidth = narrow ? chartWidth - 34 : chartWidth * 0.72 - 28;
  const ticks = useMemo(
    () =>
      timeTicks(range.start, range.end, {
        maxTicks: Math.max(3, Math.min(8, Math.floor(trackWidth / 72))),
      }),
    [range.start, range.end, trackWidth],
  );
  // Leave room at the right edge for the "Now" label.
  const nowZone = 100 - (64 / Math.max(trackWidth, 1)) * 100;

  const [localSelectedId, setLocalSelectedId] = useState(null);
  const selectedId = selection.selectedRunId ?? localSelectedId;
  const setSelectedId = (runId) => {
    setLocalSelectedId(runId);
    const run = allRuns.find((entry) => entry.id === runId) ?? null;
    selection.selectRun?.(runId, {
      taskId: run?.taskId ?? undefined,
      agentId: run?.agentId ?? undefined,
    });
  };
  const [events, setEvents] = useState([]);
  const [cursor, setCursor] = useState(0);
  const selected = allRuns.find((r) => r.id === selectedId) ?? null;
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

  const eventMin = events.length ? events[0].timestamp : 0;
  const eventMax = events.length ? events[events.length - 1].timestamp : 0;
  const visible = events.filter((e) => e.timestamp <= cursor);

  const windowText =
    windowChoice.id === "all"
      ? "since the first recorded run"
      : `in the last ${windowChoice.label}`;
  const summary = `${placed.total} run${placed.total === 1 ? "" : "s"} ${windowText}`;

  return (
    <section className="as-timeline tl" aria-label="Run timeline">
      {/* The page header already names the view; this row says what is in
          the window and lets the user change it. */}
      <header className="tl-head">
        <p className="tl-summary" role="status">
          <Clock3 size={15} aria-hidden="true" /> {summary}
        </p>
        <div className="segmented" role="group" aria-label="Time window">
          {TIMELINE_WINDOWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={windowChoice.id === entry.id}
              onClick={() => setWindowId(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
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
      {allRuns.length === 0 && !fetched.loading ? (
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
      {allRuns.length > 0 && placed.rows.length === 0 ? (
        <EmptyState
          compact
          icon={<Clock3 size={24} />}
          title={`No runs ${windowText}`}
          description={`${allRuns.length} older run${allRuns.length === 1 ? " is" : "s are"} recorded. Choose a longer window to see ${allRuns.length === 1 ? "it" : "them"}.`}
          actions={[{ label: "Show all", onClick: () => setWindowId("all") }]}
        />
      ) : null}
      {placed.rows.length > 0 ? (
        <div className="tl-chart" ref={chartRef}>
          <div className="tl-axis" aria-hidden="true">
            <span className="tl-axis-corner">Run</span>
            <div className="tl-axis-track">
              {ticks
                .filter((tick) => tick.pct <= nowZone)
                .map((tick) => (
                  <span
                    key={tick.t}
                    className={`tl-tick${tick.pct < 4 ? " at-start" : ""}`}
                    style={{ left: `${tick.pct}%` }}
                  >
                    {tick.day ? <b>{tick.day}</b> : null}
                    {tick.time ? <span>{tick.time}</span> : null}
                  </span>
                ))}
              <span className="tl-tick tl-now-label">Now</span>
            </div>
          </div>
          <div className="tl-body">
            <div className="tl-grid" aria-hidden="true">
              {ticks.map((tick) => (
                <i
                  key={tick.t}
                  className={tick.day ? "is-day" : undefined}
                  style={{ left: `${tick.pct}%` }}
                />
              ))}
              <i className="tl-now" />
            </div>
            <ol className="tl-rows" aria-label="Runs over time">
              {placed.rows.map((row) => {
                const { run } = row;
                const isSel = run.id === selectedId;
                const status = RUN_STATUS_LABELS[run.status] ?? run.status;
                const provider =
                  run.provider && run.provider !== "manual"
                    ? providerLabel(run.provider)
                    : null;
                const duration = formatElapsed(row.durationMs);
                const title = runTitle(run);
                const meta = [
                  provider,
                  status,
                  duration,
                  row.beganEarlier ? "began earlier" : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li
                    key={run.id}
                    className={`tl-row tl-${run.status}${isSel ? " is-selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="tl-label"
                      aria-pressed={isSel}
                      aria-label={`${title}. ${meta}`}
                      onClick={() => setSelectedId(run.id)}
                    >
                      <span className="tl-title" title={title}>
                        {title}
                      </span>
                      <span className="tl-meta">{meta}</span>
                    </button>
                    <div
                      className="tl-track"
                      aria-hidden="true"
                      onClick={() => setSelectedId(run.id)}
                    >
                      <span
                        className={`tl-bar${row.beganEarlier ? " began-earlier" : ""}`}
                        style={{ left: `${row.left}%`, width: `${row.width}%` }}
                        title={`${title} · ${meta}`}
                      >
                        {row.solidShare < 1 ? (
                          <span
                            className="tl-bar-gap"
                            style={{ left: `${row.solidShare * 100}%` }}
                          />
                        ) : null}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      ) : null}
      {placed.hidden > 0 ? (
        <p className="as-muted as-small">
          Showing the latest {TIMELINE_ROW_LIMIT} of {placed.total} runs{" "}
          {windowText}. Choose a shorter window, or filter, to see the others.
        </p>
      ) : null}
      {placed.rows.some((row) => row.solidShare < 1) ? (
        <p className="as-muted as-small tl-legend">
          <span className="tl-legend-gap" aria-hidden="true" /> A dotted tail is
          time since a stale run's last recorded event: nothing was recorded
          there.
        </p>
      ) : null}
      {selected ? (
        <div className="as-replay">
          <div className="as-row as-wrap">
            <ProviderBadge provider={selected.provider} mode={selected.mode} />
            <strong>{runTitle(selected)}</strong>
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
                  <span className="as-event-kind">
                    {eventKindLabel(event.kind)}
                  </span>
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

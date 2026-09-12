import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, ArrowUpRight } from "lucide-react";
import EmptyState from "./EmptyState.jsx";
import Provenance from "./Provenance.jsx";
import ActivityBadge from "./ActivityBadge.jsx";
import {
  apiFetch,
  eventKindLabel,
  formatTime,
  maskPathsInText,
  timeAgo,
  useTicker,
} from "../hooks/useApi.js";
import {
  activityDays,
  eventHistoryTotal,
  mergeEventHistory,
} from "../hooks/viewLogic.js";

const PAGE = 100;
const EMPTY_HISTORY = Object.freeze({
  probe: null,
  fetched: [],
  nextBefore: null,
  status: "idle",
  error: "",
});

/**
 * Older events for the Activity page, read a page at a time from
 * GET /api/workspaces/:id/events. The total is read once on arrival so the
 * page can say how much it is showing. A server from before the endpoint
 * answers 404; the page then says what would make older events readable.
 */
function useEventHistory(workspaceId, head) {
  const [history, setHistory] = useState(EMPTY_HISTORY);
  const base = workspaceId
    ? `/workspaces/${encodeURIComponent(workspaceId)}/events`
    : null;

  useEffect(() => {
    setHistory(EMPTY_HISTORY);
    if (!base) return undefined;
    let current = true;
    apiFetch(`${base}?limit=1`)
      .then((data) => {
        if (!current) return;
        setHistory((state) => ({
          ...state,
          probe: {
            total: Number(data?.total),
            newest: data?.newest ?? data?.events?.[0]?.sequence ?? null,
          },
        }));
      })
      .catch((error) => {
        if (!current) return;
        setHistory((state) => ({
          ...state,
          status: error?.status === 404 ? "unsupported" : "idle",
        }));
      });
    return () => {
      current = false;
    };
  }, [base]);

  const loadOlder = useCallback(async () => {
    if (!base) return;
    setHistory((state) => ({ ...state, status: "loading", error: "" }));
    try {
      // The first page starts at the newest event and covers the live head,
      // so nothing that later scrolls off the head goes missing.
      const query = history.nextBefore
        ? `?before=${history.nextBefore}&limit=${PAGE}`
        : `?limit=${head.length + PAGE}`;
      const data = await apiFetch(`${base}${query}`);
      setHistory((state) => ({
        ...state,
        status: "idle",
        fetched: [...state.fetched, ...(data?.events ?? [])],
        nextBefore: data?.nextBefore ?? null,
        probe: {
          total: Number(data?.total),
          newest: data?.newest ?? state.probe?.newest ?? null,
        },
      }));
    } catch (error) {
      setHistory((state) => ({
        ...state,
        status: error?.status === 404 ? "unsupported" : "error",
        error: error?.message ?? "Could not read older events.",
      }));
    }
  }, [base, head.length, history.nextBefore]);

  return { history, loadOlder };
}

/**
 * The Activity page: this workspace's recorded events, newest first, one
 * dense row each: the clock time, what kind of event it is, what it says, and
 * whose it is. Rows are grouped by day. A provider's own events carry no chip
 * (the summary says so); events from Agent Space or a person are marked. The
 * live snapshot holds the latest events; older ones are read on request, and
 * the summary says how many of the recorded total are showing.
 *
 * @param {{
 *   events: any[],
 *   workspaceId?: string,
 *   agents?: { id: string, name: string }[],
 *   presentation?: boolean,
 *   onOpenRun?: (runId: string) => void,
 * }} props
 */
export default function ActivityFeed({
  events = [],
  workspaceId,
  agents = [],
  presentation = false,
  onOpenRun,
}) {
  // Re-render each minute so "4m ago" in the tooltips stays true.
  useTicker(events.length > 0, 60_000);
  const names = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const { history, loadOlder } = useEventHistory(workspaceId, events);
  const shown = useMemo(
    () => mergeEventHistory(events, history.fetched),
    [events, history.fetched],
  );
  const total = eventHistoryTotal(history.probe, events);
  const days = useMemo(() => activityDays(shown), [shown]);
  const moreRecorded =
    total != null &&
    shown.length < total &&
    !(history.fetched.length && !history.nextBefore);

  if (!events.length)
    return (
      <EmptyState
        icon={<Activity size={26} />}
        title="Nothing recorded yet"
        description="Task updates and run events land here as soon as they are recorded, each with its provenance."
      />
    );

  return (
    <div className="feed">
      <p className="feed-summary">
        <span className="live-pill">
          <i className="dot green" aria-hidden="true" />
          Live
        </span>
        <span aria-live="polite">
          {total != null
            ? `Showing ${shown.length.toLocaleString()} of ${Math.max(total, shown.length).toLocaleString()} recorded events, newest first.`
            : `The latest ${shown.length.toLocaleString()} events, newest first.`}{" "}
          Recorded by the provider unless marked.
        </span>
        {onOpenRun ? (
          <span>Open a row to see its run&apos;s full history.</span>
        ) : null}
      </p>
      {days.map((day) => (
        <section
          key={day.day ?? "undated"}
          className="feed-day"
          aria-label={day.label}
        >
          <h2>{day.label}</h2>
          <ul className="feed-list">
            {day.events.map((event) => (
              <li key={event.id}>
                <FeedRow
                  event={event}
                  who={names.get(event.agentId) ?? null}
                  presentation={presentation}
                  onOpenRun={onOpenRun}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="feed-more">
        {moreRecorded && history.status !== "unsupported" ? (
          <button
            type="button"
            className="button"
            disabled={history.status === "loading"}
            onClick={loadOlder}
          >
            {history.status === "loading"
              ? "Reading older events…"
              : `Show ${Math.min(PAGE, total - shown.length).toLocaleString()} older events`}
          </button>
        ) : null}
        {history.status === "error" ? (
          <p className="form-error" role="alert">
            {history.error}
          </p>
        ) : null}
        {history.status === "unsupported" ? (
          <p className="as-muted as-small">
            Older events can be read once the Agent Space server is restarted
            with this version.
          </p>
        ) : null}
        {total != null && shown.length >= total && history.fetched.length ? (
          <p className="as-muted as-small">
            That is every event recorded in this workspace.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FeedRow({ event, who, presentation, onOpenRun }) {
  const provenance = event.provenance ?? "system";
  // Provider events are the default and carry no chip (the summary says so).
  const marked = provenance !== "provider";
  // The snapshot carries the inferred activity on the event itself.
  const activity = event.activity ?? event.data?.activity ?? null;
  const at =
    typeof event.timestamp === "number"
      ? event.timestamp
      : Date.parse(event.timestamp ?? "");
  const dated = Number.isFinite(at) && at > 0;
  const message = maskPathsInText(event.message ?? "", presentation);
  const content = (
    <>
      <time
        className="feed-time"
        dateTime={dated ? new Date(at).toISOString() : undefined}
        title={
          dated
            ? `${timeAgo(at)} · ${new Date(at).toLocaleString()}`
            : undefined
        }
      >
        {dated ? formatTime(at) : "—"}
      </time>
      <span className="feed-kind">{eventKindLabel(event.kind)}</span>
      <span
        className="feed-message"
        title={presentation ? undefined : event.message || undefined}
      >
        {message || "No message recorded"}
      </span>
      {marked || activity ? (
        <span className="feed-marks">
          {marked ? <Provenance value={provenance} /> : null}
          {activity ? <ActivityBadge activity={activity} inferred /> : null}
        </span>
      ) : null}
      <span className="feed-who">
        {who ? <span className="feed-who-name">{who}</span> : null}
        {event.runId && onOpenRun ? (
          <ArrowUpRight size={13} aria-hidden="true" className="feed-open" />
        ) : null}
      </span>
    </>
  );
  if (event.runId && onOpenRun)
    return (
      <button
        type="button"
        className="feed-row"
        title="Open this run in the inspector"
        onClick={() => onOpenRun(event.runId)}
      >
        {content}
      </button>
    );
  return <div className="feed-row">{content}</div>;
}

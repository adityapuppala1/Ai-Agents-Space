import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Square,
  RotateCcw,
  MessageSquare,
  Play,
  FileDiff,
  Wrench,
  GitBranch,
  Gauge,
  History,
  Info,
  Check,
  X,
  TriangleAlert,
  Share2,
} from "lucide-react";
import {
  apiFetch,
  useApi,
  formatElapsed,
  formatTime,
  formatNumber,
  groupToolEvents,
  parseDiff,
  attemptChain,
  isActiveRun,
  RUN_STATUS_LABELS,
  maskPath,
  basename,
  eventKindLabel,
  useTicker,
} from "../hooks/useApi.js";
import ProviderBadge from "./ProviderBadge.jsx";
import Provenance from "./Provenance.jsx";
import ActivityBadge from "./ActivityBadge.jsx";
import { actionMessage } from "../hooks/viewLogic.js";
import Tabs from "./Tabs.jsx";
import AgentConversation from "./AgentConversation.jsx";
import RunLineage from "./RunLineage.jsx";
import { PinToggle } from "./PinnedRuns.jsx";

/** How many events the inspector keeps in memory for one run. */
const MAX_RETAINED_EVENTS = 5000;
/** The run detail carries at most this many events; more are paged in. */
const DETAIL_EVENT_CAP = 1000;
/** Events drawn at once in Live activity; earlier ones on request. */
const ACTIVITY_PAGE = 200;

const TASK_STATUS_TEXT = {
  QUEUE: "Queued",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
};
const APPROVAL_STATUS_TEXT = {
  pending: "Pending",
  approved: "Approved",
  denied: "Declined",
  expired: "Expired",
};
const USAGE_LABELS = {
  input_tokens: "Input tokens",
  output_tokens: "Output tokens",
  cache_read_input_tokens: "Cache read tokens",
  cache_creation_input_tokens: "Cache write tokens",
  reasoning_output_tokens: "Reasoning tokens",
  total_tokens: "Total tokens",
};

const TABS = [
  { id: "overview", label: "Overview", icon: <Info size={13} /> },
  {
    id: "conversation",
    label: "Conversation",
    icon: <MessageSquare size={13} />,
  },
  { id: "activity", label: "Live activity", icon: <Activity size={13} /> },
  { id: "files", label: "Files/diff", icon: <FileDiff size={13} /> },
  { id: "tools", label: "Tools", icon: <Wrench size={13} /> },
  { id: "deps", label: "Dependencies", icon: <GitBranch size={13} /> },
  { id: "usage", label: "Usage", icon: <Gauge size={13} /> },
  { id: "lineage", label: "Lineage", icon: <Share2 size={13} /> },
  { id: "history", label: "History", icon: <History size={13} /> },
];

const CONTROL_REASON = {
  unsupported:
    "This provider does not support this action through a documented interface.",
  unknown: "Not verified for this provider yet.",
  experimental: "Experimental for this provider; disabled until verified.",
};

function Row({ label, children, mono = false }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "as-mono" : ""}>{children ?? "—"}</dd>
    </>
  );
}

/**
 * One run control. It is enabled only when the provider supports the action
 * AND the run is in a state where it applies (`unavailable` says why not).
 */
function Control({
  icon,
  label,
  capability,
  onClick,
  busy,
  unavailable = null,
}) {
  const verified = capability === "verified";
  const usable = verified && !unavailable;
  const title = !verified
    ? `${label} unavailable: ${CONTROL_REASON[capability] ?? "capability not verified for this provider."}`
    : unavailable
      ? `${label} unavailable: ${unavailable}`
      : label;
  return (
    <button
      type="button"
      className="button as-control"
      disabled={!usable || busy}
      title={title}
      aria-label={usable ? label : title}
      aria-disabled={!usable}
      onClick={onClick}
    >
      {icon}
      {label}
      {!verified ? (
        <span className="as-cap-mini">{capability ?? "unknown"}</span>
      ) : null}
    </button>
  );
}

/**
 * Full run inspector with tabs. Fetches `GET /api/runs/:id` and, while the run
 * is active, polls `GET /api/runs/:id/events?after=<sequence>` every 2 s. A
 * caller that already streams events may pass them in `events` to skip polling.
 *
 * @param {{
 *   runId: string,
 *   workspaceId?: string,
 *   capabilities?: Record<string, Record<string, 'verified'|'unsupported'|'unknown'|'experimental'>>,
 *   onAction?: (action: 'cancel'|'retry'|'input'|'resume'|'review', result: any) => void,
 *   events?: any[] | null,
 *   presentation?: boolean,        // mask private paths
 *   initialTab?: string
 * }} props
 */
export default function RunInspector({
  runId,
  workspaceId,
  capabilities = {},
  onAction,
  events: externalEvents = null,
  presentation = false,
  initialTab = "overview",
}) {
  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [events, setEvents] = useState([]);
  const detail = useApi(runId ? `/runs/${encodeURIComponent(runId)}` : null);
  const run = detail.data?.run ?? null;
  const active = isActiveRun(run);
  useTicker(active);
  const lastSequence = useRef(0);
  const seenIds = useRef(new Set());
  // True when older events were left out to stay within the retention cap.
  const [trimmed, setTrimmed] = useState(false);

  useEffect(() => {
    const initial = Array.isArray(detail.data?.events)
      ? detail.data.events
      : [];
    setEvents(initial);
    setTrimmed(false);
    seenIds.current = new Set(initial.map((e) => e.id));
    lastSequence.current = initial.reduce(
      (max, e) => Math.max(max, e.sequence ?? 0),
      0,
    );
    // The run detail stops at its first 1000 events. Page forward to the
    // newest, so a long finished run does not show its first thousand as
    // "newest last" and never its end.
    if (!runId || externalEvents || initial.length < DETAIL_EVENT_CAP)
      return undefined;
    let stopped = false;
    (async () => {
      let collected = [...initial];
      let dropped = false;
      for (let page = 0; page < 20 && !stopped; page += 1) {
        const result = await apiFetch(
          `/runs/${encodeURIComponent(runId)}/events?after=${lastSequence.current}&limit=5000`,
        ).catch(() => null);
        const fresh = Array.isArray(result) ? result : (result?.events ?? []);
        if (!fresh.length) break;
        for (const event of fresh) seenIds.current.add(event.id);
        lastSequence.current = fresh.reduce(
          (max, e) => Math.max(max, e.sequence ?? 0),
          lastSequence.current,
        );
        collected = collected.concat(fresh);
        if (collected.length > MAX_RETAINED_EVENTS) {
          collected = collected.slice(-MAX_RETAINED_EVENTS);
          dropped = true;
        }
        if (fresh.length < 5000) break;
      }
      if (stopped) return;
      setEvents(collected);
      setTrimmed(dropped);
    })();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data]);

  useEffect(() => {
    if (externalEvents || !runId || !active) return undefined;
    let stopped = false;
    let timer = null;
    const poll = async () => {
      try {
        const result = await apiFetch(
          `/runs/${encodeURIComponent(runId)}/events?after=${lastSequence.current}`,
        );
        const fresh = Array.isArray(result) ? result : (result?.events ?? []);
        if (stopped || fresh.length === 0) return;
        // The seen-id set lives in a ref: rebuilding it from the whole
        // accumulated array on every tick is O(n) per poll on a list that can
        // reach tens of thousands of events.
        const added = fresh.filter((e) => !seenIds.current.has(e.id));
        for (const event of added) seenIds.current.add(event.id);
        lastSequence.current = fresh.reduce(
          (max, e) => Math.max(max, e.sequence ?? 0),
          lastSequence.current,
        );
        if (added.length)
          setEvents((current) => {
            const merged = [...current, ...added];
            // Retention cap: each event carries up to 4 KB of data, and a long
            // managed run would otherwise hold tens of megabytes in state. The
            // oldest are dropped and the Live activity tab says so.
            if (merged.length <= MAX_RETAINED_EVENTS) return merged;
            setTrimmed(true);
            return merged.slice(-MAX_RETAINED_EVENTS);
          });
        if (
          fresh.some((e) =>
            ["complete", "status", "error", "session.end"].includes(e.kind),
          )
        )
          detail.reload();
      } catch {
        /* polling errors are transient; the next tick retries */
      }
    };
    // A self-rescheduling timeout, not setInterval: with an interval a slow
    // response is overtaken by the next request, which asks for the SAME
    // `after` sequence (it only advances in the response handler) and
    // re-downloads the same rows several times over.
    const tick = async () => {
      if (typeof document === "undefined" || !document.hidden) await poll();
      if (!stopped) timer = setTimeout(tick, 2000);
    };
    timer = setTimeout(tick, 2000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId, active, externalEvents, detail.reload]);

  const allEvents = useMemo(() => {
    const source = externalEvents ?? events;
    return [...source].sort(
      (a, b) =>
        (a.sequence ?? 0) - (b.sequence ?? 0) ||
        (a.timestamp ?? 0) - (b.timestamp ?? 0),
    );
  }, [externalEvents, events]);

  const caps = capabilities?.[run?.provider] ?? {};
  const call = useCallback(
    async (action, body) => {
      if (!run) return;
      setBusy(action);
      setMessage("");
      try {
        const result = await apiFetch(
          `/runs/${encodeURIComponent(run.id)}/${action}`,
          { method: "POST", body },
        );
        onAction?.(action, result);
        // "<action> accepted." read "review accepted." after a rejection.
        setMessage(actionMessage(action, body, result));
        detail.reload();
      } catch (error) {
        setMessage(error.message);
      } finally {
        setBusy("");
      }
    },
    [run, onAction, detail],
  );

  if (!runId) return <p className="as-muted">Select a run to inspect it.</p>;
  if (detail.error)
    return (
      <div className="form-error" role="alert">
        {detail.error.message}
      </div>
    );
  if (!run) return <p className="as-muted">Loading run…</p>;

  // Only a run Agent Space launched can be cancelled, retried or resumed
  // from here (the server refuses the rest).
  const managed = run.mode === "managed";
  const started = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const ended = run.endedAt ? new Date(run.endedAt).getTime() : null;
  const elapsed = started ? (ended ?? Date.now()) - started : 0;
  const approvals = detail.data?.approvals ?? [];
  const artifacts = detail.data?.artifacts ?? [];
  const context = detail.data?.context ?? run.context ?? null;
  const pendingApprovals = approvals.filter(
    (a) => a.status === "pending",
  ).length;

  return (
    <section className="as-inspector" aria-label={`Run ${run.id}`}>
      <header className="as-inspector-head">
        <div>
          <div className="as-row">
            <ProviderBadge provider={run.provider} mode={run.mode} />
            <span className={`status as-run-status as-run-${run.status}`}>
              <i className="dot" aria-hidden="true" />
              {RUN_STATUS_LABELS[run.status] ?? run.status}
            </span>
            <ActivityBadge
              activity={run.activity}
              inferred={Boolean(run.activity)}
              status={run.status}
            />
          </div>
          <h3 className="as-inspector-title">
            {run.title ??
              run.label ??
              run.summary ??
              `Run ${run.id.slice(0, 8)}`}
          </h3>
          <p className="as-muted">
            Elapsed <strong aria-live="off">{formatElapsed(elapsed)}</strong> ·
            attempt {run.attempt ?? 1}
            {run.lastEventAt
              ? ` · last event ${formatTime(run.lastEventAt)}`
              : ""}
          </p>
        </div>
        <div className="as-controls" role="group" aria-label="Run controls">
          <PinToggle runId={run.id} title="this run" />
          {managed ? (
            <>
              <Control
                icon={<Square size={12} />}
                label="Cancel"
                capability={caps.interrupt}
                unavailable={active ? null : "the run is not running."}
                busy={busy === "cancel"}
                onClick={() => call("cancel")}
              />
              <Control
                icon={<RotateCcw size={12} />}
                label="Retry"
                capability={caps.launch}
                unavailable={
                  active
                    ? "cancel the run or wait for it to finish first."
                    : null
                }
                busy={busy === "retry"}
                onClick={() => call("retry")}
              />
              <Control
                icon={<MessageSquare size={12} />}
                label="Reply"
                capability={caps.resume}
                unavailable={
                  active
                    ? "input is accepted between attempts, not while the run executes."
                    : null
                }
                busy={busy === "input"}
                // The reply box lives with the conversation it belongs to,
                // rather than being a second form on top of the header.
                onClick={() => setTab("conversation")}
              />
              <Control
                icon={<Play size={12} />}
                label="Resume"
                capability={caps.resume}
                unavailable={active ? "the run is still executing." : null}
                busy={busy === "resume"}
                onClick={() => call("input", { text: "", resume: true })}
              />
            </>
          ) : null}
        </div>
      </header>
      {managed ? (
        <p className="as-note">
          <TriangleAlert size={12} aria-hidden="true" /> Interrupting does not
          undo side effects already made by the provider.
        </p>
      ) : (
        <p className="as-note as-note-info">
          <Info size={12} aria-hidden="true" />{" "}
          {run.mode === "observed"
            ? "This session was started outside Agent Space. It is recorded here, not controlled: stop, retry or answer it where it runs."
            : "This run is not controlled by Agent Space; it is recorded here only."}
        </p>
      )}
      {message ? (
        <p className="as-feedback" role="status">
          {message}
        </p>
      ) : null}
      <Tabs
        tabs={TABS.map((t) =>
          t.id === "activity"
            ? { ...t, badge: allEvents.length }
            : t.id === "history" && pendingApprovals
              ? { ...t, badge: pendingApprovals }
              : t,
        )}
        value={tab}
        onChange={setTab}
        label="Run inspector sections"
      >
        {tab === "overview" && (
          <Overview
            run={run}
            elapsed={elapsed}
            presentation={presentation}
            context={context}
          />
        )}
        {tab === "conversation" && (
          <AgentConversation
            runId={runId}
            // While the run is working, its answer can still arrive.
            interval={active ? 3000 : 0}
            onReplied={(started) => onAction?.("input", started)}
          />
        )}
        {tab === "activity" && (
          <LiveActivity
            events={allEvents}
            presentation={presentation}
            trimmed={trimmed}
            baseProvenance={
              run.mode === "observed" || run.mode === "managed"
                ? "provider"
                : null
            }
          />
        )}
        {tab === "files" && (
          <Files
            run={run}
            artifacts={artifacts}
            presentation={presentation}
            busy={busy}
            onReview={(decision, note) => call("review", { decision, note })}
            onChanged={() => detail.reload()}
          />
        )}
        {tab === "tools" && (
          <Tools events={allEvents} presentation={presentation} />
        )}
        {tab === "deps" && (
          <Dependencies
            workspaceId={workspaceId ?? run.workspaceId}
            taskId={run.taskId}
          />
        )}
        {tab === "usage" && <Usage run={run} events={allEvents} />}
        {tab === "lineage" && (
          <RunLineage
            run={run}
            workspaceId={workspaceId ?? run.workspaceId}
            presentation={presentation}
          />
        )}
        {tab === "history" && (
          <HistoryTab
            run={run}
            approvals={approvals}
            workspaceId={workspaceId ?? run.workspaceId}
          />
        )}
      </Tabs>
    </section>
  );
}

function Overview({ run, elapsed, presentation, context }) {
  const agent = run.agentSnapshot ?? {};
  return (
    <dl className="as-passport">
      <Row label="Task">{run.title ?? run.taskId}</Row>
      <Row label="Agent">
        {agent.name
          ? `${agent.name}${agent.role ? ` · ${agent.role}` : ""}`
          : run.agentId}
      </Row>
      <Row label="Provider">
        <ProviderBadge provider={run.provider} mode={run.mode} />
      </Row>
      <Row label="Requested model">
        {run.requestedModel ?? "none requested"}
      </Row>
      <Row label="Actual model">{run.actualModel ?? "model not reported"}</Row>
      <Row label="Host" mono>
        {run.host}
      </Row>
      <Row label="Working directory" mono>
        {maskPath(run.cwd, presentation) || "—"}
      </Row>
      <Row label="Branch" mono>
        {run.branch}
      </Row>
      <Row label="Worktree" mono>
        {maskPath(run.worktree, presentation) || "none"}
      </Row>
      <Row label="Status">{RUN_STATUS_LABELS[run.status] ?? run.status}</Row>
      <Row label="Elapsed">{formatElapsed(elapsed)}</Row>
      <Row label="Started">
        {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}
      </Row>
      <Row label="Ended">
        {run.endedAt ? new Date(run.endedAt).toLocaleString() : "still running"}
      </Row>
      <Row label="Attempt">
        {run.attempt ?? 1}
        {run.parentRunId ? ` (retry of ${run.parentRunId.slice(0, 8)})` : ""}
      </Row>
      <Row label="Provider session" mono>
        {run.providerSessionId ?? "not reported"}
      </Row>
      <Row label="Current action">{run.currentAction ?? "—"}</Row>
      <Row label="Current file" mono>
        {run.currentFile ? basename(run.currentFile) : "—"}
      </Row>
      {run.exitCode !== null && run.exitCode !== undefined ? (
        <Row label="Exit code">{run.exitCode}</Row>
      ) : null}
      {run.error ? (
        <Row label="Error">
          <span className="as-error-text">{run.error}</span>
        </Row>
      ) : null}
      {run.summary ? <Row label="Summary">{run.summary}</Row> : null}
      {run.prompt ? (
        <Row label="Prompt">
          <pre className="as-pre">{run.prompt}</pre>
        </Row>
      ) : null}
      {context && Array.isArray(context.files) ? (
        <Row label="Context">
          {context.files.length} file(s) ·{" "}
          {context.estimatedTokens
            ? `${formatNumber(context.estimatedTokens)} tokens (estimate)`
            : "no estimate"}
        </Row>
      ) : null}
      {run.configSnapshot?.command ? (
        <Row label="Command" mono>
          <pre className="as-pre">
            {[
              run.configSnapshot.command,
              ...(run.configSnapshot.args ?? []),
            ].join(" ")}
          </pre>
        </Row>
      ) : null}
    </dl>
  );
}

/**
 * The run's events, newest last. Only the latest page is drawn (a run can
 * hold thousands); earlier events are added on request, and the tab says
 * when the oldest were dropped to stay within the retention cap.
 */
function LiveActivity({
  events,
  presentation,
  trimmed = false,
  baseProvenance = null,
}) {
  const listRef = useRef(null);
  const [follow, setFollow] = useState(true);
  const [shown, setShown] = useState(ACTIVITY_PAGE);
  useEffect(() => {
    if (follow && listRef.current)
      listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [events.length, follow]);
  if (events.length === 0)
    return <p className="as-muted">No events recorded yet.</p>;
  const visible = events.slice(-shown);
  const hidden = events.length - visible.length;
  return (
    <div className="as-live-activity">
      <div className="as-row as-wrap">
        <label className="as-check">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />{" "}
          Follow newest
        </label>
        <span className="as-muted as-small">
          {baseProvenance === "provider"
            ? "Recorded by the provider unless marked. "
            : ""}
          Showing the latest {formatNumber(visible.length)} of{" "}
          {formatNumber(events.length)} loaded events
          {trimmed
            ? `; older events beyond the latest ${formatNumber(MAX_RETAINED_EVENTS)} are not loaded here`
            : ""}
          .
        </span>
      </div>
      {hidden > 0 ? (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setFollow(false);
            setShown((value) => value + ACTIVITY_PAGE);
          }}
        >
          Show {formatNumber(Math.min(ACTIVITY_PAGE, hidden))} earlier events
        </button>
      ) : null}
      <ol
        className="as-events"
        ref={listRef}
        aria-label="Run events, newest last"
      >
        {visible.map((event) => (
          <li
            key={event.id ?? `${event.sequence}-${event.timestamp}`}
            className={`as-event as-event-${String(event.kind).replace(".", "-")}`}
          >
            <time dateTime={new Date(event.timestamp).toISOString()}>
              {formatTime(event.timestamp)}
            </time>
            <span className="as-event-kind">{eventKindLabel(event.kind)}</span>
            <span className="as-event-msg">
              {event.message ?? event.summary}
              {event.file ? (
                <code className="as-mono">
                  {" "}
                  {maskPath(event.file, presentation)}
                </code>
              ) : null}
            </span>
            <span className="as-event-meta">
              {/* Only a source other than the run's own is marked, so the
                  common case carries no chip on every row. */}
              {event.provenance && event.provenance !== baseProvenance ? (
                <Provenance value={event.provenance} />
              ) : null}
              {event.data?.activity ? (
                <ActivityBadge activity={event.data.activity} inferred />
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DiffView({ text }) {
  const lines = useMemo(() => parseDiff(text), [text]);
  return (
    <pre className="as-diff" aria-label="Diff">
      {lines.map((line, index) => (
        <span
          key={index}
          className={`as-diff-${line.type}`}
          data-sign={
            line.type === "add" ? "+" : line.type === "del" ? "−" : " "
          }
        >
          {line.text || " "}
        </span>
      ))}
    </pre>
  );
}

function Files({ run, artifacts, presentation, busy, onReview, onChanged }) {
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState("");
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const chosen =
    artifacts.find((a) => a.id === selected) ?? artifacts[0] ?? null;
  useEffect(() => {
    if (!chosen) return;
    if (chosen.content !== undefined && chosen.content !== null) {
      setContent(chosen.content);
      return;
    }
    let stopped = false;
    setLoading(true);
    apiFetch(
      `/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(chosen.id)}`,
    )
      .then((data) => {
        if (!stopped)
          setContent(
            typeof data === "string"
              ? data
              : (data?.content ?? data?.artifact?.content ?? ""),
          );
      })
      .catch((error) => {
        if (!stopped) setContent(`Could not load artifact: ${error.message}`);
      })
      .finally(() => !stopped && setLoading(false));
    return () => {
      stopped = true;
    };
  }, [chosen, run.id]);
  const isDiff =
    chosen &&
    /diff|patch/i.test(
      `${chosen.type ?? ""} ${chosen.kind ?? ""} ${chosen.title ?? ""}`,
    );
  return (
    <div className="as-files">
      <ul className="as-artifact-list" aria-label="Artifacts">
        {artifacts.length === 0 ? (
          <li className="as-muted">No artifacts recorded for this run.</li>
        ) : null}
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <button
              type="button"
              className={`as-artifact ${chosen?.id === artifact.id ? "active" : ""}`}
              onClick={() => setSelected(artifact.id)}
              aria-pressed={chosen?.id === artifact.id}
            >
              <strong>
                {artifact.title ??
                  artifact.name ??
                  artifact.type ??
                  artifact.id}
              </strong>
              <span className="as-muted">
                {artifact.type ?? artifact.kind ?? "artifact"}
                {artifact.size ? ` · ${formatNumber(artifact.size)} B` : ""}
                {/* Only the fence can say what a snippet is written in. */}
                {artifact.kind === "snippet"
                  ? ` · ${artifact.metadata?.language ?? "language not reported"}`
                  : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="as-artifact-body">
        {chosen ? (
          loading ? (
            <p className="as-muted">Loading…</p>
          ) : isDiff ? (
            <DiffView text={content ?? ""} />
          ) : (
            <pre className="as-pre">{content ?? ""}</pre>
          )
        ) : (
          <p className="as-muted">
            Diffs and outputs appear here once the provider produces them.
          </p>
        )}
        <div className="as-review">
          <label>
            Review note <span className="optional">(optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why you accept or reject"
            />
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={busy === "review"}
              onClick={() => onReview("reject", note)}
              aria-label="Reject changes"
            >
              <X size={12} /> Reject
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy === "review"}
              onClick={() => onReview("accept", note)}
              aria-label="Accept changes"
            >
              <Check size={12} /> Accept
            </button>
          </div>
          <p className="as-muted">
            Accepting marks the task completed.{" "}
            {run.worktree
              ? `The changes stay in the worktree ${maskPath(run.worktree, presentation)} until you apply them.`
              : ""}
          </p>
          <WorktreeApply
            run={run}
            presentation={presentation}
            onChanged={onChanged}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Copies a reviewed worktree into the working tree, as uncommitted edits.
 * The server checks everything first (the review accepted, the reviewed diff
 * complete and unchanged, none of your own uncommitted work in the way, not
 * already applied) and says why not; this shows its answer and asks before
 * anything is written. Nothing is ever committed or pushed.
 */
function WorktreeApply({ run, presentation, onChanged }) {
  const [state, setState] = useState({
    status: "checking",
    files: [],
    root: null,
    reason: "",
  });
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const applied = run.context?.appliedAt ?? null;
  const path = `/runs/${encodeURIComponent(run.id)}/worktree/apply`;

  useEffect(() => {
    if (!run.worktree || applied) return undefined;
    let current = true;
    setState((previous) => ({ ...previous, status: "checking" }));
    apiFetch(path, { method: "POST", body: { check: true } })
      .then((data) => {
        if (current)
          setState({
            status: "ready",
            files: data?.files ?? [],
            root: data?.root ?? null,
            reason: "",
          });
      })
      .catch((error) => {
        if (current)
          setState({
            status: error.status === 404 ? "unsupported" : "blocked",
            files: [],
            root: null,
            reason: error.message,
          });
      });
    return () => {
      current = false;
    };
  }, [path, run.worktree, run.lastEventAt, applied]);

  if (applied) {
    const files = run.context?.appliedFiles ?? [];
    return (
      <p className="as-note as-note-info" role="status">
        Applied {files.length} file{files.length === 1 ? "" : "s"} to{" "}
        {maskPath(run.context?.appliedTo ?? "", presentation) ||
          "the working tree"}{" "}
        at {formatTime(applied)}. They are not committed: review and commit them
        with your own tools.
      </p>
    );
  }
  if (!run.worktree || state.status === "unsupported") return null;
  if (state.status === "checking")
    return (
      <p className="as-muted as-small">Checking whether it can be applied…</p>
    );
  if (state.status === "blocked")
    return (
      <p className="as-muted as-small as-apply-blocked">
        Apply to your working tree: not yet. {state.reason}
      </p>
    );

  const apply = async () => {
    setApplying(true);
    try {
      await apiFetch(path, { method: "POST", body: {} });
      setConfirming(false);
      onChanged?.();
    } catch (error) {
      setState((previous) => ({
        ...previous,
        status: "blocked",
        reason: error.message,
      }));
      setConfirming(false);
    } finally {
      setApplying(false);
    }
  };
  const shown = state.files.slice(0, 10);
  return (
    <div className="as-apply">
      {confirming ? (
        <div
          className="as-apply-confirm"
          role="group"
          aria-label="Apply changes"
        >
          <p>
            Copies {state.files.length} file
            {state.files.length === 1 ? "" : "s"} into{" "}
            <span className="as-mono">
              {maskPath(state.root ?? "", presentation) || "the working tree"}
            </span>{" "}
            as uncommitted changes. Nothing is committed, and your other changes
            are not touched.
          </p>
          <ul className="as-apply-files">
            {shown.map((file) => (
              <li key={file} className="as-mono">
                {presentation ? maskPath(file, true) : file}
              </li>
            ))}
            {state.files.length > shown.length ? (
              <li className="as-muted">
                and {state.files.length - shown.length} more
              </li>
            ) : null}
          </ul>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button primary"
              disabled={applying}
              onClick={apply}
            >
              {applying
                ? "Applying…"
                : `Apply ${state.files.length} file${state.files.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="button"
          onClick={() => setConfirming(true)}
        >
          Apply to my working tree…
        </button>
      )}
    </div>
  );
}

function Tools({ events, presentation }) {
  const groups = useMemo(() => groupToolEvents(events), [events]);
  if (groups.length === 0)
    return <p className="as-muted">No tool calls recorded.</p>;
  return (
    <div className="as-table-wrap as-inspector-table-wrap">
      <table className="as-table as-tools-table">
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col">Started</th>
            <th scope="col">Finished</th>
            <th scope="col">Errors</th>
            <th scope="col">Files</th>
            <th scope="col">Last</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.tool}>
              <th scope="row">
                <code>{group.tool}</code>
              </th>
              <td data-label="Started">{group.starts}</td>
              <td data-label="Finished">{group.ends}</td>
              <td data-label="Errors">{group.errors}</td>
              <td data-label="Files" className="as-mono">
                {group.files
                  .slice(0, 4)
                  .map((f) => maskPath(f, presentation))
                  .join(", ")}
                {group.files.length > 4 ? ` +${group.files.length - 4}` : ""}
              </td>
              <td data-label="Last">
                {group.last ? formatTime(group.last) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Dependencies({ workspaceId, taskId }) {
  const graph = useApi(
    workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}/graph` : null,
  );
  if (graph.error)
    return (
      <p className="as-muted">
        Dependency graph unavailable: {graph.error.message}
      </p>
    );
  if (!graph.data) return <p className="as-muted">Loading dependencies…</p>;
  const nodes = graph.data.nodes ?? [];
  const edges = graph.data.edges ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const upstream = edges
    .filter((e) => e.to === taskId)
    .map((e) => byId.get(e.from))
    .filter(Boolean);
  const downstream = edges
    .filter((e) => e.from === taskId)
    .map((e) => byId.get(e.to))
    .filter(Boolean);
  const list = (items) =>
    items.length === 0 ? (
      <li className="as-muted">none</li>
    ) : (
      items.map((n) => (
        <li key={n.id}>
          <span
            className={`status status-${String(n.status ?? "").toLowerCase()}`}
          >
            {TASK_STATUS_TEXT[n.status] ?? n.status}
          </span>{" "}
          {n.title ?? n.id}
        </li>
      ))
    );
  return (
    <div className="as-deps">
      <h4>Depends on</h4>
      <ul>{list(upstream)}</ul>
      <h4>Unblocks</h4>
      <ul>{list(downstream)}</ul>
    </div>
  );
}

/**
 * Tokens and cost as the run recorded them. The tag says where the numbers
 * came from: a provider-backed run's come from the provider, a demo run's
 * are simulated, and cost carries its own stated source.
 */
function Usage({ run, events }) {
  const usage = run.usage ?? {};
  const cost = run.cost ?? {};
  const hasUsage = Object.keys(usage).length > 0;
  const hasCost = Object.keys(cost).length > 0;
  const usageEvents = events.filter((e) => e.kind === "usage").length;
  const simulated =
    run.provider === "simulated" ||
    run.provider === "demo" ||
    run.mode === "demo";
  const tokenBasis = simulated ? "simulated (demo)" : "reported by provider";
  const costBasis = cost.estimated
    ? "estimated"
    : cost.reportedBy === "provider" || cost.usd !== undefined
      ? "reported by provider"
      : simulated
        ? "simulated (demo)"
        : "source not recorded";
  const costEntries = Object.entries(cost).filter(
    ([key]) => !["reportedBy", "estimated"].includes(key),
  );
  return (
    <div className="as-usage">
      <h4>
        Tokens{" "}
        <span className={`as-tag ${simulated ? "as-tag-warn" : ""}`}>
          {tokenBasis}
        </span>
      </h4>
      {hasUsage ? (
        <dl className="as-passport">
          {Object.entries(usage).map(([key, value]) => (
            <Row key={key} label={USAGE_LABELS[key] ?? key.replace(/_/g, " ")}>
              {typeof value === "object"
                ? JSON.stringify(value)
                : formatNumber(value)}
            </Row>
          ))}
        </dl>
      ) : (
        <p className="as-muted">No token usage was recorded for this run.</p>
      )}
      <h4>
        Cost{" "}
        {hasCost ? (
          <span
            className={`as-tag ${costBasis === "reported by provider" ? "" : "as-tag-warn"}`}
          >
            {costBasis}
          </span>
        ) : null}
      </h4>
      {hasCost ? (
        <dl className="as-passport">
          {costEntries.map(([key, value]) => (
            <Row key={key} label={key === "usd" ? "US dollars" : key}>
              {typeof value === "number" && key === "usd"
                ? `$${value.toFixed(4)}`
                : typeof value === "object"
                  ? JSON.stringify(value)
                  : String(value)}
            </Row>
          ))}
        </dl>
      ) : (
        <p className="as-muted">
          No cost was reported for this run. Agent Space does not estimate cost
          for it.
        </p>
      )}
      <p className="as-muted">
        {usageEvents} usage event(s) recorded. Model:{" "}
        {run.actualModel ?? "model not reported"}.
      </p>
    </div>
  );
}

function HistoryTab({ run, approvals, workspaceId }) {
  const runs = useApi(
    workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}/runs` : null,
  );
  const chain = useMemo(
    () =>
      attemptChain(
        run,
        Array.isArray(runs.data) ? runs.data : (runs.data?.runs ?? []),
      ),
    [run, runs.data],
  );
  return (
    <div className="as-history">
      <h4>Attempts</h4>
      <ol className="as-chain">
        {chain.map((entry) => (
          <li key={entry.id} className={entry.id === run.id ? "current" : ""}>
            <span className="as-mono">{entry.id.slice(0, 8)}</span> · attempt{" "}
            {entry.attempt ?? 1} ·{" "}
            {RUN_STATUS_LABELS[entry.status] ?? entry.status} ·{" "}
            {entry.startedAt ? new Date(entry.startedAt).toLocaleString() : ""}
            {entry.id === run.id ? (
              <span className="as-tag">this run</span>
            ) : null}
          </li>
        ))}
      </ol>
      <h4>Approvals</h4>
      {approvals.length === 0 ? (
        <p className="as-muted">No approvals requested for this run.</p>
      ) : (
        <div className="as-table-wrap as-inspector-table-wrap">
          <table className="as-table">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Reason</th>
                <th scope="col">Status</th>
                <th scope="col">Decided by</th>
              </tr>
            </thead>
            <tbody>
              {approvals.map((approval) => (
                <tr key={approval.id}>
                  <td>
                    {String(approval.kind ?? "")
                      .charAt(0)
                      .toUpperCase() + String(approval.kind ?? "").slice(1)}
                  </td>
                  <td>{approval.reason ?? "—"}</td>
                  <td>
                    {APPROVAL_STATUS_TEXT[approval.status] ?? approval.status}
                  </td>
                  <td>{approval.decidedBy ?? approval.decided_by ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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
} from "../hooks/useApi.js";
import ProviderBadge from "./ProviderBadge.jsx";
import Provenance from "./Provenance.jsx";
import ActivityBadge from "./ActivityBadge.jsx";
import Tabs from "./Tabs.jsx";
import RunLineage from "./RunLineage.jsx";
import { PinToggle } from "./PinnedRuns.jsx";

const TABS = [
  { id: "overview", label: "Overview", icon: <Info size={13} /> },
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

function useTicker(active) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

function Row({ label, children, mono = false }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={mono ? "as-mono" : ""}>{children ?? "—"}</dd>
    </>
  );
}

function Control({ icon, label, capability, onClick, busy }) {
  const verified = capability === "verified";
  const title = verified
    ? label
    : `${label} unavailable: ${CONTROL_REASON[capability] ?? "capability not verified for this provider."}`;
  return (
    <button
      type="button"
      className="button as-control"
      disabled={!verified || busy}
      title={title}
      aria-label={label}
      aria-disabled={!verified}
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
  const [inputText, setInputText] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [events, setEvents] = useState([]);
  const detail = useApi(runId ? `/runs/${encodeURIComponent(runId)}` : null);
  const run = detail.data?.run ?? null;
  const active = isActiveRun(run);
  useTicker(active);
  const lastSequence = useRef(0);

  useEffect(() => {
    const initial = Array.isArray(detail.data?.events)
      ? detail.data.events
      : [];
    setEvents(initial);
    lastSequence.current = initial.reduce(
      (max, e) => Math.max(max, e.sequence ?? 0),
      0,
    );
  }, [detail.data]);

  useEffect(() => {
    if (externalEvents || !runId || !active) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await apiFetch(
          `/runs/${encodeURIComponent(runId)}/events?after=${lastSequence.current}`,
        );
        const fresh = Array.isArray(result) ? result : (result?.events ?? []);
        if (stopped || fresh.length === 0) return;
        setEvents((current) => {
          const known = new Set(current.map((e) => e.id));
          const merged = [...current, ...fresh.filter((e) => !known.has(e.id))];
          lastSequence.current = merged.reduce(
            (max, e) => Math.max(max, e.sequence ?? 0),
            lastSequence.current,
          );
          return merged;
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
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) poll();
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
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
        setMessage(`${action} accepted.`);
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
          <Control
            icon={<Square size={12} />}
            label="Cancel"
            capability={active ? caps.interrupt : "unsupported"}
            busy={busy === "cancel"}
            onClick={() => call("cancel")}
          />
          <Control
            icon={<RotateCcw size={12} />}
            label="Retry"
            capability={caps.launch}
            busy={busy === "retry"}
            onClick={() => call("retry")}
          />
          <Control
            icon={<MessageSquare size={12} />}
            label="Provide input"
            capability={caps.resume}
            busy={busy === "input"}
            onClick={() => setShowInput((v) => !v)}
          />
          <Control
            icon={<Play size={12} />}
            label="Resume"
            capability={caps.resume}
            busy={busy === "resume"}
            onClick={() => call("input", { text: "", resume: true })}
          />
        </div>
      </header>
      <p className="as-note">
        <TriangleAlert size={12} aria-hidden="true" /> Interrupting does not
        undo side effects already made by the provider.
      </p>
      {showInput ? (
        <form
          className="as-input-form"
          onSubmit={(event) => {
            event.preventDefault();
            call("input", { text: inputText }).then(() => setInputText(""));
          }}
        >
          <label>
            Message to the agent
            <textarea
              rows={3}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              data-autofocus
            />
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => setShowInput(false)}
            >
              Close
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={!inputText.trim() || busy === "input"}
            >
              Send input
            </button>
          </div>
        </form>
      ) : null}
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
        {tab === "activity" && (
          <LiveActivity events={allEvents} presentation={presentation} />
        )}
        {tab === "files" && (
          <Files
            run={run}
            artifacts={artifacts}
            presentation={presentation}
            busy={busy}
            onReview={(decision, note) => call("review", { decision, note })}
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

function LiveActivity({ events, presentation }) {
  const listRef = useRef(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && listRef.current)
      listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [events.length, follow]);
  if (events.length === 0)
    return <p className="as-muted">No events recorded yet.</p>;
  return (
    <div>
      <label className="as-check">
        <input
          type="checkbox"
          checked={follow}
          onChange={(e) => setFollow(e.target.checked)}
        />{" "}
        Follow newest
      </label>
      <ol
        className="as-events"
        ref={listRef}
        aria-label="Run events, newest last"
      >
        {events.map((event) => (
          <li
            key={event.id ?? `${event.sequence}-${event.timestamp}`}
            className={`as-event as-event-${String(event.kind).replace(".", "-")}`}
          >
            <time dateTime={new Date(event.timestamp).toISOString()}>
              {formatTime(event.timestamp)}
            </time>
            <span className="as-event-kind">{event.kind}</span>
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
              <Provenance value={event.provenance} />
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

function Files({ run, artifacts, presentation, busy, onReview }) {
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
              ? `Changes live in worktree ${maskPath(run.worktree, presentation)}.`
              : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

function Tools({ events, presentation }) {
  const groups = useMemo(() => groupToolEvents(events), [events]);
  if (groups.length === 0)
    return <p className="as-muted">No tool calls recorded.</p>;
  return (
    <table className="as-table">
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
            <td>{group.starts}</td>
            <td>{group.ends}</td>
            <td>{group.errors}</td>
            <td className="as-mono">
              {group.files
                .slice(0, 4)
                .map((f) => maskPath(f, presentation))
                .join(", ")}
              {group.files.length > 4 ? ` +${group.files.length - 4}` : ""}
            </td>
            <td>{group.last ? formatTime(group.last) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
            {n.status}
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

function Usage({ run, events }) {
  const usage = run.usage ?? {};
  const cost = run.cost ?? {};
  const hasUsage = Object.keys(usage).length > 0;
  const hasCost = Object.keys(cost).length > 0;
  const usageEvents = events.filter((e) => e.kind === "usage").length;
  return (
    <div className="as-usage">
      <h4>
        Tokens <span className="as-tag">reported by provider</span>
      </h4>
      {hasUsage ? (
        <dl className="as-passport">
          {Object.entries(usage).map(([key, value]) => (
            <Row key={key} label={key}>
              {typeof value === "object"
                ? JSON.stringify(value)
                : formatNumber(value)}
            </Row>
          ))}
        </dl>
      ) : (
        <p className="as-muted">Token usage not reported by provider.</p>
      )}
      <h4>
        Cost <span className="as-tag">reported by provider</span>
      </h4>
      {hasCost ? (
        <dl className="as-passport">
          {Object.entries(cost).map(([key, value]) => (
            <Row key={key} label={key}>
              {typeof value === "object"
                ? JSON.stringify(value)
                : String(value)}
            </Row>
          ))}
        </dl>
      ) : (
        <p className="as-muted">
          Cost not reported by provider. Agent Space does not estimate cost for
          this run.
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
                <td>{approval.kind}</td>
                <td>{approval.reason ?? "—"}</td>
                <td>
                  {approval.status}
                  {approval.decision ? ` (${approval.decision})` : ""}
                </td>
                <td>{approval.decidedBy ?? approval.decided_by ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

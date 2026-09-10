import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  X,
  RotateCcw,
  ExternalLink,
  Inbox,
  RefreshCw,
  MessageSquareWarning,
} from "lucide-react";
import {
  apiFetch,
  useApi,
  expiresIn,
  maskPath,
  maskText,
  parseDiff,
  formatElapsed,
  RUN_STATUS_LABELS,
} from "../hooks/useApi.js";
import { useGlobal } from "../hooks/useGlobal.js";
import ProviderBadge from "./ProviderBadge.jsx";
import EmptyState from "./EmptyState.jsx";
import {
  URGENCY_RANK,
  orderByUrgency,
  urgencyRank,
} from "../hooks/viewLogic.js";

/* Urgency ordering is in ../hooks/viewLogic.js (covered by node:test). */
export { orderByUrgency, urgencyRank, URGENCY_RANK };

function UrgencyBadge({ urgency }) {
  const level = urgency?.level ?? "normal";
  const label =
    level === "critical" ? "Critical" : level === "high" ? "High" : "Normal";
  return (
    <span
      className={`as-urgency as-urgency-${level}`}
      title={urgency?.reason ?? "urgency not computed"}
      aria-label={`Urgency: ${label}. ${urgency?.reason ?? ""}`}
    >
      {label}
    </span>
  );
}

function DiffPreview({ diff, summary }) {
  const lines = useMemo(() => parseDiff(diff).slice(0, 60), [diff]);
  return (
    <div className="as-diff-block">
      {summary ? (
        <p className="as-muted as-small">
          {summary.files ?? summary.fileCount ?? "?"} file(s), +
          {summary.added ?? summary.additions ?? 0} / −
          {summary.removed ?? summary.deletions ?? 0} lines. This is the patch
          the agent proposes, exactly as it was sent.
        </p>
      ) : null}
      <pre className="as-diff as-diff-preview" aria-label="Diff preview">
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
    </div>
  );
}

/**
 * The exact proposed action, from the server's `proposedAction` when it is
 * present and from the raw payload otherwise. Nothing is paraphrased: a
 * command is shown verbatim so the reader approves what actually runs.
 */
function ProposedAction({ approval, presentation }) {
  const payload = approval.payload ?? {};
  const action = approval.proposedAction ?? {};
  const command =
    action.command ?? payload.command ?? payload.tool_input?.command;
  const path =
    action.path ??
    payload.path ??
    payload.file ??
    payload.tool_input?.file_path;
  const url = action.url ?? payload.url ?? payload.tool_input?.url;
  const diff = payload.diff ?? payload.patch ?? payload.tool_input?.patch;
  const question = payload.question ?? payload.message;
  const tool = action.tool ?? payload.tool ?? payload.tool_name;
  const resources = approval.affectedResources ?? [];
  return (
    <div className="as-payload">
      <p className="as-proposed-line">
        <span className="as-k">Proposed</span>
        <strong>{action.text ?? approval.action ?? approval.kind}</strong>
      </p>
      {command ? (
        <div>
          <span className="as-k">Command</span>
          <code className="as-mono as-exact">{command}</code>
        </div>
      ) : null}
      {path ? (
        <div>
          <span className="as-k">Path</span>
          <code className="as-mono as-exact">
            {maskPath(path, presentation)}
          </code>
        </div>
      ) : null}
      {url ? (
        <div>
          <span className="as-k">URL</span>
          <code className="as-mono as-exact">{url}</code>
        </div>
      ) : null}
      {tool ? (
        <div>
          <span className="as-k">Tool</span>
          <code>{tool}</code>
        </div>
      ) : null}
      {question ? (
        <div>
          <span className="as-k">Question</span>
          <span>{maskText(question, presentation, 8)}</span>
        </div>
      ) : null}
      {resources.length ? (
        <div>
          <span className="as-k">Affects</span>
          <span className="as-row as-wrap">
            {resources.map((resource, index) => (
              <span key={index} className="as-tag">
                {typeof resource === "string"
                  ? maskPath(resource, presentation)
                  : `${resource.type ?? "resource"}: ${maskPath(resource.value ?? resource.id ?? "", presentation)}`}
              </span>
            ))}
          </span>
        </div>
      ) : null}
      {diff ? <DiffPreview diff={diff} summary={action.diffSummary} /> : null}
      {!command && !path && !url && !diff && !question ? (
        <pre className="as-pre">{JSON.stringify(payload, null, 2)}</pre>
      ) : null}
      {approval.kind ? <span className="as-tag">{approval.kind}</span> : null}
    </div>
  );
}

/**
 * Unified decision inbox: pending approvals ordered by urgency, provider
 * questions, failed/stale/disconnected runs and review-pending tasks, from
 * `GET /api/inbox`.
 *
 * Decisions are approve, decline, or request a change. Requesting a change is
 * not a decision: the server keeps the approval pending and the run keeps
 * waiting, and the card says so, because pretending otherwise would let a run
 * resume on a request the agent never saw.
 *
 * Keyboard: with a card focused (or the first card when nothing is focused)
 * `A` approves, `D` declines, `C` requests a change, `J`/`K` move between
 * cards, and `R` refreshes. Every shortcut has a visible button too.
 *
 * @param {{
 *   onOpenRun?: (runId: string, workspaceId?: string) => void,
 *   onOpenTask?: (taskId: string, workspaceId?: string) => void,
 *   presentation?: boolean,
 *   workspaceId?: string|null       // narrows the inbox to one workspace
 * }} props
 */
export default function DecisionInbox({
  onOpenRun,
  onOpenTask,
  presentation = false,
  workspaceId = null,
}) {
  const { revision } = useGlobal();
  const inbox = useApi(
    `/inbox${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`,
    { interval: 15000 },
  );
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [cursor, setCursor] = useState(0);
  const [, setTick] = useState(0);
  const cardRefs = useRef([]);

  useEffect(() => {
    if (revision === 0) return;
    inbox.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const data = inbox.data ?? {};
  const approvals = useMemo(
    () => orderByUrgency(data.approvals ?? data.pending ?? []),
    [data],
  );
  const runs = data.runs ?? data.failedRuns ?? [];
  const reviews = data.reviews ?? data.tasks ?? [];
  const questions = (data.questions ?? []).filter(
    (question) => !approvals.some((approval) => approval.id === question.id),
  );
  const decidable = useMemo(
    () => [...approvals, ...questions],
    [approvals, questions],
  );

  const decide = async (approval, decision) => {
    setBusy(approval.id);
    setFeedback("");
    try {
      await apiFetch(`/approvals/${encodeURIComponent(approval.id)}/decide`, {
        method: "POST",
        body: { decision, note: notes[approval.id] ?? "" },
      });
      setFeedback(
        decision === "approve"
          ? `Approved ${approval.kind ?? "request"}. The run resumes with exactly the payload you saw.`
          : decision === "deny"
            ? `Declined ${approval.kind ?? "request"}. The provider is told no; work already done is not undone.`
            : `Change requested. The approval stays pending and the run keeps waiting until you approve or decline.`,
      );
      inbox.reload();
    } catch (error) {
      setFeedback(
        error.status === 409
          ? "Already decided by someone else."
          : error.status === 410
            ? "This request expired."
            : error.message,
      );
      inbox.reload();
    } finally {
      setBusy("");
    }
  };

  const retry = async (run) => {
    setBusy(run.id);
    setFeedback("");
    try {
      await apiFetch(`/runs/${encodeURIComponent(run.id)}/retry`, {
        method: "POST",
      });
      setFeedback(
        "Retry queued. The provider is reconciled before re-running.",
      );
      inbox.reload();
    } catch (error) {
      setFeedback(error.message);
    } finally {
      setBusy("");
    }
  };

  const onKeyDown = (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key.toLowerCase();
    const target = decidable[cursor];
    if (key === "j" || key === "arrowdown") {
      event.preventDefault();
      const next = Math.min(cursor + 1, Math.max(0, decidable.length - 1));
      setCursor(next);
      cardRefs.current[next]?.focus();
    } else if (key === "k" || key === "arrowup") {
      event.preventDefault();
      const next = Math.max(cursor - 1, 0);
      setCursor(next);
      cardRefs.current[next]?.focus();
    } else if (key === "r") {
      event.preventDefault();
      inbox.reload();
    } else if (target && key === "a") {
      event.preventDefault();
      decide(target, "approve");
    } else if (target && key === "d") {
      event.preventDefault();
      decide(target, "deny");
    } else if (target && key === "c") {
      event.preventDefault();
      decide(target, "request-change");
    }
  };

  const total =
    approvals.length + runs.length + reviews.length + questions.length;
  const counts = {
    critical: approvals.filter((a) => a.urgency?.level === "critical").length,
    high: approvals.filter((a) => a.urgency?.level === "high").length,
  };

  return (
    <section
      className="as-inbox"
      aria-label="Decision inbox"
      onKeyDown={onKeyDown}
    >
      <header className="as-section-head">
        <h3>
          <Inbox size={14} aria-hidden="true" /> Decisions
          {total ? <span className="as-count">{total}</span> : null}
        </h3>
        <div className="as-row">
          {counts.critical ? (
            <span className="as-urgency as-urgency-critical">
              {counts.critical} critical
            </span>
          ) : null}
          {counts.high ? (
            <span className="as-urgency as-urgency-high">
              {counts.high} high
            </span>
          ) : null}
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh inbox"
            onClick={() => inbox.reload()}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>
      <p className="as-muted as-small">
        Ordered by urgency, which the server computes from what is blocked, the
        policy rule that raised it, task priority and how long it has waited.
        Keys: <kbd>J</kbd>/<kbd>K</kbd> move, <kbd>A</kbd> approve, <kbd>D</kbd>{" "}
        decline, <kbd>C</kbd> request a change, <kbd>R</kbd> refresh.
      </p>

      {inbox.error ? (
        <EmptyState
          compact
          title="The inbox is unavailable"
          error={inbox.error}
          missingRoutes={["GET /api/inbox"]}
        />
      ) : null}
      {feedback ? (
        <p className="as-feedback" role="status">
          {feedback}
        </p>
      ) : null}
      {total === 0 && !inbox.loading && !inbox.error ? (
        <EmptyState
          icon={<Inbox size={28} />}
          title="Nothing needs a decision"
          description="Approvals, provider questions, failed runs and pending reviews land here."
          hint="An empty inbox means nothing is waiting on you — not that nothing is running."
        />
      ) : null}

      {decidable.map((approval, index) => {
        const expiry = expiresIn(approval.expiresAt ?? approval.expires_at);
        const changeRequests = approval.changeRequests ?? [];
        return (
          <article
            key={approval.id}
            ref={(node) => {
              cardRefs.current[index] = node;
            }}
            tabIndex={0}
            onFocus={() => setCursor(index)}
            className={`as-card as-approval ${index === cursor ? "focused" : ""}`}
            aria-label={`${approval.kind === "question" ? "Question" : "Approval"} · urgency ${approval.urgency?.level ?? "normal"}`}
          >
            <header className="as-row as-wrap">
              <UrgencyBadge urgency={approval.urgency} />
              <strong>
                {approval.kind === "question"
                  ? "Question from agent"
                  : `Approve ${approval.kind ?? "action"}?`}
              </strong>
              <ProviderBadge provider={approval.provider} size="small" />
              <span className="as-muted">
                {approval.workspaceName ?? approval.workspaceId}
                {approval.agentName ? ` · ${approval.agentName}` : ""}
              </span>
              <span
                className={`as-tag ${expiry === "expired" ? "as-tag-warn" : ""}`}
              >
                {expiry}
              </span>
              {approval.urgency?.ageMs ? (
                <span className="as-tag">
                  waiting {formatElapsed(approval.urgency.ageMs)}
                </span>
              ) : null}
            </header>
            {approval.urgency?.reason ? (
              <p className="as-muted as-small">
                Why now: {approval.urgency.reason}
              </p>
            ) : null}
            {approval.reason ? (
              <p className="as-reason">{approval.reason}</p>
            ) : null}

            <ProposedAction approval={approval} presentation={presentation} />

            {changeRequests.length ? (
              <ul className="as-changerequests" aria-label="Change requests">
                {changeRequests.map((entry, i) => (
                  <li key={i}>
                    <MessageSquareWarning size={12} aria-hidden="true" />
                    <span>{entry.note ?? "change requested"}</span>
                    <span className="as-muted as-small">
                      by {entry.actor ?? "you"} — still pending
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <label className="as-inline-label">
              Note{" "}
              <span className="optional">(recorded with the decision)</span>
              <input
                value={notes[approval.id] ?? ""}
                onChange={(event) =>
                  setNotes({ ...notes, [approval.id]: event.target.value })
                }
                placeholder={
                  approval.kind === "question"
                    ? "Your answer"
                    : "Why, or what to change"
                }
              />
            </label>
            <div className="as-row as-wrap">
              <button
                type="button"
                className="button primary"
                disabled={busy === approval.id}
                onClick={() => decide(approval, "approve")}
                aria-label={`Approve ${approval.kind ?? "request"}`}
              >
                <Check size={12} /> Approve <kbd>A</kbd>
              </button>
              <button
                type="button"
                className="button"
                disabled={busy === approval.id}
                onClick={() => decide(approval, "deny")}
                aria-label={`Decline ${approval.kind ?? "request"}`}
              >
                <X size={12} /> Decline <kbd>D</kbd>
              </button>
              <button
                type="button"
                className="button"
                disabled={busy === approval.id}
                onClick={() => decide(approval, "request-change")}
                aria-label={`Request a change to ${approval.kind ?? "request"}`}
                title="Records what should change. The approval stays pending and the run keeps waiting."
              >
                <MessageSquareWarning size={12} /> Request change <kbd>C</kbd>
              </button>
              {approval.runId ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    onOpenRun?.(approval.runId, approval.workspaceId)
                  }
                >
                  <ExternalLink size={12} /> Open run
                </button>
              ) : null}
            </div>
          </article>
        );
      })}

      {runs.map((run) => (
        <article
          key={run.id}
          className="as-card as-failed"
          aria-label={`Run ${RUN_STATUS_LABELS[run.status] ?? run.status}`}
        >
          <header className="as-row as-wrap">
            <span className={`status as-run-status as-run-${run.status}`}>
              <i className="dot" aria-hidden="true" />
              {RUN_STATUS_LABELS[run.status] ?? run.status}
            </span>
            <ProviderBadge
              provider={run.provider}
              mode={run.mode}
              size="small"
            />
            <strong>{run.title ?? run.label ?? run.id.slice(0, 8)}</strong>
            <span className="as-muted">
              {run.workspaceName ?? run.workspaceId}
            </span>
            {run.attempt ? (
              <span className="as-tag">attempt {run.attempt}</span>
            ) : null}
          </header>
          {run.error ? <p className="as-error-text">{run.error}</p> : null}
          <div className="as-row">
            <button
              type="button"
              className="button"
              disabled={busy === run.id}
              onClick={() => retry(run)}
              aria-label={`Retry run ${run.id.slice(0, 8)}`}
            >
              <RotateCcw size={12} /> Retry
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => onOpenRun?.(run.id, run.workspaceId)}
            >
              <ExternalLink size={12} /> Open run
            </button>
          </div>
        </article>
      ))}

      {reviews.map((task) => (
        <article
          key={task.taskId ?? task.id}
          className="as-card as-review-card"
          aria-label="Review pending"
        >
          <header className="as-row as-wrap">
            <span className="status status-in_progress">
              <i className="dot" aria-hidden="true" />
              Review pending
            </span>
            <strong>{task.title}</strong>
            <span className="as-muted">
              {task.workspaceName ?? task.workspaceId}
            </span>
          </header>
          {task.note ? <p className="as-reason">{task.note}</p> : null}
          <div className="as-row">
            {(task.review?.runId ?? task.runId) ? (
              <button
                type="button"
                className="button primary"
                onClick={() =>
                  onOpenRun?.(
                    task.review?.runId ?? task.runId,
                    task.workspaceId,
                  )
                }
              >
                <ExternalLink size={12} /> Open
              </button>
            ) : null}
            <button
              type="button"
              className="text-button"
              onClick={() =>
                onOpenTask?.(task.taskId ?? task.id, task.workspaceId)
              }
            >
              Open task
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

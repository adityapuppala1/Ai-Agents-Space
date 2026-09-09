import React, { useEffect, useState } from "react";
import {
  Check,
  X,
  RotateCcw,
  ExternalLink,
  Inbox,
  RefreshCw,
} from "lucide-react";
import {
  apiFetch,
  useApi,
  expiresIn,
  maskPath,
  parseDiff,
  RUN_STATUS_LABELS,
} from "../hooks/useApi.js";
import { useGlobal } from "../hooks/useGlobal.js";
import ProviderBadge from "./ProviderBadge.jsx";

function Payload({ kind, payload = {}, presentation }) {
  const command = payload.command ?? payload.cmd ?? payload.tool_input?.command;
  const path =
    payload.path ??
    payload.file ??
    payload.file_path ??
    payload.tool_input?.file_path;
  const url = payload.url ?? payload.tool_input?.url;
  const diff = payload.diff ?? payload.patch;
  const question = payload.question ?? payload.message;
  return (
    <div className="as-payload">
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
      {(payload.tool ?? payload.tool_name) ? (
        <div>
          <span className="as-k">Tool</span>
          <code>{payload.tool ?? payload.tool_name}</code>
        </div>
      ) : null}
      {question ? (
        <div>
          <span className="as-k">Question</span>
          <span>{question}</span>
        </div>
      ) : null}
      {diff ? (
        <pre className="as-diff as-diff-preview" aria-label="Diff preview">
          {parseDiff(diff)
            .slice(0, 40)
            .map((line, i) => (
              <span
                key={i}
                className={`as-diff-${line.type}`}
                data-sign={
                  line.type === "add" ? "+" : line.type === "del" ? "−" : " "
                }
              >
                {line.text || " "}
              </span>
            ))}
        </pre>
      ) : null}
      {!command && !path && !url && !diff && !question ? (
        <pre className="as-pre">{JSON.stringify(payload, null, 2)}</pre>
      ) : null}
      {kind ? <span className="as-tag">{kind}</span> : null}
    </div>
  );
}

/**
 * Unified decision inbox: pending approvals, failed/stale/disconnected runs,
 * review-pending tasks and provider questions from `GET /api/inbox`.
 * Refreshes whenever the global snapshot changes.
 *
 * @param {{
 *   onOpenRun?: (runId: string, workspaceId?: string) => void,
 *   onOpenTask?: (taskId: string, workspaceId?: string) => void,
 *   presentation?: boolean
 * }} props
 */
export default function DecisionInbox({
  onOpenRun,
  onOpenTask,
  presentation = false,
}) {
  const { revision } = useGlobal();
  const inbox = useApi("/inbox", { interval: 15000 });
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (revision === 0) return; // useApi already fetched on mount
    inbox.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const data = inbox.data ?? {};
  const approvals = data.approvals ?? data.pending ?? [];
  const runs = data.runs ?? data.failedRuns ?? [];
  const reviews = data.reviews ?? data.tasks ?? [];
  const questions = (data.questions ?? []).filter(
    (q) => !approvals.some((a) => a.id === q.id),
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
        `${decision === "approve" ? "Approved" : "Denied"} ${approval.kind ?? "request"}.`,
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

  const empty =
    approvals.length + runs.length + reviews.length + questions.length === 0;
  return (
    <section className="as-inbox" aria-label="Decision inbox">
      <header className="as-section-head">
        <h3>
          <Inbox size={14} aria-hidden="true" /> Decisions
        </h3>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh inbox"
          onClick={() => inbox.reload()}
        >
          <RefreshCw size={14} />
        </button>
      </header>
      {inbox.error ? (
        <div className="form-error" role="alert">
          {inbox.error.message}
        </div>
      ) : null}
      {feedback ? (
        <p className="as-feedback" role="status">
          {feedback}
        </p>
      ) : null}
      {empty && !inbox.loading && !inbox.error ? (
        <div className="empty-state">
          <Inbox size={28} aria-hidden="true" />
          <h3>Nothing needs a decision</h3>
          <p>Approvals, failed runs and reviews will show up here.</p>
        </div>
      ) : null}

      {[...approvals, ...questions].map((approval) => (
        <article
          key={approval.id}
          className="as-card as-approval"
          aria-label={`Approval ${approval.kind ?? ""}`}
        >
          <header className="as-row as-wrap">
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
              className={`as-tag ${expiresIn(approval.expiresAt ?? approval.expires_at) === "expired" ? "as-tag-warn" : ""}`}
            >
              {expiresIn(approval.expiresAt ?? approval.expires_at)}
            </span>
          </header>
          {approval.reason ? (
            <p className="as-reason">{approval.reason}</p>
          ) : null}
          <Payload
            kind={approval.kind}
            payload={approval.payload ?? {}}
            presentation={presentation}
          />
          <label className="as-inline-label">
            Note <span className="optional">(optional)</span>
            <input
              value={notes[approval.id] ?? ""}
              onChange={(e) =>
                setNotes({ ...notes, [approval.id]: e.target.value })
              }
              placeholder={approval.kind === "question" ? "Your answer" : "Why"}
            />
          </label>
          <div className="as-row">
            <button
              type="button"
              className="button primary"
              disabled={busy === approval.id}
              onClick={() => decide(approval, "approve")}
              aria-label={`Approve ${approval.kind ?? "request"}`}
            >
              <Check size={12} /> Approve
            </button>
            <button
              type="button"
              className="button"
              disabled={busy === approval.id}
              onClick={() => decide(approval, "deny")}
              aria-label={`Deny ${approval.kind ?? "request"}`}
            >
              <X size={12} /> Deny
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
      ))}

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
          key={task.id}
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
              onClick={() => onOpenTask?.(task.id, task.workspaceId)}
            >
              Open task
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

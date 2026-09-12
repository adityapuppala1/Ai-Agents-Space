import React, { useState } from "react";
import {
  HeartPulse,
  OctagonX,
  Play,
  Database,
  Download,
  ShieldCheck,
  Timer,
  ListOrdered,
  ClipboardCheck,
} from "lucide-react";
import {
  apiFetch,
  useApi,
  formatElapsed,
  formatNumber,
} from "../hooks/useApi.js";
import EmptyState from "./EmptyState.jsx";
import { useGlobal } from "../hooks/useGlobal.js";
import {
  healthSummary,
  providerCounts,
  formatBytes,
} from "../hooks/opsSummary.js";
import { ROADMAP_BOARD, roadmapBoardTotals } from "./roadmapBoard.js";

const LEVEL_TEXT = {
  info: "Note",
  warn: "Attention",
  critical: "Critical",
};

const RETENTION_LABELS = {
  eventsDays: "Events",
  runsDays: "Runs",
  auditDays: "Audit entries",
  artifactsDays: "Artifacts",
};

function Alert({ alert }) {
  return (
    <li className={`as-ops-alert as-ops-${alert.level ?? "info"}`}>
      <span className={`as-tag ${alert.level === "info" ? "" : "as-tag-warn"}`}>
        {LEVEL_TEXT[alert.level] ?? alert.level}
      </span>
      <strong>{alert.title ?? alert.code ?? "alert"}</strong>
      {alert.detail ? (
        <span className="as-muted as-small">{alert.detail}</span>
      ) : null}
      {alert.fix ? <span className="as-small">Fix: {alert.fix}</span> : null}
    </li>
  );
}

function Metric({ label, value, hint }) {
  return (
    <div className="as-tile" role="group" aria-label={`${label}: ${value}`}>
      <span className="as-tile-label">{label}</span>
      <strong className="as-tile-value">{value}</strong>
      {hint ? <span className="as-muted as-small">{hint}</span> : null}
    </div>
  );
}

function RoadmapBoard() {
  const [filter, setFilter] = useState("all");
  const totals = roadmapBoardTotals();
  const labels = {
    all: "All areas",
    completed: "Completed",
    working: "Working on",
    "not-started": "Not started",
  };
  const rows = ROADMAP_BOARD.filter(
    (row) => filter === "all" || row.status === filter,
  );
  return (
    <article className="as-card as-roadmap-board">
      <p className="as-muted as-small">
        {totals.completed} completed · {totals.working} working ·{" "}
        {totals["not-started"]} not started. Implementation review, 11 September
        2026. These are plan statuses, not live agent activity.
      </p>
      <div
        className="as-roadmap-filters"
        role="group"
        aria-label="Filter roadmap status"
      >
        {Object.entries(labels).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className="as-btn"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label} ({value === "all" ? ROADMAP_BOARD.length : totals[value]})
          </button>
        ))}
      </div>
      <p className="as-muted as-small" role="status">
        Showing {rows.length} implementation areas
      </p>
      <div className="as-roadmap-lanes" role="list">
        {rows.map((row) => (
          <div
            key={row.slice}
            className={`as-roadmap-item as-roadmap-${row.status}`}
            role="listitem"
          >
            <span className="as-roadmap-status">{labels[row.status]}</span>
            <strong>{row.slice}</strong>
            <small>{row.detail}</small>
          </div>
        ))}
      </div>
    </article>
  );
}

/**
 * Operations panel: the health dashboard, queue visibility, the incident
 * stop switch, a backup and a restore drill, a diagnostics bundle, the
 * audit verification result, and retention settings.
 *
 * Every destructive action requires an explicit confirmation typed into the
 * request body (`confirm: true`), matching what the server demands, and every
 * one of them says plainly what it does not undo.
 *
 * Routes used: GET /api/ops/health, GET /api/ops/status,
 * POST /api/ops/stop-all, POST /api/ops/resume, POST /api/ops/backup,
 * POST /api/ops/restore-drill, POST /api/ops/diagnostics,
 * GET|PUT /api/ops/retention, POST /api/ops/retention/sweep,
 * GET /api/audit?verify=1.
 *
 * @param {{ pollMs?: number, onOpenAudit?: () => void }} props
 */
export default function OpsPanel({ pollMs = 15000, onOpenAudit }) {
  const health = useApi("/ops/health", { interval: pollMs });
  const status = useApi("/ops/status", { interval: pollMs });
  const retention = useApi("/ops/retention");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmSweep, setConfirmSweep] = useState(false);
  const { global } = useGlobal();
  const workspaceNames = new Map(
    (global.workspaces ?? []).map((workspace) => [
      workspace.id,
      workspace.name,
    ]),
  );
  const [reason, setReason] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [audit, setAudit] = useState(null);
  const [retentionForm, setRetentionForm] = useState(null);

  const data = health.data ?? null;
  const ops = status.data ?? null;
  // GET /api/ops/retention answers { policy, preview }. Reading the whole
  // object as the policy hid the day fields and would have saved the wrapper.
  const policy =
    retentionForm ??
    retention.data?.policy ??
    retention.data?.retention ??
    null;
  const preview = retention.data?.preview ?? null;

  const call = async (key, fn, successText) => {
    setBusy(key);
    setError("");
    setMessage("");
    try {
      const result = await fn();
      setMessage(
        typeof successText === "function" ? successText(result) : successText,
      );
      health.reload();
      status.reload();
      return result;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy("");
    }
  };

  if (health.error && status.error)
    return (
      <EmptyState
        title="Operations are unavailable"
        error={health.error}
        missingRoutes={["GET /api/ops/health", "GET /api/ops/status"]}
      />
    );

  const queue = data?.queue ?? {};
  const stopped = ops?.dispatchStopped ?? data?.incident?.dispatchStopped;
  const summary = healthSummary(data);
  const unacknowledged = Array.isArray(ops?.unacknowledged)
    ? ops.unacknowledged
    : [];
  // The stopped-dispatch banner already says it; the alert list does not
  // repeat it.
  const alerts = (data?.alerts ?? []).filter(
    (alert) => !(stopped && alert.code === "ops.dispatch-stopped"),
  );
  const workspaceRows = Object.entries(
    queue.byWorkspace && !Array.isArray(queue.byWorkspace)
      ? queue.byWorkspace
      : {},
  ).sort((a, b) => b[1] - a[1]);

  return (
    <section className="as-ops ops" aria-label="Operations">
      <p className={`ops-status is-${summary.tone}`}>
        <HeartPulse size={15} aria-hidden="true" />
        <strong>{summary.label}</strong>
        <span className="as-muted">{summary.detail}</span>
      </p>

      {message ? (
        <p className="as-feedback" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}

      {stopped ? (
        <div className="as-ops-banner" role="alert">
          <OctagonX size={14} aria-hidden="true" />
          <div>
            <strong>Dispatch is stopped.</strong>{" "}
            <span>
              No new run will start.
              {ops?.reason ? ` Reason: ${ops.reason}.` : ""}
              {ops?.stoppedBy ? ` Stopped by ${ops.stoppedBy}.` : ""} Runs that
              were already executing were interrupted where possible;
              interrupting does not undo side effects.
              {unacknowledged.length
                ? ` ${unacknowledged.length} run${unacknowledged.length === 1 ? " has" : "s have"} not reached a stopped state yet; a headless or offline worker may not have received the stop.`
                : ""}
            </span>
          </div>
          <button
            type="button"
            className="button primary"
            disabled={busy === "resume"}
            onClick={() =>
              call(
                "resume",
                () =>
                  apiFetch("/ops/resume", {
                    method: "POST",
                    body: {
                      confirm: true,
                      reason: reason || "resumed by operator",
                    },
                  }),
                "Dispatch resumed. Queued work will start again.",
              )
            }
          >
            <Play size={12} /> Resume dispatch
          </button>
        </div>
      ) : null}

      {alerts.length ? (
        <article className="as-card">
          <h2>
            Alerts <span className="as-muted as-small">({alerts.length})</span>
          </h2>
          <ul className="as-ops-alerts" role="list">
            {alerts.map((alert, index) => (
              <Alert key={alert.code ?? alert.id ?? index} alert={alert} />
            ))}
          </ul>
        </article>
      ) : null}

      {/* ------------------------------------------------- health dashboard */}
      {/* Nothing is shown as a value until the health check has answered: a
          "read-only" database or "0 approvals" before loading is invented. */}
      {data ? (
        <div className="as-tiles ops-tiles">
          <Metric
            label="Database"
            value={data.db?.writable ? "Writable" : "Not writable"}
            hint={
              data.db?.inMemory
                ? "in memory for this session"
                : data.db?.sizeBytes
                  ? formatBytes(data.db.sizeBytes)
                  : undefined
            }
          />
          <Metric
            label="Approvals waiting"
            value={formatNumber(data.approvals?.pending ?? 0)}
            hint={
              data.approvals?.oldestPendingMs
                ? `oldest waiting ${formatElapsed(data.approvals.oldestPendingMs)}`
                : undefined
            }
          />
          <Metric
            label="Session observation"
            value={data.observation?.enabled ? "On" : "Off"}
            hint={
              data.observation?.enabled
                ? `${data.observation.sessionsLive ?? 0} live session${data.observation.sessionsLive === 1 ? "" : "s"}`
                : undefined
            }
          />
          <Metric
            label="Assistants available"
            value={`${providerCounts(data).available} of ${providerCounts(data).installed}`}
            hint="installed; available means a sign-in file exists"
          />
          <Metric
            label="Uptime"
            value={formatElapsed(data.uptimeMs)}
            hint={
              data.schemaVersion ? `schema ${data.schemaVersion}` : undefined
            }
          />
        </div>
      ) : (
        <p className="as-muted">Checking health…</p>
      )}

      {/* -------------------------------------------------------- the queue */}
      {data ? (
        <article className="as-card">
          <h2>
            <ListOrdered size={13} aria-hidden="true" /> Runs in flight
          </h2>
          <p className="ops-queue-line">
            <strong>{formatNumber(queue.active ?? 0)}</strong> running ·{" "}
            <strong>{formatNumber(queue.queued ?? 0)}</strong> queued
          </p>
          {workspaceRows.length ? (
            <ul className="ops-queue-list" role="list">
              {workspaceRows.map(([workspaceId, count]) => (
                <li key={workspaceId}>
                  <span>{workspaceNames.get(workspaceId) ?? workspaceId}</span>
                  <span className="as-muted">
                    {formatNumber(count)} run{count === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="as-muted as-small">No run is in flight.</p>
          )}
        </article>
      ) : null}

      {/* -------------------------------------------------- incident switch */}
      <article className="as-card as-ops-danger">
        <h2>
          <OctagonX size={13} aria-hidden="true" /> Stop all work
        </h2>
        <p className="as-muted as-small">
          This is an operations action, not a safety guarantee. It stops
          dispatch and interrupts running provider processes. Work a provider
          has already written to disk, pushed, or sent stays done — interrupting
          does not undo side effects. A stop is requested, never assumed: each
          run stays listed until it actually reaches a stopped state.
        </p>
        <label className="as-inline-label">
          <span>
            Reason <span className="optional">(recorded in the audit log)</span>
          </span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why work is being stopped"
          />
        </label>
        {confirmStop ? (
          <div className="as-row as-wrap">
            <strong>Stop every run now?</strong>
            <button
              type="button"
              className="button danger"
              disabled={busy === "stop"}
              onClick={async () => {
                setConfirmStop(false);
                await call(
                  "stop",
                  () =>
                    apiFetch("/ops/stop-all", {
                      method: "POST",
                      body: { confirm: true, reason },
                    }),
                  (result) =>
                    `Dispatch stopped. ${formatNumber(result?.stopped?.length ?? result?.stopped ?? 0)} run(s) were interrupted; side effects already applied are not undone.`,
                );
              }}
            >
              Yes, stop everything
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setConfirmStop(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="button"
            disabled={stopped}
            onClick={() => setConfirmStop(true)}
          >
            Stop all runs…
          </button>
        )}
      </article>

      {/* -------------------------------------------- backup / restore drill */}
      <article className="as-card">
        <h2>
          <Database size={13} aria-hidden="true" /> Backup and restore drill
        </h2>
        <label className="as-inline-label">
          Backup file path
          <input
            value={backupPath}
            onChange={(event) => setBackupPath(event.target.value)}
            placeholder="C:\\backups\\agent-space.sqlite"
          />
        </label>
        <div className="as-row as-wrap">
          <button
            type="button"
            className="button"
            disabled={busy === "backup" || !backupPath.trim()}
            onClick={() =>
              call(
                "backup",
                () =>
                  apiFetch("/ops/backup", {
                    method: "POST",
                    body: { confirm: true, outPath: backupPath.trim() },
                  }),
                (result) =>
                  `Backup written to ${result?.path ?? backupPath}${result?.bytes ? ` (${formatNumber(result.bytes)} bytes)` : ""}.`,
              )
            }
          >
            Back up the database
          </button>
          <button
            type="button"
            className="button"
            disabled={busy === "drill"}
            onClick={() =>
              call(
                "drill",
                () =>
                  apiFetch("/ops/restore-drill", {
                    method: "POST",
                    body: { confirm: true },
                  }),
                (result) =>
                  result?.ok
                    ? `Restore drill passed: the backup opened and reported schema version ${result.schemaVersion ?? "unknown"}.`
                    : `Restore drill failed: ${result?.error ?? "see the server log"}.`,
              )
            }
          >
            Run a restore drill
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy === "diagnostics"}
            aria-label="Write a diagnostics bundle"
            onClick={() =>
              call(
                "diagnostics",
                () =>
                  apiFetch("/ops/diagnostics", {
                    method: "POST",
                    body: { confirm: true },
                  }),
                (result) =>
                  `Diagnostics bundle written to ${result?.path ?? "the diagnostics folder"}.`,
              )
            }
          >
            <Download size={12} /> Diagnostics
          </button>
        </div>
        <p className="as-muted as-small">
          The restore drill opens the backup in a temporary location and reads
          it. It never replaces your live database.
        </p>
      </article>

      {/* -------------------------------------------------- audit verification */}
      <article className="as-card">
        <h2>
          <ShieldCheck size={13} aria-hidden="true" /> Audit verification
        </h2>
        <div className="as-row as-wrap">
          <button
            type="button"
            className="button"
            disabled={busy === "audit"}
            onClick={async () => {
              const result = await call(
                "audit",
                () => apiFetch("/audit/verify"),
                "Audit chain checked.",
              );
              setAudit(result ?? null);
            }}
          >
            Verify the audit chain
          </button>
          {onOpenAudit ? (
            <button type="button" className="text-button" onClick={onOpenAudit}>
              Open the audit log
            </button>
          ) : null}
        </div>
        {audit ? (
          <p
            className={audit.ok === false ? "as-error-text" : "as-feedback"}
            role="status"
          >
            {audit.ok === false
              ? `Verification failed${audit.brokenAt !== null && audit.brokenAt !== undefined ? ` at sequence ${audit.brokenAt}` : ""}: ${audit.brokenReason ?? "the recorded chain does not match"}.`
              : `Verified ${formatNumber(audit.count ?? 0)} chained entries (sequence ${audit.firstSequence ?? "—"}–${audit.lastSequence ?? "—"}).`}
            {audit.unchained
              ? ` ${formatNumber(audit.unchained)} older entry(ies) predate the hash chain and are not claimed as verified.`
              : ""}
          </p>
        ) : (
          <p className="as-muted as-small">
            Verification recomputes the stored chain. A pass proves the recorded
            entries were not rewritten in place; it cannot prove that an event
            was never missed.
          </p>
        )}
      </article>

      {/* ---------------------------------------------------------- retention */}
      <article className="as-card">
        <h2>
          <Timer size={13} aria-hidden="true" /> Retention
        </h2>
        {retention.error ? (
          <EmptyState
            compact
            title="Retention settings unavailable"
            error={retention.error}
            missingRoutes={["GET /api/ops/retention"]}
          />
        ) : null}
        {policy ? (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              await call(
                "retention",
                () =>
                  apiFetch("/ops/retention", { method: "PUT", body: policy }),
                "Retention policy saved. It applies on the next sweep.",
              );
              retention.reload();
              setRetentionForm(null);
            }}
          >
            <div className="form-columns">
              <label className="as-check">
                <input
                  type="checkbox"
                  checked={Boolean(policy.enabled)}
                  onChange={(event) =>
                    setRetentionForm({
                      ...policy,
                      enabled: event.target.checked,
                    })
                  }
                />
                Delete old records automatically
              </label>
              {["eventsDays", "runsDays", "auditDays", "artifactsDays"].map(
                (key) =>
                  policy[key] === undefined ? null : (
                    <label key={key}>
                      {RETENTION_LABELS[key]} kept for (days)
                      <input
                        type="number"
                        min="1"
                        value={policy[key] ?? ""}
                        onChange={(event) =>
                          setRetentionForm({
                            ...policy,
                            [key]: event.target.value
                              ? Number(event.target.value)
                              : null,
                          })
                        }
                      />
                    </label>
                  ),
              )}
            </div>
            <div className="as-row as-wrap">
              <button
                type="submit"
                className="button primary"
                disabled={busy === "retention"}
              >
                Save retention
              </button>
              <button
                type="button"
                className="button"
                disabled={busy === "sweep"}
                onClick={() =>
                  call(
                    "sweep",
                    () =>
                      apiFetch("/ops/retention/sweep", {
                        method: "POST",
                        body: { confirm: true, dryRun: true },
                      }),
                    (result) =>
                      `Dry run: ${formatNumber(
                        result?.total ??
                          Object.values(result?.deleted ?? {}).reduce(
                            (sum, value) => sum + (Number(value) || 0),
                            0,
                          ),
                      )} record(s) would be deleted. Nothing was removed.`,
                  )
                }
              >
                Preview a sweep
              </button>
              {/* Deleting records is permanent, so it takes a second step,
                  like stopping all work. */}
              {confirmSweep ? null : (
                <button
                  type="button"
                  className="button danger"
                  disabled={busy === "sweep-real"}
                  onClick={() => setConfirmSweep(true)}
                >
                  Sweep now…
                </button>
              )}
            </div>
            {confirmSweep ? (
              <div className="as-row as-wrap ops-confirm" role="group">
                <strong>
                  Delete every record older than these limits now? Without a
                  backup this cannot be undone.
                </strong>
                <button
                  type="button"
                  className="button danger"
                  disabled={busy === "sweep-real"}
                  onClick={async () => {
                    setConfirmSweep(false);
                    await call(
                      "sweep-real",
                      () =>
                        apiFetch("/ops/retention/sweep", {
                          method: "POST",
                          body: { confirm: true, dryRun: false },
                        }),
                      "Sweep finished. Deleted records cannot be recovered without a backup.",
                    );
                  }}
                >
                  Yes, delete them
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => setConfirmSweep(false)}
                >
                  Cancel
                </button>
              </div>
            ) : null}
            {preview?.counts ? (
              <p className="as-small">
                At the saved limits a sweep would delete{" "}
                {formatNumber(preview.counts.events ?? 0)} events,{" "}
                {formatNumber(preview.counts.runs ?? 0)} runs,{" "}
                {formatNumber(preview.counts.audit ?? 0)} audit entries and{" "}
                {formatNumber(preview.counts.artifacts ?? 0)} artifacts
                {preview.protectedRuns
                  ? `; ${formatNumber(preview.protectedRuns)} runs are protected and kept`
                  : ""}
                .
              </p>
            ) : null}
            <p className="as-muted as-small">
              Deleting events removes the evidence behind past runs: a day in
              review or a lineage view will say the events are gone rather than
              reconstructing them.
            </p>
          </form>
        ) : null}
      </article>

      {/* The implementation plan is a document, not an operations signal:
          it sits last and closed. */}
      <details className="ops-roadmap">
        <summary>
          <ClipboardCheck size={14} aria-hidden="true" /> Roadmap progress
          <span className="as-muted as-small">
            plan statuses, not live activity
          </span>
        </summary>
        <RoadmapBoard />
      </details>
    </section>
  );
}

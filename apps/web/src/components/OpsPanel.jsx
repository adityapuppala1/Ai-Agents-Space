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
} from "lucide-react";
import {
  apiFetch,
  useApi,
  formatElapsed,
  formatNumber,
} from "../hooks/useApi.js";
import EmptyState from "./EmptyState.jsx";

const LEVEL_TEXT = {
  ok: "ok",
  info: "ok",
  warn: "attention",
  critical: "critical",
  degraded: "degraded",
  down: "down",
};

function Alert({ alert }) {
  return (
    <li className={`as-ops-alert as-ops-${alert.level ?? "info"}`}>
      <span className={`as-tag ${alert.level === "info" ? "" : "as-tag-warn"}`}>
        {LEVEL_TEXT[alert.level] ?? alert.level}
      </span>
      <strong>{alert.title ?? alert.id ?? "alert"}</strong>
      {alert.detail ? (
        <span className="as-muted as-small">{alert.detail}</span>
      ) : null}
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
  const [reason, setReason] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [audit, setAudit] = useState(null);
  const [retentionForm, setRetentionForm] = useState(null);

  const data = health.data ?? null;
  const ops = status.data ?? null;
  const policy =
    retentionForm ?? retention.data?.retention ?? retention.data ?? null;

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

  return (
    <section className="as-ops" aria-label="Operations">
      <header className="as-section-head">
        <h3>
          <HeartPulse size={14} aria-hidden="true" /> Operations
        </h3>
        <span
          className={`as-tag ${data?.status === "ok" ? "" : "as-tag-warn"}`}
        >
          {LEVEL_TEXT[data?.status] ?? data?.status ?? "unknown"}
        </span>
      </header>

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

      {/* ------------------------------------------------- health dashboard */}
      <div className="as-tiles">
        <Metric
          label="Uptime"
          value={data ? formatElapsed(data.uptimeMs) : "—"}
        />
        <Metric
          label="Schema version"
          value={data?.schemaVersion ?? "—"}
          hint="database migration level"
        />
        <Metric
          label="Database"
          value={data?.db?.writable ? "writable" : "read-only"}
          hint={
            data?.db?.sizeBytes
              ? `${formatNumber(data.db.sizeBytes)} bytes`
              : undefined
          }
        />
        <Metric
          label="Approvals waiting"
          value={formatNumber(data?.approvals?.pending ?? 0)}
        />
        <Metric
          label="Observation"
          value={data?.observation?.enabled ? "on" : "off"}
          hint={
            data?.observation?.liveSessions !== undefined
              ? `${data.observation.liveSessions} live sessions`
              : undefined
          }
        />
        <Metric
          label="Providers ready"
          value={formatNumber(
            data?.providers?.ready ??
              (data?.providers?.connections ?? []).filter(
                (c) => c.status === "ready" && c.enabled,
              ).length,
          )}
          hint={
            (data?.providers?.total ?? data?.providers?.connections?.length) !==
            undefined
              ? `of ${data.providers.total ?? data.providers.connections.length} detected`
              : undefined
          }
        />
      </div>

      {data?.alerts?.length ? (
        <article className="as-card">
          <h4>Alerts</h4>
          <ul className="as-ops-alerts" role="list">
            {data.alerts.map((alert, index) => (
              <Alert key={alert.id ?? index} alert={alert} />
            ))}
          </ul>
        </article>
      ) : null}

      {/* -------------------------------------------------------- the queue */}
      <article className="as-card">
        <h4>
          <ListOrdered size={13} aria-hidden="true" /> Queue
        </h4>
        <div className="as-tiles">
          <Metric label="Running" value={formatNumber(queue.running ?? 0)} />
          <Metric label="Queued" value={formatNumber(queue.queued ?? 0)} />
          <Metric
            label="Waiting for approval"
            value={formatNumber(queue.waitingApproval ?? 0)}
          />
          <Metric label="Stale" value={formatNumber(queue.stale ?? 0)} />
        </div>
        {Array.isArray(queue.byWorkspace) && queue.byWorkspace.length ? (
          <div className="as-table-wrap">
            <table className="as-table as-numeric">
              <thead>
                <tr>
                  <th scope="col">Workspace</th>
                  <th scope="col">Running</th>
                  <th scope="col">Queued</th>
                  <th scope="col">Limit</th>
                </tr>
              </thead>
              <tbody>
                {queue.byWorkspace.map((row) => (
                  <tr key={row.workspaceId}>
                    <th scope="row">{row.name ?? row.workspaceId}</th>
                    <td>{formatNumber(row.running ?? 0)}</td>
                    <td>{formatNumber(row.queued ?? 0)}</td>
                    <td>{formatNumber(row.limit ?? "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="as-muted as-small">
            No per-workspace queue detail is reported by this server build.
          </p>
        )}
      </article>

      {/* -------------------------------------------------- incident switch */}
      <article className="as-card as-ops-danger">
        <h4>
          <OctagonX size={13} aria-hidden="true" /> Stop all work
        </h4>
        <p className="as-muted as-small">
          This is an operations action, not a safety guarantee. It stops
          dispatch and interrupts running provider processes. Work a provider
          has already written to disk, pushed, or sent stays done — interrupting
          does not undo side effects. Each interrupted run is recorded and must
          be acknowledged.
        </p>
        <label className="as-inline-label">
          Reason <span className="optional">(recorded in the audit log)</span>
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
        {Array.isArray(ops?.unacknowledged) && ops.unacknowledged.length ? (
          <p className="as-muted as-small">
            {ops.unacknowledged.length} interrupted run(s) still need
            acknowledgement in the decision inbox.
          </p>
        ) : null}
      </article>

      {/* -------------------------------------------- backup / restore drill */}
      <article className="as-card">
        <h4>
          <Database size={13} aria-hidden="true" /> Backup and restore drill
        </h4>
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
        <h4>
          <ShieldCheck size={13} aria-hidden="true" /> Audit verification
        </h4>
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
        <h4>
          <Timer size={13} aria-hidden="true" /> Retention
        </h4>
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
              <label className="as-inline-label">
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
                      {key.replace("Days", "")} kept for (days)
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
              <button
                type="button"
                className="button danger"
                disabled={busy === "sweep-real"}
                onClick={() =>
                  call(
                    "sweep-real",
                    () =>
                      apiFetch("/ops/retention/sweep", {
                        method: "POST",
                        body: { confirm: true, dryRun: false },
                      }),
                    "Sweep finished. Deleted records cannot be recovered without a backup.",
                  )
                }
              >
                Sweep now
              </button>
            </div>
            <p className="as-muted as-small">
              Deleting events removes the evidence behind past runs: a day in
              review or a lineage view will say the events are gone rather than
              reconstructing them.
            </p>
          </form>
        ) : null}
      </article>
    </section>
  );
}

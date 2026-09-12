import React, { useEffect, useMemo, useState } from "react";
import { Shield, Search } from "lucide-react";
import EmptyState from "./EmptyState.jsx";
import { apiFetch, useApi } from "../hooks/useApi.js";
import RoutingRules from "./RoutingRules.jsx";

const FALLBACK_PRESETS = [
  {
    id: "observe-only",
    label: "Observe only",
    description: "Never launch runs from this workspace; only watch sessions.",
  },
  {
    id: "propose",
    label: "Propose",
    description:
      "Launch read-only runs that plan or explain. No file writes or shell.",
  },
  {
    id: "sandbox",
    label: "Execute in sandbox",
    description:
      "Writes go to an isolated Git worktree; shell allowed inside it; you review the patch.",
  },
  {
    id: "scoped",
    label: "Scoped execution",
    description:
      "Writes to the project folder; risky commands and pushes need your approval.",
  },
];

/**
 * Workspace policy editor: GET/PUT /api/workspaces/:id/policy plus a preview
 * box calling POST /api/workspaces/:id/policy/preview. Policies are enforced
 * server-side; this form only edits the stored rules.
 * @param {{ workspaceId: string, onSaved?: (policy: object) => void }} props
 */
export default function PolicyEditor({ workspaceId, onSaved }) {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/policy`;
  const policy = useApi(base);
  const presets = useApi("/policy/presets");
  const presetList = useMemo(() => {
    const data = presets.data;
    if (!data) return FALLBACK_PRESETS;
    if (Array.isArray(data)) return data;
    return Object.entries(data).map(([id, value]) => ({ id, ...value }));
  }, [presets.data]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [preview, setPreview] = useState({
    kind: "command",
    command: "",
    path: "",
    url: "",
  });
  const [verdict, setVerdict] = useState(null);
  const retention = useApi("/ops/retention");
  const opsStatus = useApi("/ops/status", { interval: 20000 });
  const [opsBusy, setOpsBusy] = useState(false);
  const [opsMessage, setOpsMessage] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const retentionPolicy = retention.data?.retention ?? retention.data ?? null;
  const dispatchStopped = opsStatus.data?.dispatchStopped ?? false;

  useEffect(() => {
    const data = policy.data?.policy ?? policy.data;
    if (data && typeof data === "object")
      setForm({
        autonomy: data.autonomy ?? "scoped",
        maxConcurrentRuns: data.maxConcurrentRuns ?? 2,
        allowedFolders: (data.allowedFolders ?? []).join("\n"),
        deniedCommands: (data.deniedCommands ?? []).join("\n"),
        timeoutMinutes: Math.round((data.timeoutMs ?? 30 * 60 * 1000) / 60000),
        maxRepairAttempts: data.maxRepairAttempts ?? "",
        maxTokensPerRun: data.budget?.maxTokensPerRun ?? "",
        maxRunsPerDay: data.budget?.maxRunsPerDay ?? "",
      });
  }, [policy.data]);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const body = {
        autonomy: form.autonomy,
        maxConcurrentRuns: Number(form.maxConcurrentRuns) || 1,
        allowedFolders: form.allowedFolders
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        deniedCommands: form.deniedCommands
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        timeoutMs: Math.max(1, Number(form.timeoutMinutes) || 30) * 60000,
        budget: {
          maxTokensPerRun: form.maxTokensPerRun
            ? Number(form.maxTokensPerRun)
            : null,
          maxRunsPerDay: form.maxRunsPerDay ? Number(form.maxRunsPerDay) : null,
        },
      };
      if (form.maxRepairAttempts !== "")
        body.maxRepairAttempts = Number(form.maxRepairAttempts);
      const result = await apiFetch(base, { method: "PUT", body });
      onSaved?.(result);
      setSaved(
        "Policy saved. It is enforced by the server on every launch and tool call.",
      );
      policy.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (event) => {
    event.preventDefault();
    setVerdict(null);
    const request = { kind: preview.kind };
    if (preview.kind === "command") request.command = preview.command;
    else if (preview.kind === "network") request.url = preview.url;
    else request.path = preview.path;
    try {
      const result = await apiFetch(`${base}/preview`, {
        method: "POST",
        body: request,
      });
      setVerdict(result);
    } catch (err) {
      setVerdict({ decision: "error", reason: err.message });
    }
  };

  if (policy.error)
    return (
      <div className="form-error" role="alert">
        {policy.error.message}
      </div>
    );
  if (!form) return <p className="as-muted">Loading policy…</p>;
  const set = (key, value) => setForm({ ...form, [key]: value });
  return (
    <section className="as-policy" aria-label="Workspace policy">
      <form onSubmit={save}>
        <header className="as-section-head">
          <h3>
            <Shield size={14} aria-hidden="true" /> Execution policy
          </h3>
          <span className="as-muted">Enforced server-side</span>
        </header>
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        {saved ? (
          <p className="as-feedback" role="status">
            {saved}
          </p>
        ) : null}
        <fieldset className="as-fieldset">
          <legend>Autonomy preset</legend>
          {presetList.map((preset) => (
            <label key={preset.id} className="as-radio">
              <input
                type="radio"
                name="autonomy"
                value={preset.id}
                checked={form.autonomy === preset.id}
                onChange={() => set("autonomy", preset.id)}
              />
              <span>
                <strong>{preset.label ?? preset.id}</strong>
                <span className="as-muted">{preset.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="form-columns">
          <label>
            Max concurrent runs
            <input
              type="number"
              min={1}
              max={32}
              value={form.maxConcurrentRuns}
              onChange={(e) => set("maxConcurrentRuns", e.target.value)}
            />
          </label>
          <label>
            Run timeout (minutes)
            <input
              type="number"
              min={1}
              value={form.timeoutMinutes}
              onChange={(e) => set("timeoutMinutes", e.target.value)}
            />
          </label>
        </div>
        <div className="form-columns">
          <label>
            Allowed folders{" "}
            <span className="optional">
              (one per line; empty = workspace root only)
            </span>
            <textarea
              rows={4}
              value={form.allowedFolders}
              onChange={(e) => set("allowedFolders", e.target.value)}
            />
          </label>
          <label>
            Denied commands{" "}
            <span className="optional">(one per line, prefix match)</span>
            <textarea
              rows={4}
              value={form.deniedCommands}
              onChange={(e) => set("deniedCommands", e.target.value)}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button type="submit" className="button primary" disabled={busy}>
            Save policy
          </button>
        </div>
      </form>
      <section
        className="as-card as-policy-limits"
        aria-label="Limits and budgets"
      >
        <h4>Limits and budgets</h4>
        <div className="form-columns">
          <label>
            Bounded repair attempts
            <input
              type="number"
              min="0"
              max="10"
              value={form.maxRepairAttempts}
              onChange={(event) => set("maxRepairAttempts", event.target.value)}
              placeholder="server default"
            />
            <span className="as-muted as-small">
              How many times a rejected task may open a repair task before the
              workflow gives up and asks a human. The value shown is what the
              server reports; a build whose policy validator does not accept
              this key will keep its own default.
            </span>
          </label>
          <label>
            Token budget per run
            <input
              type="number"
              min="1"
              value={form.maxTokensPerRun}
              onChange={(event) => set("maxTokensPerRun", event.target.value)}
              placeholder="no limit"
            />
            <span className="as-muted as-small">
              Recorded, and shown against reported usage. Token totals arrive
              after a turn finishes, so this cannot stop a run mid-turn — it is
              a budget you are told about, not a hard cap.
            </span>
          </label>
          <label>
            Runs per day
            <input
              type="number"
              min="1"
              value={form.maxRunsPerDay}
              onChange={(event) => set("maxRunsPerDay", event.target.value)}
              placeholder="no limit"
            />
            <span className="as-muted as-small">
              Enforced before launch: the server refuses a new run once the day
              total is reached.
            </span>
          </label>
        </div>
      </section>

      <RoutingRules
        workspaceId={workspaceId}
        policy={policy.data?.policy ?? policy.data}
        onSaved={(result) => {
          onSaved?.(result);
          policy.reload();
        }}
      />

      <section className="as-card as-policy-ops" aria-label="Operations">
        <h4>Retention and the incident stop switch</h4>
        <p className="as-muted as-small">
          These are operations actions, not policy rules. They apply to the
          whole installation, not just this workspace, and they are recorded in
          the audit log.
        </p>
        {opsMessage ? (
          <p className="as-feedback" role="status">
            {opsMessage}
          </p>
        ) : null}
        {retention.error ? (
          <EmptyState
            compact
            title="Retention settings unavailable"
            error={retention.error}
            missingRoutes={["GET /api/ops/retention"]}
          />
        ) : retentionPolicy ? (
          <p className="as-small">
            Retention is{" "}
            <strong>{retentionPolicy.enabled ? "on" : "off"}</strong>
            {retentionPolicy.enabled
              ? `: events kept ${retentionPolicy.eventsDays ?? "?"} day(s).`
              : ": nothing is deleted automatically."}{" "}
            Deleting events removes the evidence behind past runs; a day in
            review or a lineage view then says the events are gone rather than
            reconstructing them. Change it in Operations.
          </p>
        ) : null}

        {dispatchStopped ? (
          <div className="as-verdict as-verdict-deny" role="status">
            <strong>DISPATCH STOPPED</strong>
            <span>
              No new run will start anywhere until an operator resumes dispatch
              in Operations.
            </span>
          </div>
        ) : confirmStop ? (
          <div className="as-row as-wrap">
            <strong>Stop every run on this installation?</strong>
            <button
              type="button"
              className="button danger"
              disabled={opsBusy}
              onClick={async () => {
                setOpsBusy(true);
                setConfirmStop(false);
                try {
                  const result = await apiFetch("/ops/stop-all", {
                    method: "POST",
                    body: {
                      confirm: true,
                      reason: "stopped from the policy editor",
                    },
                  });
                  setOpsMessage(
                    `Dispatch stopped; ${result?.stopped?.length ?? 0} run(s) were interrupted. Side effects already applied are not undone.`,
                  );
                  opsStatus.reload();
                } catch (err) {
                  setOpsMessage(err.message);
                } finally {
                  setOpsBusy(false);
                }
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
            disabled={opsBusy || opsStatus.error}
            onClick={() => setConfirmStop(true)}
            title={
              opsStatus.error
                ? "This server has no /api/ops/status route"
                : undefined
            }
          >
            Stop all runs…
          </button>
        )}
      </section>

      <form
        className="as-preview"
        onSubmit={runPreview}
        aria-label="Policy preview"
      >
        <h4>
          <Search size={13} aria-hidden="true" /> Preview a decision
        </h4>
        <div className="form-columns">
          <label>
            Request kind
            <select
              value={preview.kind}
              onChange={(e) => setPreview({ ...preview, kind: e.target.value })}
            >
              <option value="command">command</option>
              <option value="file">file</option>
              <option value="network">network</option>
              <option value="tool">tool</option>
            </select>
          </label>
          <label>
            {preview.kind === "command"
              ? "Command"
              : preview.kind === "network"
                ? "URL"
                : "Path"}
            {preview.kind === "command" ? (
              <input
                value={preview.command}
                onChange={(e) =>
                  setPreview({ ...preview, command: e.target.value })
                }
                placeholder="git push origin main"
              />
            ) : preview.kind === "network" ? (
              <input
                value={preview.url}
                onChange={(e) =>
                  setPreview({ ...preview, url: e.target.value })
                }
                placeholder="https://example.com"
              />
            ) : (
              <input
                value={preview.path}
                onChange={(e) =>
                  setPreview({ ...preview, path: e.target.value })
                }
                placeholder="src/.env"
              />
            )}
          </label>
        </div>
        <div className="modal-actions">
          <button type="submit" className="button">
            Preview
          </button>
        </div>
        {verdict ? (
          <div
            className={`as-verdict as-verdict-${verdict.decision}`}
            role="status"
          >
            <strong>
              {String(verdict.decision ?? "unknown").toUpperCase()}
            </strong>
            <span>{verdict.reason ?? "no reason given"}</span>
            {verdict.rule ? (
              <code className="as-mono">
                rule:{" "}
                {typeof verdict.rule === "string"
                  ? verdict.rule
                  : JSON.stringify(verdict.rule)}
              </code>
            ) : null}
          </div>
        ) : null}
        <p className="as-muted as-small">
          The preview explains the stored rules. It never bypasses enforcement.
        </p>
      </form>
    </section>
  );
}

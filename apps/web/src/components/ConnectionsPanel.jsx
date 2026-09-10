import React, { useEffect, useMemo, useState } from "react";
import {
  Plug,
  RefreshCw,
  Activity,
  Shield,
  ChevronRight,
  ChevronLeft,
  Check,
  TriangleAlert,
  Info,
  X,
} from "lucide-react";
import {
  apiFetch,
  useApi,
  providerLabel,
  maskPath,
  formatTime,
} from "../hooks/useApi.js";
import { useGlobal } from "../hooks/useGlobal.js";
import ProviderBadge from "./ProviderBadge.jsx";
import EmptyState from "./EmptyState.jsx";
import Dialog from "./Dialog.jsx";
import TaskLauncher from "./TaskLauncher.jsx";

const CAP_ORDER = [
  "observe",
  "launch",
  "stream",
  "attach",
  "interrupt",
  "resume",
  "fork",
  "approve",
  "reportModel",
  "reportUsage",
  "artifacts",
  "delegate",
];
const DOCS = {
  "claude-code":
    "Run `claude` once in a terminal and sign in when prompted (or `claude login`).",
  codex: "Run `codex login` in a terminal (ChatGPT account or API key).",
  copilot:
    "Run `copilot` and follow the GitHub device login. Non-interactive runs require --allow-all-tools.",
  cursor:
    "Install cursor-agent from Cursor settings; managed runs are experimental.",
  gemini:
    "Install Gemini CLI (`npm i -g @google/gemini-cli`) and run `gemini` to sign in. Unverified here.",
};

function Caps({ caps = {} }) {
  return (
    <div className="as-caps" aria-label="Capabilities">
      {CAP_ORDER.filter((key) => caps[key] !== undefined).map((key) => (
        <span
          key={key}
          className={`as-cap as-cap-${caps[key]}`}
          title={`${key}: ${caps[key]}`}
        >
          {key}
          <b>{caps[key]}</b>
        </span>
      ))}
      {Object.keys(caps).length === 0 ? (
        <span className="as-muted">not probed</span>
      ) : null}
    </div>
  );
}

function Toggle({ label, checked, onChange, disabled }) {
  return (
    <label className="as-switch">
      <input
        type="checkbox"
        role="switch"
        checked={Boolean(checked)}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        aria-label={label}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * Provider connection registry, doctor output, Claude Code hooks card and a
 * connection wizard. Data: GET /api/connections, /api/connections/capabilities,
 * /api/connections/doctor, /api/hooks/claude-code/status.
 * @param {{
 *   presentation?: boolean,
 *   workspace?: { id: string, rootPath?: string, tasks?: any[] },   // for the wizard's sandbox task
 *   agents?: any[],
 *   onLaunched?: (run: any, task: any) => void
 * }} props
 */
/**
 * Expanded detail for one connection: its error category with the plain
 * remediation, its recorded probe history, and the migration assistant.
 * Every block degrades to a named missing route rather than an empty list.
 */
function ConnectionDetail({ connection, agents, workspace }) {
  const probes = useApi(
    `/connections/${encodeURIComponent(connection.id)}/probes`,
  );
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const rows = Array.isArray(probes.data)
    ? probes.data
    : (probes.data?.probes ?? []);

  const runPreview = async () => {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (agentId) params.set("agentId", agentId);
      if (workspace?.id) params.set("workspaceId", workspace.id);
      setPreview(
        await apiFetch(
          `/connections/${encodeURIComponent(connection.id)}/migration-preview?${params}`,
        ),
      );
    } catch (err) {
      setError(err.message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="as-conn-detail">
      <section aria-label="Connection health">
        <h5>Health</h5>
        <dl className="as-passport">
          <div>
            <dt>Error category</dt>
            <dd>
              {connection.errorCategory ? (
                <span className="as-tag as-tag-warn">
                  {String(connection.errorCategory).replace(/-/g, " ")}
                </span>
              ) : (
                "none recorded"
              )}
            </dd>
          </div>
          <div>
            <dt>Remediation</dt>
            <dd>{connection.remediation ?? "nothing to fix"}</dd>
          </div>
          <div>
            <dt>Last successful event</dt>
            <dd>
              {connection.lastSuccessAt || connection.lastEventAt
                ? formatTime(connection.lastSuccessAt ?? connection.lastEventAt)
                : "never recorded"}
            </dd>
          </div>
          <div>
            <dt>Credential expiry</dt>
            <dd>
              {connection.authExpiresAt
                ? formatTime(connection.authExpiresAt)
                : "not derivable — Agent Space only checks that the credential file exists"}
            </dd>
          </div>
        </dl>
      </section>

      <section aria-label="Probe history">
        <h5>Probe history</h5>
        {probes.error ? (
          <EmptyState
            compact
            title="Probe history unavailable"
            error={probes.error}
            missingRoutes={["GET /api/connections/:id/probes"]}
          />
        ) : rows.length === 0 ? (
          <p className="as-muted as-small">
            No probe recorded yet. Press Probe to run a read-only check.
          </p>
        ) : (
          <ul className="as-probe-list" role="list">
            {rows.slice(0, 12).map((probe) => (
              <li key={probe.id ?? probe.probedAt}>
                <span className={`as-tag ${probe.ok ? "" : "as-tag-warn"}`}>
                  {probe.ok ? "ok" : (probe.category ?? "failed")}
                </span>
                <time>{formatTime(probe.probedAt)}</time>
                <span className="as-muted as-small">
                  {probe.detail ?? (probe.ok ? "responded" : "no detail")}
                </span>
                {probe.remediation ? (
                  <span className="as-small">Fix: {probe.remediation}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Migration assistant">
        <h5>Migration assistant</h5>
        <p className="as-muted as-small">
          Moving an agent to another runtime copies only settings both sides
          understand. No conversation, memory, or hidden provider state
          transfers — the new provider starts from the task brief.
        </p>
        <div className="as-row as-wrap">
          <label className="as-inline-label">
            Agent
            <select
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              <option value="">Choose an agent…</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button"
            onClick={runPreview}
            disabled={busy || !agentId}
          >
            Preview the migration
          </button>
          {preview ? (
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const result = await apiFetch(
                    `/connections/${encodeURIComponent(connection.id)}/migrate?apply=1`,
                    {
                      method: "POST",
                      body: { agentId, workspaceId: workspace?.id },
                    },
                  );
                  setMessage(
                    `Applied. ${result?.applied?.length ?? 0} field(s) copied; ${result?.unsupported?.length ?? preview.unsupported?.length ?? 0} left behind. No run was started.`,
                  );
                } catch (err) {
                  setError(err.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Apply the plan
            </button>
          ) : null}
        </div>
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        {message ? (
          <p className="as-feedback" role="status">
            {message}
          </p>
        ) : null}
        {preview ? (
          <div className="as-migration">
            <div>
              <h6>Copied</h6>
              <ul>
                {(preview.compatible ?? []).length === 0 ? (
                  <li className="as-muted as-small">nothing</li>
                ) : null}
                {(preview.compatible ?? []).map((field, index) => (
                  <li key={field.field ?? index}>
                    {field.field ?? String(field)}
                    {field.value !== undefined ? (
                      <span className="as-muted as-small">
                        {" "}
                        = {String(field.value).slice(0, 60)}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h6>Not supported by the target</h6>
              <ul>
                {(preview.unsupported ?? []).length === 0 ? (
                  <li className="as-muted as-small">nothing</li>
                ) : null}
                {(preview.unsupported ?? []).map((field, index) => (
                  <li key={field.field ?? index}>
                    <span className="as-tag as-tag-warn">
                      {field.field ?? String(field)}
                    </span>{" "}
                    {field.reason ?? ""}
                  </li>
                ))}
              </ul>
            </div>
            {preview.notes?.length ? (
              <div>
                <h6>Notes</h6>
                <ul>
                  {preview.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default function ConnectionsPanel({
  presentation = false,
  workspace,
  agents = [],
  onLaunched,
}) {
  const { global, revision } = useGlobal();
  const connections = useApi("/connections");
  const capabilities = useApi("/connections/capabilities");
  const doctor = useApi("/connections/doctor");
  const hooks = useApi("/hooks/claude-code/status");
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [wizard, setWizard] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [aliasDraft, setAliasDraft] = useState(null);
  const compatibility = useApi("/connections/compatibility");
  const health = useApi("/ops/health", { interval: 30000 });
  useEffect(() => {
    if (revision === 0) return; // useApi already fetched on mount
    connections.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  const list = useMemo(() => {
    const data = connections.data;
    const rows = Array.isArray(data)
      ? data
      : (data?.connections ?? global.connections ?? []);
    return [...rows].sort((a, b) =>
      String(a.provider).localeCompare(String(b.provider)),
    );
  }, [connections.data, global.connections]);
  const caps = capabilities.data ?? {};
  const doctorList = Array.isArray(doctor.data)
    ? doctor.data
    : (doctor.data?.items ?? []);
  const hookStatus = hooks.data ?? null;
  const compatNotes = useMemo(() => {
    const data = compatibility.data;
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.notes ?? data.compatibility ?? data.items ?? [];
  }, [compatibility.data]);
  // An "outage" here is only what this machine can see: an enabled runtime
  // whose last probe failed, or one the ops health check flagged as down.
  const outage = useMemo(() => {
    const unhealthy = new Set(
      (health.data?.providers?.unhealthy ?? [])
        .map((entry) => entry.provider ?? entry)
        .filter(Boolean),
    );
    return list.filter(
      (connection) =>
        connection.enabled !== false &&
        (connection.status === "error" ||
          connection.status === "missing" ||
          unhealthy.has(connection.provider)),
    );
  }, [list, health.data]);

  const act = async (key, fn, message) => {
    setBusy(key);
    setFeedback("");
    try {
      await fn();
      if (message) setFeedback(message);
      await Promise.all([
        connections.reload(),
        capabilities.reload(),
        doctor.reload(),
        hooks.reload(),
      ]);
    } catch (err) {
      setFeedback(err.message);
    } finally {
      setBusy("");
    }
  };
  const patch = (connection, body) =>
    act(connection.id, () =>
      apiFetch(`/connections/${encodeURIComponent(connection.id)}`, {
        method: "PATCH",
        body,
      }),
    );

  return (
    <section className="as-connections" aria-label="Connections">
      <header className="as-section-head">
        <h3>
          <Plug size={14} aria-hidden="true" /> Providers
        </h3>
        <div className="as-row">
          <button
            type="button"
            className="button"
            disabled={busy === "refresh"}
            onClick={() =>
              act(
                "refresh",
                () => apiFetch("/connections/refresh", { method: "POST" }),
                "Detection finished.",
              )
            }
          >
            <RefreshCw size={12} /> Refresh
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() =>
              setWizard({
                step: 0,
                provider: list[0]?.provider ?? "claude-code",
              })
            }
          >
            <Plug size={12} /> Connect a provider
          </button>
        </div>
      </header>
      {feedback ? (
        <p className="as-feedback" role="status">
          {feedback}
        </p>
      ) : null}
      {connections.error ? (
        <EmptyState
          title="Connections are unavailable"
          error={connections.error}
          missingRoutes={["GET /api/connections"]}
        />
      ) : null}

      {outage.length ? (
        <div className="as-outage" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <div>
            <strong>
              {outage.length === 1
                ? `${providerLabel(outage[0].provider)} is not usable right now.`
                : `${outage.length} runtimes are not usable right now.`}
            </strong>
            <ul>
              {outage.map((connection) => (
                <li key={connection.id ?? connection.provider}>
                  {providerLabel(connection.provider)}
                  {connection.alias && connection.alias !== "default"
                    ? ` (${connection.alias})`
                    : ""}
                  : {connection.error ?? connection.status}
                  {connection.remediation ? ` — ${connection.remediation}` : ""}
                </li>
              ))}
            </ul>
            <span className="as-muted as-small">
              This banner reflects the last detection and probe on this machine.
              It is not a vendor status feed: Agent Space never contacts a
              provider status service.
            </span>
          </div>
        </div>
      ) : null}

      <div className="as-row as-wrap as-alias-bar">
        {aliasDraft ? (
          <form
            className="as-row as-wrap"
            aria-label="Add a connection alias"
            onSubmit={(event) => {
              event.preventDefault();
              act(
                "alias",
                () =>
                  apiFetch("/connections", {
                    method: "POST",
                    body: {
                      provider: aliasDraft.provider,
                      alias: aliasDraft.alias.trim(),
                      owner: aliasDraft.owner.trim() || null,
                      host: aliasDraft.host.trim() || null,
                    },
                  }),
                "Alias added. It is a separate account label on the same runtime; Agent Space still holds no credential.",
              ).then(() => setAliasDraft(null));
            }}
          >
            <label className="as-inline-label">
              Runtime
              <select
                value={aliasDraft.provider}
                onChange={(event) =>
                  setAliasDraft({ ...aliasDraft, provider: event.target.value })
                }
              >
                {[...new Set(list.map((row) => row.provider))].map((id) => (
                  <option key={id} value={id}>
                    {providerLabel(id)}
                  </option>
                ))}
              </select>
            </label>
            <label className="as-inline-label">
              Alias
              <input
                value={aliasDraft.alias}
                onChange={(event) =>
                  setAliasDraft({ ...aliasDraft, alias: event.target.value })
                }
                placeholder="work-account"
              />
            </label>
            <label className="as-inline-label">
              Owner
              <input
                value={aliasDraft.owner}
                onChange={(event) =>
                  setAliasDraft({ ...aliasDraft, owner: event.target.value })
                }
                placeholder="who this login belongs to"
              />
            </label>
            <label className="as-inline-label">
              Host
              <input
                value={aliasDraft.host}
                onChange={(event) =>
                  setAliasDraft({ ...aliasDraft, host: event.target.value })
                }
                placeholder="local"
              />
            </label>
            <button
              type="submit"
              className="button primary"
              disabled={busy === "alias" || !aliasDraft.alias.trim()}
            >
              Add alias
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setAliasDraft(null)}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="button"
            onClick={() =>
              setAliasDraft({
                provider: list[0]?.provider ?? "claude-code",
                alias: "",
                owner: "",
                host: "",
              })
            }
          >
            Add another account alias
          </button>
        )}
      </div>

      <div className="as-table-wrap">
        <table className="as-table as-conn-table">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Kind</th>
              <th scope="col">Alias</th>
              <th scope="col">Status</th>
              <th scope="col">Version</th>
              <th scope="col">Binary</th>
              <th scope="col">Home</th>
              <th scope="col">Observe</th>
              <th scope="col">Enabled</th>
              <th scope="col">Capabilities</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr>
                <td colSpan={11} className="as-muted">
                  No connections yet. Press Refresh to detect installed CLIs.
                </td>
              </tr>
            ) : null}
            {list.map((connection) => (
              <React.Fragment key={connection.id ?? connection.provider}>
                <tr>
                  <th scope="row">
                    <ProviderBadge provider={connection.provider} />
                  </th>
                  <td>
                    <span className="as-tag">
                      {connection.kind ?? "coding-runtime"}
                    </span>
                  </td>
                  <td>
                    {connection.alias ?? "default"}
                    {connection.owner ? (
                      <div className="as-muted as-small">
                        owner: {connection.owner}
                      </div>
                    ) : null}
                    {connection.host && connection.host !== "local" ? (
                      <div className="as-muted as-small">
                        host: {connection.host}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={`status as-conn-${connection.status ?? "unknown"}`}
                    >
                      <i className="dot" aria-hidden="true" />
                      {connection.status ?? "unknown"}
                    </span>
                    {connection.errorCategory ? (
                      <div className="as-small">
                        <span className="as-tag as-tag-warn">
                          {String(connection.errorCategory).replace(/-/g, " ")}
                        </span>
                      </div>
                    ) : null}
                    {connection.error ? (
                      <div className="as-error-text as-small">
                        {connection.error}
                      </div>
                    ) : null}
                    {connection.remediation ? (
                      <div className="as-muted as-small">
                        Fix: {connection.remediation}
                      </div>
                    ) : null}
                  </td>
                  <td>{connection.version ?? "—"}</td>
                  <td className="as-mono as-small">
                    {maskPath(
                      connection.binaryPath ?? connection.binary_path,
                      presentation,
                    ) || "—"}
                  </td>
                  <td className="as-mono as-small">
                    {maskPath(
                      connection.homePath ?? connection.home_path,
                      presentation,
                    ) || "—"}
                  </td>
                  <td>
                    <Toggle
                      label={`Observe ${providerLabel(connection.provider)} sessions`}
                      checked={connection.observe}
                      disabled={busy === connection.id}
                      onChange={(observe) => patch(connection, { observe })}
                    />
                  </td>
                  <td>
                    <Toggle
                      label={`Enable ${providerLabel(connection.provider)}`}
                      checked={connection.enabled}
                      disabled={busy === connection.id}
                      onChange={(enabled) => patch(connection, { enabled })}
                    />
                  </td>
                  <td>
                    <Caps
                      caps={
                        caps[connection.provider] ??
                        connection.details?.capabilities ??
                        {}
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button"
                      disabled={busy === connection.id}
                      onClick={() =>
                        act(
                          connection.id,
                          () =>
                            apiFetch(
                              `/connections/${encodeURIComponent(connection.id)}/probe`,
                              { method: "POST" },
                            ),
                          `Probed ${providerLabel(connection.provider)}.`,
                        )
                      }
                      aria-label={`Probe ${providerLabel(connection.provider)}`}
                    >
                      <Activity size={12} /> Probe
                    </button>
                    {(connection.lastProbeAt ?? connection.last_probe_at) ? (
                      <div className="as-muted as-small">
                        probed{" "}
                        {formatTime(
                          connection.lastProbeAt ?? connection.last_probe_at,
                        )}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="text-button"
                      aria-expanded={expanded === connection.id}
                      onClick={() =>
                        setExpanded((current) =>
                          current === connection.id ? null : connection.id,
                        )
                      }
                    >
                      {expanded === connection.id ? "Hide details" : "Details"}
                    </button>
                  </td>
                </tr>
                {expanded === connection.id ? (
                  <tr className="as-conn-detail-row">
                    <td colSpan={11}>
                      <ConnectionDetail
                        connection={connection}
                        agents={agents}
                        workspace={workspace}
                      />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="as-conn-grid">
        <article className="as-card">
          <h4>Compatibility notes</h4>
          {compatibility.error ? (
            <EmptyState
              compact
              title="Compatibility notes unavailable"
              error={compatibility.error}
              missingRoutes={["GET /api/connections/compatibility"]}
            />
          ) : null}
          {compatNotes.length === 0 && !compatibility.error ? (
            <p className="as-muted as-small">
              No compatibility note is recorded for the runtimes on this
              machine.
            </p>
          ) : null}
          <ul className="as-compat-list" role="list">
            {compatNotes.map((note, index) => (
              <li key={note.provider ? `${note.provider}-${index}` : index}>
                <span className="as-row as-wrap">
                  <strong>{providerLabel(note.provider)}</strong>
                  {note.version ? (
                    <span className="as-tag">{note.version}</span>
                  ) : null}
                  <span
                    className={`as-tag ${note.verified ? "" : "as-tag-warn"}`}
                  >
                    {note.verified ? "verified here" : "not verified here"}
                  </span>
                </span>
                <span className="as-muted as-small">
                  {note.note ?? note.detail ?? note.message ?? ""}
                </span>
              </li>
            ))}
          </ul>
          <p className="as-muted as-small">
            Verified means a run or a read-only probe actually succeeded on this
            machine and OS. Everything else stays experimental or unknown.
          </p>
        </article>
        <article className="as-card">
          <h4>
            <Shield size={13} aria-hidden="true" /> Claude Code hooks
          </h4>
          <p className="as-muted">
            Hooks in <code>~/.claude/settings.json</code> forward permission
            prompts and tool events from interactive Claude Code sessions to
            Agent Space, so approvals land in the inbox. Existing hooks (for
            example rtk) are kept.
          </p>
          {hooks.error ? (
            <p className="as-error-text as-small">{hooks.error.message}</p>
          ) : null}
          <p>
            Status:{" "}
            <strong>
              {hookStatus
                ? hookStatus.installed
                  ? "installed"
                  : "not installed"
                : "unknown"}
            </strong>
            {hookStatus?.settingsPath ? (
              <span className="as-muted as-small">
                {" "}
                · {maskPath(hookStatus.settingsPath, presentation)}
              </span>
            ) : null}
            {hookStatus?.command ? (
              <code className="as-mono as-small as-block">
                {hookStatus.command}
              </code>
            ) : null}
          </p>
          <div className="as-row">
            <button
              type="button"
              className="button primary"
              disabled={busy === "hooks" || hookStatus?.installed}
              onClick={() =>
                act(
                  "hooks",
                  () =>
                    apiFetch("/hooks/claude-code/install", { method: "POST" }),
                  "Hooks installed. Restart running Claude Code sessions to pick them up.",
                )
              }
            >
              <Check size={12} /> Install
            </button>
            <button
              type="button"
              className="button"
              disabled={busy === "hooks" || !hookStatus?.installed}
              onClick={() =>
                act(
                  "hooks",
                  () =>
                    apiFetch("/hooks/claude-code/uninstall", {
                      method: "POST",
                    }),
                  "Hooks removed.",
                )
              }
            >
              <X size={12} /> Uninstall
            </button>
          </div>
        </article>
        <article className="as-card">
          <h4>
            <Activity size={13} aria-hidden="true" /> Doctor
          </h4>
          {doctor.error ? (
            <p className="as-error-text as-small">{doctor.error.message}</p>
          ) : null}
          {doctorList.length === 0 ? (
            <p className="as-muted">No findings.</p>
          ) : null}
          <ul className="as-doctor">
            {doctorList.map((item, index) => (
              <li key={index} className={`as-doctor-${item.level ?? "ok"}`}>
                {item.level === "error" ? (
                  <TriangleAlert size={13} aria-hidden="true" />
                ) : item.level === "warn" ? (
                  <Info size={13} aria-hidden="true" />
                ) : (
                  <Check size={13} aria-hidden="true" />
                )}
                <div>
                  <strong>
                    {item.provider ? `${providerLabel(item.provider)}: ` : ""}
                    {item.title}
                  </strong>
                  <span className="as-level">{item.level ?? "ok"}</span>
                  {item.detail ? (
                    <p className="as-muted">{item.detail}</p>
                  ) : null}
                  {item.fix ? (
                    <p className="as-small">Fix: {item.fix}</p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </article>
      </div>

      {wizard ? (
        <Wizard
          state={wizard}
          setState={setWizard}
          connections={list}
          capabilities={caps}
          workspaces={global.workspaces}
          workspace={workspace}
          agents={agents}
          presentation={presentation}
          onLaunched={onLaunched}
          onDone={() => {
            setWizard(null);
            connections.reload();
          }}
        />
      ) : null}
    </section>
  );
}

const STEPS = ["Detect", "Sign-in", "Probe", "Scope", "Sandbox task"];

function Wizard({
  state,
  setState,
  connections,
  capabilities,
  workspaces,
  workspace,
  agents,
  presentation,
  onLaunched,
  onDone,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [launcher, setLauncher] = useState(false);
  const [probe, setProbe] = useState(null);
  const connection = connections.find((c) => c.provider === state.provider);
  const step = state.step;
  const go = (delta) =>
    setState({
      ...state,
      step: Math.max(0, Math.min(STEPS.length - 1, step + delta)),
    });
  const detect = async () => {
    setBusy(true);
    setError("");
    try {
      await apiFetch("/connections/refresh", { method: "POST" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const runProbe = async () => {
    if (!connection) return;
    setBusy(true);
    setError("");
    try {
      setProbe(
        await apiFetch(
          `/connections/${encodeURIComponent(connection.id)}/probe`,
          { method: "POST" },
        ),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const allowed =
    connection?.allowedWorkspaces ?? connection?.allowed_workspaces ?? [];
  const saveScope = async (ids) => {
    if (!connection) return;
    setBusy(true);
    try {
      await apiFetch(`/connections/${encodeURIComponent(connection.id)}`, {
        method: "PATCH",
        body: { allowedWorkspaces: ids },
      });
      setState({ ...state, allowed: ids });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const currentAllowed = state.allowed ?? allowed;
  return (
    <Dialog title="Connect a provider" onClose={onDone} wide>
      <ol className="as-stepper" aria-label="Wizard steps">
        {STEPS.map((label, index) => (
          <li
            key={label}
            className={index === step ? "active" : index < step ? "done" : ""}
            aria-current={index === step ? "step" : undefined}
          >
            <span className="as-step-num">
              {index < step ? (
                <Check size={11} aria-hidden="true" />
              ) : (
                index + 1
              )}
            </span>
            {label}
          </li>
        ))}
      </ol>
      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="as-wizard-body">
        {step === 0 ? (
          <>
            <label>
              Provider
              <select
                value={state.provider}
                onChange={(e) =>
                  setState({ ...state, provider: e.target.value })
                }
                data-autofocus
              >
                {["claude-code", "codex", "copilot", "cursor", "gemini"].map(
                  (id) => (
                    <option key={id} value={id}>
                      {providerLabel(id)}
                    </option>
                  ),
                )}
              </select>
            </label>
            <p className="as-muted">
              Detection runs each CLI's <code>--version</code> and reads its
              documented home folder. Nothing is written.
            </p>
            <div className="as-row">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={detect}
              >
                <RefreshCw size={12} /> Detect now
              </button>
              {connection ? (
                <span
                  className={`status as-conn-${connection.status ?? "unknown"}`}
                >
                  <i className="dot" aria-hidden="true" />
                  {connection.status ?? "unknown"}
                  {connection.version ? ` · ${connection.version}` : ""}
                </span>
              ) : (
                <span className="as-muted">not detected yet</span>
              )}
            </div>
          </>
        ) : null}
        {step === 1 ? (
          <>
            <p>
              <strong>{providerLabel(state.provider)}</strong> keeps its own
              credentials. Agent Space never stores or reads tokens; it only
              checks that the CLI reports itself as signed in.
            </p>
            <p className="form-note">
              <Info size={14} aria-hidden="true" />
              {DOCS[state.provider]}
            </p>
            {connection?.details?.authHint ? (
              <p className="as-muted">
                Detected: {connection.details.authHint}
              </p>
            ) : null}
          </>
        ) : null}
        {step === 2 ? (
          <>
            <p className="as-muted">
              Probe runs read-only checks and records which capabilities are
              verified, unsupported, unknown or experimental.
            </p>
            <button
              type="button"
              className="button"
              disabled={busy || !connection}
              onClick={runProbe}
            >
              <Activity size={12} /> Probe {providerLabel(state.provider)}
            </button>
            {!connection ? (
              <p className="as-error-text">Detect the provider first.</p>
            ) : null}
            {probe || capabilities[state.provider] ? (
              <Caps
                caps={probe?.capabilities ?? capabilities[state.provider] ?? {}}
              />
            ) : null}
          </>
        ) : null}
        {step === 3 ? (
          <>
            <p className="as-muted">
              Choose which workspaces may launch this provider. Empty means all
              workspaces.
            </p>
            <ul className="as-scope">
              {workspaces.map((ws) => (
                <li key={ws.id}>
                  <label className="as-check">
                    <input
                      type="checkbox"
                      checked={currentAllowed.includes(ws.id)}
                      disabled={busy}
                      onChange={(e) =>
                        saveScope(
                          e.target.checked
                            ? [...currentAllowed, ws.id]
                            : currentAllowed.filter((id) => id !== ws.id),
                        )
                      }
                    />
                    {ws.name}{" "}
                    <span className="as-muted as-mono">
                      {maskPath(ws.rootPath, presentation)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {step === 4 ? (
          <>
            <p>
              Finish by running a read-only sandbox task (for example "List the
              files in this folder and summarise the project") so you can watch
              events arrive in the inspector before granting write access.
            </p>
            {workspace ? (
              <button
                type="button"
                className="button primary"
                onClick={() => setLauncher(true)}
              >
                <ChevronRight size={12} /> Run a sandbox task in{" "}
                {workspace.name ?? workspace.id}
              </button>
            ) : (
              <p className="as-muted">
                Open a workspace to launch the sandbox task.
              </p>
            )}
          </>
        ) : null}
      </div>
      <div className="modal-actions">
        <button
          type="button"
          className="button"
          disabled={step === 0}
          onClick={() => go(-1)}
        >
          <ChevronLeft size={12} /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            className="button primary"
            onClick={() => go(1)}
          >
            Next <ChevronRight size={12} />
          </button>
        ) : (
          <button type="button" className="button primary" onClick={onDone}>
            Done
          </button>
        )}
      </div>
      {launcher && workspace ? (
        <TaskLauncher
          workspace={workspace}
          agents={agents}
          connections={connections}
          capabilities={capabilities}
          defaults={{
            title: "Sandbox: describe this project",
            description:
              "Read-only: list the top-level files and summarise what this project does. Do not modify anything.",
            provider: state.provider,
            readOnly: true,
          }}
          onClose={() => setLauncher(false)}
          onLaunched={(run, task) => {
            onLaunched?.(run, task);
            onDone();
          }}
        />
      ) : null}
    </Dialog>
  );
}

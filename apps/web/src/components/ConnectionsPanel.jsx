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
  RadioTower,
  X,
} from "lucide-react";
import {
  apiFetch,
  useApi,
  providerLabel,
  maskPath,
  maskPathsInText,
  formatTime,
} from "../hooks/useApi.js";
import { useGlobal, useGlobalChange } from "../hooks/useGlobal.js";
import {
  compatibilityRows,
  connectionState,
  connectionSummary,
  connectionOutages,
  groupCapabilities,
  runningProviderSet,
  shortPath,
  authHintText,
  CONNECTION_STATES,
} from "../hooks/providerStatus.js";
import EmptyState from "./EmptyState.jsx";
import Dialog from "./Dialog.jsx";
import TaskLauncher from "./TaskLauncher.jsx";

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

const CAPABILITY_LEVELS = [
  ["verified", "Verified"],
  ["experimental", "Experimental"],
  ["unknown", "Not verified"],
  ["unsupported", "Not supported"],
];

const SURFACE_KIND = { cli: "Command line", ide: "Editor" };
const FIDELITY = {
  "provider-session-files": "Reads its session files",
  "unverified-session-files": "Reads its session files (format unverified)",
  "conversation-summaries": "Conversation summaries only",
  "installation-detection": "Sees the installation only",
};

/**
 * What the provider registry records for one CLI, grouped by level. These
 * come from this project's own testing of each CLI, not from a live check of
 * this machine, and the caption says so.
 */
function CapabilitySummary({ caps = {} }) {
  const groups = groupCapabilities(caps);
  const rows = CAPABILITY_LEVELS.filter(([level]) => groups[level].length);
  if (!rows.length)
    return <p className="as-muted as-small">No capability is recorded.</p>;
  return (
    <div className="conn-caps">
      <dl>
        {rows.map(([level, label]) => (
          <div key={level} className={`conn-caps-row cap-${level}`}>
            <dt>{label}</dt>
            <dd>{groups[level].map((cap) => cap.label).join(", ")}</dd>
          </div>
        ))}
      </dl>
      <p className="as-muted as-small">
        From the provider registry: what this project has tested for this CLI.
        It is not a live check of this machine.
      </p>
    </div>
  );
}

function Toggle({ label, name, checked, onChange, disabled }) {
  return (
    <label className="as-switch">
      <input
        type="checkbox"
        role="switch"
        checked={Boolean(checked)}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        aria-label={name ? `${label} — ${name}` : label}
      />
      <span>{label}</span>
    </label>
  );
}

/** One runtime on this machine: its state, where it lives, what it can do. */
function ConnectionCard({
  connection,
  state,
  caps,
  live,
  activeModes,
  presentation,
  busy,
  expanded,
  onToggleExpanded,
  onPatch,
  onRecheck,
  agents,
  workspace,
}) {
  const name = providerLabel(connection.provider);
  const alias =
    connection.alias && connection.alias !== "default"
      ? connection.alias
      : null;
  const fullName = alias ? `${name} (${alias})` : name;
  const binary = maskPath(
    connection.binaryPath ?? connection.binary_path,
    presentation,
  );
  const home = maskPath(
    connection.homePath ?? connection.home_path,
    presentation,
  );
  const probedAt = connection.lastProbeAt ?? connection.last_probe_at;
  const detailId = `conn-detail-${connection.id ?? connection.provider}`;
  const mask = (text) => maskPathsInText(text, presentation);
  // Say what is live without guessing: a counted session, else the recorded
  // mode of the active run, else only that something is active.
  let note = state.detail;
  if (state.key === "running") {
    if (live) note = `${live} live session${live === 1 ? "" : "s"} now.`;
    else if (activeModes?.has("managed") && !activeModes.has("observed"))
      note = "A run Agent Space started is active now.";
    else if (activeModes?.has("observed"))
      note = "A session started from a terminal is active now.";
    else note = "A session or run is active now.";
  }
  return (
    <li
      className={`conn-card tone-${state.tone}${expanded ? " is-expanded" : ""}`}
    >
      <div className="conn-card-head">
        <h3>
          {name}
          {alias ? <span className="conn-card-alias"> · {alias}</span> : null}
        </h3>
        <span className={`conn-state tone-${state.tone}`} title={state.detail}>
          <i className="dot" aria-hidden="true" />
          {state.label}
        </span>
      </div>
      <p className="conn-card-note">{note}</p>
      {connection.status === "error" && connection.error ? (
        <p className="as-error-text as-small">{mask(connection.error)}</p>
      ) : null}
      {connection.remediation ? (
        <p className="as-small">Fix: {mask(connection.remediation)}</p>
      ) : null}
      <dl className="conn-facts">
        <div>
          <dt>Version</dt>
          <dd>{connection.version ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Program</dt>
          <dd className="conn-path" title={binary || undefined}>
            {binary ? shortPath(binary) : "Not found"}
          </dd>
        </div>
        <div>
          <dt>Home folder</dt>
          <dd className="conn-path" title={home || undefined}>
            {home ? shortPath(home) : "None"}
          </dd>
        </div>
        {connection.owner ? (
          <div>
            <dt>Owner</dt>
            <dd>{connection.owner}</dd>
          </div>
        ) : null}
        {connection.host && connection.host !== "local" ? (
          <div>
            <dt>Host</dt>
            <dd>{connection.host}</dd>
          </div>
        ) : null}
        <div>
          <dt>Last checked</dt>
          <dd>{probedAt ? formatTime(probedAt) : "Not yet"}</dd>
        </div>
      </dl>
      <CapabilitySummary caps={caps} />
      <div className="conn-card-foot">
        <div className="conn-toggles">
          <Toggle
            label="Observe sessions"
            name={fullName}
            checked={connection.observe}
            disabled={busy}
            onChange={(observe) => onPatch({ observe })}
          />
          <Toggle
            label="Enabled"
            name={fullName}
            checked={connection.enabled}
            disabled={busy}
            onChange={(enabled) => onPatch({ enabled })}
          />
        </div>
        <div className="conn-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={onRecheck}
            aria-label={`Check again — ${fullName}`}
          >
            <Activity size={12} aria-hidden="true" /> Check again
          </button>
          <button
            type="button"
            className="text-button"
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            aria-label={`${expanded ? "Hide details" : "Details"} — ${fullName}`}
            onClick={onToggleExpanded}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        </div>
      </div>
      {expanded ? (
        <div id={detailId}>
          <ConnectionDetail
            connection={connection}
            agents={agents}
            workspace={workspace}
            presentation={presentation}
          />
        </div>
      ) : null}
    </li>
  );
}

/**
 * Expanded detail for one connection: its error category with the plain
 * remediation, its recorded probe history, and the migration assistant.
 * Every block degrades to a named missing route rather than an empty list.
 */
function ConnectionDetail({ connection, agents, workspace, presentation }) {
  const mask = (text) => maskPathsInText(text, presentation);
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
        <h4>Health</h4>
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
            <dd>{mask(connection.remediation) || "nothing to fix"}</dd>
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
        <h4>Probe history</h4>
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
                  {probe.detail
                    ? mask(probe.detail)
                    : probe.ok
                      ? "responded"
                      : "no detail"}
                </span>
                {probe.remediation ? (
                  <span className="as-small">
                    Fix: {mask(probe.remediation)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Migration assistant">
        <h4>Migration assistant</h4>
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
              <h5>Copied</h5>
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
              <h5>Not supported by the target</h5>
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
                <h5>Notes</h5>
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

/**
 * Provider connections: one card per runtime on this machine with its state in
 * the product's words, what Agent Space can see of each assistant product, and
 * the doctor, hooks and compatibility notes underneath. Data:
 * GET /api/connections, /api/connections/capabilities, /api/connections/doctor,
 * /api/connections/compatibility, /api/hooks/claude-code/status,
 * /api/observation/status and /api/ops/health (circuit breakers).
 * @param {{
 *   presentation?: boolean,
 *   workspace?: { id: string, rootPath?: string, tasks?: any[] },   // for the wizard's sandbox task
 *   agents?: any[],
 *   onLaunched?: (run: any, task: any) => void
 * }} props
 */
export default function ConnectionsPanel({
  presentation = false,
  workspace,
  agents = [],
  onLaunched,
}) {
  const { global } = useGlobal();
  const connections = useApi("/connections");
  const capabilities = useApi("/connections/capabilities");
  const doctor = useApi("/connections/doctor");
  const hooks = useApi("/hooks/claude-code/status");
  const observation = useApi("/observation/status", { interval: 5000 });
  const compatibility = useApi("/connections/compatibility");
  const health = useApi("/ops/health", { interval: 30000 });
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [wizard, setWizard] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [aliasDraft, setAliasDraft] = useState(null);
  const [allFindings, setAllFindings] = useState(false);
  const mask = (text) => maskPathsInText(text, presentation);
  useGlobalChange(() => connections.reload());

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
  const doctorList = useMemo(() => {
    const items = Array.isArray(doctor.data)
      ? doctor.data
      : (doctor.data?.items ?? []);
    const weight = { error: 0, warn: 1 };
    return [...items].sort(
      (a, b) => (weight[a.level] ?? 2) - (weight[b.level] ?? 2),
    );
  }, [doctor.data]);
  const doctorProblems = doctorList.filter(
    (item) => item.level === "error" || item.level === "warn",
  ).length;
  const hookStatus = hooks.data ?? null;
  const compatNotes = useMemo(
    () => compatibilityRows(compatibility.data),
    [compatibility.data],
  );
  const surfaces = useMemo(
    () => observation.data?.surfaces ?? [],
    [observation.data],
  );
  const running = useMemo(
    () => runningProviderSet(agents, surfaces),
    [agents, surfaces],
  );
  const liveByProvider = useMemo(() => {
    const counts = new Map();
    for (const surface of surfaces)
      counts.set(
        surface.provider,
        (counts.get(surface.provider) ?? 0) + (surface.liveSessions ?? 0),
      );
    return counts;
  }, [surfaces]);
  const activeModes = useMemo(() => {
    const modes = new Map();
    for (const agent of agents) {
      if (!agent.activeProviderRun || !agent.provider) continue;
      const set = modes.get(agent.provider) ?? new Set();
      if (agent.runMode) set.add(agent.runMode);
      modes.set(agent.provider, set);
    }
    return modes;
  }, [agents]);
  const summary = useMemo(
    () => connectionSummary(list, running),
    [list, running],
  );
  // Only a failed check or a tripped breaker stops a runtime. An absent CLI is
  // listed below as "Not detected" and never raises this banner.
  const outages = useMemo(
    () => connectionOutages(list, health.data?.providers?.breakers),
    [list, health.data],
  );
  const present = list.filter((connection) => connection.status !== "missing");
  const absent = list.filter((connection) => connection.status === "missing");
  const seen = surfaces.filter((surface) => surface.detected);
  const unseen = surfaces.filter((surface) => !surface.detected);
  const liveTotal = seen.reduce(
    (total, surface) => total + (surface.liveSessions ?? 0),
    0,
  );

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
        observation.reload(),
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
  const recheck = (connection) =>
    act(
      connection.id,
      () =>
        apiFetch(`/connections/${encodeURIComponent(connection.id)}/probe`, {
          method: "POST",
        }),
      `Checked ${providerLabel(connection.provider)} again.`,
    );

  return (
    <section className="as-connections conn-page" aria-label="Connections">
      <header className="conn-head">
        <div className="conn-head-text">
          <h2>
            <Plug size={16} aria-hidden="true" /> Assistants on this machine
          </h2>
          <p className="as-muted">
            Agent Space looks for each command-line assistant and checks that
            its sign-in file exists. It never reads or stores a credential, and
            a check here does not prove a run will succeed.
          </p>
          {summary.length ? (
            <ul className="conn-summary" aria-label="Summary">
              {summary.map((entry) => (
                <li key={entry.key} className={`conn-state tone-${entry.tone}`}>
                  <i className="dot" aria-hidden="true" />
                  <b>{entry.count}</b> {entry.label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="conn-head-actions">
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
            <RefreshCw size={12} aria-hidden="true" /> Refresh
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() =>
              setWizard({
                step: 0,
                provider: present[0]?.provider ?? "claude-code",
              })
            }
          >
            <Plug size={12} aria-hidden="true" /> Connect a provider
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

      {outages.length ? (
        <div className="as-outage" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <div>
            <strong>
              {outages.length === 1
                ? `${providerLabel(outages[0].provider)} cannot take runs right now.`
                : `${outages.length} runtimes cannot take runs right now.`}
            </strong>
            <ul>
              {outages.map((row) => (
                <li key={row.id}>
                  {providerLabel(row.provider)}
                  {row.alias !== "default" ? ` (${row.alias})` : ""}:{" "}
                  {mask(row.reason)}
                  {row.remediation ? ` — ${mask(row.remediation)}` : ""}
                </li>
              ))}
            </ul>
            <span className="as-muted as-small">
              From the last check and launch history on this machine. Agent
              Space never contacts a provider status service.
            </span>
          </div>
        </div>
      ) : null}

      <ul className="conn-cards" role="list" aria-label="Providers">
        {present.map((connection) => {
          const key = connection.id ?? connection.provider;
          return (
            <ConnectionCard
              key={key}
              connection={connection}
              state={connectionState(connection, running)}
              caps={
                caps[connection.provider] ??
                connection.details?.capabilities ??
                {}
              }
              live={liveByProvider.get(connection.provider) ?? 0}
              activeModes={activeModes.get(connection.provider)}
              presentation={presentation}
              busy={busy === connection.id}
              expanded={expanded === key}
              onToggleExpanded={() =>
                setExpanded((current) => (current === key ? null : key))
              }
              onPatch={(body) => patch(connection, body)}
              onRecheck={() => recheck(connection)}
              agents={agents}
              workspace={workspace}
            />
          );
        })}
        {present.length === 0 && !connections.loading && !connections.error ? (
          <li className="as-muted">
            No assistant was found on this machine yet. Install one, then press
            Refresh.
          </li>
        ) : null}
      </ul>

      {absent.length ? (
        <details className="conn-absent">
          <summary>
            Not detected on this machine <span>({absent.length})</span>
          </summary>
          <ul role="list">
            {absent.map((connection) => (
              <li key={connection.id ?? connection.provider}>
                <div>
                  <strong>
                    {providerLabel(connection.provider)}
                    {connection.alias && connection.alias !== "default"
                      ? ` · ${connection.alias}`
                      : ""}
                  </strong>
                  <span className="as-muted as-small">
                    {DOCS[connection.provider] ??
                      CONNECTION_STATES.missing.detail}
                  </span>
                </div>
                <button
                  type="button"
                  className="button"
                  disabled={busy === connection.id}
                  onClick={() => recheck(connection)}
                  aria-label={`Check again — ${providerLabel(connection.provider)}`}
                >
                  <Activity size={12} aria-hidden="true" /> Check again
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="conn-alias">
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
                {[...new Set(present.map((row) => row.provider))].map((id) => (
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
        ) : present.length ? (
          <button
            type="button"
            className="text-button"
            onClick={() =>
              setAliasDraft({
                provider: present[0]?.provider ?? "claude-code",
                alias: "",
                owner: "",
                host: "",
              })
            }
          >
            Add another account for an installed assistant
          </button>
        ) : null}
      </div>

      <section className="conn-section" aria-labelledby="conn-surfaces-title">
        <div className="conn-section-head">
          <div>
            <h2 id="conn-surfaces-title">
              <RadioTower size={14} aria-hidden="true" /> What Agent Space can
              see
            </h2>
            <p className="as-muted as-small">
              “Events mapped” means Agent Space turns the product's session
              files into office activity. “Installation only” means it can tell
              the product is installed and nothing more.
            </p>
          </div>
          <span
            className={`conn-state tone-${observation.data?.running ? "ok" : "neutral"}`}
          >
            <i className="dot" aria-hidden="true" />
            {observation.data?.running
              ? `Watching · ${liveTotal} live session${liveTotal === 1 ? "" : "s"}`
              : "Not watching"}
          </span>
        </div>
        {observation.error ? (
          <p className="as-error-text">
            Signal status unavailable: {observation.error.message}
          </p>
        ) : observation.loading && !surfaces.length ? (
          <p className="as-muted">Looking for assistant products…</p>
        ) : (
          <>
            <ul className="conn-surfaces" role="list">
              {seen.map((surface) => (
                <li
                  key={surface.id}
                  className={surface.liveSessions ? "is-live" : undefined}
                >
                  <div className="conn-surface-name">
                    <strong>
                      {surface.label === surface.provider
                        ? providerLabel(surface.provider)
                        : surface.label}
                    </strong>
                    <span className="as-muted as-small">
                      {SURFACE_KIND[surface.kind] ?? surface.kind}
                    </span>
                  </div>
                  <span className="conn-surface-mode">
                    {surface.observable ? "Events mapped" : "Installation only"}
                    <small className="as-muted">
                      {FIDELITY[surface.fidelity] ??
                        String(surface.fidelity ?? "").replace(/-/g, " ")}
                    </small>
                  </span>
                  <span className="conn-surface-live">
                    {surface.liveSessions
                      ? `${surface.liveSessions} live`
                      : "No live session"}
                  </span>
                  {surface.error ? (
                    <p className="as-error-text as-small">
                      {mask(surface.error)}
                    </p>
                  ) : surface.note ? (
                    <p className="as-muted as-small">{mask(surface.note)}</p>
                  ) : null}
                </li>
              ))}
              {seen.length === 0 ? (
                <li className="as-muted">
                  No assistant product was found on this machine.
                </li>
              ) : null}
            </ul>
            {unseen.length ? (
              <p className="as-muted as-small">
                Also looked for, not found:{" "}
                {unseen
                  .map((surface) =>
                    surface.label === surface.provider
                      ? providerLabel(surface.provider)
                      : surface.label,
                  )
                  .join(", ")}
                .
              </p>
            ) : null}
          </>
        )}
      </section>

      <div className="conn-grid">
        <article className="as-card">
          <h2>
            <Activity size={13} aria-hidden="true" /> Doctor
            {doctorProblems ? (
              <span className="as-muted as-small">
                {" "}
                · {doctorProblems} to look at
              </span>
            ) : null}
          </h2>
          {doctor.error ? (
            <p className="as-error-text as-small">{doctor.error.message}</p>
          ) : null}
          {doctorList.length === 0 && !doctor.error ? (
            <p className="as-muted">No findings.</p>
          ) : null}
          <ul className="as-doctor">
            {(allFindings ? doctorList : doctorList.slice(0, 4)).map(
              (item, index) => (
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
                      {mask(item.title)}
                    </strong>
                    {item.detail ? (
                      <p className="as-muted">{mask(item.detail)}</p>
                    ) : null}
                    {item.fix ? (
                      <p className="as-small">Fix: {mask(item.fix)}</p>
                    ) : null}
                  </div>
                </li>
              ),
            )}
          </ul>
          {doctorList.length > 4 ? (
            <button
              type="button"
              className="text-button"
              aria-expanded={allFindings}
              onClick={() => setAllFindings((value) => !value)}
            >
              {allFindings
                ? "Show fewer findings"
                : `Show all ${doctorList.length} findings`}
            </button>
          ) : null}
        </article>
        <article className="as-card">
          <h2>
            <Shield size={13} aria-hidden="true" /> Claude Code hooks
          </h2>
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
                  ? "Installed"
                  : "Not installed"
                : "Not checked"}
            </strong>
            {hookStatus?.settingsPath ? (
              <span
                className="as-muted as-small"
                title={maskPath(hookStatus.settingsPath, presentation)}
              >
                {" "}
                · {shortPath(maskPath(hookStatus.settingsPath, presentation))}
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
              <Check size={12} aria-hidden="true" /> Install
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
              <X size={12} aria-hidden="true" /> Uninstall
            </button>
          </div>
        </article>
        <article className="as-card">
          <h2>Tested versions</h2>
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
                    <span className="as-tag">installed {note.version}</span>
                  ) : null}
                  <span
                    className={`as-tag ${note.tested ? "" : "as-tag-warn"}`}
                  >
                    {note.tested ? "tested version" : "untested version"}
                  </span>
                </span>
                <span className="as-muted as-small">
                  {mask(note.reason)}
                  {note.testedVersions.length
                    ? ` Tested: ${note.testedVersions.join(", ")}${
                        note.testedOS.length
                          ? ` on ${note.testedOS.join(", ")}`
                          : ""
                      }.`
                    : ""}
                </span>
                {note.notes ? (
                  <span className="as-muted as-small">{mask(note.notes)}</span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="as-muted as-small">
            A tested version is one this project exercised on that operating
            system. It is not a live check of this machine: a newer version or
            another OS stays untested until someone runs it.
          </p>
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

const STEPS = ["Detect", "Sign-in", "Check", "Scope", "Sandbox task"];

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
                  className={`conn-state tone-${connectionState(connection).tone}`}
                  title={connectionState(connection).detail}
                >
                  <i className="dot" aria-hidden="true" />
                  {connectionState(connection).label}
                  {connection.version ? ` · ${connection.version}` : ""}
                </span>
              ) : (
                <span className="as-muted">Not checked yet</span>
              )}
            </div>
          </>
        ) : null}
        {step === 1 ? (
          <>
            <p>
              <strong>{providerLabel(state.provider)}</strong> keeps its own
              credentials. Agent Space never stores or reads tokens; it only
              checks that the CLI's sign-in file or credential variable exists.
            </p>
            <p className="form-note">
              <Info size={14} aria-hidden="true" />
              {DOCS[state.provider]}
            </p>
            {connection?.details?.authHint ? (
              <p className="as-muted">
                Last check: {authHintText(connection.details.authHint)}
              </p>
            ) : null}
          </>
        ) : null}
        {step === 2 ? (
          <>
            <p className="as-muted">
              A check re-runs the CLI's version command and looks for its
              sign-in file again. Nothing is written. What the CLI can do comes
              from the provider registry below, not from this check.
            </p>
            <button
              type="button"
              className="button"
              disabled={busy || !connection}
              onClick={runProbe}
            >
              <Activity size={12} aria-hidden="true" /> Check{" "}
              {providerLabel(state.provider)}
            </button>
            {!connection ? (
              <p className="as-error-text">Detect the provider first.</p>
            ) : null}
            {probe ? (
              <p className="as-feedback" role="status">
                {providerLabel(state.provider)}: {connectionState(probe).label}
                {probe.version ? ` · ${probe.version}` : ""}.{" "}
                {connectionState(probe).detail}
              </p>
            ) : null}
            {capabilities[state.provider] ? (
              <CapabilitySummary caps={capabilities[state.provider]} />
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

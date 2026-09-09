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
        <div className="form-error" role="alert">
          {connections.error.message}
        </div>
      ) : null}
      <div className="as-table-wrap">
        <table className="as-table as-conn-table">
          <thead>
            <tr>
              <th scope="col">Provider</th>
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
                <td colSpan={9} className="as-muted">
                  No connections yet. Press Refresh to detect installed CLIs.
                </td>
              </tr>
            ) : null}
            {list.map((connection) => (
              <tr key={connection.id ?? connection.provider}>
                <th scope="row">
                  <ProviderBadge provider={connection.provider} />
                  {connection.alias && connection.alias !== "default" ? (
                    <span className="as-muted"> {connection.alias}</span>
                  ) : null}
                </th>
                <td>
                  <span
                    className={`status as-conn-${connection.status ?? "unknown"}`}
                  >
                    <i className="dot" aria-hidden="true" />
                    {connection.status ?? "unknown"}
                  </span>
                  {connection.error ? (
                    <div className="as-error-text as-small">
                      {connection.error}
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="as-conn-grid">
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

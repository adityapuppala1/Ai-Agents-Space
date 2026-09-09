import React, { useMemo, useState } from "react";
import { Play, Plus, Info } from "lucide-react";
import { apiFetch, useApi, providerLabel } from "../hooks/useApi.js";
import Dialog from "./Dialog.jsx";

const PRIORITIES = ["critical", "high", "medium", "low"];

function connectionReason(connection, capabilities) {
  if (!connection) return "not detected";
  if (connection.enabled === false || connection.enabled === 0)
    return "disabled in Connections";
  if (connection.status === "missing") return "binary not found";
  if (connection.status === "error")
    return connection.error ? `error: ${connection.error}` : "probe failed";
  // "detected" = binary found without a verified credential file; the server
  // accepts launches for it (RunWorker.providerAvailability), so do we.
  if (connection.status !== "ready" && connection.status !== "detected")
    return `status ${connection.status ?? "unknown"}`;
  const launch = capabilities?.[connection.provider]?.launch;
  if (launch && launch !== "verified" && launch !== "experimental")
    return `launch ${launch}`;
  return "";
}

function connectionHint(connection) {
  if (connection?.status === "detected") return "sign-in not verified";
  return "";
}

/**
 * Task creation + launch form (native <dialog>).
 * @param {{
 *   workspace: { id: string, rootPath?: string, policy?: object, tasks?: any[] },
 *   agents?: any[],
 *   connections?: any[],
 *   capabilities?: Record<string, object>,
 *   tasks?: any[],                  // workspace tasks for the dependency picker (falls back to workspace.tasks)
 *   defaults?: Partial<{ title: string, description: string, provider: string, prompt: string, readOnly: boolean }>,
 *   simple?: boolean,               // start in the compact "Task name / Description / Create task" form
 *   onClose: () => void,
 *   onCreated?: (task: any) => void,
 *   onLaunched?: (run: any, task: any) => void
 * }} props
 */
export default function TaskLauncher({
  workspace,
  agents = [],
  connections = [],
  capabilities = {},
  tasks,
  defaults = {},
  simple = false,
  onClose,
  onCreated,
  onLaunched,
}) {
  const [mode, setMode] = useState(simple ? "simple" : "advanced");
  const presets = useApi("/policy/presets");
  const presetList = useMemo(() => {
    const data = presets.data;
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return Object.entries(data).map(([id, value]) => ({ id, ...value }));
  }, [presets.data]);
  const taskList = tasks ?? workspace?.tasks ?? [];
  const [form, setForm] = useState({
    title: defaults.title ?? "",
    description: defaults.description ?? "",
    deliverable: "",
    priority: "medium",
    folder: "",
    files: "",
    range: "",
    provider: defaults.provider ?? "",
    agentId: "",
    preset: workspace?.policy?.autonomy ?? "",
    isolation: workspace?.policy?.autonomy === "sandbox" ? "worktree" : "none",
    dependsOn: [],
    model: "",
  });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const set = (key, value) =>
    setForm((current) => ({ ...current, [key]: value }));

  const providerOptions = useMemo(() => {
    const byProvider = new Map();
    for (const connection of connections) {
      const reason = connectionReason(connection, capabilities);
      const existing = byProvider.get(connection.provider);
      if (!existing || (existing.reason && !reason))
        byProvider.set(connection.provider, {
          provider: connection.provider,
          reason,
          connection,
        });
    }
    return [...byProvider.values()].sort(
      (a, b) =>
        (a.reason ? 1 : 0) - (b.reason ? 1 : 0) ||
        a.provider.localeCompare(b.provider),
    );
  }, [connections, capabilities]);

  const agentOptions = useMemo(() => {
    const active = agents.filter((a) => !a.archived);
    const match = active.filter((a) => a.provider === form.provider);
    const rest = active.filter((a) => a.provider !== form.provider);
    return [
      ...match.sort(
        (a, b) => (b.autoCreated ? 1 : 0) - (a.autoCreated ? 1 : 0),
      ),
      ...rest,
    ];
  }, [agents, form.provider]);

  const buildBody = () => {
    const files = form.files
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const rangeMatch = form.range.match(/^(.+?):(\d+)(?:-(\d+))?$/);
    return {
      title: form.title.trim(),
      description: form.description.trim(),
      deliverable: form.deliverable.trim() || undefined,
      priority: form.priority,
      provider: form.provider || undefined,
      agentId: form.agentId || undefined,
      target:
        form.folder || files.length || rangeMatch
          ? {
              folder: form.folder.trim() || undefined,
              files: files.length ? files : undefined,
              range: rangeMatch
                ? {
                    file: rangeMatch[1],
                    start: Number(rangeMatch[2]),
                    end: Number(rangeMatch[3] ?? rangeMatch[2]),
                  }
                : undefined,
            }
          : undefined,
      executionPolicy:
        form.preset || form.isolation
          ? { autonomy: form.preset || undefined, isolation: form.isolation }
          : undefined,
      dependsOn: form.dependsOn.length ? form.dependsOn : undefined,
      model: form.model.trim() || undefined,
      source: "launcher",
    };
  };

  const submit = async (launch) => {
    if (!form.title.trim()) {
      setError("Give the task a title.");
      return;
    }
    if (launch && !form.provider) {
      setError("Choose a ready provider to run now, or add it to the board.");
      return;
    }
    setBusy(launch ? "run" : "add");
    setError("");
    try {
      const task = await apiFetch(
        `/workspaces/${encodeURIComponent(workspace.id)}/tasks`,
        { method: "POST", body: buildBody() },
      );
      onCreated?.(task);
      if (launch) {
        const run = await apiFetch(
          `/workspaces/${encodeURIComponent(workspace.id)}/tasks/${encodeURIComponent(task.id)}/run`,
          {
            method: "POST",
            body: {
              provider: form.provider,
              agentId: form.agentId || undefined,
              model: form.model.trim() || undefined,
              isolation: form.isolation,
              policy: form.preset ? { autonomy: form.preset } : undefined,
              prompt: defaults.prompt ?? undefined,
              readOnly: defaults.readOnly ?? undefined,
            },
          },
        );
        onLaunched?.(run, task);
      }
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  };

  const selectedPreset = presetList.find((p) => p.id === form.preset);
  const launchable = providerOptions.filter((option) => !option.reason);

  if (mode === "simple") {
    return (
      <Dialog title="Give your team a task" onClose={onClose}>
        <p className="modal-intro">
          Add work to the queue, assign it to an available agent, or run it now
          through a connected provider.
        </p>
        <form
          className="as-launcher as-launcher-simple"
          onSubmit={(e) => {
            e.preventDefault();
            submit(false);
          }}
        >
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <label>
            Task name
            <input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              required
              maxLength={200}
              data-autofocus
              placeholder="What needs to get done?"
            />
          </label>
          <label>
            Description <span className="optional">optional</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Add context, requirements, or a definition of done."
            />
          </label>
          <div className="form-columns">
            <label>
              Priority
              <select
                value={form.priority}
                onChange={(e) => set("priority", e.target.value)}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Assign to
              <select
                value={form.agentId}
                onChange={(e) => set("agentId", e.target.value)}
              >
                <option value="">Task queue</option>
                {agents
                  .filter((a) => !a.archivedAt)
                  .map((agent) => (
                    <option
                      key={agent.id}
                      value={agent.id}
                      disabled={Boolean(agent.taskId)}
                    >
                      {agent.name}
                      {agent.taskId ? " · busy" : " · available"}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {launchable.length ? (
            <label>
              Run with provider{" "}
              <span className="optional">(optional, for Run now)</span>
              <select
                value={form.provider}
                onChange={(e) => set("provider", e.target.value)}
                aria-label="Provider"
              >
                <option value="">Choose a connected provider</option>
                {launchable.map((option) => (
                  <option key={option.provider} value={option.provider}>
                    {providerLabel(option.provider)}
                    {connectionHint(option.connection)
                      ? ` — ${connectionHint(option.connection)}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="form-note">
            <Info size={16} aria-hidden="true" />
            <span>
              Manual tasks move when you update them. Provider runs report
              elapsed time and recorded events, never invented progress.
            </span>
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="text-button as-launcher-more"
              onClick={() => setMode("advanced")}
            >
              More options
            </button>
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            {launchable.length ? (
              <button
                type="button"
                className="button"
                disabled={Boolean(busy) || !form.provider}
                title={
                  form.provider
                    ? "Create the task and launch it now"
                    : "Choose a connected provider first"
                }
                onClick={() => submit(true)}
              >
                <Play size={12} /> Run now
              </button>
            ) : null}
            <button
              type="submit"
              className="button primary"
              disabled={Boolean(busy)}
            >
              {busy === "add" ? "Creating…" : "Create task"}
            </button>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={defaults.readOnly ? "Run a read-only sandbox task" : "New task"}
      onClose={onClose}
      wide
    >
      <form
        className="as-launcher"
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        {error ? (
          <div className="form-error" role="alert">
            {error}
          </div>
        ) : null}
        <label>
          Title
          <input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            required
            data-autofocus
            placeholder="What should be done?"
          />
        </label>
        <label>
          Description{" "}
          <span className="optional">(sent to the provider as the brief)</span>
          <textarea
            rows={3}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </label>
        <div className="form-columns">
          <label>
            Deliverable <span className="optional">(what counts as done)</span>
            <input
              value={form.deliverable}
              onChange={(e) => set("deliverable", e.target.value)}
              placeholder="e.g. patch + passing tests"
            />
          </label>
          <label>
            Priority
            <select
              value={form.priority}
              onChange={(e) => set("priority", e.target.value)}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="as-fieldset">
          <legend>Target</legend>
          <div className="form-columns">
            <label>
              Folder{" "}
              <span className="optional">
                (relative to {workspace?.rootPath ?? "workspace root"})
              </span>
              <input
                value={form.folder}
                onChange={(e) => set("folder", e.target.value)}
                placeholder="src/"
              />
            </label>
            <label>
              Code range <span className="optional">(file:start-end)</span>
              <input
                value={form.range}
                onChange={(e) => set("range", e.target.value)}
                placeholder="src/app.js:10-40"
              />
            </label>
          </div>
          <label>
            Files <span className="optional">(comma or newline separated)</span>
            <textarea
              rows={2}
              value={form.files}
              onChange={(e) => set("files", e.target.value)}
            />
          </label>
        </fieldset>
        <div className="form-columns">
          <label>
            Provider
            <select
              value={form.provider}
              onChange={(e) => set("provider", e.target.value)}
            >
              <option value="">Board only (no provider)</option>
              {providerOptions.map((option) => (
                <option
                  key={option.provider}
                  value={option.provider}
                  disabled={Boolean(option.reason)}
                >
                  {providerLabel(option.provider)}
                  {option.reason
                    ? ` — ${option.reason}`
                    : connectionHint(option.connection)
                      ? ` — ${connectionHint(option.connection)}`
                      : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Agent
            <select
              value={form.agentId}
              onChange={(e) => set("agentId", e.target.value)}
            >
              <option value="">Auto (provider default)</option>
              {agentOptions.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.provider ? ` · ${providerLabel(agent.provider)}` : ""}
                  {agent.autoCreated ? " (auto)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-columns">
          <label>
            Policy preset
            <select
              value={form.preset}
              onChange={(e) => {
                set("preset", e.target.value);
                const p = presetList.find((x) => x.id === e.target.value);
                if (p?.isolation) set("isolation", p.isolation);
              }}
            >
              <option value="">Workspace default</option>
              {presetList.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label ?? preset.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Isolation
            <select
              value={form.isolation}
              onChange={(e) => set("isolation", e.target.value)}
            >
              <option value="none">None (write in project folder)</option>
              <option value="worktree">
                Git worktree (review patch before merge)
              </option>
            </select>
          </label>
        </div>
        {selectedPreset?.description ? (
          <p className="form-note">
            <Info size={14} aria-hidden="true" />
            {selectedPreset.description}
          </p>
        ) : null}
        <div className="form-columns">
          <label>
            Depends on
            <select
              multiple
              size={Math.min(5, Math.max(2, taskList.length))}
              value={form.dependsOn}
              onChange={(e) =>
                set(
                  "dependsOn",
                  [...e.target.selectedOptions].map((o) => o.value),
                )
              }
              aria-describedby="as-deps-help"
            >
              {taskList.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title} ({task.status})
                </option>
              ))}
            </select>
            <span id="as-deps-help" className="optional">
              Ctrl+click to select several.
            </span>
          </label>
          <label>
            Model{" "}
            <span className="optional">
              (optional; provider must accept it)
            </span>
            <input
              value={form.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder="leave blank for provider default"
            />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" disabled={Boolean(busy)}>
            <Plus size={12} /> Add to board
          </button>
          <button
            type="button"
            className="button primary"
            disabled={Boolean(busy) || !form.provider}
            title={
              form.provider
                ? "Create the task and launch it now"
                : "Choose a ready provider first"
            }
            onClick={() => submit(true)}
          >
            <Play size={12} /> Run now
          </button>
        </div>
      </form>
    </Dialog>
  );
}

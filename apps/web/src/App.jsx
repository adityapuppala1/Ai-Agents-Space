import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Box,
  LayoutDashboard,
  ListTodo,
  Users,
  Radio,
  Settings2,
  Plus,
  ChevronDown,
  ArrowUpRight,
  CircleHelp,
  Check,
  CheckCheck,
  Clock3,
  Activity,
  Pause,
  Play,
  RotateCcw,
  X,
  Search,
  ArrowRight,
  Cable,
  Copy,
  Sun,
  Moon,
  Layers3,
  Coffee,
  AlertCircle,
  Pencil,
  Archive,
  ArchiveRestore,
  FolderPlus,
  UserPlus,
} from "lucide-react";
import { api, useWorkspace, DEFAULT_WORKSPACE } from "./useWorkspace.js";
const Office = lazy(() => import("./Office.jsx"));
const workingStates = [
  ["CODING", "Coding"],
  ["ANALYZING", "Planning"],
  ["TESTING", "Testing"],
  ["DEBUGGING", "Debugging"],
  ["RESEARCHING", "Researching"],
];
function readWorkspaceId() {
  try {
    return localStorage.getItem("agent-space-workspace") || DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}
const stateLabels = {
  CODING: "Coding",
  ANALYZING: "Planning",
  TESTING: "Testing",
  DEBUGGING: "Debugging",
  RESEARCHING: "Researching",
  BLOCKED: "Blocked",
  IDLE: "Available",
};
const taskLabels = {
  QUEUE: "Queued",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
};

function Avatar({ agent, small = false }) {
  return (
    <span
      className={`avatar ${small ? "small" : ""}`}
      style={{ "--agent-color": agent.color }}
    >
      {agent.initials}
    </span>
  );
}
function Badge({ state }) {
  return (
    <span className={`status status-${state.toLowerCase()}`}>
      <i className="dot" />
      {stateLabels[state] ?? taskLabels[state] ?? state}
    </span>
  );
}
function Progress({ value, color }) {
  return (
    <div className="progress-track">
      <div style={{ width: `${value}%`, background: color }} />
    </div>
  );
}
function RelativeTime({ timestamp }) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return <>{seconds < 60 ? "Just now" : `${Math.floor(seconds / 60)}m ago`}</>;
}

function Modal({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    dialog.querySelector("[data-autofocus]")?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      aria-label={title}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          aria-label="Close dialog"
          className="icon-button"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function WorkspaceForm({ workspace, onClose, onSaved }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editing = !!workspace;
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const saved = editing
        ? await api(`/api/workspaces/${workspace.id}`, "PATCH", data)
        : await api("/api/workspaces", "POST", data);
      onSaved(saved);
      onClose();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={editing ? "Workspace details" : "Create a workspace"}
      onClose={onClose}
    >
      <p className="modal-intro">
        {editing
          ? "Rename this workspace or point it at a project folder."
          : "Each workspace keeps its own agents, tasks, and activity. Nothing is shared with the demo."}
      </p>
      <form onSubmit={submit}>
        <label>
          Workspace name
          <input
            name="name"
            data-autofocus
            required
            maxLength={80}
            defaultValue={workspace?.name ?? ""}
            placeholder="Storefront, Data platform, Client site…"
          />
        </label>
        <label>
          Project folder <span className="optional">optional</span>
          <input
            name="rootPath"
            maxLength={500}
            defaultValue={workspace?.rootPath ?? ""}
            placeholder="C:\projects\storefront"
          />
        </label>
        <div className="form-note">
          <CircleHelp size={16} />
          <span>
            The folder is recorded for upcoming provider runs. Nothing is read
            from it yet.
          </span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save workspace" : "Create workspace"}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AgentForm({ base, agent, onClose, onSaved }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const editing = !!agent;
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const saved = editing
        ? await api(`${base}/agents/${agent.id}`, "PATCH", data)
        : await api(`${base}/agents`, "POST", data);
      onSaved(saved, editing ? "Agent updated" : "Agent added");
      onClose();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={editing ? `Edit ${agent.name}` : "Add an agent"}
      onClose={onClose}
    >
      <p className="modal-intro">
        {editing
          ? "Changes apply to new work. Runs already started keep the profile they began with."
          : "Give the new agent a name and a role. You can connect a runtime later."}
      </p>
      <form onSubmit={submit}>
        <div className="form-columns">
          <label>
            Agent name
            <input
              name="name"
              data-autofocus
              required
              maxLength={60}
              defaultValue={agent?.name ?? ""}
              placeholder="Nova"
            />
          </label>
          <label>
            Role
            <input
              name="role"
              required
              maxLength={60}
              defaultValue={agent?.role ?? ""}
              placeholder="Frontend developer"
            />
          </label>
        </div>
        <div className="form-columns">
          <label>
            Working style
            <select
              name="workingState"
              defaultValue={agent?.workingState ?? "CODING"}
            >
              {workingStates.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Color
            <input
              name="color"
              type="color"
              className="color-field"
              defaultValue={agent?.color ?? "#4c78ce"}
            />
          </label>
        </div>
        <label>
          Specialty <span className="optional">optional</span>
          <input
            name="specialty"
            maxLength={120}
            defaultValue={agent?.specialty ?? ""}
            placeholder="Interfaces & interaction"
          />
        </label>
        <label>
          Instructions <span className="optional">optional</span>
          <textarea
            name="instructions"
            maxLength={4000}
            rows={3}
            defaultValue={agent?.instructions ?? ""}
            placeholder="Standing guidance this agent should follow."
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save agent" : "Add agent"}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TaskForm({ base, agents, onClose, onCreated }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const task = await api(`${base}/tasks`, "POST", data);
      onCreated(task);
      onClose();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Give your team a task" onClose={onClose}>
      <p className="modal-intro">
        Add work to the queue or assign it to an available agent.
      </p>
      <form onSubmit={submit}>
        <label>
          Task name
          <input
            name="title"
            data-autofocus
            required
            maxLength={200}
            placeholder="What needs to get done?"
          />
        </label>
        <label>
          Description <span className="optional">optional</span>
          <textarea
            name="description"
            maxLength={2000}
            rows={3}
            placeholder="Add context, requirements, or a definition of done."
          />
        </label>
        <div className="form-columns">
          <label>
            Priority
            <select name="priority" defaultValue="medium">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label>
            Assign to
            <select name="agentId">
              <option value="">Task queue</option>
              {agents.map((agent) => (
                <option
                  key={agent.id}
                  value={agent.id}
                  disabled={!!agent.taskId}
                >
                  {agent.name}
                  {agent.taskId ? " · busy" : " · available"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-note">
          <CircleHelp size={16} />
          <span>
            Manual tasks move when you update them. Demo simulation only changes
            sample tasks.
          </span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Creating…" : "Create task"}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TaskDetails({ base, task, agents, runs, onAction }) {
  const [assignTo, setAssignTo] = useState("");
  const agent = agents.find((a) => a.id === task.assignedAgentId);
  const run = runs.find((r) => r.taskId === task.id);
  return (
    <div className="task-details">
      <div className="task-kicker">
        <span className={`priority priority-${task.priority}`}>
          {task.priority} priority
        </span>
        <span className="source-tag">
          {task.source === "demo" ? "Demo task" : "Manual task"}
        </span>
      </div>
      <h3>{task.title}</h3>
      <p>{task.description || "No additional description for this task."}</p>
      <div className="progress-heading">
        <span>Task progress</span>
        <strong>{task.progress}%</strong>
      </div>
      <Progress value={task.progress} color={agent?.color} />
      <div className="task-properties">
        <span>Status</span>
        <Badge state={task.status} />
        <span>Assigned to</span>
        <strong>{agent?.name ?? "Unassigned"}</strong>
        {run && (
          <>
            <span>Run</span>
            <strong className="run-passport" title={run.id}>
              {run.provider} · {run.status} · started as{" "}
              {run.agentSnapshot.name}
            </strong>
          </>
        )}
        <span>Created</span>
        <strong>
          {new Date(task.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </strong>
      </div>
      {task.status === "QUEUE" && (
        <div className="assignment-control">
          <label className="sr-only" htmlFor="assign-agent">
            Available agent
          </label>
          <select
            id="assign-agent"
            value={assignTo}
            onChange={(e) => setAssignTo(e.target.value)}
          >
            <option value="">Choose an agent</option>
            {agents
              .filter((a) => !a.taskId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
          <button
            className="button primary"
            disabled={!assignTo}
            onClick={() =>
              onAction(
                `${base}/tasks/${task.id}/assign`,
                "POST",
                { agentId: assignTo },
                "Task assigned",
              )
            }
          >
            Assign task
            <ArrowRight size={15} />
          </button>
        </div>
      )}
      {task.status === "IN_PROGRESS" && (
        <div className="task-actions">
          <button
            className="button"
            onClick={() =>
              onAction(
                `${base}/tasks/${task.id}`,
                "PATCH",
                { status: "BLOCKED" },
                "Task paused",
              )
            }
          >
            <Pause size={14} />
            Pause task
          </button>
          <button
            className="button"
            disabled={task.progress >= 99}
            onClick={() =>
              onAction(
                `${base}/tasks/${task.id}`,
                "PATCH",
                { progress: Math.min(99, task.progress + 10) },
                "Progress updated",
              )
            }
          >
            +10% progress
          </button>
          <button
            className="button primary complete-button"
            onClick={() =>
              onAction(
                `${base}/tasks/${task.id}`,
                "PATCH",
                { status: "COMPLETED" },
                "Task completed",
              )
            }
          >
            <Check size={16} />
            Mark complete
          </button>
        </div>
      )}
      {task.status === "BLOCKED" && (
        <>
          <div className="blocker-note">
            <AlertCircle size={17} />
            <span>
              This task is paused. Resume it when the blocker is resolved.
            </span>
          </div>
          <button
            className="button primary wide"
            onClick={() =>
              onAction(
                `${base}/tasks/${task.id}`,
                "PATCH",
                { status: "IN_PROGRESS" },
                "Task resumed",
              )
            }
          >
            <Play size={15} />
            Resume task
          </button>
        </>
      )}
      {task.status === "COMPLETED" && (
        <div className="completed-note">
          <CheckCheck size={18} />
          All done. Ready for the next task.
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [workspaceId, setWorkspaceId] = useState(readWorkspaceId);
  const { workspace, connected, missing } = useWorkspace(workspaceId);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const [view, setView] = useState("office"),
    [selectedAgent, setSelectedAgent] = useState(null),
    [selectedTask, setSelectedTask] = useState(null),
    [showArchived, setShowArchived] = useState(false),
    [archivedAgents, setArchivedAgents] = useState([]);
  useEffect(() => {
    try {
      localStorage.setItem("agent-space-workspace", workspaceId);
    } catch {}
    setSelectedAgent(null);
    setSelectedTask(null);
    setShowArchived(false);
  }, [workspaceId]);
  useEffect(() => {
    if (missing) setWorkspaceId(DEFAULT_WORKSPACE);
  }, [missing]);
  useEffect(() => {
    if (!showArchived) return;
    fetch(`${base}/agents?archived=1`)
      .then((r) => r.json())
      .then((list) =>
        setArchivedAgents(
          Array.isArray(list) ? list.filter((a) => a.archivedAt) : [],
        ),
      )
      .catch(() => setArchivedAgents([]));
  }, [showArchived, base, workspace?.sequence]);
  const [modal, setModal] = useState(null),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [toast, setToast] = useState(null);
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem("agent-space-theme") === "dark";
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem("agent-space-theme", dark ? "dark" : "light");
    } catch {}
  }, [dark]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  const lock = useRef(false);
  async function action(path, method, data, message) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      await api(path, method, data);
      if (message) setToast({ message });
    } catch (error) {
      setToast({ message: error.message, error: true });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function selectAgent(id) {
    setSelectedAgent(id);
    setSelectedTask(null);
  }
  const agents = workspace?.agents ?? [],
    tasks = workspace?.tasks ?? [],
    runs = workspace?.runs ?? [],
    workspaces = workspace?.workspaces ?? [],
    isDemo = workspace?.workspace?.kind === "demo";
  const active = tasks.filter((t) => t.status === "IN_PROGRESS"),
    completed = tasks.filter((t) => t.status === "COMPLETED"),
    blocked = tasks.filter((t) => t.status === "BLOCKED");
  const agent =
    agents.find((a) => a.id === selectedAgent) ??
    agents.find((a) => a.name === "Nova") ??
    agents[0];
  const task = selectedTask
    ? tasks.find((t) => t.id === selectedTask)
    : tasks.find((t) => t.id === agent?.taskId);
  const shownTasks = tasks.filter(
    (t) =>
      (filter === "all" || t.status === filter) &&
      t.title.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <aside className="rail">
        <a className="brand-mark" href="/" title="Agent Space home">
          <Box size={25} strokeWidth={1.7} />
        </a>
        <nav aria-label="Main navigation">
          {[
            [LayoutDashboard, "office", "Workspace"],
            [ListTodo, "tasks", "Task board"],
            [Users, "agents", "Your agents"],
            [Radio, "activity", "Activity"],
          ].map(([Icon, id, label]) => (
            <button
              key={id}
              title={label}
              aria-label={label}
              aria-current={view === id ? "page" : undefined}
              className={view === id ? "active" : ""}
              onClick={() => setView(id)}
            >
              <Icon size={21} />
              <span className="rail-tooltip">{label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <button
            title="Connections"
            aria-label="Connections"
            onClick={() => setModal("connections")}
          >
            <Cable size={21} />
          </button>
          <button
            title="Workspace settings"
            aria-label="Workspace settings"
            onClick={() => setModal("settings")}
          >
            <Settings2 size={20} />
          </button>
          <span className="user-avatar" title="Local workspace">
            YO
          </span>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="brand-name">
            agent<span>space</span>
            <span className="brand-divider" />
            <label className="workspace-name">
              <span className="sr-only">Switch workspace</span>
              <select
                className="workspace-select"
                aria-label="Switch workspace"
                value={workspaceId}
                onChange={(event) => {
                  if (event.target.value === "__new") setModal("workspace-new");
                  else setWorkspaceId(event.target.value);
                }}
              >
                {!workspaces.some((w) => w.id === workspaceId) && (
                  <option value={workspaceId}>
                    {workspace?.workspace?.name ?? "Loading…"}
                  </option>
                )}
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                    {w.kind === "demo" ? " (demo)" : ""}
                    {w.attention ? ` · ${w.attention} blocked` : ""}
                  </option>
                ))}
                <option value="__new">＋ New workspace…</option>
              </select>
              <ChevronDown size={14} />
            </label>
          </div>
          <div className="topbar-right">
            <span className={`connection ${connected ? "" : "offline"}`}>
              <i className="dot" />
              {connected ? "Live connection" : "Reconnecting…"}
            </span>
            <span className="topbar-divider" />
            <button
              className="icon-button"
              aria-label="Help"
              onClick={() => setModal("help")}
            >
              <CircleHelp size={19} />
            </button>
            <button
              className="icon-button"
              aria-label={dark ? "Use light theme" : "Use dark theme"}
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={19} /> : <Moon size={18} />}
            </button>
          </div>
        </header>
        <main>
          <section className="page-heading">
            <div>
              <div className="eyebrow">YOUR TEAM, IN VIEW</div>
              <h1>
                {view === "office"
                  ? "A little space. A lot happening."
                  : view === "tasks"
                    ? "Good work starts here."
                    : view === "agents"
                      ? "Meet your workspace crew."
                      : "Every step, in the open."}
              </h1>
              <p>
                {view === "office"
                  ? "Watch your agents work, connect the dots, and keep things moving."
                  : view === "tasks"
                    ? "Follow every task from the first idea to the final check."
                    : view === "agents"
                      ? "Name them, shape their roles, and keep the roster yours."
                      : "A live record of task updates and workspace activity."}
              </p>
            </div>
            <button
              className="button primary new-task"
              onClick={() => setModal("task")}
              disabled={!connected}
            >
              <Plus size={17} />
              New task
            </button>
          </section>
          {!workspace ? (
            <div className="loading-state">
              <Box size={34} />
              <h2>Opening your workspace…</h2>
              <p>
                {connected
                  ? "Gathering your agents and tasks."
                  : "Waiting for the local server. The connection will retry automatically."}
              </p>
            </div>
          ) : (
            <>
              <section className="stats" aria-label="Workspace statistics">
                {[
                  [
                    Users,
                    `${agents.filter((a) => a.taskId).length}`,
                    `/ ${agents.length}`,
                    "Agents on task",
                    "blue",
                  ],
                  [Layers3, active.length, "", "Tasks in progress", "violet"],
                  [
                    CheckCheck,
                    completed.length,
                    "",
                    "Tasks completed",
                    "green",
                  ],
                  [AlertCircle, blocked.length, "", "Need attention", "amber"],
                ].map(([Icon, number, suffix, label, color]) => (
                  <div className="stat" key={label}>
                    <span className={`stat-icon ${color}`}>
                      <Icon size={20} />
                    </span>
                    <div>
                      <strong>
                        {number}
                        <span>{suffix}</span>
                      </strong>
                      <p>{label}</p>
                    </div>
                    {label === "Tasks in progress" && (
                      <span className="sparkline">
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </div>
                ))}
              </section>
              <div
                className={`workspace-layout ${view !== "office" ? "alternate-view" : ""}`}
              >
                <div className="workspace-left">
                  {view === "office" && (
                    <section className="panel office-panel">
                      <div className="panel-header">
                        <div className="view-tabs">
                          <button className="active">
                            <Box size={16} />
                            Office view
                          </button>
                          <button onClick={() => setView("tasks")}>
                            <ListTodo size={16} />
                            Task board
                          </button>
                        </div>
                        <div className="demo-controls">
                          <span className="demo-label">
                            {isDemo ? "DEMO WORKSPACE" : "PROJECT WORKSPACE"}
                          </span>
                          {isDemo && (
                            <button
                              className="icon-button"
                              aria-label={
                                workspace.demoRunning
                                  ? "Pause demo"
                                  : "Resume demo"
                              }
                              title={
                                workspace.demoRunning
                                  ? "Pause demo"
                                  : "Resume demo"
                              }
                              disabled={!connected || busy}
                              onClick={() =>
                                action(
                                  `${base}/demo`,
                                  "POST",
                                  { running: !workspace.demoRunning },
                                  workspace.demoRunning
                                    ? "Demo paused"
                                    : "Demo resumed",
                                )
                              }
                            >
                              {workspace.demoRunning ? (
                                <Pause size={15} />
                              ) : (
                                <Play size={15} />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                      <Suspense
                        fallback={
                          <div className="scene-loading">
                            Building your office…
                          </div>
                        }
                      >
                        <Office
                          key={workspaceId}
                          agents={agents}
                          selected={agent?.id}
                          onSelect={selectAgent}
                          running={workspace.demoRunning}
                        />
                      </Suspense>
                      <div className="scene-legend">
                        <span>
                          <i className="dot green" />
                          Working
                        </span>
                        <span>
                          <i className="dot amber" />
                          Blocked
                        </span>
                        <span>
                          <i className="dot gray" />
                          Available
                        </span>
                        <span className="scene-caption">
                          A shared space for independent minds.
                        </span>
                      </div>
                    </section>
                  )}
                  {(view === "office" || view === "agents") && (
                    <section
                      className={`team-section ${view === "agents" ? "expanded" : ""}`}
                    >
                      <div className="section-title">
                        <h2>
                          Your agents <span>{agents.length}</span>
                        </h2>
                        {view === "agents" ? (
                          <span className="agent-toolbar">
                            <button
                              className="button"
                              disabled={!connected}
                              onClick={() => setModal("agent-new")}
                            >
                              <UserPlus size={14} />
                              Add agent
                            </button>
                            <button
                              className="text-button"
                              aria-pressed={showArchived}
                              onClick={() => setShowArchived(!showArchived)}
                            >
                              {showArchived ? "Hide archived" : "Show archived"}
                            </button>
                          </span>
                        ) : (
                          <span>
                            Click an agent to look closer
                            <ArrowUpRight size={13} />
                          </span>
                        )}
                      </div>
                      <div className="agent-grid">
                        {agents.map((a) => (
                          <button
                            key={a.id}
                            className={`agent-card ${agent?.id === a.id ? "selected" : ""}`}
                            onClick={() => selectAgent(a.id)}
                            style={{ "--agent-color": a.color }}
                          >
                            <div className="agent-card-top">
                              <Avatar agent={a} />
                              <i
                                className={`dot ${a.state === "BLOCKED" ? "amber" : a.state === "IDLE" ? "gray" : "green"}`}
                              />
                            </div>
                            <h3>{a.name}</h3>
                            <p>{a.role}</p>
                            <span className="agent-state">
                              {a.state === "IDLE" ? (
                                <Coffee size={12} />
                              ) : (
                                <Activity size={12} />
                              )}{" "}
                              {stateLabels[a.state]}
                            </span>
                            {view === "agents" && (
                              <div className="agent-extra">
                                {a.specialty || "No specialty set"}
                                <br />
                                {a.completed} tasks completed
                              </div>
                            )}
                          </button>
                        ))}
                        {!agents.length && (
                          <div className="empty-state">
                            <Users size={26} />
                            <h3>No active agents</h3>
                            <p>Add an agent or restore an archived one.</p>
                          </div>
                        )}
                      </div>
                      {view === "agents" && showArchived && (
                        <div
                          className="archived-list"
                          aria-label="Archived agents"
                        >
                          <h3>Archived agents</h3>
                          {archivedAgents.length ? (
                            archivedAgents.map((a) => (
                              <div className="archived-row" key={a.id}>
                                <Avatar agent={a} small />
                                <span>
                                  <strong>{a.name}</strong> · {a.role}
                                </span>
                                <button
                                  className="button"
                                  disabled={!connected || busy}
                                  onClick={() =>
                                    action(
                                      `${base}/agents/${a.id}/restore`,
                                      "POST",
                                      {},
                                      `${a.name} restored`,
                                    )
                                  }
                                >
                                  <ArchiveRestore size={14} />
                                  Restore
                                </button>
                              </div>
                            ))
                          ) : (
                            <p>Nothing archived in this workspace.</p>
                          )}
                        </div>
                      )}
                    </section>
                  )}
                  {view === "tasks" && (
                    <section className="panel task-board">
                      <div className="board-tools">
                        <h2>
                          Task board <span>{tasks.length}</span>
                        </h2>
                        <label className="search-box">
                          <Search size={15} />
                          <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search tasks"
                            aria-label="Search tasks"
                          />
                        </label>
                      </div>
                      <div className="filter-tabs">
                        {[
                          ["all", "All tasks"],
                          ["QUEUE", "Queued"],
                          ["IN_PROGRESS", "In progress"],
                          ["BLOCKED", "Blocked"],
                          ["COMPLETED", "Completed"],
                        ].map(([id, label]) => (
                          <button
                            className={filter === id ? "active" : ""}
                            key={id}
                            onClick={() => setFilter(id)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="task-list">
                        {shownTasks.length ? (
                          shownTasks.map((t) => (
                            <button
                              className={`task-row ${selectedTask === t.id ? "selected" : ""}`}
                              key={t.id}
                              onClick={() => setSelectedTask(t.id)}
                            >
                              <span
                                className={`task-check ${t.status === "COMPLETED" ? "done" : ""}`}
                              >
                                {t.status === "COMPLETED" ? (
                                  <Check size={13} />
                                ) : (
                                  <span />
                                )}
                              </span>
                              <div>
                                <h3>{t.title}</h3>
                                <p>
                                  {agents.find(
                                    (a) => a.id === t.assignedAgentId,
                                  )?.name ?? "Unassigned"}
                                  <span>·</span>
                                  {t.source === "demo"
                                    ? "Demo task"
                                    : "Manual task"}
                                </p>
                              </div>
                              <Badge state={t.status} />
                              <span className="row-progress">
                                {t.progress}%
                              </span>
                              <ArrowUpRight size={16} />
                            </button>
                          ))
                        ) : (
                          <div className="empty-state">
                            <Search size={26} />
                            <h3>No tasks here yet</h3>
                            <p>
                              {search
                                ? "Try another search or clear the filter."
                                : "Create a task to add work to your team."}
                            </p>
                          </div>
                        )}
                      </div>
                    </section>
                  )}
                  {view === "activity" && (
                    <section className="panel activity-page">
                      <div className="panel-header">
                        <h2>Workspace activity</h2>
                        <span className="live-pill">
                          <i className="dot green" />
                          Live
                        </span>
                      </div>
                      <div className="activity-list">
                        {workspace.events.map((event) => (
                          <div className="activity-item" key={event.id}>
                            <span
                              className={`event-icon ${event.kind === "complete" ? "green" : ""}`}
                            >
                              {event.kind === "complete" ? (
                                <Check size={17} />
                              ) : (
                                <Activity size={17} />
                              )}
                            </span>
                            <div>
                              <p>{event.message}</p>
                              <time>
                                <RelativeTime timestamp={event.timestamp} />
                              </time>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
                <aside className="inspector">
                  <section className="panel inspector-main">
                    <div className="panel-header">
                      <h2>
                        {selectedTask ? "Task details" : "Agent spotlight"}
                      </h2>
                      <span className="inspector-dots">•••</span>
                    </div>
                    {agent && !selectedTask && (
                      <div className="agent-identity">
                        <Avatar agent={agent} />
                        <div>
                          <h2>
                            {agent.name}
                            <span className="agent-id">
                              {agent.id.toUpperCase()}
                            </span>
                          </h2>
                          <p>{agent.role}</p>
                          <Badge state={agent.state} />
                        </div>
                        <div className="agent-tools">
                          <button
                            className="icon-button"
                            aria-label={`Edit ${agent.name}`}
                            title="Edit agent"
                            disabled={!connected}
                            onClick={() => setModal("agent-edit")}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Duplicate ${agent.name}`}
                            title="Duplicate agent"
                            disabled={!connected || busy}
                            onClick={() =>
                              action(
                                `${base}/agents/${agent.id}/duplicate`,
                                "POST",
                                {},
                                "Agent duplicated",
                              )
                            }
                          >
                            <Copy size={16} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label={`Archive ${agent.name}`}
                            title="Archive agent"
                            disabled={!connected || busy || !!agent.taskId}
                            onClick={() =>
                              action(
                                `${base}/agents/${agent.id}/archive`,
                                "POST",
                                {},
                                `${agent.name} archived`,
                              )
                            }
                          >
                            <Archive size={16} />
                          </button>
                        </div>
                      </div>
                    )}
                    <fieldset
                      className="action-fieldset"
                      disabled={!connected || busy}
                    >
                      {task ? (
                        <TaskDetails
                          key={task.id}
                          base={base}
                          task={task}
                          agents={agents}
                          runs={runs}
                          onAction={action}
                        />
                      ) : (
                        <div className="idle-details">
                          <span className="coffee-icon">
                            <Coffee size={27} />
                          </span>
                          <h3>Ready for what’s next.</h3>
                          <p>
                            {agent?.name ?? "Your agent"} is available. Choose a
                            queued task or create something new.
                          </p>
                          <button
                            className="button wide"
                            onClick={() => setView("tasks")}
                          >
                            Browse task queue
                            <ArrowRight size={15} />
                          </button>
                        </div>
                      )}
                    </fieldset>
                    {!selectedTask && (
                      <div className="agent-footnote">
                        <span>
                          <i className="dot blue" />
                          Workspace agent
                        </span>
                        <span>{agent?.completed ?? 0} completed</span>
                      </div>
                    )}
                  </section>
                  <section className="panel activity-preview">
                    <div className="panel-header">
                      <h2>Latest activity</h2>
                      <button
                        className="text-button"
                        onClick={() => setView("activity")}
                      >
                        View all
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                    <div className="activity-list">
                      {workspace.events.slice(0, 3).map((event) => (
                        <div className="activity-item" key={event.id}>
                          <span
                            className={`event-icon ${event.kind === "complete" ? "green" : ""}`}
                          >
                            {event.kind === "complete" ? (
                              <Check size={14} />
                            ) : (
                              <Activity size={14} />
                            )}
                          </span>
                          <div>
                            <p>{event.message}</p>
                            <time>
                              <RelativeTime timestamp={event.timestamp} />
                            </time>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                  <div className="demo-note">
                    <span className="demo-note-icon">
                      <Box size={18} />
                    </span>
                    <p>
                      {isDemo ? (
                        <>
                          <strong>A preview of what’s possible</strong>This
                          office uses simulated agents. Your manually created
                          tasks are controlled by you.
                        </>
                      ) : (
                        <>
                          <strong>Your project workspace</strong>Agents here do
                          not run yet. Tasks and profiles are saved locally and
                          never mixed with the demo.
                        </>
                      )}
                    </p>
                  </div>
                </aside>
              </div>
            </>
          )}
          <footer>
            <span>
              <i className={`dot ${connected ? "green" : "amber"}`} />
              {connected ? "Workspace connected" : "Connection interrupted"}
              <span className="footer-separator">/</span>Saved locally in SQLite
            </span>
            <span>
              Built for minds that work together.
              <Box size={13} />
            </span>
          </footer>
        </main>
      </div>
      {modal === "workspace-new" && (
        <WorkspaceForm
          onClose={() => setModal(null)}
          onSaved={(saved) => {
            setWorkspaceId(saved.id);
            setToast({ message: `Workspace “${saved.name}” created` });
          }}
        />
      )}
      {modal === "workspace-edit" && (
        <WorkspaceForm
          workspace={workspace?.workspace}
          onClose={() => setModal(null)}
          onSaved={() => setToast({ message: "Workspace saved" })}
        />
      )}
      {modal === "agent-new" && (
        <AgentForm
          base={base}
          onClose={() => setModal(null)}
          onSaved={(saved, message) => {
            setSelectedAgent(saved.id);
            setToast({ message });
          }}
        />
      )}
      {modal === "agent-edit" && agent && (
        <AgentForm
          base={base}
          agent={agent}
          onClose={() => setModal(null)}
          onSaved={(saved, message) => setToast({ message })}
        />
      )}
      {modal === "task" && (
        <TaskForm
          base={base}
          agents={agents}
          onClose={() => setModal(null)}
          onCreated={(task) => {
            setSelectedTask(task.id);
            setView("tasks");
            setToast({ message: "Task created" });
          }}
        />
      )}
      {modal === "settings" && (
        <Modal title="Workspace settings" onClose={() => setModal(null)}>
          <div className="settings-row">
            <div>
              <h3>{workspace?.workspace?.name ?? "Workspace"}</h3>
              <p>
                {isDemo
                  ? "The demo workspace keeps simulated sample work."
                  : workspace?.workspace?.rootPath || "No project folder set."}
              </p>
            </div>
            {isDemo ? (
              <button
                className="button"
                onClick={() => setModal("workspace-new")}
              >
                <FolderPlus size={14} />
                New workspace
              </button>
            ) : (
              <span className="settings-buttons">
                <button
                  className="button"
                  onClick={() => setModal("workspace-edit")}
                >
                  <Pencil size={14} />
                  Rename
                </button>
                <button
                  className="button"
                  disabled={!connected || busy}
                  onClick={async () => {
                    await action(
                      `/api/workspaces/${workspaceId}/archive`,
                      "POST",
                      {},
                      "Workspace archived",
                    );
                    setWorkspaceId(DEFAULT_WORKSPACE);
                    setModal(null);
                  }}
                >
                  <Archive size={14} />
                  Archive
                </button>
              </span>
            )}
          </div>
          <div className="settings-row">
            <div>
              <h3>Dark appearance</h3>
              <p>A quieter view for late sessions.</p>
            </div>
            <button
              role="switch"
              aria-checked={dark}
              aria-label="Dark appearance"
              className={`toggle ${dark ? "on" : ""}`}
              onClick={() => setDark(!dark)}
            >
              <span />
            </button>
          </div>
          {isDemo && (
            <>
              <div className="settings-row">
                <div>
                  <h3>Demo simulation</h3>
                  <p>Move sample tasks forward automatically.</p>
                </div>
                <button
                  className="button"
                  disabled={!connected || busy}
                  onClick={() =>
                    action(`${base}/demo`, "POST", {
                      running: !workspace?.demoRunning,
                    })
                  }
                >
                  {workspace?.demoRunning ? "Pause" : "Resume"}
                </button>
              </div>
              <div className="settings-row">
                <div>
                  <h3>Restart demo</h3>
                  <p>Reload sample tasks. Manual tasks are kept.</p>
                </div>
                <button
                  className="button"
                  disabled={!connected || busy}
                  onClick={() =>
                    action(
                      `${base}/demo`,
                      "POST",
                      { action: "reset" },
                      "Demo restarted",
                    )
                  }
                >
                  <RotateCcw size={14} />
                  Restart
                </button>
              </div>
            </>
          )}
          <p className="form-note">
            Workspaces, agents, tasks, and runs are saved in a local SQLite
            database and survive server restarts.
          </p>
        </Modal>
      )}
      {modal === "connections" && (
        <Modal title="Connect your workflow" onClose={() => setModal(null)}>
          <div className="integration-banner">
            <Cable size={24} />
            <div>
              <h3>Local task API</h3>
              <p>Ready to receive tasks from your scripts.</p>
            </div>
            <Badge state="IDLE" />
          </div>
          <p className="modal-intro">
            Send a task to this workspace using the local HTTP API. The office
            updates immediately in every connected tab.
          </p>
          <pre>
            {`curl -X POST ${location.origin}/api/tasks \\n  -H "Content-Type: application/json" \\n  -d '{"title":"Review my project","priority":"high"}'`.replaceAll(
              "\\n",
              "\n",
            )}
          </pre>
          <button
            className="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  `${location.origin}/api/tasks`,
                );
                setToast({ message: "API URL copied" });
              } catch {
                setToast({
                  message:
                    "Could not access clipboard. Select the URL above to copy it.",
                  error: true,
                });
              }
            }}
          >
            <Copy size={14} />
            Copy API URL
          </button>
          <div className="integration-placeholder">
            <h3>Assistant-specific connections</h3>
            <p>
              Codex, Claude Code, Cursor, and Copilot adapters are not
              connected. This workspace does not read assistant conversations
              automatically.
            </p>
          </div>
        </Modal>
      )}
      {modal === "help" && (
        <Modal title="Welcome to Agent Space" onClose={() => setModal(null)}>
          <div className="help-steps">
            <p>
              <strong>Explore your office.</strong> Drag to orbit, scroll to
              zoom, and click an agent to see what they’re working on.
            </p>
            <p>
              <strong>Give the team a task.</strong> Create a task and choose an
              available agent, or keep it in the queue for later.
            </p>
            <p>
              <strong>Keep work moving.</strong> Use the spotlight panel to
              update progress, pause a task, or mark it complete.
            </p>
            <p>
              <strong>Try the demo.</strong> Sample tasks progress
              automatically. Pause or restart the simulation in settings. Manual
              tasks always remain under your control.
            </p>
          </div>
          <button
            className="button primary wide"
            onClick={() => setModal(null)}
          >
            Let’s get to work
            <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <AlertCircle size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

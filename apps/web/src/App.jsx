import OfficeControl, { OFFICE_THEMES } from "./components/OfficeControl.jsx";
import { agentMatchesFilters } from "./hooks/viewLogic.js";
import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  LayoutDashboard,
  ListTodo,
  Users,
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
  Coffee,
  AlertCircle,
  Pencil,
  Archive,
  ArchiveRestore,
  FolderPlus,
  UserPlus,
  Columns3,
  GitBranch,
  ChartBar,
  Inbox,
  Antenna,
  Command,
  Keyboard,
  Shield,
  Sparkles,
  ExternalLink,
  KeyRound,
  Timer,
  HeartPulse,
  BookOpen,
  Film,
  Download,
  Upload,
  Eye,
} from "lucide-react";
import {
  api,
  useWorkspace,
  DEFAULT_WORKSPACE,
  saveToken,
  readToken,
} from "./useWorkspace.js";
import {
  RunInspector,
  DecisionInbox,
  ConnectionsPanel,
  LiveSessions,
  CommandPalette,
  TaskLauncher,
  TemplateGallery,
  PolicyEditor,
  ProviderBadge,
  Provenance,
  ActivityBadge,
  Dialog,
  useGlobal,
  useApi,
  SelectionProvider,
  FilterChips,
  EmptyState,
  VirtualList,
  WorkspaceSwitcher,
  GlobalSearch,
  DragAssign,
  PinnedRuns,
  PinToggle,
  DayInReview,
  Onboarding,
  SetupEntry,
  ONBOARDING_KEY,
  OpsPanel,
  MemoryPanel,
  KnowledgePanel,
  HandoverBrief,
  buildStandardCommands,
  useLocalStorage,
  apiFetch,
} from "./components/index.js";
import {
  BoardView,
  TimelineView,
  DependencyMap,
  AnalyticsView,
} from "./views/index.js";
import {
  activityLabel,
  providerLabel,
  formatElapsed,
  basename,
  maskPath,
  maskText,
  maskArtifact,
  isActiveRun,
  RUN_STATUS_LABELS,
} from "./hooks/useApi.js";
const Office = lazy(() => import("./Office.jsx"));

const workingStates = [
  ["CODING", "Coding"],
  ["ANALYZING", "Planning"],
  ["TESTING", "Testing"],
  ["DEBUGGING", "Debugging"],
  ["RESEARCHING", "Researching"],
];
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
const PROVIDER_MODES = new Set(["observed", "managed"]);
const PREFS_KEY = "agent-space-prefs";
const UI_KEY = "agent-space-ui";
const VIRTUALIZE_TASKS_ABOVE = 40;
const CAMERA_KEY = "agent-space-office-camera";
const ROOM_KEY = "agent-space-office-room";
const DEFAULT_PREFS = {
  graphics: "medium",
  reducedMotion: false,
  focusMode: false,
  presentation: false,
  presentationLargeLabels: true,
  rememberViews: true,
  officeTheme: {},
};

/**
 * Office settings that live on the server (so a second browser sees the same
 * office) but are UI-only. Unknown keys are accepted by Settings and returned
 * by GET /api/settings, which is how they come back here.
 */
const OFFICE_SETTINGS = {
  graphics: { key: "ui.graphics", fallback: "medium" },
  labelDensity: { key: "ui.office.labelDensity", fallback: "auto" },
  avatarDetail: { key: "ui.office.avatarDetail", fallback: "auto" },
  ambientSound: { key: "ui.office.ambientSound", fallback: false },
  lighting: { key: "ui.office.lighting", fallback: "day" },
  largeLabels: { key: "ui.presentationLargeLabels", fallback: true },
};

/**
 * Rail views. `full` views take the whole width (no spotlight column);
 * `heading`/`blurb` feed the page heading. Labels are part of the e2e
 * contract ("Workspace", "Task board", "Connections").
 */
const VIEWS = [
  {
    id: "office",
    group: "Work",
    label: "Workspace",
    icon: LayoutDashboard,
    key: "w",
    heading: "Your agents. One shared space.",
    blurb: "Watch your agents work, connect the dots, and keep things moving.",
  },
  {
    id: "tasks",
    group: "Work",
    label: "Task board",
    icon: ListTodo,
    key: "t",
    heading: "Good work starts here.",
    blurb: "Follow every task from the first idea to the final check.",
  },
  {
    id: "board",
    group: "Work",
    label: "Board",
    icon: Columns3,
    key: "b",
    heading: "See the flow at a glance.",
    blurb:
      "Queued, in progress, blocked, completed. Move cards with the keyboard.",
  },
  {
    id: "agents",
    group: "Set up",
    label: "Your agents",
    icon: Users,
    key: "y",
    heading: "Meet your workspace crew.",
    blurb: "Name them, shape their roles, and keep the roster yours.",
  },
  {
    id: "activity",
    group: "Watch",
    label: "Activity",
    icon: Activity,
    key: "v",
    heading: "Every step, in the open.",
    blurb:
      "A live record of task updates and workspace activity, each with its provenance.",
  },
  {
    id: "timeline",
    group: "Watch",
    label: "Timeline",
    icon: Clock3,
    key: "m",
    full: true,
    heading: "Runs over time.",
    blurb: "Bars for every run; replay uses recorded events only.",
  },
  {
    id: "deps",
    group: "Work",
    label: "Dependencies",
    icon: GitBranch,
    key: "d",
    heading: "What unblocks what.",
    blurb: "A dependency map of the tasks in this workspace.",
  },
  {
    id: "analytics",
    group: "Decide",
    label: "Analytics",
    icon: ChartBar,
    key: "a",
    full: true,
    heading: "Numbers with their basis.",
    blurb: "Every figure is labelled counted, reported, measured or estimated.",
  },
  {
    id: "inbox",
    group: "Decide",
    label: "Inbox",
    icon: Inbox,
    key: "i",
    full: true,
    heading: "Decisions waiting for you.",
    blurb:
      "Approvals, failed runs and reviews. Policies are enforced server-side.",
  },
  {
    id: "sessions",
    group: "Watch",
    label: "Live sessions",
    icon: Antenna,
    key: "l",
    full: true,
    heading: "What is running on this machine.",
    blurb:
      "Provider sessions read from the vendors' own session files. Activity derived from tool names is marked inferred.",
  },
  {
    id: "connections",
    group: "Set up",
    label: "Connections",
    icon: Cable,
    key: "c",
    full: true,
    heading: "Providers and the local API.",
    blurb: "Detect installed CLIs, check capabilities honestly, install hooks.",
  },
  {
    id: "ops",
    group: "Set up",
    label: "Operations",
    icon: HeartPulse,
    key: "o",
    full: true,
    heading: "How this machine is holding up.",
    blurb:
      "Health, queues, retention and the stop-all switch. Stopping interrupts work; it never undoes side effects.",
  },
  {
    id: "knowledge",
    group: "Set up",
    label: "Knowledge",
    icon: BookOpen,
    key: "k",
    full: true,
    heading: "What the team remembers.",
    blurb:
      "Shared memory, knowledge collections and the handover brief. Every entry keeps the source it came from.",
  },
  {
    id: "review",
    group: "Watch",
    label: "Day in review",
    icon: Film,
    key: "r",
    full: true,
    heading: "The day, assembled from recorded events.",
    blurb:
      "Each beat cites the event it came from. Nothing here is narrated or summarised by a model.",
  },
];
/** Rail order: four labelled groups instead of fourteen flat icons. */
const RAIL_GROUP_ORDER = ["Work", "Watch", "Decide", "Set up"];
export const RAIL_GROUPS = RAIL_GROUP_ORDER.map((name) => [
  name,
  VIEWS.filter((v) => v.group === name),
]).filter(([, items]) => items.length);

/** Views that show the workspace overview strip; others go straight to content. */
const STATS_VIEWS = new Set(["office", "tasks", "agents"]);

const VIEW_IDS = new Set(VIEWS.map((v) => v.id));

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
function readWorkspaceId() {
  try {
    return localStorage.getItem("agent-space-workspace") || DEFAULT_WORKSPACE;
  } catch {
    return DEFAULT_WORKSPACE;
  }
}
function readPrefs() {
  return { ...DEFAULT_PREFS, ...readJson(PREFS_KEY, {}) };
}
function readSavedUi(prefs) {
  const saved = readJson(UI_KEY, {});
  if (!prefs.rememberViews) return { view: "office", filter: "all" };
  return {
    view: VIEW_IDS.has(saved.view) ? saved.view : "office",
    filter: typeof saved.filter === "string" ? saved.filter : "all",
  };
}

/** Per-second re-render while something with elapsed time is on screen. */
function useTicker(active) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);
}

/**
 * True when a key press belongs to the element under the cursor rather than to
 * the app-wide shortcuts. Widgets that handle their own keys (the drag-assign
 * task list and its agent listbox, the inbox cards, any dialog) must never
 * also trigger a view switch.
 */
function isEditable(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(
    target.closest(
      "input, textarea, select, [contenteditable=''], [contenteditable='true'], dialog, [role='dialog'], [role='alertdialog'], [role='listbox'], [role='option'], [role='button'], [role='menu'], [role='menuitem']",
    ),
  );
}

/**
 * Merges the snapshot agent with the run it is executing so cards, the
 * office and the spotlight agree. Nothing here invents progress: elapsed time
 * comes from run.startedAt, activity comes from recorded events and is
 * labelled inferred for observed/managed runs.
 */
function enrichAgent(agent, tasks, runs) {
  const task = tasks.find((t) => t.id === agent.taskId) ?? null;
  const run =
    (agent.runId && runs.find((r) => r.id === agent.runId)) ??
    (task && runs.find((r) => r.taskId === task.id && !r.endedAt)) ??
    null;
  const runMode =
    agent.runMode ??
    run?.mode ??
    (run ? (run.provider === "simulated" ? "simulated" : "manual") : null);
  const provider =
    agent.provider ??
    agent.runProvider ??
    run?.provider ??
    (task?.source === "demo" ? "simulated" : null);
  const providerRun = PROVIDER_MODES.has(runMode);
  const reviewPending = Boolean(task && task.review?.status === "pending");
  const recordedActivity = agent.activity ?? run?.activity ?? null;
  let activity;
  if (providerRun)
    activity =
      recordedActivity ??
      (["WAITING_APPROVAL", "STALE", "BLOCKED"].includes(agent.state)
        ? agent.state
        : "IDLE");
  else if (agent.state === "BLOCKED") activity = "BLOCKED";
  else if (agent.state === "IDLE") activity = "IDLE";
  else if (reviewPending && !run) activity = "REVIEWING";
  else activity = recordedActivity ?? agent.state;
  const activityProvenance =
    agent.activityProvenance ??
    (providerRun && recordedActivity ? "inferred" : null);
  const runStatus = agent.runStatus ?? run?.status ?? null;
  const startedAt = run?.startedAt ?? null;
  const elapsedMs =
    agent.elapsedMs ??
    (startedAt
      ? (run?.endedAt ? new Date(run.endedAt).getTime() : Date.now()) -
        new Date(startedAt).getTime()
      : null);
  // Most recent provider-backed run for this agent (shown when idle).
  const lastRun =
    runs
      .filter((r) => r.agentId === agent.id && PROVIDER_MODES.has(r.mode))
      .sort(
        (a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0),
      )[0] ?? null;
  return {
    ...agent,
    provider,
    activity,
    activityProvenance,
    currentFile: agent.currentFile ?? run?.currentFile ?? null,
    currentAction: agent.currentAction ?? run?.currentAction ?? null,
    runId: agent.runId ?? run?.id ?? null,
    runStatus,
    runMode,
    elapsedMs,
    taskTitle: task?.title ?? null,
    reviewPending,
    autoCreated: Boolean(agent.autoCreated ?? agent.auto_created),
    activeProviderRun: providerRun && run ? isActiveRun(run) : false,
    lastRun,
  };
}

/* --------------------------------------------------------------------------
 * Office data. Every prop below is derived from records the server already
 * sent. When something was never recorded the prop is left undefined and the
 * scene says so ("no test output yet", "no build events recorded") instead of
 * showing an invented value.
 * ------------------------------------------------------------------------ */

/** Commands that a recorded shell event has to mention to count as a build. */
const BUILD_COMMAND =
  /\b(build|rebuild|compile|bundle|webpack|vite|rollup|tsc|make|msbuild|gradle|mvn|cargo build|go build|dotnet build)\b/i;
const DEPLOY_COMMAND =
  /\b(deploy|release|publish|ship|rollout|terraform apply|kubectl apply|docker push|helm upgrade)\b/i;

/**
 * Test counts a run actually reported. `run.tests` is written by
 * Workspace.testSummaries from the run's `test-output` artifact and the exit
 * codes the provider reported. A summary with commands whose exit code was
 * never reported keeps `total` undefined: the QA screen then says the total
 * was not reported rather than implying every command passed.
 */
function testResultsFrom(runs = []) {
  const out = {};
  for (const run of runs) {
    const tests = run?.tests;
    if (!tests) continue;
    out[run.id] = {
      passed: tests.passed,
      failed: tests.failed,
      total: tests.reported ? tests.commands : undefined,
      // Forwarded so the QA screen can tell "no failures" apart from "not every
      // command reported an outcome"; without them a partial result reads green.
      reported: tests.reported === true,
      unknown: tests.unknown,
      updatedAt: run.lastEventAt ?? run.endedAt ?? run.startedAt ?? null,
      artifactId: tests.artifactId ?? null,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Build/deploy activity for the operations pipeline wall. Two honest sources:
 * recorded command/test events whose command text names a build or deploy, and
 * CI checks a connector read (GET /api/workspaces/:id/checks). Status is what
 * the source said; a recorded command carries no outcome of its own, so it is
 * labelled "recorded" rather than "passed".
 */
function buildEventsFrom(events = [], checks = null) {
  const list = [];
  for (const event of events) {
    if (event.kind !== "command" && event.kind !== "test") continue;
    const text = `${event.message ?? ""} ${event.tool ?? ""}`;
    const deploy = DEPLOY_COMMAND.test(text);
    const build = BUILD_COMMAND.test(text);
    if (event.kind !== "test" && !deploy && !build) continue;
    list.push({
      id: event.id,
      kind: deploy ? "deploy" : event.kind === "test" ? "check" : "build",
      status: "recorded",
      label: event.message ?? event.tool ?? "command",
      timestamp: event.timestamp,
    });
  }
  for (const check of checks?.available ? (checks.checks ?? []) : []) {
    list.push({
      id: `check:${check.name ?? check.workflow ?? list.length}`,
      kind: "check",
      status: String(
        check.conclusion ?? check.state ?? check.status ?? "unknown",
      ).toLowerCase(),
      label: check.name ?? check.workflow ?? "check",
      timestamp: check.completedAt ?? check.updatedAt ?? null,
    });
  }
  return list.length ? list : undefined;
}

/**
 * Handoffs the office can draw. A `delegation` event records that an agent
 * handed work to a subagent; the receiver is not an agent profile we track, so
 * `toAgentId` stays null and the scene prints "unknown agent" instead of
 * naming someone.
 */
function handoffsFrom(events = []) {
  const list = events
    .filter((event) => event.kind === "delegation")
    .slice(0, 20)
    .map((event) => ({
      id: event.id,
      fromAgentId: event.agentId ?? null,
      toAgentId: null,
      taskTitle: event.message ?? null,
      timestamp: event.timestamp,
    }));
  return list.length ? list : undefined;
}

/** Latest recorded message per agent, with who reported it. Never synthesized. */
function messagesFrom(events = [], agents = []) {
  const out = {};
  for (const event of events) {
    if (event.kind !== "message" || !event.agentId) continue;
    if (out[event.agentId]) continue; // events arrive newest first
    const agent = agents.find((a) => a.id === event.agentId);
    out[event.agentId] = {
      summary: event.message,
      timestamp: event.timestamp,
      attribution: agent?.provider
        ? `${providerLabel(agent.provider)} message`
        : "recorded message",
      eventId: event.id,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Team per agent. `team` comes from the profile (its own field or its role). */
function teamsFrom(agents = []) {
  const out = {};
  for (const agent of agents) if (agent.team) out[agent.id] = agent.team;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Avatar styling stored on the profile (`agent_profiles.avatar`). Only the
 * four fields the scene understands are forwarded, and only when the column
 * actually holds a JSON object.
 */
function avatarStylesFrom(agents = []) {
  const out = {};
  for (const agent of agents) {
    const raw = agent.avatar;
    if (!raw || typeof raw !== "string") continue;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const style = {};
    for (const key of ["outfit", "accessory", "hairColor", "pronouns"])
      if (typeof parsed[key] === "string" && parsed[key])
        style[key] = parsed[key];
    if (Object.keys(style).length) out[agent.id] = style;
  }
  return Object.keys(out).length ? out : undefined;
}

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
    <span className={`status status-${String(state).toLowerCase()}`}>
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
function eventProvenance(event) {
  if (event.provenance) return event.provenance;
  if (event.kind === "system") return "system";
  return "user";
}

function Modal({ title, onClose, children, wide = false }) {
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
      className={`modal ${wide ? "modal-wide" : ""}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
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
            Provider runs start in this folder and observed sessions with this
            cwd are mapped here. Files are read only when a task attaches them.
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
    data.provider ||= null;
    data.skills = data.skills.split(",").map((skill) => skill.trim()).filter(Boolean);
    data.avatar = {
      outfit: data.outfit,
      accessory: data.accessory,
      hairColor: data.hairColor,
      pronouns: data.pronouns,
    };
    delete data.outfit;
    delete data.accessory;
    delete data.hairColor;
    delete data.pronouns;
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
  let avatar = {};
  try { avatar = agent?.avatar ? JSON.parse(agent.avatar) : {}; } catch { avatar = {}; }
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
        <fieldset className="agent-runtime-fields">
          <legend>Assistant identity</legend>
          <p>Choose the preferred runtime for new work. A completed run still shows the model actually reported by that provider.</p>
          <div className="form-columns">
            <label>Provider
              <select name="provider" defaultValue={agent?.provider ?? ""}>
                <option value="">Choose later</option>
                <option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="copilot">GitHub Copilot</option><option value="cursor">Cursor</option><option value="gemini">Gemini CLI</option>
              </select>
            </label>
            <label>Requested model <span className="optional">optional</span>
              <input name="model" maxLength={120} defaultValue={agent?.model ?? ""} placeholder="Provider default" />
            </label>
          </div>
          <label>Runtime or connection alias <span className="optional">optional</span>
            <input name="runtime" maxLength={60} defaultValue={agent?.runtime ?? ""} placeholder="Local CLI, build host…" />
          </label>
        </fieldset>
        <fieldset className="agent-identity-fields">
          <legend>Skills and appearance</legend>
          <label>Skills <span className="optional">comma separated</span>
            <input name="skills" defaultValue={(agent?.skills ?? []).join(", ")} placeholder="React, accessibility, Playwright" />
          </label>
          <div className="form-columns">
            <label>Outfit<select name="outfit" defaultValue={avatar.outfit ?? "shirt"}><option value="shirt">Shirt</option><option value="hoodie">Hoodie</option><option value="labcoat">Lab coat</option><option value="vest">Vest</option><option value="jacket">Jacket</option></select></label>
            <label>Accessory<select name="accessory" defaultValue={avatar.accessory ?? "none"}><option value="none">Based on role</option><option value="hardhat">Hard hat</option><option value="glasses">Glasses</option><option value="headset">Headset</option><option value="clipboard">Clipboard</option></select></label>
          </div>
          <div className="form-columns">
            <label>Pronouns <span className="optional">optional</span><input name="pronouns" maxLength={30} defaultValue={avatar.pronouns ?? ""} placeholder="they/them" /></label>
            <label>Hair color<input name="hairColor" type="color" className="color-field" defaultValue={avatar.hairColor ?? "#493d38"} /></label>
          </div>
        </fieldset>
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

/** Passport for a provider-backed run shown inside task details. */
function RunPassport({ run, presentation, onOpenRun }) {
  useTicker(isActiveRun(run));
  const started = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const ended = run.endedAt ? new Date(run.endedAt).getTime() : null;
  const elapsed = started ? (ended ?? Date.now()) - started : null;
  return (
    <div className="run-summary" aria-label="Run summary">
      <div className="run-summary-row">
        <ProviderBadge provider={run.provider} mode={run.mode} />
        <span className={`status as-run-status as-run-${run.status}`}>
          <i className="dot" aria-hidden="true" />
          {RUN_STATUS_LABELS[run.status] ?? run.status}
        </span>
        <ActivityBadge
          activity={run.activity}
          inferred={Boolean(run.activity)}
          status={run.status}
        />
      </div>
      <div className="task-properties">
        <span>Elapsed</span>
        <strong>
          <Timer size={12} aria-hidden="true" />{" "}
          {elapsed === null ? "—" : formatElapsed(elapsed)}
          {isActiveRun(run) ? " · running" : ""}
        </strong>
        <span>Model</span>
        <strong>{run.actualModel ?? "model not reported"}</strong>
        <span>Current file</span>
        <strong className="as-mono">
          {run.currentFile ? basename(run.currentFile) : "—"}
        </strong>
        <span>Folder</span>
        <strong className="as-mono">
          {maskPath(run.cwd, presentation) || "—"}
        </strong>
      </div>
      <p className="form-note">
        <CircleHelp size={14} aria-hidden="true" />
        <span>
          Provider runs show elapsed time and recorded milestones. No percentage
          is estimated.
        </span>
      </p>
      <div className="run-summary-actions">
        <button
          className="button wide"
          onClick={() => onOpenRun?.(run.id, run.workspaceId)}
        >
          <ExternalLink size={14} />
          Open run inspector
        </button>
        <PinToggle runId={run.id} title={run.title ?? run.id} />
      </div>
    </div>
  );
}

function TaskDetails({
  base,
  task,
  agents,
  runs,
  onAction,
  presentation,
  onOpenRun,
}) {
  const [assignTo, setAssignTo] = useState("");
  const agent = agents.find((a) => a.id === task.assignedAgentId);
  const run =
    runs.find((r) => r.taskId === task.id && !r.endedAt) ??
    runs.find((r) => r.taskId === task.id);
  const providerRun = run && PROVIDER_MODES.has(run.mode);
  const sourceLabel =
    task.source === "demo"
      ? "Demo task"
      : task.source === "observed"
        ? "Observed session"
        : task.source === "workflow"
          ? "Workflow step"
          : task.source === "launcher"
            ? "Launched task"
            : "Manual task";
  return (
    <div className="task-details">
      <div className="task-kicker">
        <span className={`priority priority-${task.priority}`}>
          {task.priority} priority
        </span>
        <span className="source-tag">{sourceLabel}</span>
        {task.provider ? (
          <ProviderBadge provider={task.provider} size="small" />
        ) : null}
      </div>
      <h3>{maskText(task.title, presentation)}</h3>
      <p>
        {maskText(
          task.description || "No additional description for this task.",
          presentation,
        )}
      </p>
      {task.deliverable ? (
        <p className="task-deliverable">
          <strong>Deliverable:</strong> {task.deliverable}
        </p>
      ) : null}
      {!providerRun && (
        <>
          <div className="progress-heading">
            <span>Task progress</span>
            <strong>{task.progress}%</strong>
          </div>
          <Progress value={task.progress} color={agent?.color} />
        </>
      )}
      <div className="task-properties">
        <span>Status</span>
        <Badge state={task.status} />
        <span>Assigned to</span>
        <strong>{agent?.name ?? "Unassigned"}</strong>
        {run && !providerRun && (
          <>
            <span>Run</span>
            <strong className="run-passport" title={run.id}>
              {run.provider} · {run.status} · started as{" "}
              {run.agentSnapshot?.name ?? agent?.name ?? "agent"}
            </strong>
          </>
        )}
        {Array.isArray(task.dependsOn) && task.dependsOn.length > 0 && (
          <>
            <span>Depends on</span>
            <strong>{task.dependsOn.length} task(s)</strong>
          </>
        )}
        {task.review?.status && (
          <>
            <span>Review</span>
            <strong>{task.review.status}</strong>
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
      {providerRun ? (
        <RunPassport
          run={run}
          presentation={presentation}
          onOpenRun={onOpenRun}
        />
      ) : (
        <>
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

function ActivityRow({ event, size = 17 }) {
  const provenance = eventProvenance(event);
  const inferredActivity = event.data?.activity ?? null;
  return (
    <div className="activity-item">
      <span
        className={`event-icon ${event.kind === "complete" ? "green" : ""}`}
      >
        {event.kind === "complete" ? (
          <Check size={size} />
        ) : (
          <Activity size={size} />
        )}
      </span>
      <div>
        <p>{event.message}</p>
        <time>
          <RelativeTime timestamp={event.timestamp} />
        </time>
        <span className="activity-meta">
          <Provenance value={provenance} />
          {inferredActivity ? (
            <ActivityBadge activity={inferredActivity} inferred />
          ) : null}
        </span>
      </div>
    </div>
  );
}

function SettingSwitch({ title, text, label, checked, onChange, disabled }) {
  return (
    <div className="settings-row">
      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`toggle ${checked ? "on" : ""}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

const SHORTCUTS = [
  ["Ctrl / ⌘ + K", "Open the command palette"],
  ["?", "Keyboard shortcuts and help"],
  ["N", "New task"],
  ["W / T / B", "Workspace, Task board, Board"],
  ["I / L / C", "Inbox, Live sessions, Connections"],
  ["A / M / D", "Analytics, Timeline, Dependencies"],
  ["Esc", "Close dialogs"],
  ["Arrows, + / -, F", "Pan, zoom, follow inside the office (focus it first)"],
];

export default function App() {
  const [prefs, setPrefsState] = useState(readPrefs);
  const savedUi = useMemo(() => readSavedUi(prefs), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [workspaceId, setWorkspaceId] = useState(readWorkspaceId);
  const { workspace, connected, missing, unauthorized } =
    useWorkspace(workspaceId);
  const { global, revision } = useGlobal();
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
  const [view, setView] = useState(savedUi.view),
    [selectedAgent, setSelectedAgent] = useState(null),
    [selectedTask, setSelectedTask] = useState(null),
    [showArchived, setShowArchived] = useState(false),
    [archivedAgents, setArchivedAgents] = useState([]),
    [showTemplates, setShowTemplates] = useState(false),
    [palette, setPalette] = useState(false),
    [runModal, setRunModal] = useState(null),
    [tokenPrompt, setTokenPrompt] = useState(false);
  const [modal, setModal] = useState(null),
    [filter, setFilter] = useState(savedUi.filter),
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
  const [visualPresetPreview, setVisualPresetPreview] = useState(null);
  const [visualPresetError, setVisualPresetError] = useState(null);
  const [visualPresetBusy, setVisualPresetBusy] = useState(false);
  const capabilities = useApi("/connections/capabilities", {
    deps: [revision],
  });
  // Fallback when the global channel carries no connection rows yet.
  const connectionsApi = useApi("/connections", {
    enabled: !(global.connections?.length > 0),
    deps: [revision],
  });
  const connections = useMemo(() => {
    if (global.connections?.length) return global.connections;
    const data = connectionsApi.data;
    return Array.isArray(data) ? data : (data?.connections ?? []);
  }, [global.connections, connectionsApi.data]);

  // Server settings (all of them, including the UI-only ui.office.* keys the
  // office reads). Re-fetched whenever the global channel says something
  // changed, so a second browser sees the same office preferences.
  const settingsApi = useApi("/settings", { deps: [revision] });
  const serverSettings = settingsApi.data ?? {};
  const workspaceVisualSettings = workspace?.workspace?.settings?.visual ?? {};
  const officeSetting = useCallback(
    (name) => {
      const entry = OFFICE_SETTINGS[name];
      const value = workspaceVisualSettings[entry.key] ?? serverSettings[entry.key];
      return value === undefined || value === null ? entry.fallback : value;
    },
    [serverSettings, workspaceVisualSettings],
  );
  const saveSetting = useCallback(
    async (key, value) => {
      try {
        await api("/api/settings", "PUT", { [key]: value });
        settingsApi.reload();
      } catch (error) {
        setToast({
          message: `Setting not saved: ${error.message}`,
          error: true,
        });
      }
    },
    [settingsApi],
  );

  const [searchOpen, setSearchOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  // Onboarding keeps its own progress in this browser; App reads the same key
  // so "Skip for now" hides the panel immediately (the component writes the
  // flag, and this copy has to learn about it too).
  const [onboarding, setOnboarding] = useLocalStorage(ONBOARDING_KEY, {
    step: 0,
    done: [],
    dismissed: false,
  });
  const [cameraStates, setCameraStates] = useLocalStorage(CAMERA_KEY, {});
  const [roomChoices, setRoomChoices] = useLocalStorage(ROOM_KEY, {});

  const setPrefs = useCallback((patch) => {
    setPrefsState((current) => {
      const next = { ...current, ...patch };
      writeJson(PREFS_KEY, next);
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("agent-space-workspace", workspaceId);
    } catch {}
    setSelectedAgent(null);
    setSelectedTask(null);
    setShowArchived(false);
    setShowTemplates(false);
  }, [workspaceId]);
  useEffect(() => {
    if (missing) setWorkspaceId(DEFAULT_WORKSPACE);
  }, [missing]);
  useEffect(() => {
    if (unauthorized) setTokenPrompt(true);
  }, [unauthorized]);
  useEffect(() => {
    const onUnauthorized = () => setTokenPrompt(true);
    window.addEventListener("agent-space:unauthorized", onUnauthorized);
    return () =>
      window.removeEventListener("agent-space:unauthorized", onUnauthorized);
  }, []);
  useEffect(() => {
    if (!prefs.rememberViews) return;
    writeJson(UI_KEY, { view, filter });
  }, [view, filter, prefs.rememberViews]);
  useEffect(() => {
    if (!showArchived) return;
    api(`${base}/agents?archived=1`, "GET")
      .then((list) =>
        setArchivedAgents(
          Array.isArray(list) ? list.filter((a) => a.archivedAt) : [],
        ),
      )
      .catch(() => setArchivedAgents([]));
  }, [showArchived, base, workspace?.sequence]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try {
      localStorage.setItem("agent-space-theme", dark ? "dark" : "light");
    } catch {}
  }, [dark]);
  useEffect(() => {
    document.documentElement.classList.toggle(
      "reduced-motion",
      Boolean(prefs.reducedMotion || prefs.focusMode),
    );
    document.documentElement.classList.toggle(
      "presentation-mode",
      Boolean(prefs.presentation),
    );
  }, [prefs.reducedMotion, prefs.focusMode, prefs.presentation]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  // Server settings (shared mode) win over local preferences when they
  // change; local edits are pushed with PUT /api/settings and come back
  // through the global channel.
  const serverPrefs = useRef({});
  useEffect(() => {
    const settings = global.settings ?? {};
    const mapping = {
      graphics: settings["ui.graphics"],
      reducedMotion: settings["ui.reducedMotion"],
      presentation: settings["ui.presentationMode"],
    };
    const patch = {};
    for (const [key, value] of Object.entries(mapping)) {
      if (value === undefined || value === null) continue;
      if (serverPrefs.current[key] !== value) {
        serverPrefs.current[key] = value;
        patch[key] = value;
      }
    }
    if (Object.keys(patch).length) setPrefs(patch);
  }, [revision, global.settings, setPrefs]);
  const updatePref = useCallback(
    (key, value) => {
      setPrefs({ [key]: value });
      const serverKey = {
        graphics: "ui.graphics",
        reducedMotion: "ui.reducedMotion",
        presentation: "ui.presentationMode",
      }[key];
      if (serverKey) {
        serverPrefs.current[key] = value;
        api("/api/settings", "PUT", { [serverKey]: value }).catch(() => {});
      }
    },
    [setPrefs],
  );

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
  const openRun = useCallback(
    (runId, targetWorkspaceId) => {
      if (!runId) return;
      if (targetWorkspaceId && targetWorkspaceId !== workspaceId)
        setWorkspaceId(targetWorkspaceId);
      setRunModal({ runId });
    },
    [workspaceId],
  );
  const openTask = useCallback(
    (taskId, targetWorkspaceId) => {
      if (targetWorkspaceId && targetWorkspaceId !== workspaceId)
        setWorkspaceId(targetWorkspaceId);
      setSelectedTask(taskId);
      setView("tasks");
    },
    [workspaceId],
  );

  const rawAgents = workspace?.agents ?? [],
    tasks = workspace?.tasks ?? [],
    runs = workspace?.runs ?? [],
    workspaces = workspace?.workspaces ?? global.workspaces ?? [],
    isDemo = workspace?.workspace?.kind === "demo",
    events = workspace?.events ?? [];
  const agents = useMemo(
    () => rawAgents.map((a) => enrichAgent(a, tasks, runs)),
    [rawAgents, tasks, runs],
  );
  useTicker(agents.some((a) => a.activeProviderRun));

  /* ---------------------------------------------------------------- office */
  const inOffice = view === "office";
  const activeRunIds = useMemo(
    () =>
      agents
        .filter((a) => a.runId && a.activeProviderRun)
        .map((a) => a.runId)
        .slice(0, 6),
    [agents],
  );
  const activeRunKey = activeRunIds.join(",");
  const [artifactsByRun, setArtifactsByRun] = useState({});
  useEffect(() => {
    if (!inOffice || !activeRunKey) {
      setArtifactsByRun({});
      return undefined;
    }
    let stopped = false;
    (async () => {
      const next = {};
      for (const runId of activeRunKey.split(",")) {
        try {
          const data = await apiFetch(`/runs/${encodeURIComponent(runId)}`);
          const list = Array.isArray(data?.artifacts) ? data.artifacts : [];
          if (list.length)
            next[runId] = list.slice(0, 6).map((artifact) => ({
              id: artifact.id,
              title: artifact.title ?? artifact.kind ?? "artifact",
              kind: artifact.kind ?? null,
            }));
        } catch {
          /* The run may have ended, or this build has no run route. */
        }
      }
      if (!stopped) setArtifactsByRun(next);
    })();
    return () => {
      stopped = true;
    };
  }, [inOffice, activeRunKey]);
  // CI checks a connector could read for this workspace. Absent tooling (no
  // gh, no repository) answers `available: false` and contributes nothing.
  const checksApi = useApi(
    inOffice && !isDemo && workspace?.workspace?.rootPath
      ? `/workspaces/${encodeURIComponent(workspaceId)}/checks`
      : null,
    { deps: [workspaceId] },
  );
  const officeData = useMemo(() => {
    const masked = Boolean(prefs.presentation);
    const artifactsByAgent = {};
    for (const a of agents) {
      const list = a.runId ? artifactsByRun[a.runId] : null;
      if (list?.length)
        artifactsByAgent[a.id] = list.map((artifact) =>
          masked ? maskArtifact(artifact, true) : artifact,
        );
    }
    return {
      testResults: testResultsFrom(runs),
      buildEvents: buildEventsFrom(events, checksApi.data),
      artifactsByAgent: Object.keys(artifactsByAgent).length
        ? artifactsByAgent
        : undefined,
      handoffs: handoffsFrom(events),
      messages: messagesFrom(events, agents),
      teams: teamsFrom(agents),
      avatarStyles: avatarStylesFrom(rawAgents),
    };
  }, [
    agents,
    rawAgents,
    runs,
    events,
    artifactsByRun,
    checksApi.data,
    prefs.presentation,
  ]);
  const cameraState = cameraStates?.[workspaceId] ?? null;
  const onCameraChange = useCallback(
    (state) =>
      setCameraStates((current) => ({
        ...(current ?? {}),
        [workspaceId]: state,
      })),
    [setCameraStates, workspaceId],
  );
  const selectedRoom = roomChoices?.[workspaceId] ?? null;
  const onSelectRoom = useCallback(
    (roomId) =>
      setRoomChoices((current) => ({
        ...(current ?? {}),
        [workspaceId]: roomId,
      })),
    [setRoomChoices, workspaceId],
  );

  const completed = tasks.filter((t) => t.status === "COMPLETED");
  const inboxCounts = global.inbox?.counts ?? {};
  const needsDecision =
    inboxCounts.total ??
    (inboxCounts.approvals ?? 0) +
      (inboxCounts.runs ?? 0) +
      (inboxCounts.reviews ?? 0) +
      (inboxCounts.questions ?? 0);
  const liveSessions = global.liveSessions ?? [];
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
  // One selection and one filter set shared by the Office, Board, Timeline and
  // Dependency map. App.jsx owns the state so the spotlight, the scene and the
  // views can never disagree about which task or agent is selected.
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [selectionFilters, setSelectionFilters] = useState(undefined);
  const officeAgents = useMemo(() => agents.filter(a => agentMatchesFilters(a, selectionFilters)), [agents, selectionFilters]);
  const selectionValue = useMemo(
    () => ({
      selectedTaskId: selectedTask,
      selectedRunId,
      selectedAgentId: selectedAgent,
      filters: selectionFilters,
    }),
    [selectedTask, selectedRunId, selectedAgent, selectionFilters],
  );
  const onSelectionChange = useCallback((next) => {
    setSelectionFilters(next.filters);
    setSelectedTask(next.selectedTaskId ?? null);
    setSelectedAgent(next.selectedAgentId ?? null);
    setSelectedRunId(next.selectedRunId ?? null);
  }, []);

  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];
  const fullView = Boolean(current.full);
  const officeTheme =
    workspace?.workspace?.theme ?? prefs.officeTheme?.[workspaceId] ?? "studio";
  const spotlightRun =
    agent?.activeProviderRun && agent.runId ? agent.runId : null;
  const followAgentId =
    prefs.focusMode && agent?.activeProviderRun ? agent.id : null;
  const presentation = Boolean(prefs.presentation);
  const capabilityMap = capabilities.data ?? {};
  // First run: nothing but the demo workspace and no provider that is ready to
  // launch. Setup is a panel, never a blocking modal, and "Skip for now"
  // remembers the choice in this browser. Settings keeps a way back in.
  const hasProjectWorkspace = workspaces.some(
    (w) => w.kind !== "demo" && !w.archivedAt,
  );
  const hasReadyConnection = connections.some((c) => c.status === "ready");
  const showSetup =
    setupOpen ||
    (!onboarding?.dismissed && !hasProjectWorkspace && !hasReadyConnection);

  async function setOfficeTheme(theme) {
    try {
      await api(`${base}`, "PATCH", { theme });
      setPrefs({ officeTheme: { ...prefs.officeTheme, [workspaceId]: theme } });
      setToast({ message: `Office theme set to ${theme}` });
    } catch (error) {
      setToast({
        message: `Theme could not be saved (${error.message})`,
        error: true,
      });
    }
  }

  async function saveVisualSetting(key, value) {
    const preset = {
      kind: "agent-space-visual-preset",
      version: 1,
      name: `${workspace?.workspace?.name ?? "Workspace"} visual preset`,
      theme: officeTheme,
      settings: { ...workspaceVisualSettings, [key]: value },
    };
    try {
      await api(`${base}/visual-preset/apply`, "POST", { preset });
    } catch (error) {
      setToast({ message: `Visual setting not saved: ${error.message}`, error: true });
    }
  }

  async function exportVisualPreset() {
    try {
      const preset = await api(`${base}/visual-preset`, "GET");
      const blob = new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "office"}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setToast({ message: "Visual preset exported" });
    } catch (error) {
      setToast({ message: `Preset could not be exported: ${error.message}`, error: true });
    }
  }

  async function previewVisualPreset(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setVisualPresetError(null);
    try {
      const parsed = JSON.parse(await file.text());
      const preview = await api(`${base}/visual-preset/preview`, "POST", { preset: parsed });
      setVisualPresetPreview(preview);
    } catch (error) {
      setVisualPresetPreview(null);
      setVisualPresetError(`That preset cannot be used: ${error.message}`);
    }
  }

  async function applyVisualPreset() {
    if (!visualPresetPreview) return;
    setVisualPresetBusy(true);
    try {
      await api(`${base}/visual-preset/apply`, "POST", { preset: visualPresetPreview.preset });
      setVisualPresetPreview(null);
      setToast({ message: "Visual preset applied to this workspace" });
    } catch (error) {
      setVisualPresetError(`Preset could not be applied: ${error.message}`);
    } finally {
      setVisualPresetBusy(false);
    }
  }

  // Keyboard shortcuts (single keys outside inputs and dialogs).
  useEffect(() => {
    const handler = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (palette || modal || runModal || tokenPrompt) return;
      // A component that already acted on this key (drag-to-assign, the
      // inbox, the office) calls preventDefault; the app shortcuts stand down.
      if (event.defaultPrevented) return;
      if (isEditable(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.key === "?") {
        event.preventDefault();
        setModal("help");
        return;
      }
      if (key === "n" && connected) {
        event.preventDefault();
        setModal("task");
        return;
      }
      const target = VIEWS.find((v) => v.key === key);
      if (target) {
        event.preventDefault();
        setView(target.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [palette, modal, runModal, tokenPrompt, connected]);

  const commands = useMemo(() => {
    const list = VIEWS.map((v) => ({
      id: `view:${v.id}`,
      group: "Go to",
      label: v.label,
      hint: v.id === "inbox" && needsDecision ? `${needsDecision} waiting` : "",
      keywords: `${v.id} view navigate`,
      run: () => setView(v.id),
    }));
    for (const w of workspaces)
      list.push({
        id: `workspace:${w.id}`,
        group: "Workspace",
        label: w.name,
        hint: w.kind === "demo" ? "demo" : maskPath(w.rootPath, presentation),
        keywords: "switch open workspace",
        run: () => setWorkspaceId(w.id),
      });
    list.push(
      {
        id: "action:new-task",
        group: "Action",
        label: "New task",
        hint: "N",
        keywords: "create launch run",
        run: () => setModal("task"),
      },
      {
        id: "action:template",
        group: "Action",
        label: "Use a template",
        keywords: "workflow templates gallery",
        run: () => {
          setView("tasks");
          setShowTemplates(true);
        },
      },
      {
        id: "action:inbox",
        group: "Action",
        label: "Open inbox",
        hint: needsDecision ? `${needsDecision} waiting` : "",
        keywords: "approve deny decisions",
        run: () => setView("inbox"),
      },
      {
        id: "action:new-workspace",
        group: "Action",
        label: "New workspace",
        keywords: "create project folder",
        run: () => setModal("workspace-new"),
      },
      {
        id: "action:settings",
        group: "Action",
        label: "Workspace settings",
        keywords: "theme graphics motion focus presentation policy",
        run: () => setModal("settings"),
      },
      {
        id: "action:theme",
        group: "Action",
        label: dark ? "Use light theme" : "Use dark theme",
        keywords: "appearance dark light",
        run: () => setDark((v) => !v),
      },
      {
        id: "action:focus",
        group: "Action",
        label: prefs.focusMode ? "Leave focus mode" : "Enter focus mode",
        keywords: "pin run quiet",
        run: () => updatePref("focusMode", !prefs.focusMode),
      },
      {
        id: "action:help",
        group: "Action",
        label: "Keyboard shortcuts",
        hint: "?",
        keywords: "help keys",
        run: () => setModal("help"),
      },
    );
    if (isDemo && workspace)
      list.push({
        id: "action:demo",
        group: "Action",
        label: workspace.demoRunning ? "Pause demo" : "Resume demo",
        keywords: "simulation",
        run: () =>
          action(`${base}/demo`, "POST", { running: !workspace.demoRunning }),
      });
    return list;
  }, [
    workspaces,
    needsDecision,
    presentation,
    dark,
    prefs.focusMode,
    isDemo,
    workspace,
    base,
    updatePref,
  ]);

  const renderAgentCard = (a) => (
    <button
      key={a.id}
      className={`agent-card ${agent?.id === a.id ? "selected" : ""}`}
      onClick={() => selectAgent(a.id)}
      style={{ "--agent-color": a.color }}
    >
      <div className="agent-card-top">
        <Avatar agent={a} />
        <i
          className={`dot ${
            a.state === "BLOCKED" ||
            ["waiting_approval", "blocked", "stale"].includes(a.runStatus)
              ? "amber"
              : a.state === "IDLE"
                ? "gray"
                : "green"
          }`}
        />
      </div>
      <h3>
        {a.name}
        {a.autoCreated ? (
          <span
            className="auto-tag"
            title="Created automatically from a session"
          >
            auto
          </span>
        ) : null}
      </h3>
      <p>{a.role}</p>
      <span className="agent-meta">
        <ProviderBadge provider={a.provider} size="small" />
        <span className="agent-state">
          {a.activity === "IDLE" ? (
            <Coffee size={12} />
          ) : (
            <Activity size={12} />
          )}{" "}
          {activityLabel(a.activity)}
          {a.activityProvenance === "inferred" ? (
            <em className="as-inferred">inferred</em>
          ) : null}
        </span>
      </span>
      {a.currentFile ? (
        <span
          className="agent-file as-mono"
          title={presentation ? undefined : a.currentFile}
        >
          {basename(a.currentFile)}
        </span>
      ) : null}
      {a.activeProviderRun && a.elapsedMs !== null ? (
        <span className="agent-elapsed">
          <Timer size={11} aria-hidden="true" /> {formatElapsed(a.elapsedMs)}
        </span>
      ) : null}
      {view === "agents" && (
        <div className="agent-extra">
          {a.specialty || "No specialty set"}
          <br />
          {a.completed} tasks completed
        </div>
      )}
    </button>
  );

  const taskPanel = (
    <section className="panel task-board">
      <div className="board-tools">
        <h2>
          Task board <span>{tasks.length}</span>
        </h2>
        <div
          className="view-tabs board-modes"
          role="group"
          aria-label="Board layout"
        >
          <button
            className={view === "tasks" ? "active" : ""}
            onClick={() => setView("tasks")}
          >
            <ListTodo size={15} />
            List
          </button>
          <button
            className={view === "board" ? "active" : ""}
            onClick={() => setView("board")}
          >
            <Columns3 size={15} />
            Kanban
          </button>
        </div>
        <button
          className="button"
          aria-pressed={showTemplates}
          onClick={() => setShowTemplates((v) => !v)}
        >
          <Sparkles size={14} />
          Use a template
        </button>
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
      {showTemplates && (
        <div className="template-drawer">
          <TemplateGallery
            workspaceId={workspaceId}
            onInstantiated={(workflow) => {
              setShowTemplates(false);
              setToast({
                message: `Workflow “${workflow?.name ?? workflow?.templateId ?? "template"}” created`,
              });
            }}
          />
        </div>
      )}
      {view === "board" ? (
        <div className="board-wrap">
          <BoardView
            tasks={shownTasks}
            agents={agents}
            selectedId={selectedTask}
            presentation={presentation}
            onCreateTask={() => setModal("task")}
            onSelectTask={(t) => setSelectedTask(t.id)}
            onMove={(t, status) =>
              action(
                `${base}/tasks/${t.id}`,
                "PATCH",
                { status },
                `Moved “${t.title}” to ${taskLabels[status] ?? status}`,
              )
            }
          />
          <DragAssign
            tasks={tasks}
            agents={agents}
            presentation={presentation}
            onAssign={(taskId, agentId) =>
              apiFetch(`/workspaces/${workspaceId}/tasks/${taskId}/assign`, {
                method: "POST",
                body: { agentId },
              })
            }
          />
        </div>
      ) : (
        <>
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
              renderTaskRows(shownTasks)
            ) : (
              <EmptyState
                icon={<Search size={26} />}
                title="No tasks here yet"
                description={
                  search
                    ? "Nothing matches that search in this workspace."
                    : "Create a task to add work to your team."
                }
                actions={[
                  search
                    ? { label: "Clear search", onClick: () => setSearch("") }
                    : {
                        label: "New task",
                        primary: true,
                        onClick: () => setModal("task"),
                      },
                ]}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
  function renderTaskRows(list) {
    const row = (t) => {
      const owner = agents.find((a) => a.id === t.assignedAgentId);
      const taskRun =
        runs.find((r) => r.taskId === t.id && !r.endedAt) ??
        runs.find((r) => r.taskId === t.id);
      const providerRun = taskRun && PROVIDER_MODES.has(taskRun.mode);
      return (
        <button
          className={`task-row ${selectedTask === t.id ? "selected" : ""}`}
          key={t.id}
          onClick={() => setSelectedTask(t.id)}
        >
          <span
            className={`task-check ${t.status === "COMPLETED" ? "done" : ""}`}
          >
            {t.status === "COMPLETED" ? <Check size={13} /> : <span />}
          </span>
          <div>
            <h3>{maskText(t.title, presentation)}</h3>
            <p>
              {owner?.name ?? "Unassigned"}
              <span>·</span>
              {t.source === "demo"
                ? "Demo task"
                : t.source === "observed"
                  ? "Observed session"
                  : t.source === "workflow"
                    ? "Workflow step"
                    : "Manual task"}
              {t.provider || taskRun?.provider ? (
                <>
                  <span>·</span>
                  <ProviderBadge
                    provider={t.provider ?? taskRun?.provider}
                    size="small"
                  />
                </>
              ) : null}
            </p>
          </div>
          <Badge state={t.status} />
          <span className="row-progress">
            {providerRun
              ? taskRun.startedAt
                ? formatElapsed(
                    (taskRun.endedAt
                      ? new Date(taskRun.endedAt).getTime()
                      : Date.now()) - new Date(taskRun.startedAt).getTime(),
                  )
                : "—"
              : `${t.progress}%`}
          </span>
          <ArrowUpRight size={16} />
        </button>
      );
    };
    // Long lists are windowed so a workspace with hundreds of tasks stays
    // responsive; short lists render in full (the e2e suite counts .task-row).
    if (list.length <= VIRTUALIZE_TASKS_ABOVE) return list.map(row);
    return (
      <VirtualList
        items={list}
        itemHeight={74}
        height={520}
        label="Tasks"
        getKey={(t) => t.id}
        renderItem={(t) => row(t)}
      />
    );
  }

  return (
    <SelectionProvider value={selectionValue} onChange={onSelectionChange}>
      <div
        className={`app-shell ${prefs.focusMode ? "focus-mode" : ""} ${presentation ? "presentation" : ""}`}
      >
        <aside className="rail">
          <a className="brand-mark" href="/" title="Agent Space home">
            <Box size={25} strokeWidth={1.7} />
          </a>
          <nav aria-label="Main navigation">
            {RAIL_GROUPS.map(([groupName, items]) => (
              <div className="rail-group" key={groupName}>
                <h2 className="rail-group-label" aria-hidden="true">
                  {groupName}
                </h2>
                {items.map(({ icon: Icon, id, label }) => (
                  <button
                    key={id}
                    title={label}
                    aria-label={label}
                    aria-current={view === id ? "page" : undefined}
                    className={view === id ? "active" : ""}
                    onClick={() => setView(id)}
                  >
                    <Icon size={19} />
                    <span className="rail-text">{label}</span>
                    {id === "inbox" && needsDecision > 0 ? (
                      <span
                        className="rail-badge"
                        aria-label={`${needsDecision} decisions waiting`}
                        data-testid="inbox-badge"
                      >
                        {needsDecision > 99 ? "99+" : needsDecision}
                      </span>
                    ) : null}
                    {id === "sessions" && liveSessions.length > 0 ? (
                      <span className="rail-badge live" aria-hidden="true">
                        {liveSessions.length}
                      </span>
                    ) : null}
                    <span className="rail-tooltip">{label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="rail-bottom">
            <button
              title="Workspace settings"
              aria-label="Workspace settings"
              onClick={() => setModal("settings")}
            >
              <Settings2 size={20} />
            </button>
            <span className="user-avatar" title="Local workspace">
              {presentation ? "··" : "YO"}
            </span>
          </div>
        </aside>
        <div className="app-main">
          <header className="topbar">
            <div className="brand-name">
              agent<span>space</span>
              <span className="brand-divider" />
              <WorkspaceSwitcher
                currentId={workspaceId}
                onSelect={setWorkspaceId}
                workspaces={workspaces.length ? workspaces : undefined}
                connections={connections.length ? connections : undefined}
                presentation={presentation}
              />
              {/*
              The switcher above is the visible control. This native select is
              the equivalent keyboard/assistive path (and what the e2e suite
              drives): it carries the same options and the "Switch workspace"
              label, and is kept in sync with the switcher.
            */}
              <label className="workspace-name sr-only">
                <span>Switch workspace</span>
                <select
                  className="workspace-select"
                  aria-label="Switch workspace"
                  value={workspaceId}
                  onChange={(event) => {
                    if (event.target.value === "__new")
                      setModal("workspace-new");
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
                      {(w.autoCreated ?? w.auto_created) ? " · auto" : ""}
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
                aria-label="Command palette"
                title="Command palette (Ctrl+K)"
                onClick={() => setPalette(true)}
              >
                <Command size={18} />
              </button>
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
                <div className="eyebrow">
                  {prefs.focusMode ? "FOCUS MODE" : "YOUR TEAM, IN VIEW"}
                </div>
                <h1>{current.heading}</h1>
                <p>{current.blurb}</p>
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
            {showSetup && (
              <div className="setup-slot">
                <Onboarding
                  open
                  workspaceId={workspaceId}
                  onClose={() => {
                    setSetupOpen(false);
                    setOnboarding((current) => ({
                      ...(current ?? {}),
                      dismissed: true,
                    }));
                  }}
                  onOpenWorkspace={(id) => {
                    setWorkspaceId(id);
                    setSetupOpen(false);
                  }}
                  onOpenConnections={() => setView("connections")}
                  onOpenTemplates={() => {
                    setView("tasks");
                    setShowTemplates(true);
                  }}
                  onStartDemo={() => {
                    setWorkspaceId(DEFAULT_WORKSPACE);
                    setView("office");
                  }}
                />
              </div>
            )}
            {!workspace ? (
              <div className="loading-state">
                <Box size={34} />
                <h2>Opening your workspace…</h2>
                <p>
                  {connected
                    ? "Gathering your agents and tasks."
                    : unauthorized
                      ? "This server requires an access token."
                      : "Waiting for the local server. The connection will retry automatically."}
                </p>
                {unauthorized && (
                  <button
                    className="button primary"
                    onClick={() => setTokenPrompt(true)}
                  >
                    <KeyRound size={15} />
                    Enter access token
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* The overview strip belongs on the workspace overview. Repeating it on
                    every page pushed each page's real content below the fold. */}
                {STATS_VIEWS.has(view) ? (
                  <section className="stats" aria-label="Workspace statistics">
                    {[
                      [
                        Users,
                        `${agents.filter((a) => a.taskId).length}`,
                        `/ ${agents.length}`,
                        "Agents on task",
                        "blue",
                      ],
                      [
                        Antenna,
                        liveSessions.length,
                        "",
                        "Live sessions",
                        "violet",
                      ],
                      [Inbox, needsDecision, "", "Needs decision", "amber"],
                      [
                        CheckCheck,
                        completed.length,
                        "",
                        "Tasks completed",
                        "green",
                      ],
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
                      </div>
                    ))}
                  </section>
                ) : null}
                <FilterChips />
                {view === "office" && <OfficeControl agents={agents} visibleCount={officeAgents.length} filters={selectionFilters} onFilters={setSelectionFilters} theme={officeTheme} onTheme={setOfficeTheme} isDemo={isDemo} onConnections={() => setView("connections")} onSelectAgent={selectAgent} />}
                <div
                  className={`workspace-layout ${view !== "office" ? "alternate-view" : ""} ${fullView ? "full-view" : ""}`}
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
                            agents={officeAgents}
                            selected={agent?.id}
                            onSelect={selectAgent}
                            running={!isDemo || workspace.demoRunning}
                            theme={officeTheme}
                            graphics={officeSetting("graphics")}
                            reducedMotion={
                              prefs.reducedMotion || prefs.focusMode
                            }
                            followAgentId={followAgentId}
                            testResults={officeData.testResults}
                            buildEvents={officeData.buildEvents}
                            artifactsByAgent={officeData.artifactsByAgent}
                            handoffs={officeData.handoffs}
                            messages={officeData.messages}
                            teams={officeData.teams}
                            avatarStyles={officeData.avatarStyles}
                            selectedRoom={selectedRoom}
                            onSelectRoom={onSelectRoom}
                            cameraState={cameraState}
                            onCameraChange={onCameraChange}
                            onOpenMonitor={(agentId) => {
                              const target = agents.find(
                                (a) => a.id === agentId,
                              );
                              if (target?.runId) openRun(target.runId);
                              else selectAgent(agentId);
                            }}
                            onOpenArtifact={(artifactId) => {
                              const owner = agents.find((a) =>
                                (
                                  officeData.artifactsByAgent?.[a.id] ?? []
                                ).some(
                                  (artifact) => artifact.id === artifactId,
                                ),
                              );
                              if (owner?.runId) openRun(owner.runId);
                            }}
                            onOpenEvent={(eventId) => {
                              const event = events.find(
                                (e) => e.id === eventId,
                              );
                              if (event?.runId) openRun(event.runId);
                              else setView("activity");
                            }}
                            presentation={
                              presentation
                                ? {
                                    enabled: true,
                                    largeLabels: Boolean(
                                      officeSetting("largeLabels"),
                                    ),
                                  }
                                : null
                            }
                            labelDensity={
                              officeSetting("labelDensity") === "auto"
                                ? null
                                : officeSetting("labelDensity")
                            }
                            avatarDetail={
                              officeSetting("avatarDetail") === "auto"
                                ? null
                                : officeSetting("avatarDetail")
                            }
                            ambientSound={Boolean(
                              officeSetting("ambientSound"),
                            )}
                            lighting={officeSetting("lighting")}
                          />
                        </Suspense>
                        <div className="scene-legend">
                          <span>
                            <i className="dot green" />
                            Working
                          </span>
                          <span>
                            <i className="dot amber" />
                            Blocked / needs approval
                          </span>
                          <span>
                            <i className="dot gray" />
                            Available
                          </span>
                          <span className="scene-caption">
                            {prefs.focusMode
                              ? "Focus mode: ambient motion paused, active run pinned."
                              : "Activity derived from tool names is marked inferred."}
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
                                {showArchived
                                  ? "Hide archived"
                                  : "Show archived"}
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
                          {agents.map(renderAgentCard)}
                          {!agents.length && (
                            <EmptyState
                              icon={<Users size={26} />}
                              title="No active agents"
                              description="Add an agent, or restore one you archived earlier."
                              actions={[
                                {
                                  label: "Add agent",
                                  primary: true,
                                  disabled: !connected,
                                  onClick: () => setModal("agent-new"),
                                },
                                {
                                  label: "Show archived",
                                  onClick: () => {
                                    setView("agents");
                                    setShowArchived(true);
                                  },
                                },
                              ]}
                            />
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
                    {(view === "tasks" || view === "board") && taskPanel}
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
                          {events.length > VIRTUALIZE_TASKS_ABOVE ? (
                            <VirtualList
                              items={events}
                              itemHeight={72}
                              height={560}
                              label="Workspace activity"
                              getKey={(event) => event.id}
                              renderItem={(event) => (
                                <ActivityRow event={event} />
                              )}
                            />
                          ) : (
                            events.map((event) => (
                              <ActivityRow key={event.id} event={event} />
                            ))
                          )}
                          {!events.length && (
                            <EmptyState
                              icon={<Activity size={26} />}
                              title="Nothing recorded yet"
                              description="Task updates and run events land here as soon as they are recorded, each with its provenance."
                            />
                          )}
                        </div>
                      </section>
                    )}
                    {view === "timeline" && (
                      <section className="panel view-panel">
                        <TimelineView
                          workspaceId={workspaceId}
                          runs={runs}
                          onOpenRun={(runId) => openRun(runId)}
                          onOpenEvent={(ref) => openRun(ref?.runId)}
                        />
                      </section>
                    )}
                    {view === "deps" && (
                      <section className="panel view-panel">
                        <DependencyMap
                          workspaceId={workspaceId}
                          selectedId={selectedTask}
                          onSelectTask={(taskId) => setSelectedTask(taskId)}
                        />
                      </section>
                    )}
                    {view === "analytics" && (
                      <section className="panel view-panel">
                        <AnalyticsView
                          workspaceId={workspaceId}
                          onOpenRun={openRun}
                          onOpenTask={openTask}
                        />
                      </section>
                    )}
                    {view === "ops" && (
                      <section className="panel view-panel">
                        <OpsPanel onOpenAudit={() => setView("activity")} />
                      </section>
                    )}
                    {view === "knowledge" && (
                      <section className="panel view-panel knowledge-stack">
                        <KnowledgePanel
                          workspaceId={workspaceId}
                          presentation={presentation}
                        />
                        <MemoryPanel
                          workspaceId={workspaceId}
                          runId={agent?.runId ?? null}
                        />
                        <HandoverBrief
                          workspaceId={workspaceId}
                          taskId={selectedTask ?? null}
                          runId={agent?.runId ?? null}
                        />
                      </section>
                    )}
                    {view === "review" && (
                      <section className="panel view-panel">
                        <DayInReview
                          workspaceId={workspaceId}
                          runs={runs}
                          onOpenRun={(runId) => openRun(runId)}
                          onOpenEvent={(ref) => openRun(ref?.runId)}
                          presentation={presentation}
                        />
                      </section>
                    )}
                    {view === "inbox" && (
                      <section className="panel view-panel">
                        {/* Left global on purpose: the inbox is the one
                          cross-workspace view, and the rail badge counts
                          every workspace. */}
                        <DecisionInbox
                          onOpenRun={openRun}
                          onOpenTask={openTask}
                          presentation={presentation}
                        />
                      </section>
                    )}
                    {view === "sessions" && (
                      <section className="panel view-panel">
                        <LiveSessions
                          sessions={liveSessions}
                          onOpenRun={openRun}
                          onSwitchWorkspace={(id) => {
                            setWorkspaceId(id);
                            setView("office");
                          }}
                          presentation={presentation}
                        />
                      </section>
                    )}
                    {view === "connections" && (
                      <>
                        <section className="panel api-card">
                          <div className="integration-banner">
                            <Cable size={24} />
                            <div>
                              <h3>Local task API</h3>
                              <p>
                                Ready to receive tasks from your scripts and the
                                agent-space CLI.
                              </p>
                            </div>
                            <Badge state="IDLE" />
                          </div>
                          <p className="modal-intro">
                            Send a task to this workspace using the local HTTP
                            API. The office updates immediately in every
                            connected tab.
                          </p>
                          <pre>
                            {`curl -X POST ${presentation ? "http://127.0.0.1:<port>" : location.origin}${base}/tasks \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"Review my project","priority":"high"}'`}
                          </pre>
                          <button
                            className="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(
                                  `${location.origin}${base}/tasks`,
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
                        </section>
                        <section className="panel view-panel">
                          <ConnectionsPanel
                            presentation={presentation}
                            workspace={{
                              ...(workspace?.workspace ?? {}),
                              id: workspaceId,
                              tasks,
                            }}
                            agents={agents}
                            onLaunched={(run) => {
                              setToast({ message: "Sandbox task launched" });
                              if (run?.id) openRun(run.id, run.workspaceId);
                            }}
                          />
                        </section>
                      </>
                    )}
                  </div>
                  {!fullView && (
                    <aside className="inspector">
                      <section className="panel inspector-main">
                        <div className="panel-header">
                          <h2>
                            {selectedTask ? "Task details" : "Agent spotlight"}
                          </h2>
                          {spotlightRun && !selectedTask ? (
                            <span className="live-pill">
                              <i className="dot green" />
                              Run
                            </span>
                          ) : (
                            <span className="inspector-dots">•••</span>
                          )}
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
                              <span className="identity-badges">
                                <ProviderBadge
                                  provider={agent.provider}
                                  mode={agent.runMode ?? undefined}
                                  size="small"
                                />
                                <ActivityBadge
                                  activity={agent.activity}
                                  inferred={
                                    agent.activityProvenance === "inferred"
                                  }
                                  status={
                                    agent.activeProviderRun
                                      ? agent.runStatus
                                      : undefined
                                  }
                                />
                              </span>
                              {agent.activeProviderRun &&
                                agent.elapsedMs !== null && (
                                  <span className="identity-elapsed">
                                    <Timer size={12} aria-hidden="true" />{" "}
                                    {formatElapsed(agent.elapsedMs)} elapsed
                                  </span>
                                )}
                              {(agent.model || agent.runtime || (agent.skills?.length ?? 0) > 0 || agent.lastRun?.actualModel) && (
                                <div className="agent-passport" aria-label="Agent capability details">
                                  {(agent.model || agent.runtime) && <div className="passport-models">
                                    {agent.model && <span><small>Preferred</small>{agent.model}</span>}
                                    {agent.lastRun?.actualModel && <span><small>Last reported</small>{agent.lastRun.actualModel}</span>}
                                    {agent.runtime && <span><small>Runtime</small>{agent.runtime}</span>}
                                  </div>}
                                  {(agent.skills?.length ?? 0) > 0 && <div className="passport-skills" aria-label="Agent skills">
                                    {agent.skills.slice(0, 5).map((skill) => <span key={skill}>{skill}</span>)}
                                    {agent.skills.length > 5 && <span>+{agent.skills.length - 5}</span>}
                                  </div>}
                                </div>
                              )}
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
                        {spotlightRun && !selectedTask ? (
                          <div className="spotlight-run">
                            <RunInspector
                              key={spotlightRun}
                              runId={spotlightRun}
                              workspaceId={workspaceId}
                              capabilities={capabilityMap}
                              presentation={presentation}
                              initialTab="activity"
                              onAction={(name) =>
                                setToast({ message: `Run ${name} requested` })
                              }
                            />
                          </div>
                        ) : (
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
                                presentation={presentation}
                                onOpenRun={openRun}
                              />
                            ) : (
                              <div className="idle-details">
                                <span className="coffee-icon">
                                  <Coffee size={27} />
                                </span>
                                <h3>Ready for what’s next.</h3>
                                <p>
                                  {agent?.name ?? "Your agent"} is available.
                                  Choose a queued task or create something new.
                                </p>
                                <button
                                  className="button wide"
                                  onClick={() => setView("tasks")}
                                >
                                  Browse task queue
                                  <ArrowRight size={15} />
                                </button>
                                {agent?.lastRun &&
                                  agent.lastRun.endedAt &&
                                  Date.now() -
                                    new Date(agent.lastRun.endedAt).getTime() <
                                    30 * 60 * 1000 && (
                                    <div className="last-run">
                                      <h4>Last run</h4>
                                      <RunPassport
                                        run={agent.lastRun}
                                        presentation={presentation}
                                        onOpenRun={openRun}
                                      />
                                    </div>
                                  )}
                              </div>
                            )}
                          </fieldset>
                        )}
                        {!selectedTask && (
                          <div className="agent-footnote">
                            <span>
                              <i className="dot blue" />
                              {agent?.autoCreated
                                ? "Auto-created agent"
                                : "Workspace agent"}
                            </span>
                            <span>{agent?.completed ?? 0} completed</span>
                          </div>
                        )}
                      </section>
                      <section className="panel pinned-panel">
                        <PinnedRuns
                          runs={runs}
                          onOpenRun={(runId, targetWorkspaceId) =>
                            openRun(runId, targetWorkspaceId)
                          }
                        />
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
                          {events.slice(0, 3).map((event) => (
                            <ActivityRow
                              key={event.id}
                              event={event}
                              size={14}
                            />
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
                              office uses simulated agents. Your manually
                              created tasks are controlled by you.
                            </>
                          ) : (
                            <>
                              <strong>Your project workspace</strong>Provider
                              runs and observed sessions land here with their
                              provenance. Tasks and profiles are saved locally
                              and never mixed with the demo.
                            </>
                          )}
                        </p>
                      </div>
                    </aside>
                  )}
                </div>
              </>
            )}
            <footer>
              <span>
                <i className={`dot ${connected ? "green" : "amber"}`} />
                {connected ? "Workspace connected" : "Connection interrupted"}
                <span className="footer-separator">/</span>Saved locally in
                SQLite
              </span>
              <span>
                Built for minds that work together.
                <Box size={13} />
              </span>
            </footer>
          </main>
        </div>
        <CommandPalette
          open={palette}
          onOpen={() => setPalette(true)}
          onClose={() => setPalette(false)}
          commands={commands}
          extraCommands={buildStandardCommands({
            workspaces,
            onOpenSearch: () => setSearchOpen(true),
            onSelectWorkspace: setWorkspaceId,
            currentWorkspaceId: workspaceId,
          })}
        />
        <GlobalSearch
          open={searchOpen}
          onOpen={() => setSearchOpen(true)}
          onClose={() => setSearchOpen(false)}
          workspaceId={workspaceId}
          presentation={presentation}
          onOpenResult={(result) => {
            setSearchOpen(false);
            if (!result) return;
            if (result.workspaceId && result.workspaceId !== workspaceId)
              setWorkspaceId(result.workspaceId);
            if (result.runId) openRun(result.runId, result.workspaceId);
            else if (result.taskId) openTask(result.taskId, result.workspaceId);
            else if (result.kind === "task")
              openTask(result.id, result.workspaceId);
            else if (result.kind === "run")
              openRun(result.id, result.workspaceId);
            else setView("activity");
          }}
        />
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
        {modal === "task" && workspace && (
          <TaskLauncher
            simple
            workspace={{
              ...(workspace.workspace ?? {}),
              id: workspaceId,
              tasks,
            }}
            agents={agents}
            connections={connections}
            capabilities={capabilityMap}
            tasks={tasks}
            onClose={() => setModal(null)}
            onCreated={(created) => {
              setSelectedTask(created.id);
              setView("tasks");
              setToast({ message: "Task created" });
            }}
            onLaunched={(run) => {
              setToast({ message: "Run started" });
              if (run?.agentId) {
                setSelectedAgent(run.agentId);
                setSelectedTask(null);
                setView("office");
              }
            }}
          />
        )}
        {modal === "policy" && (
          <Dialog title="Workspace policy" onClose={() => setModal(null)} wide>
            <PolicyEditor
              workspaceId={workspaceId}
              onSaved={() => setToast({ message: "Policy saved" })}
            />
          </Dialog>
        )}
        {modal === "settings" && (
          <Modal title="Workspace settings" onClose={() => setModal(null)}>
            <div className="settings-row">
              <div>
                <h3>{workspace?.workspace?.name ?? "Workspace"}</h3>
                <p>
                  {isDemo
                    ? "The demo workspace keeps simulated sample work."
                    : maskPath(workspace?.workspace?.rootPath, presentation) ||
                      "No project folder set."}
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
            {!isDemo && (
              <div className="settings-row">
                <div>
                  <h3>Execution policy</h3>
                  <p>
                    {workspace?.workspace?.policy?.autonomy
                      ? `Preset: ${workspace.workspace.policy.autonomy}`
                      : "Autonomy preset, allowed folders, denied commands."}
                  </p>
                </div>
                <button className="button" onClick={() => setModal("policy")}>
                  <Shield size={14} />
                  Edit policy
                </button>
              </div>
            )}
            <SettingSwitch
              title="Dark appearance"
              text="A quieter view for late sessions."
              label="Dark appearance"
              checked={dark}
              onChange={setDark}
            />
            <div className="settings-row">
              <div>
                <h3>Office theme</h3>
                <p>Five palettes for focused work, from daylight to midnight.</p>
              </div>
              <select
                aria-label="Office theme"
                value={officeTheme}
                onChange={(e) => setOfficeTheme(e.target.value)}
              >
                {OFFICE_THEMES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </div>
            <div className="settings-row visual-preset-row">
              <div>
                <h3>Portable visual preset</h3>
                <p>Move this office’s appearance between workspaces. A preview lists every change before anything is saved.</p>
              </div>
              <span className="settings-buttons visual-preset-actions">
                <button className="button" type="button" onClick={exportVisualPreset}>
                  <Download size={14} /> Export preset
                </button>
                <label className="button visual-preset-import">
                  <Upload size={14} /> Import preset
                  <input aria-label="Import visual preset" type="file" accept="application/json,.json" onChange={previewVisualPreset} />
                </label>
              </span>
            </div>
            {visualPresetError ? <p className="visual-preset-error" role="alert">{visualPresetError}</p> : null}
            {visualPresetPreview ? (
              <section className="visual-preset-preview" aria-label="Visual preset preview" role="status">
                <div>
                  <span className="visual-preset-icon"><Eye size={16} /></span>
                  <p><strong>{visualPresetPreview.preset.name}</strong><br />Review these workspace-only appearance changes.</p>
                </div>
                <ul>
                  {visualPresetPreview.changes.length ? visualPresetPreview.changes.map((change) => (
                    <li key={change.key}><b>{{ theme: "Theme", "ui.graphics": "Graphics", "ui.office.labelDensity": "Label density", "ui.office.avatarDetail": "Avatar detail", "ui.office.lighting": "Lighting", "ui.office.ambientSound": "Ambient room tone" }[change.key] ?? change.key}</b><span>{String(change.from ?? "default")} → {String(change.to)}</span></li>
                  )) : <li>No visual changes are needed.</li>}
                </ul>
                <span className="settings-buttons">
                  <button className="text-button" type="button" onClick={() => setVisualPresetPreview(null)}>Discard</button>
                  <button className="button primary" type="button" disabled={visualPresetBusy} onClick={applyVisualPreset}>Apply preset</button>
                </span>
              </section>
            ) : null}
            <div className="settings-row">
              <div>
                <h3>Graphics</h3>
                <p>
                  Low disables shadows and particles; high uses full detail.
                </p>
              </div>
              <select
                aria-label="Graphics preset"
                value={officeSetting("graphics")}
                onChange={(e) => saveVisualSetting(OFFICE_SETTINGS.graphics.key, e.target.value)}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <SettingSwitch
              title="Reduced motion"
              text="No walking tweens, bobbing or particles in the office."
              label="Reduced motion"
              checked={Boolean(prefs.reducedMotion)}
              onChange={(v) => updatePref("reducedMotion", v)}
            />
            <SettingSwitch
              title="Focus mode"
              text="Hides decorative motion and pins the active run in the spotlight."
              label="Focus mode"
              checked={Boolean(prefs.focusMode)}
              onChange={(v) => updatePref("focusMode", v)}
            />
            <SettingSwitch
              title="Presentation mode"
              text="Masks private folder paths and account labels on screen."
              label="Presentation mode"
              checked={Boolean(prefs.presentation)}
              onChange={(v) => updatePref("presentation", v)}
            />
            <SettingSwitch
              title="Large labels in presentation mode"
              text="Bigger name plates in the office while you are presenting."
              label="Large labels in presentation mode"
              checked={Boolean(officeSetting("largeLabels"))}
              disabled={!presentation}
              onChange={(v) =>
                saveSetting(OFFICE_SETTINGS.largeLabels.key, Boolean(v))
              }
            />
            <div className="settings-row">
              <div>
                <h3>Label density</h3>
                <p>How many name plates the office draws at once.</p>
              </div>
              <select
                aria-label="Label density"
                value={officeSetting("labelDensity")}
                onChange={(e) =>
                  saveVisualSetting(OFFICE_SETTINGS.labelDensity.key, e.target.value)
                }
              >
                <option value="auto">Follow graphics preset</option>
                <option value="all">Every agent</option>
                <option value="active">Working agents only</option>
                <option value="none">None</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <h3>Avatar detail</h3>
                <p>Low drops accessories and hair; high draws every part.</p>
              </div>
              <select
                aria-label="Avatar detail"
                value={officeSetting("avatarDetail")}
                onChange={(e) =>
                  saveVisualSetting(OFFICE_SETTINGS.avatarDetail.key, e.target.value)
                }
              >
                <option value="auto">Follow graphics preset</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <h3>Lighting</h3>
                <p>Day, evening or a focused pool of light on the desks.</p>
              </div>
              <select
                aria-label="Office lighting"
                value={officeSetting("lighting")}
                onChange={(e) =>
                  saveVisualSetting(OFFICE_SETTINGS.lighting.key, e.target.value)
                }
              >
                <option value="day">Day</option>
                <option value="evening">Evening</option>
                <option value="focus">Focus</option>
              </select>
            </div>
            <SettingSwitch
              title="Ambient room tone"
              text="A very quiet synthesized room tone in the office. Off by default, and never played with reduced motion on."
              label="Ambient room tone"
              checked={Boolean(officeSetting("ambientSound"))}
              onChange={(v) =>
                saveVisualSetting(OFFICE_SETTINGS.ambientSound.key, Boolean(v))
              }
            />
            <SettingSwitch
              title="Share personal memory with runs"
              text="Lets a run's context include your user-scope notes. Workspace and run notes are always included."
              label="Share personal memory with runs"
              checked={serverSettings["memory.shareUserScope"] !== false}
              onChange={(v) => saveSetting("memory.shareUserScope", Boolean(v))}
            />
            <SettingSwitch
              title="Let MCP clients decide approvals"
              text="Off by default. When on, an MCP client may approve or deny a pending approval; every decision is recorded with the actor “mcp”."
              label="Let MCP clients decide approvals"
              checked={serverSettings["mcp.allowDecisions"] === true}
              onChange={(v) => saveSetting("mcp.allowDecisions", Boolean(v))}
            />
            <div className="settings-row">
              <div>
                <h3>Operations and retention</h3>
                <p>
                  Health, queues, backups and how long events and artifacts are
                  kept.
                </p>
              </div>
              <span className="settings-buttons">
                <button
                  className="button"
                  onClick={() => {
                    setModal(null);
                    setView("ops");
                  }}
                >
                  <HeartPulse size={14} />
                  Open operations
                </button>
              </span>
            </div>
            <div className="settings-row">
              <div>
                <h3>Setup</h3>
                <p>
                  The first-run checklist: demo, connections, a sample workspace
                  and a starter workflow.
                </p>
              </div>
              <SetupEntry
                onOpen={() => {
                  setModal(null);
                  setSetupOpen(true);
                }}
              />
            </div>
            <SettingSwitch
              title="Remember views"
              text="Reopen the last view, filter and workspace next time."
              label="Remember views"
              checked={Boolean(prefs.rememberViews)}
              onChange={(v) => {
                updatePref("rememberViews", v);
                if (!v) {
                  try {
                    localStorage.removeItem(UI_KEY);
                  } catch {}
                }
              }}
            />
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
            <div className="settings-row">
              <div>
                <h3>Keyboard shortcuts</h3>
                <p>Ctrl / ⌘ + K opens the command palette.</p>
              </div>
              <button className="button" onClick={() => setModal("help")}>
                <Keyboard size={14} />
                Show all
              </button>
            </div>
            <p className="form-note">
              Workspaces, agents, tasks, and runs are saved in a local SQLite
              database and survive server restarts.
            </p>
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
                <strong>Give the team a task.</strong> Create a task and choose
                an available agent, or run it now through a connected provider.
              </p>
              <p>
                <strong>Decide from the inbox.</strong> Approvals, failed runs
                and reviews wait there. Policies are enforced by the server.
              </p>
              <p>
                <strong>Trust the labels.</strong> Activity derived from tool
                names is marked inferred; models and costs are shown only when
                the provider reported them.
              </p>
            </div>
            <h3 className="help-subtitle">
              <Keyboard size={15} /> Keyboard shortcuts
            </h3>
            <dl className="shortcut-list">
              {SHORTCUTS.map(([keys, text]) => (
                <React.Fragment key={keys}>
                  <dt>
                    <kbd>{keys}</kbd>
                  </dt>
                  <dd>{text}</dd>
                </React.Fragment>
              ))}
            </dl>
            <button
              className="button primary wide"
              onClick={() => setModal(null)}
            >
              Let’s get to work
              <ArrowRight size={16} />
            </button>
          </Modal>
        )}
        {runModal && (
          <Dialog title="Run inspector" onClose={() => setRunModal(null)} wide>
            <RunInspector
              key={runModal.runId}
              runId={runModal.runId}
              workspaceId={workspaceId}
              capabilities={capabilityMap}
              presentation={presentation}
              onAction={(name) =>
                setToast({ message: `Run ${name} requested` })
              }
            />
          </Dialog>
        )}
        {tokenPrompt && (
          <Modal title="Access token" onClose={() => setTokenPrompt(false)}>
            <p className="modal-intro">
              This server runs in shared mode (AGENT_SPACE_TOKEN). Paste the
              token to connect; it is kept in this browser only.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget)
                  .get("token")
                  ?.toString()
                  .trim();
                saveToken(value || null);
                setTokenPrompt(false);
                location.reload();
              }}
            >
              <label>
                Token
                <input
                  name="token"
                  type="password"
                  data-autofocus
                  autoComplete="off"
                  defaultValue={readToken() ?? ""}
                  placeholder="Paste the AGENT_SPACE_TOKEN value"
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => setTokenPrompt(false)}
                >
                  Cancel
                </button>
                <button className="button primary">
                  <KeyRound size={15} />
                  Connect
                </button>
              </div>
            </form>
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
    </SelectionProvider>
  );
}

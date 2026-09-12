import OfficeControl, { OFFICE_THEMES } from "./components/OfficeControl.jsx";
import { agentMatchesFilters, buildEventsFrom } from "./hooks/viewLogic.js";
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
  Building2,
  CalendarClock,
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
  Workflow,
  ChartBar,
  Inbox,
  Antenna,
  Command,
  Keyboard,
  Shield,
  Sparkles,
  ExternalLink,
  MessageSquare,
  KeyRound,
  Timer,
  TriangleAlert,
  HeartPulse,
  BookOpen,
  Film,
  Download,
  Upload,
  Eye,
  Menu,
} from "lucide-react";
import {
  api,
  useWorkspace,
  DEFAULT_WORKSPACE,
  saveToken,
  readToken,
} from "./useWorkspace.js";
// Direct imports on purpose: a barrel re-exports every panel, which pulls the
// lazily loaded views back into the main bundle and defeats code splitting.
// Stylesheets are imported once, in cascade order, by main.jsx.
import RunInspector from "./components/RunInspector.jsx";
import CommandPalette, {
  buildStandardCommands,
} from "./components/CommandPalette.jsx";
import TaskLauncher from "./components/TaskLauncher.jsx";
import TemplateGallery, { TeamDialog } from "./components/TemplateGallery.jsx";
import PolicyEditor from "./components/PolicyEditor.jsx";
import ProviderBadge from "./components/ProviderBadge.jsx";
import ProviderPulse from "./components/ProviderPulse.jsx";
import AgentPortrait from "./components/AgentPortrait.jsx";
import OfficeRoster from "./components/OfficeRoster.jsx";
import AgentDirectory from "./components/AgentDirectory.jsx";
import { runningProviderSet } from "./hooks/providerStatus.js";
import { attentionElsewhere } from "./hooks/workspaceSummary.js";
import { workflowRelays, relayPresence } from "./office/relay.js";
import Provenance from "./components/Provenance.jsx";
import ActivityBadge from "./components/ActivityBadge.jsx";
import ActivityFeed from "./components/ActivityFeed.jsx";
import Dialog from "./components/Dialog.jsx";
import SelectionProvider, {
  FilterChips,
} from "./components/SelectionProvider.jsx";
import EmptyState from "./components/EmptyState.jsx";
import VirtualList from "./components/VirtualList.jsx";
import WorkspaceSwitcher from "./components/WorkspaceSwitcher.jsx";
import GlobalSearch from "./components/GlobalSearch.jsx";
import DragAssign from "./components/DragAssign.jsx";
import PinnedRuns, { PinToggle } from "./components/PinnedRuns.jsx";
import Onboarding, {
  SetupEntry,
  ONBOARDING_KEY,
} from "./components/Onboarding.jsx";
import { useGlobal } from "./hooks/useGlobal.js";
import { useApi, apiFetch, useTicker } from "./hooks/useApi.js";
import { useLocalStorage } from "./hooks/useLocalStorage.js";
import BoardView from "./views/BoardView.jsx";
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

/**
 * Route-level code splitting. These panels are only shown on their own view,
 * so they load on first visit instead of shipping in the main bundle. The
 * wrapper supplies the Suspense boundary, which keeps every render site
 * unchanged; the fallback is a short status line, never a fake skeleton of data.
 */
function deferred(loader, label) {
  const Lazy = lazy(loader);
  function Deferred(props) {
    return (
      <Suspense
        fallback={
          <div className="panel-loading" role="status" aria-live="polite">
            Loading {label}…
          </div>
        }
      >
        <Lazy {...props} />
      </Suspense>
    );
  }
  Deferred.displayName = `Deferred(${label})`;
  return Deferred;
}
const DecisionInbox = deferred(
  () => import("./components/DecisionInbox.jsx"),
  "the inbox",
);
const ConnectionsPanel = deferred(
  () => import("./components/ConnectionsPanel.jsx"),
  "connections",
);
const LiveSessions = deferred(
  () => import("./components/LiveSessions.jsx"),
  "live sessions",
);
const DayInReview = deferred(
  () => import("./components/DayInReview.jsx"),
  "the day in review",
);
const OpsPanel = deferred(
  () => import("./components/OpsPanel.jsx"),
  "operations",
);
const KnowledgeView = deferred(
  () => import("./components/KnowledgeView.jsx"),
  "knowledge",
);
const TimelineView = deferred(
  () => import("./views/TimelineView.jsx"),
  "the timeline",
);
const DependencyMap = deferred(
  () => import("./views/DependencyMap.jsx"),
  "the dependency map",
);
const AnalyticsView = deferred(
  () => import("./views/AnalyticsView.jsx"),
  "analytics",
);
const WorkflowEditor = deferred(
  () => import("./views/WorkflowEditor.jsx"),
  "the workflow editor",
);
const CampusView = deferred(() => import("./views/CampusView.jsx"), "campus");
const SchedulesView = deferred(
  () => import("./views/SchedulesView.jsx"),
  "schedules",
);

const workingStates = [
  ["CODING", "Coding"],
  ["ANALYZING", "Planning"],
  ["TESTING", "Testing"],
  ["DEBUGGING", "Debugging"],
  ["RESEARCHING", "Researching"],
  ["REVIEWING", "Reviewing"],
];
const stateLabels = {
  CODING: "Coding",
  ANALYZING: "Planning",
  TESTING: "Testing",
  DEBUGGING: "Debugging",
  RESEARCHING: "Researching",
  BLOCKED: "Blocked",
  IDLE: "Idle",
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
  graphics: "auto",
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
  graphics: { key: "ui.graphics", fallback: "auto" },
  labelDensity: { key: "ui.office.labelDensity", fallback: "auto" },
  avatarDetail: { key: "ui.office.avatarDetail", fallback: "auto" },
  ambientSound: { key: "ui.office.ambientSound", fallback: false },
  lighting: { key: "ui.office.lighting", fallback: "day" },
  largeLabels: { key: "ui.presentationLargeLabels", fallback: true },
};

/**
 * Destinations. The label is the page title and the accessible name of its
 * navigation button (the e2e suite drives them by name). `description` is one
 * factual line under the title. `full` views take the whole width; the others
 * open a detail pane beside the content only when something is selected.
 * `primary` destinations stay in the phone bottom bar; the rest move into
 * "More". `parent` marks a mode of another page: it has no entry of its own.
 */
const VIEWS = [
  {
    id: "office",
    group: "Operate",
    label: "Workspace",
    icon: LayoutDashboard,
    key: "w",
    primary: true,
    description:
      "Agents with recorded work in this workspace, placed by what they are doing.",
  },
  {
    id: "tasks",
    group: "Operate",
    label: "Task board",
    icon: ListTodo,
    key: "t",
    primary: true,
    description: "Every task in this workspace, from queued to completed.",
  },
  {
    id: "board",
    parent: "tasks",
    label: "Task board",
    icon: Columns3,
    key: "b",
    description: "Every task in this workspace, from queued to completed.",
  },
  {
    id: "inbox",
    group: "Operate",
    label: "Inbox",
    icon: Inbox,
    key: "i",
    full: true,
    primary: true,
    description:
      "Approvals, questions, failed runs and reviews from every workspace.",
  },
  {
    id: "agents",
    group: "Operate",
    label: "Agents",
    icon: Users,
    key: "y",
    primary: true,
    description:
      "Your team as it looks in the office: who needs you, who is working, and who is ready for work.",
  },
  {
    id: "sessions",
    group: "Observe",
    label: "Live sessions",
    icon: Antenna,
    key: "l",
    full: true,
    description:
      "Provider sessions observed on this machine, read from each vendor's own session files.",
  },
  {
    id: "activity",
    group: "Observe",
    label: "Activity",
    icon: Activity,
    key: "v",
    full: true,
    description:
      "Recorded events for this workspace, newest first, each with its provenance.",
  },
  {
    id: "timeline",
    group: "Observe",
    label: "Timeline",
    icon: Clock3,
    key: "m",
    full: true,
    description: "Runs as bars over time. Replay uses recorded events only.",
  },
  {
    id: "review",
    group: "Observe",
    label: "Day in review",
    icon: Film,
    key: "r",
    full: true,
    description:
      "Milestones assembled from recorded events for a date range, each cited to its source.",
  },
  {
    id: "analytics",
    group: "Observe",
    label: "Analytics",
    icon: ChartBar,
    key: "a",
    full: true,
    description:
      "Counts and durations, each labelled counted, reported, measured or estimated.",
  },
  {
    id: "workflow",
    group: "Plan",
    label: "Workflow editor",
    icon: Workflow,
    key: "g",
    full: true,
    description:
      "Edit workflow steps and links. Every save is a new, reviewable version.",
  },
  {
    id: "deps",
    group: "Plan",
    label: "Dependencies",
    icon: GitBranch,
    key: "d",
    description: "Which tasks wait on which, and what is ready to start.",
  },
  {
    id: "schedules",
    group: "Plan",
    label: "Schedules",
    icon: CalendarClock,
    full: true,
    description:
      "Tasks and workflows that start at set times. Nothing starts on a timer until scheduling is on and the schedule is enabled.",
  },
  {
    id: "campus",
    group: "Plan",
    label: "Campus",
    icon: Building2,
    full: true,
    description:
      "Every workspace as a building. Enter one to change scope; nothing is mixed.",
  },
  {
    id: "connections",
    group: "System",
    label: "Connections",
    icon: Cable,
    key: "c",
    full: true,
    description:
      "Assistants installed on this machine, what Agent Space can observe or run, and the local API.",
  },
  {
    id: "ops",
    group: "System",
    label: "Operations",
    icon: HeartPulse,
    key: "o",
    full: true,
    description:
      "Health, queue, backups, retention and the stop-all switch. Stopping never undoes side effects.",
  },
  {
    id: "knowledge",
    group: "System",
    label: "Knowledge",
    icon: BookOpen,
    key: "k",
    full: true,
    description:
      "Collections, memory and handover notes, each keeping the source it came from.",
  },
];
/** Rail order: four task-based groups. Modes (`parent`) have no entry. */
const RAIL_GROUP_ORDER = ["Operate", "Observe", "Plan", "System"];
export const RAIL_GROUPS = RAIL_GROUP_ORDER.map((name) => [
  name,
  VIEWS.filter((v) => v.group === name && !v.parent),
]).filter(([, items]) => items.length);
/** The navigation entry a view belongs to (Board highlights Task board). */
const navIdFor = (viewId) =>
  VIEWS.find((v) => v.id === viewId)?.parent ?? viewId;

const VIEW_IDS = new Set(VIEWS.map((v) => v.id));
/** Views that open Task details beside their content when a task is chosen. */
const TASK_DETAIL_VIEWS = new Set(["tasks", "board", "deps"]);
/** Views that read the shared Office/Board/Timeline/Dependency filters. */
const SHARED_FILTER_VIEWS = new Set([
  "office",
  "tasks",
  "board",
  "timeline",
  "deps",
]);

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
function hasSavedWorkspace() {
  try {
    return Boolean(localStorage.getItem("agent-space-workspace"));
  } catch {
    return false;
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
  // Most recent provider-backed run for this agent (shown when idle).
  const lastRun =
    runs
      .filter((r) => r.agentId === agent.id && PROVIDER_MODES.has(r.mode))
      .sort(
        (a, b) => new Date(b.startedAt ?? 0) - new Date(a.startedAt ?? 0),
      )[0] ?? null;
  const runMode =
    agent.runMode ??
    run?.mode ??
    lastRun?.mode ??
    (run ? (run.provider === "simulated" ? "simulated" : "manual") : null);
  // The last run is part of this chain because the spotlight renders its
  // passport directly beneath this badge. Without it an agent whose run had
  // finished said "no preferred assistant" immediately above a passport
  // reading "Claude Code managed" — two statements from the same records
  // that looked like a contradiction.
  const provider =
    agent.provider ??
    agent.runProvider ??
    run?.provider ??
    lastRun?.provider ??
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
  else if (recordedActivity) activity = recordedActivity;
  // A manual task: nothing reports its activity, and the state the server
  // sends is the profile's working style. Only "in progress" is recorded.
  else if (task && task.source !== "demo" && runMode !== "simulated")
    activity = "MANUAL";
  else activity = agent.state;
  const manualWork = activity === "MANUAL";
  const activityProvenance = manualWork
    ? "user"
    : (agent.activityProvenance ??
      (providerRun && recordedActivity ? "inferred" : null));
  const runStatus = agent.runStatus ?? run?.status ?? null;
  const startedAt = run?.startedAt ?? null;
  const elapsedMs =
    agent.elapsedMs ??
    (startedAt
      ? (run?.endedAt ? new Date(run.endedAt).getTime() : Date.now()) -
        new Date(startedAt).getTime()
      : null);
  return {
    ...agent,
    provider,
    activity,
    activityProvenance,
    manualWork,
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
 * Handoffs the office can draw. A `handoff` event is one step of a team
 * relay passing its result to the next step's agent: both agents are named,
 * so the office plays the moment (office/episodes.js). A `delegation` event
 * records that an agent handed work to a subagent; the receiver is not an
 * agent profile we track, so `toAgentId` stays null and the card says "a
 * subagent" instead of naming someone. The card itself shows only the last
 * half hour (handoffCard).
 */
function handoffsFrom(events = [], tasks = []) {
  const titleOf = (id) => tasks.find((task) => task.id === id)?.title ?? null;
  const list = [];
  for (const event of events) {
    if (list.length >= 20) break;
    if (event.kind === "handoff" && event.handoff) {
      const handoff = event.handoff;
      const nextTitle = titleOf(handoff.toTaskId);
      let detail = "Not started automatically";
      if (handoff.dispatched) detail = nextTitle ? `Next: ${nextTitle}` : null;
      list.push({
        id: event.id,
        kind: "handoff",
        fromAgentId: handoff.fromAgentId ?? event.agentId ?? null,
        toAgentId: handoff.toAgentId ?? event.toAgentId ?? null,
        toLabel: handoff.toAgentId ? null : "the next step",
        taskTitle: titleOf(handoff.fromTaskId) ?? event.message ?? null,
        // What the office writes on the passed document.
        artifact: handoff.withheld
          ? "Result withheld: it read like instructions"
          : (handoff.artifacts?.[0]?.title ?? null),
        detail,
        simulated: handoff.simulated === true,
        timestamp: event.timestamp,
      });
    } else if (event.kind === "delegation") {
      list.push({
        id: event.id,
        kind: "delegation",
        fromAgentId: event.agentId ?? null,
        toAgentId: null,
        toLabel: "a subagent",
        taskTitle: event.message ?? null,
        timestamp: event.timestamp,
      });
    }
  }
  return list.length ? list : undefined;
}

/** The toast after a team deploy: who is on it, and whether it started. */
function teamDeployedMessage(workflow, result) {
  const started = (result?.started ?? []).some((item) => !item.error);
  const members = (result?.team ?? []).filter(
    (member) => member.agentId,
  ).length;
  if (!members)
    return `Workflow “${workflow?.name ?? workflow?.templateId ?? "template"}” created`;
  return `Team of ${members} deployed for “${workflow?.name ?? "the workflow"}”${started ? ": the first step has started" : ""}`;
}

/**
 * Recorded team deployments ("team" events): who was put on the team, for
 * the kickoff huddle the office plays when one is new.
 */
function kickoffsFrom(events = []) {
  const list = events
    .filter((event) => event.kind === "team" && event.team?.members?.length)
    .slice(0, 5)
    .map((event) => ({
      id: event.id,
      members: event.team.members.map((member) => member.agentId),
      label: event.message ?? null,
      simulated: event.team.simulated === true,
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
      toAgentId: event.toAgentId ?? null,
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

/** Count shown on a navigation entry: decisions waiting, live sessions. */
function RailBadge({ id, needsDecision, liveCount }) {
  if (id === "inbox" && needsDecision > 0)
    return (
      <span
        className="rail-badge"
        aria-label={`${needsDecision} decisions waiting`}
        data-testid="inbox-badge"
      >
        {needsDecision > 99 ? "99+" : needsDecision}
      </span>
    );
  if (id === "sessions" && liveCount > 0)
    return (
      <span className="rail-badge live" aria-hidden="true">
        {liveCount}
      </span>
    );
  return null;
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
    data.skills = data.skills
      .split(",")
      .map((skill) => skill.trim())
      .filter(Boolean);
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
  try {
    avatar = agent?.avatar ? JSON.parse(agent.avatar) : {};
  } catch {
    avatar = {};
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
        <fieldset className="agent-runtime-fields">
          <legend>Assistant identity</legend>
          <p>
            Choose the preferred runtime for new work. A completed run still
            shows the model actually reported by that provider.
          </p>
          <div className="form-columns">
            <label>
              Provider
              <select name="provider" defaultValue={agent?.provider ?? ""}>
                <option value="">Choose later</option>
                <option value="claude-code">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="copilot">GitHub Copilot</option>
                <option value="cursor">Cursor</option>
                <option value="gemini">Gemini CLI</option>
              </select>
            </label>
            <label>
              Requested model <span className="optional">optional</span>
              <input
                name="model"
                maxLength={120}
                defaultValue={agent?.model ?? ""}
                placeholder="Provider default"
              />
            </label>
          </div>
          <label>
            Runtime or connection alias{" "}
            <span className="optional">optional</span>
            <input
              name="runtime"
              maxLength={60}
              defaultValue={agent?.runtime ?? ""}
              placeholder="Local CLI, build host…"
            />
          </label>
        </fieldset>
        <fieldset className="agent-identity-fields">
          <legend>Skills and appearance</legend>
          <label>
            Skills <span className="optional">comma separated</span>
            <input
              name="skills"
              defaultValue={(agent?.skills ?? []).join(", ")}
              placeholder="React, accessibility, Playwright"
            />
          </label>
          <div className="form-columns">
            <label>
              Outfit
              <select name="outfit" defaultValue={avatar.outfit ?? "shirt"}>
                <option value="shirt">Shirt</option>
                <option value="hoodie">Hoodie</option>
                <option value="labcoat">Lab coat</option>
                <option value="vest">Vest</option>
                <option value="jacket">Jacket</option>
              </select>
            </label>
            <label>
              Accessory
              <select
                name="accessory"
                defaultValue={avatar.accessory ?? "none"}
              >
                <option value="none">Based on role</option>
                <option value="hardhat">Hard hat</option>
                <option value="glasses">Glasses</option>
                <option value="headset">Headset</option>
                <option value="clipboard">Clipboard</option>
              </select>
            </label>
          </div>
          <div className="form-columns">
            <label>
              Pronouns <span className="optional">optional</span>
              <input
                name="pronouns"
                maxLength={30}
                defaultValue={avatar.pronouns ?? ""}
                placeholder="they/them"
              />
            </label>
            <label>
              Hair color
              <input
                name="hairColor"
                type="color"
                className="color-field"
                defaultValue={avatar.hairColor ?? "#493d38"}
              />
            </label>
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
        <span>Branch</span>
        <strong className="as-mono">
          {run.branch ? (
            <>
              {run.branch}
              {run.worktree ? (
                // The distinction that matters: work in a worktree of its own
                // cannot collide with the working tree you are sitting in.
                <span className="as-tag"> isolated worktree</span>
              ) : (
                <span className="as-tag"> your working tree</span>
              )}
            </>
          ) : (
            // No branch recorded is not the same as "main".
            "no branch recorded"
          )}
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
        {/* Talking to the agent is the thing people come to its desk for, so
            it is offered here rather than left to be found behind a tab. It
            opens the one conversation view; there is no second one. */}
        <button
          className="button wide"
          onClick={() => onOpenRun?.(run.id, run.workspaceId, "conversation")}
        >
          <MessageSquare size={14} aria-hidden="true" />
          Read and reply
        </button>
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
  const railNavRef = useRef(null);
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
  const [settingsTab, setSettingsTab] = useState("workspace");
  const capabilities = useApi("/connections/capabilities", {
    deps: [revision],
  });
  const observationStatus = useApi("/observation/status", {
    interval: 5000,
  });
  useEffect(() => {
    if (!window.matchMedia("(max-width: 680px)").matches) return;
    railNavRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [view]);
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
  // The office this workspace arranged for itself: rooms moved or renamed and
  // furniture placed (core/visual/OfficeLayout.js).
  const officeArrangement =
    workspace?.workspace?.settings?.officeLayout ?? null;
  // Visual settings are saved as one whole preset. A change made before the
  // workspace snapshot has caught up with the previous one is kept here, and
  // saves go out in order, so a second quick change never re-sends a stale
  // first value (observed: choosing a label density and then a lighting
  // preset reset the label density).
  const [pendingVisual, setPendingVisual] = useState({});
  // The arranger is open over the office.
  const [arranging, setArranging] = useState(false);
  const pendingVisualRef = useRef({});
  const visualSnapshotRef = useRef(workspaceVisualSettings);
  visualSnapshotRef.current = workspaceVisualSettings;
  const visualQueue = useRef(Promise.resolve());
  useEffect(() => {
    const settled = Object.entries(pendingVisualRef.current).filter(
      ([key, value]) => workspaceVisualSettings[key] === value,
    );
    if (!settled.length) return;
    const next = { ...pendingVisualRef.current };
    for (const [key] of settled) delete next[key];
    pendingVisualRef.current = next;
    setPendingVisual(next);
  }, [workspaceVisualSettings]);
  const officeSetting = useCallback(
    (name) => {
      const entry = OFFICE_SETTINGS[name];
      const value =
        pendingVisual[entry.key] ??
        workspaceVisualSettings[entry.key] ??
        serverSettings[entry.key];
      return value === undefined || value === null ? entry.fallback : value;
    },
    [serverSettings, workspaceVisualSettings, pendingVisual],
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
  // The system's "reduce motion" setting counts as much as the app's own:
  // the office walked every agent across the floor for someone who had
  // asked their operating system for less motion.
  const [systemReducedMotion, setSystemReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches),
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const change = () => setSystemReducedMotion(query.matches);
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);
  const motionReduced = Boolean(
    prefs.reducedMotion || prefs.focusMode || systemReducedMotion,
  );
  useEffect(() => {
    document.documentElement.classList.toggle("reduced-motion", motionReduced);
    document.documentElement.classList.toggle(
      "presentation-mode",
      Boolean(prefs.presentation),
    );
  }, [motionReduced, prefs.presentation]);
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
    // `tab` opens the inspector on a named section — "conversation" when the
    // caller is asking to talk to the agent rather than watch it work.
    (runId, targetWorkspaceId, tab = null) => {
      if (!runId) return;
      if (targetWorkspaceId && targetWorkspaceId !== workspaceId)
        setWorkspaceId(targetWorkspaceId);
      setRunModal({ runId, tab });
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
  const enterWorkspace = useCallback((targetWorkspaceId) => {
    setWorkspaceId(targetWorkspaceId);
    setView("office");
  }, []);

  const rawAgents = workspace?.agents ?? [],
    tasks = workspace?.tasks ?? [],
    runs = workspace?.runs ?? [],
    workspaces = workspace?.workspaces ?? global.workspaces ?? [],
    isDemo = workspace?.workspace?.kind === "demo",
    events = workspace?.events ?? [];
  // A first visit with no saved choice opens a real workspace instead of the
  // demo. It happens once: after that, choosing the demo keeps the demo.
  const autoPickWorkspace = useRef(null);
  if (autoPickWorkspace.current === null)
    autoPickWorkspace.current = !hasSavedWorkspace();
  useEffect(() => {
    if (!autoPickWorkspace.current || workspaces.length < 2) return;
    autoPickWorkspace.current = false;
    if (workspaceId !== DEFAULT_WORKSPACE) return;
    const realWorkspace = workspaces.find(
      (candidate) =>
        candidate.kind !== "demo" &&
        candidate.id !== DEFAULT_WORKSPACE &&
        !candidate.archivedAt,
    );
    if (realWorkspace) setWorkspaceId(realWorkspace.id);
  }, [workspaceId, workspaces]);
  // Team relays: each unfinished multi-step workflow, its steps and who holds
  // them. A member whose step is queued behind a colleague's live step stands
  // on the floor waiting (relayPresence); a stalled relay puts nobody there.
  const relays = useMemo(
    () => workflowRelays(tasks, rawAgents),
    [tasks, rawAgents],
  );
  const agents = useMemo(() => {
    const waiting = relayPresence(relays);
    return rawAgents.map((a) => {
      const enriched = enrichAgent(a, tasks, runs);
      const relay = enriched.taskId ? null : waiting.get(a.id);
      return relay ? { ...enriched, relay } : enriched;
    });
  }, [rawAgents, tasks, runs, relays]);
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
      handoffs: handoffsFrom(events, tasks),
      kickoffs: kickoffsFrom(events),
      messages: messagesFrom(events, agents),
      teams: teamsFrom(agents),
      avatarStyles: avatarStylesFrom(rawAgents),
    };
  }, [
    agents,
    rawAgents,
    runs,
    tasks,
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

  const inboxCounts = global.inbox?.counts ?? {};
  const needsDecision =
    inboxCounts.total ??
    (inboxCounts.approvals ?? 0) +
      (inboxCounts.runs ?? 0) +
      (inboxCounts.reviews ?? 0) +
      (inboxCounts.questions ?? 0);
  const liveSessions = global.liveSessions ?? [];
  // Only an explicit selection opens the spotlight. An arbitrary default agent
  // made unrelated pages (Activity, Task board) show someone nobody chose.
  const agent = selectedAgent
    ? (agents.find((a) => a.id === selectedAgent) ?? null)
    : null;
  const runningProviders = useMemo(
    () => runningProviderSet(agents, observationStatus.data?.surfaces ?? []),
    [agents, observationStatus.data],
  );
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
  const officeAgents = useMemo(
    () => agents.filter((a) => agentMatchesFilters(a, selectionFilters)),
    [agents, selectionFilters],
  );
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
  // The detail pane appears only for something the user selected: an agent in
  // the office, or a task on the task pages. Otherwise content keeps the width.
  // The Agents page has none: a card opens in place, and the run and the
  // agent at work have their own views (Open run, In the office).
  const showDetail =
    !fullView &&
    ((view === "office" && Boolean(agent)) ||
      (TASK_DETAIL_VIEWS.has(view) && Boolean(selectedTask)));
  // Where the detail pane stacks under a list (narrow screens), bring it into
  // view when something is chosen; otherwise a tap on a row looked like it did
  // nothing. The office is left alone: scrolling away from the scene while
  // someone explores it would be disorienting.
  const detailRef = useRef(null);
  useEffect(() => {
    if (!showDetail || view === "office") return;
    if (!window.matchMedia("(max-width: 1100px)").matches) return;
    detailRef.current?.scrollIntoView({
      block: "start",
      behavior:
        prefs.reducedMotion ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
    });
    // Only a new selection moves the page, not every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgent, selectedTask]);
  const officeTheme =
    workspace?.workspace?.theme ?? prefs.officeTheme?.[workspaceId] ?? "studio";
  const spotlightRun =
    agent?.activeProviderRun && agent.runId ? agent.runId : null;
  const focusAgent = agent ?? agents.find((a) => a.activeProviderRun) ?? null;
  const followAgentId =
    prefs.focusMode && focusAgent?.activeProviderRun ? focusAgent.id : null;
  const presentation = Boolean(prefs.presentation);
  // A stable object: the office restarts its presentation timer whenever this
  // prop changes identity, so a fresh literal reset it on every render.
  const largeLabels = Boolean(officeSetting("largeLabels"));
  const officePresentation = useMemo(
    () => (presentation ? { enabled: true, largeLabels } : null),
    [presentation, largeLabels],
  );
  const capabilityMap = capabilities.data ?? {};
  // First run: nothing but the demo workspace and no provider that is ready to
  // launch. Setup is a panel, never a blocking modal, and "Skip for now"
  // remembers the choice in this browser. Settings keeps a way back in.
  const hasProjectWorkspace = workspaces.some(
    (w) => w.kind !== "demo" && !w.archivedAt,
  );
  // Decisions waiting somewhere other than the workspace on screen.
  const elsewhere = useMemo(
    () => attentionElsewhere(workspaces, workspaceId),
    [workspaces, workspaceId],
  );
  const hasReadyConnection = connections.some((c) => c.status === "ready");
  // Once a person has started the steps, setup stays until they finish or
  // skip it. (It used to vanish mid-flow: creating the sample workspace made
  // "no project workspace" false and hid the remaining steps.)
  const setupStarted =
    (Array.isArray(onboarding?.done) && onboarding.done.length > 0) ||
    Number(onboarding?.step) > 0;
  const showSetup =
    setupOpen ||
    (!onboarding?.dismissed &&
      (setupStarted || (!hasProjectWorkspace && !hasReadyConnection)));

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

  function saveVisualSetting(key, value) {
    pendingVisualRef.current = { ...pendingVisualRef.current, [key]: value };
    setPendingVisual(pendingVisualRef.current);
    const name = `${workspace?.workspace?.name ?? "Workspace"} visual preset`;
    const theme = officeTheme;
    const target = base;
    const send = async () => {
      // Built when this save runs, not when it was queued: the latest
      // snapshot plus every change still waiting for it.
      const preset = {
        kind: "agent-space-visual-preset",
        version: 1,
        name,
        theme,
        settings: { ...visualSnapshotRef.current, ...pendingVisualRef.current },
      };
      try {
        await api(`${target}/visual-preset/apply`, "POST", { preset });
      } catch (error) {
        const next = { ...pendingVisualRef.current };
        delete next[key];
        pendingVisualRef.current = next;
        setPendingVisual(next);
        setToast({
          message: `Visual setting not saved: ${error.message}`,
          error: true,
        });
      }
    };
    visualQueue.current = visualQueue.current.then(send, send);
    return visualQueue.current;
  }

  /**
   * Saves the office a workspace arranged. It travels in the same portable
   * preset as the theme, so exporting the environment carries the layout.
   */
  async function saveOfficeLayout(layout) {
    const preset = {
      kind: "agent-space-visual-preset",
      version: 2,
      name: `${workspace?.workspace?.name ?? "Workspace"} visual preset`,
      theme: officeTheme,
      settings: { ...visualSnapshotRef.current, ...pendingVisualRef.current },
      layout,
    };
    try {
      await api(`${base}/visual-preset/apply`, "POST", { preset });
      setArranging(false);
      setToast({ message: "The office is arranged" });
    } catch (error) {
      setToast({
        message: `Office not saved: ${error.message}`,
        error: true,
      });
    }
  }

  async function exportVisualPreset() {
    try {
      const preset = await api(`${base}/visual-preset`, "GET");
      const blob = new Blob([JSON.stringify(preset, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "office"}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setToast({ message: "Visual preset exported" });
    } catch (error) {
      setToast({
        message: `Preset could not be exported: ${error.message}`,
        error: true,
      });
    }
  }

  async function previewVisualPreset(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setVisualPresetError(null);
    try {
      const parsed = JSON.parse(await file.text());
      const preview = await api(`${base}/visual-preset/preview`, "POST", {
        preset: parsed,
      });
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
      await api(`${base}/visual-preset/apply`, "POST", {
        preset: visualPresetPreview.preset,
      });
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
    const list = VIEWS.filter((v) => !v.parent).map((v) => ({
      id: `view:${v.id}`,
      group: "Go to",
      label: v.label,
      hint: v.id === "inbox" && needsDecision ? `${needsDecision} waiting` : "",
      keywords: `${v.id} view navigate`,
      run: () => setView(v.id),
    }));
    list.push({
      id: "view:board",
      group: "Go to",
      label: "Task board as columns",
      hint: "B",
      keywords: "board kanban columns tasks",
      run: () => setView("board"),
    });
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

  const taskPanel = (
    <section className="panel task-board">
      <div className="board-tools">
        <h2>
          Tasks <span>{tasks.length}</span>
        </h2>
        <div className="segmented" role="group" aria-label="Task layout">
          <button
            type="button"
            aria-pressed={view === "tasks"}
            onClick={() => setView("tasks")}
          >
            <ListTodo size={15} aria-hidden="true" />
            List
          </button>
          <button
            type="button"
            aria-pressed={view === "board"}
            onClick={() => setView("board")}
          >
            <Columns3 size={15} aria-hidden="true" />
            Board
          </button>
        </div>
        <label className="search-box">
          <Search size={15} aria-hidden="true" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks"
            aria-label="Search tasks"
          />
        </label>
        <button
          className="button"
          aria-pressed={showTemplates}
          onClick={() => setShowTemplates((v) => !v)}
        >
          <Sparkles size={14} aria-hidden="true" />
          Use a template
        </button>
      </div>
      {showTemplates && (
        <div className="template-drawer">
          <TemplateGallery
            workspaceId={workspaceId}
            agents={agents}
            connections={connections}
            capabilities={capabilityMap}
            onEnvironment={setOfficeTheme}
            onInstantiated={(workflow, result) => {
              setShowTemplates(false);
              setToast({ message: teamDeployedMessage(workflow, result) });
              // A team at work is what the office is for.
              if ((result?.started ?? []).some((item) => !item.error))
                setView("office");
            }}
          />
        </div>
      )}
      {view === "board" ? (
        <div className="board-wrap">
          <BoardView
            tasks={shownTasks}
            agents={agents}
            runs={runs}
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
          {/* Assignment lists the same tasks again, so it stays folded away
              until someone wants to assign work. */}
          <details className="assign-disclosure">
            <summary>
              <UserPlus size={15} aria-hidden="true" />
              <span>Assign tasks to agents</span>
              <small>
                {
                  tasks.filter(
                    (t) => t.status !== "COMPLETED" && !t.assignedAgentId,
                  ).length
                }{" "}
                unassigned
              </small>
            </summary>
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
          </details>
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
      const providerId = t.provider ?? taskRun?.provider ?? null;
      const ownerName = owner?.name ?? "Unassigned";
      // An agent created from a session is named after its provider; the
      // badge already says so, so the name is not repeated beside it.
      const showOwner = !(
        providerId && ownerName === providerLabel(providerId)
      );
      return (
        <button
          className={`task-row ${selectedTask === t.id ? "selected" : ""}`}
          key={t.id}
          aria-current={selectedTask === t.id ? "true" : undefined}
          onClick={() => setSelectedTask(t.id)}
        >
          <span
            className={`task-check ${t.status === "COMPLETED" ? "done" : ""}`}
            aria-hidden="true"
          >
            {t.status === "COMPLETED" ? <Check size={13} /> : null}
          </span>
          <div>
            <h3>{maskText(t.title, presentation)}</h3>
            <p>
              {showOwner ? (
                <>
                  {ownerName}
                  <span aria-hidden="true">·</span>
                </>
              ) : null}
              {t.source === "demo"
                ? "Demo task"
                : t.source === "observed"
                  ? "Observed session"
                  : t.source === "workflow"
                    ? "Workflow step"
                    : "Manual task"}
              {providerId ? (
                <>
                  <span aria-hidden="true">·</span>
                  <ProviderBadge provider={providerId} size="small" />
                </>
              ) : null}
            </p>
          </div>
          {providerRun ? (
            <span
              className={`status as-run-status as-run-${taskRun.status}`}
              title="Status of the provider run behind this task"
            >
              <i className="dot" aria-hidden="true" />
              {RUN_STATUS_LABELS[taskRun.status] ?? taskRun.status}
            </span>
          ) : (
            <Badge state={t.status} />
          )}
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
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <aside className="rail" aria-label="Sidebar">
          <a className="brand-mark" href="/" title="Agent Space home">
            <Box size={22} strokeWidth={1.8} />
            <span className="brand-mark-text">
              agent<b>space</b>
            </span>
          </a>
          <nav aria-label="Main navigation" ref={railNavRef}>
            {RAIL_GROUPS.map(([groupName, items]) => (
              <div className="rail-group" key={groupName}>
                <h2 className="rail-group-label" aria-hidden="true">
                  {groupName}
                </h2>
                {items.map(({ icon: Icon, id, label, primary }) => (
                  <button
                    key={id}
                    aria-label={label}
                    aria-current={navIdFor(view) === id ? "page" : undefined}
                    className={navIdFor(view) === id ? "active" : ""}
                    data-primary={primary ? "" : undefined}
                    onClick={() => setView(id)}
                  >
                    <Icon size={18} aria-hidden="true" />
                    <span className="rail-text">{label}</span>
                    <RailBadge
                      id={id}
                      needsDecision={needsDecision}
                      liveCount={liveSessions.length}
                    />
                    <span className="rail-tooltip" aria-hidden="true">
                      {label}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            <button
              type="button"
              className={`rail-more ${
                VIEWS.some((v) => !v.primary && navIdFor(view) === v.id)
                  ? "active"
                  : ""
              }`}
              aria-haspopup="dialog"
              aria-label="More destinations"
              onClick={() => setModal("more")}
            >
              <Menu size={18} aria-hidden="true" />
              <span className="rail-text">More</span>
              {liveSessions.length > 0 ? (
                <span className="rail-badge live" aria-hidden="true">
                  {liveSessions.length}
                </span>
              ) : null}
            </button>
          </nav>
          <div className="rail-bottom">
            <button
              aria-label="Workspace settings"
              onClick={() => setModal("settings")}
            >
              <Settings2 size={18} aria-hidden="true" />
              <span className="rail-text">Settings</span>
              <span className="rail-tooltip" aria-hidden="true">
                Settings
              </span>
            </button>
          </div>
        </aside>
        <div className="app-main">
          <header className="topbar">
            <div className="brand-name">
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
              {/* Work needing a decision somewhere other than here. Silent
                  when there is none: "0 elsewhere" is not information. */}
              {elsewhere.count ? (
                <button
                  type="button"
                  className="topbar-elsewhere"
                  title={elsewhere.workspaces
                    .map((w) => `${w.name}: ${w.attention} waiting`)
                    .join(" · ")}
                  aria-label={`${elsewhere.count} other workspace${
                    elsewhere.count === 1 ? "" : "s"
                  } need a decision. Go to ${elsewhere.workspaces[0].name}.`}
                  onClick={() => setWorkspaceId(elsewhere.workspaces[0].id)}
                >
                  <TriangleAlert size={13} aria-hidden="true" />
                  {elsewhere.count === 1
                    ? `${elsewhere.workspaces[0].name} needs you`
                    : `${elsewhere.count} workspaces need you`}
                </button>
              ) : null}
              <ProviderPulse
                connections={connections}
                runningProviders={runningProviders}
                onOpen={() => setView("connections")}
              />
              <span
                className={`connection ${connected ? "" : "offline"}`}
                role="status"
              >
                <i className="dot" aria-hidden="true" />
                <span className="connection-text">
                  {connected ? "Live connection" : "Reconnecting…"}
                </span>
              </span>
              <span className="topbar-tools">
                <button
                  className="icon-button"
                  aria-label="Command palette"
                  title="Command palette (Ctrl+K)"
                  onClick={() => setPalette(true)}
                >
                  <Command size={17} aria-hidden="true" />
                </button>
                <button
                  className="icon-button"
                  aria-label="Help"
                  title="Help and keyboard shortcuts (?)"
                  onClick={() => setModal("help")}
                >
                  <CircleHelp size={18} aria-hidden="true" />
                </button>
                <button
                  className="icon-button"
                  aria-label={dark ? "Use light theme" : "Use dark theme"}
                  title={dark ? "Use light theme" : "Use dark theme"}
                  onClick={() => setDark(!dark)}
                >
                  {dark ? (
                    <Sun size={18} aria-hidden="true" />
                  ) : (
                    <Moon size={17} aria-hidden="true" />
                  )}
                </button>
                <button
                  className="icon-button mobile-settings"
                  aria-label="Workspace settings"
                  title="Workspace settings"
                  onClick={() => setModal("settings")}
                >
                  <Settings2 size={17} aria-hidden="true" />
                </button>
              </span>
              <button
                className="button primary new-task"
                aria-label="New task"
                title="New task (N)"
                onClick={() => setModal("task")}
                disabled={!connected}
              >
                <Plus size={16} aria-hidden="true" />
                <span className="new-task-text">New task</span>
              </button>
            </div>
          </header>
          <main id="main-content" tabIndex={-1}>
            <header className="page-heading">
              <div className="page-heading-copy">
                <h1>
                  {current.label}
                  {prefs.focusMode ? (
                    <span className="page-mode-chip">Focus mode</span>
                  ) : null}
                  {presentation ? (
                    <span className="page-mode-chip">Presentation</span>
                  ) : null}
                </h1>
                <p>{current.description}</p>
              </div>
              {view === "agents" ? (
                <div className="page-actions">
                  <button
                    className="text-button"
                    aria-pressed={showArchived}
                    onClick={() => setShowArchived(!showArchived)}
                  >
                    {showArchived ? "Hide archived" : "Show archived"}
                  </button>
                  <button
                    className="button"
                    disabled={!connected}
                    onClick={() => setModal("agent-new")}
                  >
                    <UserPlus size={15} aria-hidden="true" />
                    Add agent
                  </button>
                </div>
              ) : null}
            </header>
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
                    // Switch to the new workspace and keep the remaining
                    // steps on screen; only Skip or Finish closes setup.
                    setWorkspaceId(id);
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
                {SHARED_FILTER_VIEWS.has(view) ? (
                  <FilterChips agents={agents} />
                ) : null}
                <div
                  className={`workspace-layout ${view !== "office" ? "alternate-view" : "office-stage"} ${fullView ? "full-view" : ""} ${showDetail ? "has-detail" : ""}`}
                >
                  <div className="workspace-left">
                    {view === "office" && (
                      <section className="panel office-panel">
                        <OfficeControl
                          onArrange={() => setArranging(true)}
                          agents={agents}
                          visibleCount={officeAgents.length}
                          filters={selectionFilters}
                          onFilters={setSelectionFilters}
                          theme={officeTheme}
                          onTheme={setOfficeTheme}
                          isDemo={isDemo}
                          demoRunning={Boolean(workspace.demoRunning)}
                          demoDisabled={!connected || busy}
                          onToggleDemo={() =>
                            action(
                              `${base}/demo`,
                              "POST",
                              { running: !workspace.demoRunning },
                              workspace.demoRunning
                                ? "Demo paused"
                                : "Demo resumed",
                            )
                          }
                          decisions={needsDecision}
                          liveSessions={liveSessions.length}
                          onOpenInbox={() => setView("inbox")}
                          onOpenSessions={() => setView("sessions")}
                          onConnections={() => setView("connections")}
                          // The demo is simulated and never mixes with real
                          // work, so a real team is deployed only elsewhere.
                          onDeployTeam={
                            isDemo || !connected
                              ? undefined
                              : () => setModal("team")
                          }
                        />
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
                            providerSurfaces={
                              observationStatus.data?.surfaces ?? []
                            }
                            onOpenProviders={() => setView("connections")}
                            selected={selectedAgent ?? undefined}
                            onSelect={selectAgent}
                            running={!isDemo || workspace.demoRunning}
                            theme={officeTheme}
                            graphics={officeSetting("graphics")}
                            reducedMotion={motionReduced}
                            officeLayout={officeArrangement}
                            arranging={arranging}
                            onArrangeClose={() => setArranging(false)}
                            onArrangeSave={saveOfficeLayout}
                            followAgentId={followAgentId}
                            testResults={officeData.testResults}
                            buildEvents={officeData.buildEvents}
                            artifactsByAgent={officeData.artifactsByAgent}
                            handoffs={officeData.handoffs}
                            kickoffs={officeData.kickoffs}
                            relays={relays}
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
                            presentation={officePresentation}
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
                            <i className="dot green" aria-hidden="true" />
                            Working
                          </span>
                          <span>
                            <i className="dot amber" aria-hidden="true" />
                            Needs approval, blocked or stale
                          </span>
                          <span>
                            <i className="dot red" aria-hidden="true" />
                            Failed
                          </span>
                          <span className="scene-caption">
                            {prefs.focusMode
                              ? "Focus mode: ambient motion paused, active run pinned."
                              : "Only agents with recorded work stand on the floor. Activity worked out from tool names is labelled inferred."}
                          </span>
                        </div>
                      </section>
                    )}
                    {view === "office" && (
                      <div className="pinned-strip">
                        <PinnedRuns
                          runs={runs}
                          hideWhenEmpty
                          onOpenRun={(runId, targetWorkspaceId) =>
                            openRun(runId, targetWorkspaceId)
                          }
                        />
                      </div>
                    )}
                    {view === "office" &&
                      (agents.length ? (
                        <OfficeRoster
                          agents={agents}
                          selectedId={agent?.id ?? null}
                          onSelect={selectAgent}
                          onOpenDirectory={() => setView("agents")}
                        />
                      ) : (
                        <section className="team-section roster">
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
                        </section>
                      ))}
                    {view === "agents" && (
                      <>
                        <AgentDirectory
                          agents={agents}
                          selectedId={agent?.id ?? null}
                          presentation={presentation}
                          disabled={!connected || busy}
                          avatarStyles={officeData.avatarStyles}
                          reducedMotion={motionReduced}
                          dark={dark}
                          onOpenRun={(runId) => openRun(runId)}
                          onSelect={(id) =>
                            id ? selectAgent(id) : setSelectedAgent(null)
                          }
                          onEdit={(target) => {
                            selectAgent(target.id);
                            setModal("agent-edit");
                          }}
                          onDuplicate={(target) =>
                            action(
                              `${base}/agents/${target.id}/duplicate`,
                              "POST",
                              {},
                              `${target.name} duplicated`,
                            )
                          }
                          onArchive={(target) => {
                            if (selectedAgent === target.id)
                              setSelectedAgent(null);
                            action(
                              `${base}/agents/${target.id}/archive`,
                              "POST",
                              {},
                              `${target.name} archived`,
                            );
                          }}
                          onShowInOffice={(id) => {
                            selectAgent(id);
                            setView("office");
                          }}
                        />
                        {showArchived && (
                          <section
                            className="panel archived-list"
                            aria-labelledby="archived-agents-title"
                          >
                            <h3 id="archived-agents-title">Archived agents</h3>
                            {archivedAgents.length ? (
                              <ul>
                                {archivedAgents.map((a) => (
                                  <li
                                    className="archived-row"
                                    key={a.id}
                                    style={{ "--agent-color": a.color }}
                                  >
                                    <span className="dir-tile">
                                      <AgentPortrait agent={a} size="sm" />
                                    </span>
                                    <span className="dir-name">
                                      <strong>{a.name}</strong>
                                      <span>{a.role}</span>
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
                                      <ArchiveRestore
                                        size={14}
                                        aria-hidden="true"
                                      />
                                      Restore
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="as-muted">
                                Nothing archived in this workspace.
                              </p>
                            )}
                          </section>
                        )}
                      </>
                    )}
                    {(view === "tasks" || view === "board") && taskPanel}
                    {view === "campus" && (
                      <section className="panel view-panel campus-panel">
                        <CampusView
                          workspaces={workspaces}
                          currentWorkspaceId={workspaceId}
                          onSelectWorkspace={enterWorkspace}
                          presentation={presentation}
                        />
                      </section>
                    )}
                    {view === "activity" && (
                      <section
                        className="panel activity-page"
                        aria-label="Workspace activity"
                      >
                        <ActivityFeed
                          events={events}
                          workspaceId={workspaceId}
                          agents={agents}
                          presentation={presentation}
                          onOpenRun={(runId) => openRun(runId)}
                        />
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
                    {view === "schedules" && (
                      <section className="panel view-panel">
                        <SchedulesView
                          workspaceId={workspaceId}
                          onOpenRun={(runId) => openRun(runId)}
                        />
                      </section>
                    )}
                    {view === "workflow" && (
                      <section className="panel view-panel">
                        <WorkflowEditor
                          workspaceId={workspaceId}
                          onOpenTask={openTask}
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
                        <KnowledgeView
                          workspaceId={workspaceId}
                          presentation={presentation}
                          tasks={tasks}
                          runs={runs}
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
                        <section
                          className="panel api-card"
                          aria-labelledby="local-api-title"
                        >
                          <div className="integration-banner">
                            <Cable size={22} aria-hidden="true" />
                            <div>
                              <h2 id="local-api-title">Local task API</h2>
                              <p>
                                Scripts and the agent-space CLI can add tasks to{" "}
                                <strong>
                                  {workspace?.workspace?.name ??
                                    "this workspace"}
                                </strong>{" "}
                                over HTTP. New tasks appear in every open tab.
                              </p>
                            </div>
                          </div>
                          <pre>
                            {`curl -X POST ${presentation ? "http://127.0.0.1:<port>" : location.origin}${base}/tasks \\\n${readToken() ? '  -H "Authorization: Bearer <your AGENT_SPACE_TOKEN>" \\\n' : ""}  -H "Content-Type: application/json" \\\n  -d '{"title":"Review my project","priority":"high"}'`}
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
                            <Copy size={14} aria-hidden="true" />
                            Copy API URL
                          </button>
                        </section>
                      </>
                    )}
                  </div>
                  {showDetail && (
                    <aside
                      ref={detailRef}
                      className={`inspector ${view === "office" ? "office-inspector" : ""}`}
                      aria-label={
                        selectedTask ? "Task details" : "Agent spotlight"
                      }
                    >
                      <section className="panel inspector-main">
                        <div className="panel-header">
                          <h2>
                            {selectedTask ? "Task details" : "Agent spotlight"}
                          </h2>
                          <span className="inspector-head-actions">
                            {spotlightRun && !selectedTask ? (
                              <span className="live-pill">
                                <i className="dot green" aria-hidden="true" />
                                Run active
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="Close details"
                              title="Close details"
                              onClick={() => {
                                setSelectedTask(null);
                                setSelectedAgent(null);
                              }}
                            >
                              <X size={16} aria-hidden="true" />
                            </button>
                          </span>
                        </div>
                        {agent && !selectedTask && (
                          <div className="agent-identity">
                            <AgentPortrait agent={agent} />
                            <div>
                              <h2>{agent.name}</h2>
                              <p>{agent.role}</p>
                              <span className="identity-badges">
                                {agent.provider || agent.runMode ? (
                                  <ProviderBadge
                                    provider={agent.provider}
                                    mode={agent.runMode ?? undefined}
                                    size="small"
                                  />
                                ) : (
                                  <span
                                    className="as-tag"
                                    title="Set on the profile, for new work. It is not a claim about any run."
                                  >
                                    No preferred assistant
                                  </span>
                                )}
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
                              {(agent.model ||
                                agent.runtime ||
                                (agent.skills?.length ?? 0) > 0 ||
                                agent.lastRun?.actualModel) && (
                                <div
                                  className="agent-passport"
                                  aria-label="Agent capability details"
                                >
                                  {(agent.model || agent.runtime) && (
                                    <div className="passport-models">
                                      {agent.model && (
                                        <span>
                                          <small>Preferred</small>
                                          {agent.model}
                                        </span>
                                      )}
                                      {agent.lastRun?.actualModel && (
                                        <span>
                                          <small>Last reported</small>
                                          {agent.lastRun.actualModel}
                                        </span>
                                      )}
                                      {agent.runtime && (
                                        <span>
                                          <small>Runtime</small>
                                          {agent.runtime}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                  {(agent.skills?.length ?? 0) > 0 && (
                                    <div
                                      className="passport-skills"
                                      aria-label="Agent skills"
                                    >
                                      {agent.skills.slice(0, 5).map((skill) => (
                                        <span key={skill}>{skill}</span>
                                      ))}
                                      {agent.skills.length > 5 && (
                                        <span>+{agent.skills.length - 5}</span>
                                      )}
                                    </div>
                                  )}
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
                                  {agent?.name ?? "This agent"} has no recorded
                                  work right now. Assign a queued task or create
                                  one.
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
                    </aside>
                  )}
                </div>
              </>
            )}
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
        {modal === "team" && workspace && (
          <TeamDialog
            workspaceId={workspaceId}
            agents={agents}
            connections={connections}
            capabilities={capabilityMap}
            onEnvironment={setOfficeTheme}
            onClose={() => setModal(null)}
            onDeployed={(result) => {
              setModal(null);
              setToast({
                message: teamDeployedMessage(result?.workflow, result),
              });
              setView("office");
            }}
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
          <Modal title="Workspace settings" onClose={() => setModal(null)} wide>
            <nav className="settings-tabs" aria-label="Settings sections">
              {[
                ["workspace", Box, "Workspace", "Identity and execution"],
                ["environment", Sparkles, "Environment", "Space and display"],
                ["controls", Shield, "Controls", "Privacy and operations"],
              ].map(([id, Icon, label, description]) => (
                <button
                  key={id}
                  type="button"
                  aria-current={settingsTab === id ? "page" : undefined}
                  onClick={() => setSettingsTab(id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                </button>
              ))}
            </nav>
            <section
              className="settings-pane"
              aria-labelledby={`settings-${settingsTab}`}
            >
              <header className="settings-pane-head">
                <span className="as-tag">Workspace only</span>
                <h3 id={`settings-${settingsTab}`}>
                  {
                    {
                      workspace: "Workspace identity and execution",
                      environment: "Compose the working environment",
                      controls: "Privacy, operations and product behavior",
                    }[settingsTab]
                  }
                </h3>
                <p>
                  {
                    {
                      workspace:
                        "Manage this project and the policy that controls agent work.",
                      environment:
                        "Choose the floor plan, rendering quality and information density for this workspace.",
                      controls:
                        "Choose what is shared, remembered and available to external control surfaces.",
                    }[settingsTab]
                  }
                </p>
              </header>
              {settingsTab === "workspace" ? (
                <>
                  <div className="settings-row">
                    <div>
                      <h3>{workspace?.workspace?.name ?? "Workspace"}</h3>
                      <p>
                        {isDemo
                          ? "The demo workspace keeps simulated sample work."
                          : maskPath(
                              workspace?.workspace?.rootPath,
                              presentation,
                            ) || "No project folder set."}
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
                            : "Autonomy, folders and commands, and where each kind of work may go."}
                        </p>
                      </div>
                      <button
                        className="button"
                        onClick={() => setModal("policy")}
                      >
                        <Shield size={14} />
                        Edit policy
                      </button>
                    </div>
                  )}
                  <div className="settings-row">
                    <div>
                      <h3>Setup</h3>
                      <p>
                        The first-run checklist: demo, connections, a sample
                        workspace and a starter workflow.
                      </p>
                    </div>
                    <SetupEntry
                      onOpen={() => {
                        setModal(null);
                        setSetupOpen(true);
                      }}
                    />
                  </div>
                </>
              ) : null}
              {settingsTab === "environment" ? (
                <>
                  <SettingSwitch
                    title="Dark appearance"
                    text="A quieter view for late sessions."
                    label="Dark appearance"
                    checked={dark}
                    onChange={setDark}
                  />
                  <div className="settings-row settings-environment-row">
                    <div className="settings-row-copy">
                      <h3>Office theme</h3>
                      <p>
                        Eight environments with distinct palettes and floor
                        plans.
                      </p>
                    </div>
                    <div
                      className="environment-picker"
                      aria-label="Office theme"
                    >
                      {OFFICE_THEMES.map(([id, label, color]) => (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={officeTheme === id}
                          onClick={() => setOfficeTheme(id)}
                        >
                          <i style={{ background: color }} aria-hidden="true" />
                          <span>{label}</span>
                          {officeTheme === id ? <Check size={13} /> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="settings-row visual-preset-row">
                    <div>
                      <h3>Portable visual preset</h3>
                      <p>
                        Move this office’s appearance between workspaces. A
                        preview lists every change before anything is saved.
                      </p>
                    </div>
                    <span className="settings-buttons visual-preset-actions">
                      <button
                        className="button"
                        type="button"
                        onClick={exportVisualPreset}
                      >
                        <Download size={14} /> Export preset
                      </button>
                      <label className="button visual-preset-import">
                        <Upload size={14} /> Import preset
                        <input
                          aria-label="Import visual preset"
                          type="file"
                          accept="application/json,.json"
                          onChange={previewVisualPreset}
                        />
                      </label>
                    </span>
                  </div>
                  {visualPresetError ? (
                    <p className="visual-preset-error" role="alert">
                      {visualPresetError}
                    </p>
                  ) : null}
                  {visualPresetPreview ? (
                    <section
                      className="visual-preset-preview"
                      aria-label="Visual preset preview"
                      role="status"
                    >
                      <div>
                        <span className="visual-preset-icon">
                          <Eye size={16} />
                        </span>
                        <p>
                          <strong>{visualPresetPreview.preset.name}</strong>
                          <br />
                          Review these workspace-only appearance changes.
                        </p>
                      </div>
                      <ul>
                        {visualPresetPreview.changes.length ? (
                          visualPresetPreview.changes.map((change) => (
                            <li key={change.key}>
                              <b>
                                {{
                                  theme: "Theme",
                                  "ui.graphics": "Graphics",
                                  "ui.office.labelDensity": "Label density",
                                  "ui.office.avatarDetail": "Avatar detail",
                                  "ui.office.lighting": "Lighting",
                                  "ui.office.ambientSound": "Ambient room tone",
                                }[change.key] ?? change.key}
                              </b>
                              <span>
                                {String(change.from ?? "default")} →{" "}
                                {String(change.to)}
                              </span>
                            </li>
                          ))
                        ) : (
                          <li>No visual changes are needed.</li>
                        )}
                      </ul>
                      <span className="settings-buttons">
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setVisualPresetPreview(null)}
                        >
                          Discard
                        </button>
                        <button
                          className="button primary"
                          type="button"
                          disabled={visualPresetBusy}
                          onClick={applyVisualPreset}
                        >
                          Apply preset
                        </button>
                      </span>
                    </section>
                  ) : null}
                  <div className="settings-row">
                    <div>
                      <h3>Graphics</h3>
                      <p>
                        Auto adapts detail to the screen and sustained frame
                        rate.
                      </p>
                    </div>
                    <select
                      aria-label="Graphics preset"
                      value={officeSetting("graphics")}
                      onChange={(e) =>
                        saveVisualSetting(
                          OFFICE_SETTINGS.graphics.key,
                          e.target.value,
                        )
                      }
                    >
                      <option value="auto">Auto (recommended)</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>
                  <SettingSwitch
                    title="Reduced motion"
                    text={
                      systemReducedMotion
                        ? "On, because your system asks for less motion: no walking, bobbing or particles in the office."
                        : "No walking tweens, bobbing or particles in the office."
                    }
                    label="Reduced motion"
                    checked={Boolean(prefs.reducedMotion) || systemReducedMotion}
                    disabled={systemReducedMotion}
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
                        saveVisualSetting(
                          OFFICE_SETTINGS.labelDensity.key,
                          e.target.value,
                        )
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
                      <p>
                        Low drops accessories and hair; high draws every part.
                      </p>
                    </div>
                    <select
                      aria-label="Avatar detail"
                      value={officeSetting("avatarDetail")}
                      onChange={(e) =>
                        saveVisualSetting(
                          OFFICE_SETTINGS.avatarDetail.key,
                          e.target.value,
                        )
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
                      <p>
                        Day, evening or a focused pool of light on the desks.
                      </p>
                    </div>
                    <select
                      aria-label="Office lighting"
                      value={officeSetting("lighting")}
                      onChange={(e) =>
                        saveVisualSetting(
                          OFFICE_SETTINGS.lighting.key,
                          e.target.value,
                        )
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
                      saveVisualSetting(
                        OFFICE_SETTINGS.ambientSound.key,
                        Boolean(v),
                      )
                    }
                  />
                </>
              ) : null}
              {settingsTab === "controls" ? (
                <>
                  <SettingSwitch
                    title="Share personal memory with runs"
                    text="Lets a run's context include your user-scope notes. Workspace and run notes are always included."
                    label="Share personal memory with runs"
                    checked={serverSettings["memory.shareUserScope"] !== false}
                    onChange={(v) =>
                      saveSetting("memory.shareUserScope", Boolean(v))
                    }
                  />
                  <SettingSwitch
                    title="Let MCP clients decide approvals"
                    text="Off by default. When on, an MCP client may approve or deny a pending approval; every decision is recorded with the actor “mcp”."
                    label="Let MCP clients decide approvals"
                    checked={serverSettings["mcp.allowDecisions"] === true}
                    onChange={(v) =>
                      saveSetting("mcp.allowDecisions", Boolean(v))
                    }
                  />
                  <div className="settings-row">
                    <div>
                      <h3>Operations and retention</h3>
                      <p>
                        Health, queues, backups and how long events and
                        artifacts are kept.
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
                    Workspaces, agents, tasks, and runs are saved in a local
                    SQLite database and survive server restarts.
                  </p>
                </>
              ) : null}
            </section>
          </Modal>
        )}
        {modal === "more" && (
          <Modal title="All destinations" onClose={() => setModal(null)}>
            <nav className="more-nav" aria-label="All destinations">
              {RAIL_GROUPS.map(([groupName, items]) => (
                <section key={groupName} className="more-group">
                  <h3>{groupName}</h3>
                  <div className="more-grid">
                    {items.map(({ icon: Icon, id, label }) => (
                      <button
                        key={id}
                        type="button"
                        aria-label={label}
                        aria-current={
                          navIdFor(view) === id ? "page" : undefined
                        }
                        onClick={() => {
                          setView(id);
                          setModal(null);
                        }}
                      >
                        <Icon size={18} aria-hidden="true" />
                        <span>{label}</span>
                        <RailBadge
                          id={id}
                          needsDecision={needsDecision}
                          liveCount={liveSessions.length}
                        />
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </nav>
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
              initialTab={runModal.tab ?? "overview"}
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

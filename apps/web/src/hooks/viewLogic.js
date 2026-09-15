import { providerLabel, formatElapsed, RUN_STATUS_LABELS } from "./useApi.js";
import { isOnFloor, activityOf } from "../office/presence.js";

/* ------------------------------------------------------------------ */
/* Agent directory                                                     */
/* ------------------------------------------------------------------ */

const ATTENTION_RUN = new Set(["waiting_approval", "blocked", "stale"]);
const ATTENTION_ACTIVITY = new Set([
  "WAITING_APPROVAL",
  "BLOCKED",
  "ERROR",
  "STALE",
]);
const STATE_ORDER = { attention: 0, working: 1, idle: 2 };

/**
 * Where an agent stands, from its recorded state only: "attention" (needs
 * approval, blocked, failed or stale), "working" (on the office floor) or
 * "idle" (a profile with no recorded work right now).
 */
export function agentState(agent) {
  if (
    agent?.state === "BLOCKED" ||
    ATTENTION_RUN.has(agent?.runStatus) ||
    ATTENTION_ACTIVITY.has(activityOf(agent))
  )
    return "attention";
  return isOnFloor(agent) ? "working" : "idle";
}

/**
 * Rows for the Agents directory: filtered by search text, state and
 * provider, ordered attention → working → idle and then by name, with counts
 * per state (before the state filter, so the filter chips can show them).
 */
export function agentDirectory(
  agents = [],
  { query = "", status = "all", provider = null } = {},
) {
  const needle = String(query).trim().toLowerCase();
  const searchable = (agent) =>
    [
      agent.name,
      agent.role,
      agent.specialty,
      agent.provider ? providerLabel(agent.provider) : "",
      ...(Array.isArray(agent.skills) ? agent.skills : []),
    ]
      .join(" ")
      .toLowerCase();
  const scoped = agents
    .filter((agent) => !provider || agent.provider === provider)
    .filter((agent) => !needle || searchable(agent).includes(needle))
    .map((agent) => ({ agent, state: agentState(agent) }));
  const counts = { all: scoped.length, working: 0, attention: 0, idle: 0 };
  for (const row of scoped) counts[row.state] += 1;
  const rows = scoped
    .filter((row) => status === "all" || row.state === status)
    .sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        String(a.agent.name).localeCompare(String(b.agent.name)),
    );
  const providers = [
    ...new Set(agents.map((agent) => agent.provider).filter(Boolean)),
  ].sort();
  return { rows, counts, providers };
}

/** The Agents page's sections, in the order someone scanning a team needs them. */
export const AGENT_SECTIONS = Object.freeze([
  {
    id: "attention",
    title: "Needs attention",
    hint: "Blocked, failed, stale or waiting for an approval",
  },
  { id: "working", title: "Working now", hint: "Recorded work in progress" },
  { id: "idle", title: "Ready for work", hint: "No recorded work right now" },
]);

/**
 * Directory rows (agentDirectory) grouped into AGENT_SECTIONS, each keeping
 * the rows' order. Empty sections are left out.
 */
export function agentSections(rows = []) {
  return AGENT_SECTIONS.map((section) => ({
    ...section,
    rows: rows.filter((row) => row.state === section.id),
  })).filter((section) => section.rows.length > 0);
}

/**
 * What a live session is doing, from its recorded state only. Live means the
 * provider process is open; that is not the same as working. The run behind
 * it goes stale when nothing has been recorded for the stale limit, and then
 * the session is Quiet, never Active.
 */
export function sessionState(session, now = Date.now()) {
  const last = session?.lastEventAt
    ? new Date(session.lastEventAt).getTime()
    : null;
  if (session?.live === false || session?.endedAt)
    return {
      key: "ended",
      label: "Ended",
      detail: "The session has ended.",
    };
  if (session?.status === "stale")
    return {
      key: "quiet",
      label: "Quiet",
      detail: last
        ? `The process is open, but nothing has been recorded for ${formatElapsed(Math.max(0, now - last))}.`
        : "The process is open, but nothing has been recorded.",
    };
  return {
    key: "active",
    label: "Active",
    detail: last ? "Recording events." : "Waiting for its first event.",
  };
}

const PROVIDER_RUN_MODES = new Set(["observed", "managed"]);

/**
 * What a task card says about progress. A provider run reports its status and
 * elapsed time, never a percentage; only a manual or demo task carries one,
 * because a person (or the labelled simulation) set it. A task bound to a
 * provider that no run has started says exactly that.
 */
export function cardProgress(task, run, now = Date.now()) {
  if (run && PROVIDER_RUN_MODES.has(run.mode)) {
    const label = RUN_STATUS_LABELS[run.status] ?? run.status;
    if (!run.startedAt) return label;
    const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
    return `${label} ${formatElapsed(end - new Date(run.startedAt).getTime())}`;
  }
  // Provider work is run, not advanced by hand: its stored progress was never
  // set by anyone, and a placeholder left over from before is not a start.
  if (task?.status === "IN_PROGRESS" && task.provider) return "Not launched";
  if (task?.status === "IN_PROGRESS" && typeof task.progress === "number")
    return `${task.progress}%`;
  return null;
}

/**
 * The run each task card reports on: the live run, else the most recent. A
 * provider run always wins over a manual placeholder on the same task, live or
 * not — the placeholder never did the work, and one left open by an older
 * server would otherwise make a task that did run read "Not launched".
 * Expects runs newest first, as the snapshot sends them.
 */
export function runsByTask(runs = []) {
  const map = new Map();
  for (const run of runs ?? []) {
    if (!run?.taskId) continue;
    const known = map.get(run.taskId);
    if (!known) {
      map.set(run.taskId, run);
      continue;
    }
    const isProvider = PROVIDER_RUN_MODES.has(run.mode);
    if (isProvider !== PROVIDER_RUN_MODES.has(known.mode)) {
      if (isProvider) map.set(run.taskId, run);
      continue;
    }
    if (known.endedAt && !run.endedAt) map.set(run.taskId, run);
  }
  return map;
}

/**
 * What a task row says at its right edge: a provider run's elapsed time, never
 * a percentage; "Not launched" for provider work no run has started; and the
 * percentage a person set on manual work. `run` is the one runsByTask picked.
 */
export function rowProgress(task, run, now = Date.now()) {
  if (run && PROVIDER_RUN_MODES.has(run.mode)) {
    if (!run.startedAt) return "—";
    const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
    return formatElapsed(end - new Date(run.startedAt).getTime());
  }
  if (task?.provider && task.status !== "COMPLETED") return "Not launched";
  return `${task?.progress ?? 0}%`;
}

/**
 * Where a task came from, as its row and its details say it. A task typed in
 * by hand but bound to a provider — or already executed by a provider run — is
 * not manual work, and calling it that hides who does the work.
 */
export function taskSourceLabel(task, run = null) {
  if (task?.source === "demo") return "Demo task";
  if (task?.source === "observed") return "Observed session";
  if (task?.source === "workflow") return "Workflow step";
  if (task?.source === "launcher") return "Launched task";
  if (task?.provider || (run && PROVIDER_RUN_MODES.has(run.mode)))
    return "Provider task";
  return "Manual task";
}

/**
 * Pure logic behind the wave-2 components and views.
 *
 * It lives in a `.js` module (not inside a `.jsx` component) so `node --test`
 * can import it directly with no build step, exactly like `useApi.js`. The
 * components re-export from here, so callers can keep importing either module.
 * Nothing in this file touches the DOM, the network, or React.
 */

/* ------------------------------------------------------------------ */
/* Shared selection and filters                                        */
/* ------------------------------------------------------------------ */

/** The filter shape every view understands. `null`/"" means "no filter". */
export const DEFAULT_FILTERS = Object.freeze({
  provider: null, // "claude-code" | "codex" | … | null
  status: null, // task status (QUEUE/IN_PROGRESS/BLOCKED/COMPLETED)
  runStatus: null, // run status (running/failed/…)
  agentId: null,
  role: null,
  query: "", // free text over titles
});

export const EMPTY_SELECTION = Object.freeze({
  selectedTaskId: null,
  selectedRunId: null,
  selectedAgentId: null,
  filters: DEFAULT_FILTERS,
});

export function normalizeFilters(filters) {
  return { ...DEFAULT_FILTERS, ...(filters ?? {}) };
}

/** True when a filter set is entirely empty. */
export function filtersAreEmpty(filters) {
  const f = normalizeFilters(filters);
  return Object.keys(DEFAULT_FILTERS).every(
    (key) => f[key] === null || f[key] === undefined || f[key] === "",
  );
}

/** Human labels for the active filter chips. */
/* ------------------------------------------------------------------ */
/* Build and deploy events for the office pipeline wall                */
/* ------------------------------------------------------------------ */

// A command position: the start of the text, after "Ran:", or after a shell
// separator. A tool name elsewhere in a command (a path, a package name, a
// grep pattern) is not a build.
const AT_COMMAND = String.raw`(?:^|Ran:\s*|[;&|(]\s*|&&\s*)`;
const BUILD_RUN = new RegExp(
  AT_COMMAND +
    String.raw`(?:cd\s+\S+\s*&&\s*)?(?:` +
    [
      String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?::[\w-]+)?\b`,
      String.raw`(?:npx\s+)?vite\s+build\b`,
      String.raw`(?:npx\s+)?webpack(?:\s|$)`,
      String.raw`(?:npx\s+)?rollup\s+-c\b`,
      String.raw`(?:npx\s+)?tsc(?:\s|$)`,
      String.raw`make(?:\s|$)`,
      String.raw`msbuild\b`,
      String.raw`(?:\.\/)?gradlew?\s+(?:build|assemble)\b`,
      String.raw`mvn\s+(?:package|install|compile|verify)\b`,
      String.raw`cargo\s+build\b`,
      String.raw`go\s+build\b`,
      String.raw`dotnet\s+(?:build|publish)\b`,
    ].join("|") +
    ")",
  "i",
);
const DEPLOY_RUN = new RegExp(
  AT_COMMAND +
    String.raw`(?:cd\s+\S+\s*&&\s*)?(?:` +
    [
      String.raw`(?:npm|pnpm|yarn)\s+publish\b`,
      String.raw`(?:npm|pnpm|yarn)\s+run\s+deploy\b`,
      String.raw`terraform\s+apply\b`,
      String.raw`kubectl\s+(?:apply|rollout)\b`,
      String.raw`docker\s+push\b`,
      String.raw`helm\s+(?:upgrade|install)\b`,
      String.raw`vercel(?:\s+--prod)?(?:\s|$)`,
      String.raw`netlify\s+deploy\b`,
      String.raw`fly\s+deploy\b`,
      String.raw`gh\s+release\s+create\b`,
    ].join("|") +
    ")",
  "i",
);
export const isBuildCommand = (text) => BUILD_RUN.test(String(text ?? ""));
export const isDeployCommand = (text) => DEPLOY_RUN.test(String(text ?? ""));

/** Recorded builds older than this are history, not what the wall shows. */
export const BUILD_WALL_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Build/deploy activity for the office pipeline wall. Two honest sources:
 * recorded command events that actually run a build or deploy (plus every
 * recorded test run), and CI checks a connector read. A recorded command has
 * no outcome of its own, so it is "recorded", never "passed". Only the last
 * two hours are shown, so yesterday's build never reads as current.
 */
export function buildEventsFrom(
  events = [],
  checks = null,
  { now = Date.now(), windowMs = BUILD_WALL_WINDOW_MS } = {},
) {
  const list = [];
  for (const event of events) {
    if (event.kind !== "command" && event.kind !== "test") continue;
    // The server sends epoch milliseconds; Date.parse() of a number is NaN,
    // which let every old build through the window.
    const at =
      typeof event.timestamp === "number"
        ? event.timestamp
        : Date.parse(event.timestamp ?? "");
    if (Number.isFinite(at) && now - at > windowMs) continue;
    const text = String(event.message ?? event.tool ?? "");
    const deploy = isDeployCommand(text);
    const build = isBuildCommand(text);
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

const TASK_STATUS_WORDS = {
  QUEUE: "Queued",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
};

/**
 * Chips for the active filters, worded for people: provider and status names
 * instead of ids, and the agent's name when `agentName` can resolve it.
 */
export function describeFilters(filters, { agentName } = {}) {
  const f = normalizeFilters(filters);
  const chips = [];
  if (f.provider)
    chips.push({
      key: "provider",
      label: `Provider: ${f.provider === "simulated" ? "Demo" : providerLabel(f.provider)}`,
    });
  if (f.status)
    chips.push({
      key: "status",
      label: `Task: ${TASK_STATUS_WORDS[f.status] ?? f.status}`,
    });
  if (f.runStatus)
    chips.push({
      key: "runStatus",
      label: `Run: ${RUN_STATUS_LABELS[f.runStatus] ?? f.runStatus}`,
    });
  if (f.agentId)
    chips.push({
      key: "agentId",
      label: `Agent: ${agentName?.(f.agentId) ?? "selected agent"}`,
    });
  if (f.role) chips.push({ key: "role", label: `Role: ${f.role}` });
  if (f.query) chips.push({ key: "query", label: `Text: ${f.query}` });
  return chips;
}

/** Does a task row pass the shared filters? */
export function taskMatchesFilters(task, filters) {
  if (!task) return false;
  const f = normalizeFilters(filters);
  if (f.provider && (task.provider ?? null) !== f.provider) return false;
  if (f.status && task.status !== f.status) return false;
  if (f.agentId && (task.assignedAgentId ?? null) !== f.agentId) return false;
  if (f.query) {
    const text = `${task.title ?? ""} ${task.deliverable ?? ""}`.toLowerCase();
    if (!text.includes(String(f.query).toLowerCase())) return false;
  }
  return true;
}

/** Does a run row pass the shared filters? */
export function runMatchesFilters(run, filters) {
  if (!run) return false;
  const f = normalizeFilters(filters);
  if (f.provider && (run.provider ?? null) !== f.provider) return false;
  if (f.runStatus && run.status !== f.runStatus) return false;
  if (f.agentId && (run.agentId ?? null) !== f.agentId) return false;
  if (f.query) {
    const text = `${run.title ?? ""} ${run.label ?? ""}`.toLowerCase();
    if (!text.includes(String(f.query).toLowerCase())) return false;
  }
  return true;
}

/** Does an agent row pass the shared filters? */
export function agentMatchesFilters(agent, filters) {
  if (!agent) return false;
  const f = normalizeFilters(filters);
  if (f.provider && (agent.provider ?? null) !== f.provider) return false;
  if (f.agentId && agent.id !== f.agentId) return false;
  if (f.role && (agent.role ?? null) !== f.role) return false;
  if (f.query) {
    const text = `${agent.name ?? ""} ${agent.role ?? ""}`.toLowerCase();
    if (!text.includes(String(f.query).toLowerCase())) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Virtualization                                                      */
/* ------------------------------------------------------------------ */

/**
 * Which rows a windowed list must render.
 * @returns {{ start:number, end:number, offsetY:number, totalHeight:number }}
 */
export function windowRange({
  count,
  itemHeight,
  height,
  scrollTop,
  overscan = 4,
}) {
  const safeHeight = Math.max(1, Number(itemHeight) || 1);
  const total = Math.max(0, Number(count) || 0);
  const viewport = Math.max(0, Number(height) || 0);
  const top = Math.max(0, Number(scrollTop) || 0);
  const first = Math.max(0, Math.floor(top / safeHeight) - overscan);
  const visible = Math.ceil(viewport / safeHeight) + overscan * 2 + 1;
  const end = Math.min(total, first + visible);
  const start = Math.min(first, Math.max(0, end - 1));
  return {
    start: total === 0 ? 0 : start,
    end,
    offsetY: (total === 0 ? 0 : start) * safeHeight,
    totalHeight: total * safeHeight,
  };
}

/* ------------------------------------------------------------------ */
/* Drag-to-assign compatibility                                        */
/* ------------------------------------------------------------------ */

/**
 * Is this agent a sensible destination for this task?
 * Compatibility is honest and narrow: a task that names a provider needs an
 * agent on that provider; a busy agent is compatible but flagged; an archived
 * agent is never a destination.
 */
export function assignmentCompatibility(task, agent) {
  if (!task || !agent)
    return { ok: false, reason: "Nothing selected", level: "error" };
  if (agent.archivedAt)
    return { ok: false, reason: "This agent is archived", level: "error" };
  if (task.provider && agent.provider && task.provider !== agent.provider)
    return {
      ok: false,
      level: "error",
      reason: `The task asks for ${providerLabel(task.provider)} and this agent runs ${providerLabel(agent.provider)}`,
    };
  if (agent.taskId && agent.taskId !== task.id)
    return {
      ok: true,
      level: "warn",
      reason:
        "This agent already has a task; assigning replaces the current assignment",
    };
  if (task.provider && !agent.provider)
    return {
      ok: true,
      level: "warn",
      reason: `The task asks for ${providerLabel(task.provider)}; this agent has no runtime set, so the task's provider is used`,
    };
  return { ok: true, level: "ok", reason: "Compatible" };
}

/* ------------------------------------------------------------------ */
/* Day in review                                                       */
/* ------------------------------------------------------------------ */

/** Event kinds worth a chapter beat. Everything else stays inside the run. */
export const MILESTONE_KINDS = Object.freeze([
  "prompt",
  "file.edit",
  "test",
  "command",
  "approval.request",
  "approval.decision",
  "delegation",
  "error",
  "run.status",
  "turn.end",
]);

/**
 * Builds the beats of one chapter from a run's recorded events. Every beat
 * cites the event it came from; nothing is summarized into prose.
 */
export function buildChapter(run, events = [], artifacts = []) {
  const milestones = new Set(MILESTONE_KINDS);
  const beats = [];
  const ordered = [...events].sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
  );
  for (const event of ordered) {
    if (!milestones.has(event.kind)) continue;
    beats.push({
      id: event.id,
      timestamp: event.timestamp,
      kind: event.kind,
      text: event.summary ?? event.message ?? event.kind,
      file: event.file ?? null,
      provenance: event.provenance ?? "system",
      event,
    });
  }
  return {
    runId: run.id,
    title: run.title ?? run.label ?? String(run.id ?? "").slice(0, 8),
    provider: run.provider,
    mode: run.mode,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    beats,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title ?? artifact.kind ?? artifact.id,
      kind: artifact.kind ?? null,
      path: artifact.path ?? null,
      size: artifact.size ?? null,
    })),
    eventCount: events.length,
    milestoneCount: beats.length,
  };
}

/** Readable names for milestone kinds (the raw kind stays in the event). */
export const BEAT_LABELS = Object.freeze({
  prompt: "Prompt",
  "file.edit": "Edited",
  test: "Test",
  command: "Command",
  "approval.request": "Approval asked",
  "approval.decision": "Decision",
  delegation: "Delegated",
  error: "Error",
  "run.status": "Status",
  "turn.end": "Turn ended",
});

/**
 * Text a coding tool adds to the conversation on the person's behalf:
 * attachment lists, reminders, plugin hints, a continued session's summary.
 * Recorded as a "prompt", but not something the person wrote, so it is
 * labelled as added context and kept out of the prompt count. The patterns
 * are the wrappers seen in recorded sessions, not guesses about content.
 */
const INJECTED_PROMPT =
  /^\s*(?:<[a-z][\w-]*>|# Files mentioned by the user|Caveat: The messages below were generated|This session is being continued from a previous conversation|\[Request interrupted by user)/i;

export function isInjectedPrompt(text) {
  return INJECTED_PROMPT.test(String(text ?? ""));
}

const KEY_PRIORITY = {
  error: 0,
  "approval.request": 1,
  "approval.decision": 1,
  "run.status": 2,
  delegation: 3,
  test: 4,
};

/**
 * What one run did, from its recorded milestones only: counts per kind, the
 * files it edited, and a short list of key moments (the first real prompt,
 * then errors, approvals, status changes, delegations and tests, earliest
 * first). Nothing is summarised into prose; every moment is a cited event.
 */
export function chapterDigest(chapter, { keyLimit = 8 } = {}) {
  const counts = {
    prompts: 0,
    injected: 0,
    edits: 0,
    commands: 0,
    tests: 0,
    errors: 0,
    approvals: 0,
    delegations: 0,
  };
  const files = new Map();
  const beats = (chapter?.beats ?? []).map((beat, order) => {
    const injected = beat.kind === "prompt" && isInjectedPrompt(beat.text);
    if (beat.kind === "prompt") counts[injected ? "injected" : "prompts"] += 1;
    else if (beat.kind === "file.edit") {
      counts.edits += 1;
      if (beat.file) files.set(beat.file, (files.get(beat.file) ?? 0) + 1);
    } else if (beat.kind === "command") counts.commands += 1;
    else if (beat.kind === "test") counts.tests += 1;
    else if (beat.kind === "error") counts.errors += 1;
    else if (beat.kind === "approval.request") counts.approvals += 1;
    else if (beat.kind === "delegation") counts.delegations += 1;
    return {
      ...beat,
      injected,
      order,
      label: BEAT_LABELS[beat.kind] ?? beat.kind,
    };
  });
  const firstPrompt = beats.find(
    (beat) => beat.kind === "prompt" && !beat.injected,
  );
  const important = beats.filter((beat) => beat.kind in KEY_PRIORITY);
  let picks = important;
  if (picks.length > keyLimit - (firstPrompt ? 1 : 0))
    picks = [...important]
      .sort(
        (a, b) =>
          KEY_PRIORITY[a.kind] - KEY_PRIORITY[b.kind] || a.order - b.order,
      )
      .slice(0, keyLimit - (firstPrompt ? 1 : 0));
  let keyMoments = [firstPrompt, ...picks].filter(Boolean);
  // A run with nothing notable still shows where it ended.
  if (keyMoments.length === 0)
    keyMoments = beats.filter((beat) => !beat.injected).slice(-3);
  keyMoments = [...new Set(keyMoments)].sort((a, b) => a.order - b.order);
  return {
    counts,
    files: [...files.entries()]
      .map(([path, edits]) => ({ path, edits }))
      .sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path)),
    beats,
    keyMoments,
  };
}

/** "3 prompts · 12 files edited · 1 error", zero counts left out. */
export function digestLine(counts, files = []) {
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return [
    counts.prompts ? plural(counts.prompts, "prompt") : null,
    files.length ? `${plural(files.length, "file")} edited` : null,
    counts.commands ? plural(counts.commands, "command") : null,
    counts.tests ? plural(counts.tests, "test run") : null,
    counts.approvals ? plural(counts.approvals, "approval") : null,
    counts.delegations ? plural(counts.delegations, "delegation") : null,
    counts.errors ? plural(counts.errors, "error") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/* ------------------------------------------------------------------ */
/* Decision inbox urgency ordering                                     */
/* ------------------------------------------------------------------ */

/** Urgency, highest first. The server computes the level; we only order by it. */
export const URGENCY_RANK = Object.freeze({ critical: 0, high: 1, normal: 2 });

export function urgencyRank(entry) {
  const level = entry?.urgency?.level ?? "normal";
  return URGENCY_RANK[level] ?? 2;
}

/** Orders approvals by urgency level, then score, then age. */
export function orderByUrgency(approvals = []) {
  return [...approvals].sort(
    (a, b) =>
      urgencyRank(a) - urgencyRank(b) ||
      (b.urgency?.score ?? 0) - (a.urgency?.score ?? 0) ||
      (a.requestedAt ?? 0) - (b.requestedAt ?? 0),
  );
}

/* ------------------------------------------------------------------ */
/* Dependency editor                                                   */
/* ------------------------------------------------------------------ */

/**
 * Reorders an id inside a list. `direction` is -1 (earlier) or +1 (later).
 * Order is a reading aid: the scheduler still requires every dependency.
 */
export function moveInList(list, id, direction) {
  const items = [...(list ?? [])];
  const index = items.indexOf(id);
  if (index < 0) return items;
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  [items[index], items[target]] = [items[target], items[index]];
  return items;
}

/* ------------------------------------------------------------------ */
/* Analytics heatmaps                                                  */
/* ------------------------------------------------------------------ */

/**
 * Normalizes any heatmap payload into rows of 24 hourly cells that keep the
 * run and task ids behind them, so a cell can be drilled down to real records.
 *
 * Accepts an array of
 * `{ taskId|provider, title?, hour, blockedMs|executingMs|runs, runIds?, taskIds? }`
 * cells, `{ rows: [{ id, title, hours: number[] }] }`, or `{ cells: [...] }`.
 */
export function normalizeHeatmap(
  raw,
  {
    valueKeys = ["blockedMs", "executingMs", "runs", "value", "count", "ms"],
  } = {},
) {
  if (!raw) return null;
  let cells = null;
  if (Array.isArray(raw)) cells = raw;
  else if (Array.isArray(raw.cells)) cells = raw.cells;
  const rowsById = new Map();
  const ensure = (id, title) => {
    if (!rowsById.has(id))
      rowsById.set(id, {
        id,
        title: title ?? id,
        hours: Array(24).fill(0),
        runIds: Array.from({ length: 24 }, () => []),
        taskIds: Array.from({ length: 24 }, () => []),
      });
    return rowsById.get(id);
  };
  if (cells) {
    for (const cell of cells) {
      const id = cell.taskId ?? cell.provider ?? cell.id ?? cell.key ?? "all";
      const row = ensure(id, cell.title ?? cell.provider ?? id);
      const hour = Number(cell.hour) || 0;
      let value = 0;
      for (const key of valueKeys)
        if (cell[key] !== undefined && cell[key] !== null) {
          value = Number(cell[key]) || 0;
          break;
        }
      row.hours[hour] += value;
      for (const runId of cell.runIds ?? [])
        if (runId && !row.runIds[hour].includes(runId))
          row.runIds[hour].push(runId);
      for (const taskId of cell.taskIds ?? [cell.taskId])
        if (taskId && !row.taskIds[hour].includes(taskId))
          row.taskIds[hour].push(taskId);
    }
  } else if (Array.isArray(raw.rows)) {
    for (const entry of raw.rows) {
      const row = ensure(entry.id ?? entry.taskId, entry.title);
      (entry.hours ?? entry.values ?? []).forEach((value, hour) => {
        row.hours[hour] = Number(value) || 0;
      });
    }
  } else return null;
  const rows = [...rowsById.values()];
  const max = Math.max(0, ...rows.flatMap((row) => row.hours));
  const unit = rows.some((row) => row.hours.some((value) => value > 1000))
    ? "ms"
    : "count";
  return { rows, max, unit };
}

/* ------------------------------------------------------------------ */
/* Onboarding copy                                                     */
/* ------------------------------------------------------------------ */

/** Step order. The demo comes first because it needs no credentials. */
export const ONBOARDING_STEP_IDS = Object.freeze([
  "demo",
  "connect",
  "sample",
  "workflow",
  "billing",
]);

/**
 * The scope and resource assumptions shown before anything is created. These
 * are stated, not measured: a first run has no history to estimate from.
 */
export const SAMPLE_SCOPE = Object.freeze([
  "One new workspace row in the local SQLite database. No files are written to your repository.",
  "The folder you name becomes the only path runs may touch; everything outside it is refused by the policy engine.",
  "The starter workflow creates tasks only. No provider is launched until you press Run.",
  "A run you start later spends your own provider quota — Agent Space never buys tokens.",
  "Archiving the workspace hides it; nothing on disk is deleted by Agent Space.",
]);

/**
 * Events (newest first) grouped by the local day they were recorded on, for
 * the Activity page: "Today", "Yesterday" or the date. An event without a
 * usable time goes in a last "Time not recorded" group instead of being
 * given a day it may not belong to.
 */
export function activityDays(events = [], now = Date.now()) {
  const startOf = (time) => {
    const day = new Date(time);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  };
  const today = startOf(now);
  const yesterday = startOf(today - 1);
  const labelFor = (day) => {
    if (day === today) return "Today";
    if (day === yesterday) return "Yesterday";
    return new Date(day).toLocaleDateString([], {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  };
  const groups = [];
  const undated = [];
  for (const event of events ?? []) {
    const at =
      typeof event?.timestamp === "number"
        ? event.timestamp
        : Date.parse(event?.timestamp ?? "");
    if (!Number.isFinite(at) || at <= 0) {
      undated.push(event);
      continue;
    }
    const day = startOf(at);
    let group = groups.at(-1);
    if (!group || group.day !== day) {
      group = { day, label: labelFor(day), events: [] };
      groups.push(group);
    }
    group.events.push(event);
  }
  if (undated.length)
    groups.push({ day: null, label: "Time not recorded", events: undated });
  return groups;
}

/**
 * The Activity feed's list: the live head (the snapshot's latest events) and
 * the older pages read from GET /api/workspaces/:id/events, each event once,
 * newest first. The first page is read from the newest event, so an event that
 * later scrolls off the live head is still in the fetched pages: no gap opens
 * between the two. The live copy wins for an event in both.
 */
export function mergeEventHistory(head = [], fetched = []) {
  const byId = new Map();
  for (const event of [...(fetched ?? []), ...(head ?? [])])
    if (event?.id != null) byId.set(event.id, event);
  const time = (event) =>
    typeof event.timestamp === "number"
      ? event.timestamp
      : Date.parse(event.timestamp ?? "") || 0;
  return [...byId.values()].sort((a, b) =>
    Number.isFinite(a.sequence) && Number.isFinite(b.sequence)
      ? b.sequence - a.sequence
      : time(b) - time(a),
  );
}

/**
 * How many events the workspace has recorded, from the history endpoint's
 * `total` at the time it was read plus the live events newer than the newest
 * one it had then. Null when the total was never read.
 */
export function eventHistoryTotal(probe, head = []) {
  if (!probe || !Number.isFinite(probe.total)) return null;
  const newest = Number.isFinite(probe.newest) ? probe.newest : Infinity;
  return (
    probe.total +
    (head ?? []).filter(
      (event) => Number.isFinite(event?.sequence) && event.sequence > newest,
    ).length
  );
}

/**
 * Who a recorded approver is, for display. A name typed in the Inbox is
 * recorded behind the transport's own actor ("local-user:alice"); the part
 * after the colon is the name the person gave.
 */
export function approverLabel(actor) {
  const text = String(actor ?? "").trim();
  if (!text) return "someone";
  const colon = text.indexOf(":");
  return colon > 0 && colon < text.length - 1 ? text.slice(colon + 1) : text;
}

/**
 * Where a request that needs more than one approver stands, from the
 * decisions the server recorded: how many are required, who has approved,
 * and whether the approver must give a name (the server refuses the same
 * actor twice, so each approver has to be told apart). Null for an ordinary
 * single-approver request.
 */
export function dualApprovalState(approval) {
  const required = Math.max(1, Number(approval?.requiredDecisions) || 1);
  if (required < 2) return null;
  const approvedBy = [
    ...new Set(
      (approval?.decisions ?? [])
        .filter((entry) => entry?.decision === "approve")
        .map((entry) => entry.actor),
    ),
  ];
  return {
    required,
    approvedBy,
    approvedLabels: approvedBy.map(approverLabel),
    remaining: Math.max(0, required - approvedBy.length),
    awaitingSecond:
      Boolean(approval?.awaitingSecondApprover) ||
      (approvedBy.length > 0 && approvedBy.length < required),
  };
}

/** What a run action did, in words, from what was asked and what came back. */
export function actionMessage(action, body = {}, result = null) {
  switch (action) {
    case "review":
      return body?.decision === "reject"
        ? "Review rejected. Your note is kept with the task, and the run can be retried."
        : "Review accepted: the task is completed.";
    case "cancel":
      return "Cancel requested. Work the provider already did is not undone.";
    case "retry":
      return result?.attempt
        ? `Retry started as attempt ${result.attempt}.`
        : "Retry started.";
    case "input":
      return body?.resume ? "Resume requested." : "Input sent to the run.";
    default:
      return "Done.";
  }
}

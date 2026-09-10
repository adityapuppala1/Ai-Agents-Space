import { providerLabel } from "./useApi.js";

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
export function describeFilters(filters) {
  const f = normalizeFilters(filters);
  const chips = [];
  if (f.provider)
    chips.push({ key: "provider", label: `Provider: ${f.provider}` });
  if (f.status) chips.push({ key: "status", label: `Task: ${f.status}` });
  if (f.runStatus)
    chips.push({ key: "runStatus", label: `Run: ${f.runStatus}` });
  if (f.agentId) chips.push({ key: "agentId", label: `Agent: ${f.agentId}` });
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

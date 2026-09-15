import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { InputError, TaskStore } from "./TaskStore.js";
import { AgentProfiles, DEFAULT_AGENTS } from "./AgentProfiles.js";
import { transaction } from "./db.js";
import { ACTIVITIES } from "./contracts.js";
import { mergePolicy } from "./policy/Policy.js";

// Kept for scripts that imported the fixed roster from earlier versions.
export const AGENTS = DEFAULT_AGENTS;

/** Run statuses that keep an agent busy (queued runs are waiting for a slot). */
export const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "blocked",
  "waiting_approval",
  "stale",
];

/** Task sources a client may set on creation; anything else becomes "manual". */
const CLIENT_SOURCE = /^[a-z][a-z0-9-]{0,23}$/;
const RESERVED_SOURCES = new Set(["demo", "observed", "simulated"]);

/**
 * The demo's team relay: Echo's live-stream task hands its result to Sage's
 * documentation task. Every record it writes says it is simulated.
 */
const DEMO_RELAY = "demo-relay";
const DEMO_RELAY_TEMPLATE = "live-stream-relay";
/** Scripted subagents for Nova's demo task, opened and closed by progress. */
const DEMO_SUBAGENTS = [
  ["Check the cards at phone width", "Collect the icon set"],
  ["Compare the empty states", "List the missing focus rings"],
  ["Measure the office frame rate", "Audit the colour contrast"],
];

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Run row → snapshot shape. Deliberately lighter than RunRecorder.rowToRun:
 * prompt, config snapshot, and context stay behind GET /api/runs/:id.
 */
export function rowToRun(row, now = Date.now()) {
  const active = ACTIVE_RUN_STATUSES.includes(row.status);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    agentSnapshot: parseJson(row.agent_snapshot, {}),
    connectionId: row.connection_id ?? null,
    provider: row.provider,
    requestedModel: row.requested_model ?? null,
    actualModel: row.actual_model ?? null,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    mode: row.mode ?? "manual",
    providerSessionId: row.provider_session_id ?? null,
    cwd: row.cwd ?? null,
    branch: row.branch ?? null,
    worktree: row.worktree ?? null,
    host: row.host ?? "local",
    label: row.label ?? null,
    title: row.title ?? null,
    currentAction: row.current_action ?? null,
    currentFile: row.current_file ?? null,
    activity: row.activity ?? null,
    lastEventAt: row.last_event_at ?? null,
    usage: parseJson(row.usage, {}),
    cost: parseJson(row.cost, {}),
    exitCode: row.exit_code ?? null,
    error: row.error ?? null,
    pid: row.pid ?? null,
    summary: row.summary ?? null,
    attempt: row.attempt ?? 1,
    parentRunId: row.parent_run_id ?? null,
    orchestrationOwner: row.orchestration_owner ?? "agent-space",
    elapsedMs: active
      ? Math.max(0, now - row.started_at)
      : row.ended_at
        ? Math.max(0, row.ended_at - row.started_at)
        : null,
  };
}

/**
 * Test results a managed run actually reported. The numbers come from the
 * `test-output` artifact the run worker writes (one entry per test command it
 * recognised) and from the exit codes the provider reported for those
 * commands. When a provider reported no exit code the command is counted as
 * `unknown`, never as a pass: Agent Space does not guess whether tests passed.
 *
 * Returns a Map of runId → summary for the runs asked for, and only for runs
 * that have such an artifact. Reading is bounded to the first 8 KB of the
 * artifact so a huge log cannot slow a snapshot down.
 */
export function testSummaries(db, runIds) {
  const summaries = new Map();
  const ids = [...new Set(runIds.filter(Boolean))];
  if (!ids.length) return summaries;
  const placeholders = ids.map(() => "?").join(",");
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT id, run_id, title, metadata, SUBSTR(COALESCE(content, ''), 1, 8000) AS head
         FROM artifacts WHERE kind = 'test-output' AND run_id IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(...ids);
  } catch {
    return summaries;
  }
  for (const row of rows) {
    const metadata = parseJson(row.metadata, {});
    const commands = Array.isArray(metadata.commands) ? metadata.commands : [];
    let passed = 0;
    let failed = 0;
    let unknown = 0;
    const total = Number(metadata.count) || commands.length || 0;
    let seen = 0;
    for (const match of String(row.head ?? "").matchAll(
      /^\$ .*?\(exit (-?\d+)\)\s*$/gm,
    )) {
      seen++;
      if (Number(match[1]) === 0) passed++;
      else failed++;
    }
    unknown = Math.max(0, total - seen);
    summaries.set(row.run_id, {
      artifactId: row.id,
      title: row.title ?? "Test output",
      commands: total,
      passed,
      failed,
      unknown,
      // "reported" is true only when every command carried an exit code from
      // the provider; otherwise the UI must say results are incomplete.
      reported: total > 0 && unknown === 0,
      basis: "exit codes reported by the provider for recognised test commands",
    });
  }
  return summaries;
}

export function rowToWorkspace(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    rootPath: row.root_path ?? null,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? null,
    autoCreated: row.auto_created === 1,
    theme: row.theme ?? "studio",
    policy: mergePolicy({}, parseJson(row.policy, {})),
    settings: parseJson(row.settings, {}),
  };
}

/**
 * An event row as the clients see it. `sequence` is the paging cursor for
 * Workspace.events(); `data` itself is never sent, only the inferred activity.
 */
function rowToEvent(row) {
  const data = parseJson(row.data, {});
  const event = {
    id: row.id,
    sequence: row.sequence,
    message: row.message,
    kind: row.kind,
    agentId: row.agent_id ?? undefined,
    runId: row.run_id ?? undefined,
    taskId: row.task_id ?? undefined,
    timestamp: row.timestamp,
    provenance: row.provenance ?? "system",
    tool: row.tool ?? null,
    file: row.file ?? null,
    activity: data.activity ?? null,
  };
  // Interactions between agents name their recipient; the office draws them
  // only when both ends are known agents.
  if (typeof data.toAgentId === "string") event.toAgentId = data.toAgentId;
  if (row.kind === "handoff")
    event.handoff = {
      fromAgentId: data.fromAgentId ?? row.agent_id ?? null,
      toAgentId: data.toAgentId ?? null,
      fromTaskId: data.fromTaskId ?? null,
      toTaskId: data.toTaskId ?? null,
      workflowId: data.workflowId ?? null,
      dispatched: data.dispatched === true,
      reason: data.reason ?? null,
      withheld: data.withheld === true,
      simulated: data.simulated === true,
      artifacts: Array.isArray(data.artifacts)
        ? data.artifacts.slice(0, 6).map((artifact) => ({
            id: artifact?.id ?? null,
            kind: artifact?.kind ?? null,
            title: artifact?.title ?? null,
          }))
        : [],
    };
  if (row.kind === "team")
    event.team = {
      workflowId: data.workflowId ?? null,
      simulated: data.simulated === true,
      members: Array.isArray(data.members)
        ? data.members.slice(0, 20).map((member) => ({
            agentId: member?.agentId ?? null,
            role: member?.role ?? null,
          }))
        : [],
    };
  return event;
}

/**
 * Visible state of an agent. Observed and managed runs report what the
 * provider actually did (activity inferred from tool names, labelled as
 * such); manual and simulated tasks keep the profile's working state; a
 * BLOCKED task always wins.
 *
 * For a manual task the state is the working style chosen on the profile,
 * not something anyone reported, so its provenance is "profile" and clients
 * show only that the task is in progress. Demo tasks are simulated: "system".
 *
 * Provider work — a task that names a provider, or that a managed or observed
 * run has executed — never borrows the profile's working style. With no run
 * executing it is assigned, not started, or finished and waiting for review,
 * and nothing is reporting any activity.
 */
function agentState(agent, task, run, { providerWork = false } = {}) {
  if (!task) return { state: "IDLE", activityProvenance: null };
  if (task.status === "BLOCKED")
    return { state: "BLOCKED", activityProvenance: "user" };
  if (run && (run.mode === "observed" || run.mode === "managed")) {
    if (run.status === "waiting_approval")
      return { state: "WAITING_APPROVAL", activityProvenance: "system" };
    if (run.status === "stale")
      return { state: "STALE", activityProvenance: "system" };
    if (run.status === "queued")
      return { state: "IDLE", activityProvenance: "system" };
    if (
      run.activity &&
      run.activity !== "IDLE" &&
      ACTIVITIES.includes(run.activity)
    )
      return { state: run.activity, activityProvenance: "inferred" };
    // Running, but the provider has not reported a tool or message yet.
    return { state: "IDLE", activityProvenance: "system" };
  }
  if (providerWork) return { state: "IDLE", activityProvenance: "system" };
  return {
    state: agent.workingState,
    activityProvenance: task.source === "demo" ? "system" : "profile",
  };
}

/**
 * Runtime for one persisted workspace: tasks, agent profiles, runs, and the
 * activity log. Every mutation is written to SQLite and then broadcast as a
 * full snapshot through the "change" event.
 */
export class Workspace extends EventEmitter {
  constructor(store = new TaskStore(), { demo = false } = {}) {
    super();
    this.store = store;
    this.db = store.db;
    this.id = store.workspaceId;
    this.profiles = new AgentProfiles(this.db, this.id);
    this.profiles.seedDefaults();
    this.demoRunning = false;
    this.startedAt = Date.now();
    this.sequence =
      this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS s FROM events WHERE workspace_id = ?",
        )
        .get(this.id).s ?? 0;
    if (demo) this.loadDemo();
  }

  get record() {
    return rowToWorkspace(
      this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(this.id),
    );
  }

  get isDemo() {
    return this.record.kind === "demo";
  }

  #events(limit = 60) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE workspace_id = ? ORDER BY sequence DESC LIMIT ?",
      )
      .all(this.id, limit)
      .map(rowToEvent);
  }

  /**
   * One page of this workspace's recorded events, newest first, older than
   * `before` (a sequence number; omitted = from the newest). The snapshot
   * carries only the latest 60; this is how a client reads further back.
   * `nextBefore` is null when nothing older remains. The fields are the
   * snapshot's own, so nothing is exposed that the live feed does not show.
   */
  events({ before = null, limit = 100 } = {}) {
    const size = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const cursor = Number(before);
    const rows =
      Number.isFinite(cursor) && cursor > 0
        ? this.db
            .prepare(
              "SELECT * FROM events WHERE workspace_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?",
            )
            .all(this.id, cursor, size + 1)
        : this.db
            .prepare(
              "SELECT * FROM events WHERE workspace_id = ? ORDER BY sequence DESC LIMIT ?",
            )
            .all(this.id, size + 1);
    const more = rows.length > size;
    const events = rows.slice(0, size).map(rowToEvent);
    // `total` counts every event up to `newest`, read together, so a client
    // can add the live events newer than `newest` without counting twice.
    const counts = this.db
      .prepare(
        "SELECT COUNT(*) AS n, MAX(sequence) AS newest FROM events WHERE workspace_id = ?",
      )
      .get(this.id);
    return {
      events,
      nextBefore: more ? (events.at(-1)?.sequence ?? null) : null,
      total: counts?.n ?? 0,
      newest: counts?.newest ?? null,
    };
  }

  /**
   * Attaches the reported test results to each run that has a test-output
   * artifact. Runs without one keep `tests: null` — "no tests were recorded",
   * which is not the same as "tests passed".
   */
  #withTests(runs) {
    if (!runs.length) return runs;
    const summaries = testSummaries(
      this.db,
      runs.map((run) => run.id),
    );
    for (const run of runs) run.tests = summaries.get(run.id) ?? null;
    return runs;
  }

  /**
   * Execution fields that live on the task row but are not part of the
   * TaskStore shape: the per-task contract, the branch condition, the named
   * reviewer, and the repair chain. Absent columns (an older database) are
   * reported as empty rather than failing the snapshot.
   */
  #taskExecutionFields() {
    try {
      const rows = this.db
        .prepare(
          "SELECT id, contract, branch_condition, reviewer, repair_of FROM tasks WHERE workspace_id = ?",
        )
        .all(this.id);
      return new Map(
        rows.map((row) => [
          row.id,
          {
            contract: parseJson(row.contract, null),
            branch: parseJson(row.branch_condition, null),
            reviewer: row.reviewer ?? null,
            repairOf: row.repair_of ?? null,
          },
        ]),
      );
    } catch {
      return new Map();
    }
  }

  runs(limit = 100) {
    const now = Date.now();
    return this.#withTests(
      this.db
        .prepare(
          "SELECT * FROM runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?",
        )
        .all(this.id, limit)
        .map((row) => rowToRun(row, now)),
    );
  }

  /**
   * Subagents a run started and has not heard back from: delegation events
   * (Claude Code's Task/Agent tool) whose tool-use id has no tool.end or
   * error after it. Newest first, at most four. A "subagent finished" hook
   * event carries no tool-use id and is never counted as open.
   */
  #openSubagents(runId) {
    let rows = [];
    try {
      rows = this.db
        .prepare(
          `SELECT id, kind, message, timestamp, json_extract(data, '$.toolUseId') AS tool_use_id
             FROM events
            WHERE run_id = ? AND kind IN ('delegation', 'tool.end', 'error')
            ORDER BY sequence DESC LIMIT 400`,
        )
        .all(runId);
    } catch {
      return [];
    }
    const ended = new Set(
      rows
        .filter((row) => row.kind !== "delegation" && row.tool_use_id)
        .map((row) => row.tool_use_id),
    );
    const open = [];
    for (const row of rows) {
      if (row.kind !== "delegation" || !row.tool_use_id) continue;
      if (ended.has(row.tool_use_id)) continue;
      open.push({
        id: String(row.tool_use_id),
        description: String(row.message ?? "")
          .replace(/^Delegated:\s*/i, "")
          .slice(0, 120),
        startedAt: row.timestamp,
        eventId: row.id,
      });
      if (open.length >= 4) break;
    }
    return open;
  }

  /**
   * Tasks a managed or observed run has executed. Such a task is provider
   * work even when it names no provider, because it was launched with one.
   */
  #providerRunTaskIds() {
    return new Set(
      this.db
        .prepare(
          "SELECT DISTINCT task_id FROM runs WHERE workspace_id = ? AND task_id IS NOT NULL AND mode IN ('managed', 'observed')",
        )
        .all(this.id)
        .map((row) => row.task_id),
    );
  }

  /** Runs that currently occupy an agent (queued, running, blocked, waiting, stale). */
  activeRuns() {
    const now = Date.now();
    const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(",");
    return this.#withTests(
      this.db
        .prepare(
          `SELECT * FROM runs WHERE workspace_id = ? AND status IN (${placeholders}) ORDER BY started_at DESC`,
        )
        .all(this.id, ...ACTIVE_RUN_STATUSES)
        .map((row) => rowToRun(row, now)),
    );
  }

  snapshot() {
    const now = Date.now();
    const execution = this.#taskExecutionFields();
    const tasks = this.store.list().map((task) => ({
      ...task,
      ...(execution.get(task.id) ?? {
        contract: null,
        branch: null,
        reviewer: null,
        repairOf: null,
      }),
    }));
    const activeRuns = this.activeRuns();
    const providerRunTasks = this.#providerRunTaskIds();
    const agents = this.profiles.list().map((agent) => {
      const task = tasks.find(
        (task) =>
          task.assignedAgentId === agent.id &&
          !["COMPLETED", "QUEUE"].includes(task.status),
      );
      const run = task
        ? (activeRuns.find(
            (r) => r.taskId === task.id && r.agentId === agent.id,
          ) ??
          activeRuns.find((r) => r.taskId === task.id) ??
          null)
        : null;
      const { state, activityProvenance } = agentState(agent, task, run, {
        providerWork: Boolean(
          task && (task.provider || providerRunTasks.has(task.id)),
        ),
      });
      return {
        ...agent,
        state,
        // Team name for grouping in the office. Uses the profile's own team
        // field when a build has one; otherwise the role is the team, which is
        // a label the user already chose rather than an invented one.
        team: agent.team ?? agent.role,
        taskId: task?.id,
        taskTitle: task?.title ?? null,
        completed: tasks.filter(
          (t) => t.assignedAgentId === agent.id && t.status === "COMPLETED",
        ).length,
        activity: run?.activity ?? null,
        activityProvenance,
        currentFile: run?.currentFile ?? null,
        currentAction: run?.currentAction ?? null,
        runId: run?.id ?? null,
        runStatus: run?.status ?? null,
        runMode: run?.mode ?? null,
        runProvider: run?.provider ?? null,
        // Which branch this agent's work is on, and whether it is isolated in
        // a worktree of its own. Every comparable tool isolates agents in git
        // worktrees, and "which branch is this one on?" is the first thing
        // their users ask; the run has always recorded it and nothing showed
        // it. Null branch means the run recorded none — not "main".
        branch: run?.branch ?? null,
        isolated: Boolean(run?.worktree),
        actualModel: run?.actualModel ?? null,
        lastEventAt: run?.lastEventAt ?? null,
        elapsedMs: run ? Math.max(0, now - run.startedAt) : null,
        tests: run?.tests ?? null,
        // Simulated runs are the demo's scripted delegations (tick()).
        subagents:
          run && ["observed", "managed", "simulated"].includes(run.mode)
            ? this.#openSubagents(run.id)
            : [],
      };
    });
    return {
      workspace: this.record,
      agents,
      tasks,
      runs: this.runs(),
      events: this.#events(),
      demoRunning: this.demoRunning,
      sequence: this.sequence,
      startedAt: this.startedAt,
    };
  }

  #record(message, kind = "task", agentId, runId) {
    this.sequence++;
    this.db
      .prepare(
        "INSERT INTO events (id, sequence, workspace_id, run_id, kind, message, agent_id, timestamp, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system')",
      )
      .run(
        randomUUID(),
        this.sequence,
        this.id,
        runId ?? null,
        kind,
        message,
        agentId ?? null,
        Date.now(),
      );
  }

  /**
   * Records one workspace event with structured data (a handoff names both
   * agents and the artifacts passed; a team names its members) and
   * broadcasts. `data` is stored whole; clients only ever get the fields
   * rowToEvent picks from it.
   */
  recordEvent({
    kind,
    message,
    agentId = null,
    runId = null,
    taskId = null,
    data = null,
    provenance = "system",
  } = {}) {
    // A link to a run or task that is not (or no longer) on record is dropped
    // rather than losing the event to a foreign-key refusal.
    const known = (table, id) =>
      id && this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)
        ? id
        : null;
    this.sequence++;
    this.db
      .prepare(
        `INSERT INTO events (id, sequence, workspace_id, run_id, task_id, kind, message, agent_id, timestamp, provenance, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        this.sequence,
        this.id,
        known("runs", runId),
        known("tasks", taskId),
        kind,
        String(message ?? "").slice(0, 500),
        agentId,
        Date.now(),
        provenance,
        data ? JSON.stringify(data) : null,
      );
    this.emit("change", this.snapshot());
  }

  changed(message, kind = "task", agentId, runId) {
    this.#record(message, kind, agentId, runId);
    this.emit("change", this.snapshot());
  }

  availableAgent(agentId) {
    const agent = this.snapshot().agents.find((a) => a.id === agentId);
    if (!agent) throw new InputError("Agent not found", 404);
    if (agent.taskId)
      throw new InputError(
        `${agent.name} is already working. Choose an available agent or add to queue.`,
        409,
      );
    return agent;
  }

  #startRun(task, agent) {
    // A task bound to a provider is executed by a managed run, which records
    // its own lifecycle. A placeholder here would say the task was running
    // before anything was, and would outlive the real run.
    if (task.provider) return null;
    const id = randomUUID();
    const now = Date.now();
    const snapshot = {
      name: agent.name,
      role: agent.role,
      color: agent.color,
      initials: agent.initials,
      specialty: agent.specialty,
      instructions: agent.instructions,
      workingState: agent.workingState,
      runtime: agent.runtime ?? null,
      model: agent.model ?? null,
      provider: agent.provider ?? null,
    };
    const mode = task.source === "demo" ? "simulated" : "manual";
    this.db
      .prepare(
        `INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, provider, requested_model, status, started_at, mode, title, last_event_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.id,
        task.id,
        agent.id,
        JSON.stringify(snapshot),
        mode,
        agent.model ?? null,
        now,
        mode,
        task.title,
        now,
      );
    return id;
  }

  activeRun(taskId) {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE task_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get(taskId);
    return row ? rowToRun(row) : null;
  }

  /**
   * Ends the manual placeholder runs on a task that provider work now owns,
   * so a placeholder never outlives the real run that replaced it. Each is
   * closed as cancelled with a system event saying why. Returns the ids.
   */
  closePlaceholders(
    taskId,
    {
      reason = "Closed the placeholder opened when this task was assigned: a provider runs this task, and the placeholder did no work.",
    } = {},
  ) {
    const open = this.db
      .prepare(
        "SELECT id, agent_id FROM runs WHERE task_id = ? AND mode = 'manual' AND ended_at IS NULL",
      )
      .all(taskId);
    if (!open.length) return [];
    const now = Date.now();
    const close = this.db.prepare(
      "UPDATE runs SET status = 'cancelled', ended_at = ?, last_event_at = ? WHERE id = ?",
    );
    for (const run of open) {
      close.run(now, now, run.id);
      this.#record(reason, "task", run.agent_id ?? undefined, run.id);
    }
    this.emit("change", this.snapshot());
    return open.map((run) => run.id);
  }

  /**
   * Mirrors a task status change onto its manual/simulated run. Observed and
   * managed runs are owned by the observation service and the run worker,
   * which record their own lifecycle; only the id is returned for them.
   */
  #syncRun(task) {
    const run = this.activeRun(task.id);
    if (!run) return undefined;
    if (run.mode === "observed" || run.mode === "managed") return run.id;
    const status =
      task.status === "COMPLETED"
        ? "completed"
        : task.status === "BLOCKED"
          ? "blocked"
          : "running";
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE runs SET status = ?, ended_at = ?, last_event_at = ? WHERE id = ?",
      )
      .run(status, task.status === "COMPLETED" ? now : null, now, run.id);
    return run.id;
  }

  #sourceFrom(input) {
    const source = input?.source;
    if (
      typeof source === "string" &&
      CLIENT_SOURCE.test(source) &&
      !RESERVED_SOURCES.has(source)
    )
      return source;
    return "manual";
  }

  create(input) {
    return transaction(this.db, () => {
      const agent = input?.agentId ? this.availableAgent(input.agentId) : null;
      let task = this.store.create(input, this.#sourceFrom(input));
      let runId;
      if (agent) {
        task = this.store.assign(task.id, agent.id);
        runId = this.#startRun(task, agent);
      }
      this.changed(
        agent
          ? task.provider
            ? `${agent.name} was assigned “${task.title}”`
            : `${agent.name} started “${task.title}”`
          : `Added “${task.title}” to the queue`,
        "task",
        agent?.id,
        runId,
      );
      return task;
    });
  }

  assign(id, agentId) {
    return transaction(this.db, () => {
      const agent = this.availableAgent(agentId);
      const task = this.store.assign(id, agentId);
      const runId = this.#startRun(task, agent);
      this.changed(
        task.provider
          ? `${agent.name} was assigned “${task.title}”`
          : `${agent.name} started “${task.title}”`,
        "task",
        agent.id,
        runId,
      );
      return task;
    });
  }

  update(id, input) {
    return transaction(this.db, () => {
      const task = this.store.update(id, input);
      const runId = this.#syncRun(task);
      const action =
        task.status === "COMPLETED"
          ? "Completed"
          : task.status === "BLOCKED"
            ? "Paused"
            : "Updated";
      this.changed(
        `${action} “${task.title}”`,
        task.status === "COMPLETED" ? "complete" : "task",
        task.assignedAgentId,
        runId,
      );
      return task;
    });
  }

  // Agent profile management. Runs keep their own snapshot, so these never
  // rewrite history.
  createAgent(input) {
    const agent = this.profiles.create(input);
    this.changed(
      `Added agent ${agent.name} (${agent.role})`,
      "system",
      agent.id,
    );
    return agent;
  }

  updateAgent(id, input) {
    const before = this.profiles.get(id);
    const agent = this.profiles.update(id, input);
    this.changed(
      before.name !== agent.name
        ? `Renamed ${before.name} to ${agent.name}`
        : `Updated ${agent.name}'s profile`,
      "system",
      agent.id,
    );
    return agent;
  }

  duplicateAgent(id) {
    const agent = this.profiles.duplicate(id);
    this.changed(`Duplicated profile as ${agent.name}`, "system", agent.id);
    return agent;
  }

  archiveAgent(id) {
    const agent = this.profiles.archive(id);
    this.changed(`Archived ${agent.name}`, "system", agent.id);
    return agent;
  }

  restoreAgent(id) {
    const agent = this.profiles.restore(id);
    this.changed(`Restored ${agent.name}`, "system", agent.id);
    return agent;
  }

  #requireDemo() {
    if (!this.isDemo)
      throw new InputError(
        "Demo simulation is only available in the demo workspace",
        409,
      );
  }

  setDemo(running) {
    this.#requireDemo();
    if (typeof running !== "boolean")
      throw new InputError("running must be a boolean");
    this.demoRunning = running;
    this.changed(`Demo simulation ${running ? "resumed" : "paused"}`, "system");
  }

  loadDemo() {
    this.#requireDemo();
    transaction(this.db, () => {
      this.store.removeDemoTasks();
      const samples = [
        [
          "Map the workspace architecture",
          "Break the workspace into clear modules and define the event contract.",
          64,
          "high",
        ],
        [
          "Build the agent dashboard",
          "Create responsive agent cards, task details, and the office viewport.",
          42,
          "high",
        ],
        [
          "Connect the live event stream",
          "Keep tasks and agent states synchronized across connected clients.",
          // Close to done, so the demo relay's handoff to Sage comes within
          // about a minute and a half of loading (one point per 8 s tick).
          90,
          "high",
        ],
        [
          "Test task assignment flow",
          "Verify assignment, progress updates, and completion from end to end.",
          31,
          "medium",
        ],
        [
          "Review deployment configuration",
          "Waiting for a target environment. Resume this task when the target is ready.",
          23,
          "critical",
        ],
        [
          "Explore animation references",
          "Find clear visual cues for researching, coding, testing, and idle states.",
          100,
          "low",
        ],
      ];
      // Simulated relay records from an earlier load describe tasks that no
      // longer exist; the new load writes its own.
      this.db
        .prepare(
          "DELETE FROM events WHERE workspace_id = ? AND kind IN ('team', 'handoff') AND json_extract(data, '$.simulated') = 1",
        )
        .run(this.id);
      const agents = this.snapshot().agents;
      let relayFrom = null;
      samples.forEach(([title, description, progress, priority], i) => {
        const agent = agents[i];
        if (!agent || agent.taskId) return;
        // Echo's task is the first leg of the demo relay (see DEMO_RELAY).
        const relay =
          i === 2
            ? { workflowId: DEMO_RELAY, templateId: DEMO_RELAY_TEMPLATE }
            : {};
        let task = this.store.create(
          { title, description, priority, ...relay },
          "demo",
        );
        if (i === 2) relayFrom = { task, agent };
        task = this.store.assign(task.id, agent.id);
        const runId = this.#startRun(task, agent);
        task = this.store.update(task.id, {
          progress,
          status: progress === 100 ? "COMPLETED" : "IN_PROGRESS",
        });
        if (i === 4) task = this.store.update(task.id, { status: "BLOCKED" });
        this.#syncRun(task);
        this.#record(
          `${agent.name} ${progress === 100 ? "completed" : i === 4 ? "paused" : "started"} “${title}”`,
          progress === 100 ? "complete" : "task",
          agent.id,
          runId,
        );
      });
      // The relay's second leg waits for Echo's task, already assigned to
      // Sage (the way a deployed team's later steps are), and starts when
      // Echo finishes.
      const relayTo = agents[5] && !agents[5].taskId ? agents[5] : null;
      const relayed = Boolean(relayFrom && relayTo);
      const documentTask = this.store.create(
        {
          title: "Document the integration contract",
          description:
            "Describe how external tools can submit tasks to the local workspace API.",
          priority: "medium",
          ...(relayed
            ? {
                dependsOn: [relayFrom.task.id],
                workflowId: DEMO_RELAY,
                templateId: DEMO_RELAY_TEMPLATE,
              }
            : {}),
        },
        "demo",
      );
      if (relayed) {
        this.db
          .prepare(
            "UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?",
          )
          .run(relayTo.id, Date.now(), documentTask.id);
        this.sequence++;
        this.db
          .prepare(
            `INSERT INTO events (id, sequence, workspace_id, kind, message, agent_id, timestamp, provenance, data)
             VALUES (?, ?, ?, 'team', ?, ?, ?, 'system', ?)`,
          )
          .run(
            randomUUID(),
            this.sequence,
            this.id,
            `Team assembled for “Live stream relay” (simulated): ${relayFrom.agent.name} (${relayFrom.agent.role}), ${relayTo.name} (${relayTo.role})`,
            relayFrom.agent.id,
            Date.now(),
            JSON.stringify({
              workflowId: DEMO_RELAY,
              simulated: true,
              members: [
                { agentId: relayFrom.agent.id, role: relayFrom.agent.role },
                { agentId: relayTo.id, role: relayTo.role },
              ],
            }),
          );
      }
      this.demoRunning = true;
      this.changed(
        "Demo workspace loaded. All agent activity is simulated.",
        "system",
      );
    });
  }

  tick() {
    if (!this.demoRunning || !this.isDemo) return;
    const active = this.store
      .list()
      .filter((t) => t.source === "demo" && t.status === "IN_PROGRESS");
    if (!active.length) return;
    transaction(this.db, () => {
      for (const task of active) {
        const progress = Math.min(100, task.progress + 1);
        const updated = this.store.update(task.id, {
          progress,
          status: progress === 100 ? "COMPLETED" : "IN_PROGRESS",
        });
        if (progress === 100) {
          const runId = this.#syncRun(updated);
          this.#record(
            `Completed “${task.title}”`,
            "complete",
            task.assignedAgentId,
            runId,
          );
          this.#demoHandoffs(updated);
        } else this.#demoSubagents(updated);
      }
    });
    this.sequence++;
    this.emit("change", this.snapshot());
  }

  /**
   * The demo relay's baton: when a demo task finishes, each queued demo task
   * that was waiting only on finished tasks starts with the agent it was
   * given, and a handoff naming both agents is recorded as simulated.
   */
  #demoHandoffs(finished) {
    const from = finished.assignedAgentId
      ? this.profiles.get(finished.assignedAgentId)
      : null;
    const tasks = this.store.list();
    const done = new Set(
      tasks.filter((t) => t.status === "COMPLETED").map((t) => t.id),
    );
    for (const next of tasks) {
      if (next.source !== "demo" || next.status !== "QUEUE") continue;
      if (!next.dependsOn?.includes(finished.id)) continue;
      if (!next.dependsOn.every((id) => done.has(id))) continue;
      const agentId = next.assignedAgentId;
      if (!agentId) continue;
      const agent = this.snapshot().agents.find((a) => a.id === agentId);
      if (!agent || agent.taskId) continue;
      const task = this.store.assign(next.id, agentId);
      const runId = this.#startRun(task, agent);
      this.#record(
        `${agent.name} started “${task.title}”`,
        "task",
        agentId,
        runId,
      );
      this.recordEvent({
        kind: "handoff",
        message: `${from?.name ?? "The previous step"} handed “${finished.title}” on to ${agent.name}, who started “${task.title}” (simulated)`,
        agentId: from?.id ?? null,
        runId,
        taskId: task.id,
        data: {
          fromAgentId: from?.id ?? null,
          toAgentId: agentId,
          fromTaskId: finished.id,
          toTaskId: task.id,
          workflowId: task.workflowId ?? null,
          artifacts: [],
          dispatched: true,
          simulated: true,
        },
      });
    }
  }

  /**
   * Scripted subagents on the demo's dashboard task: two open at every
   * tenth percent plus four, and report back two and four points later, so
   * the demo office shows helpers stepping out and returning. Simulated
   * delegation events, recorded like a provider's.
   */
  #demoSubagents(task) {
    if (task.title !== "Build the agent dashboard") return;
    const run = this.activeRun(task.id);
    if (!run) return;
    const step = task.progress % 10;
    const round = Math.floor(task.progress / 10) % DEMO_SUBAGENTS.length;
    const id = (index) =>
      `demo-${task.id.slice(0, 8)}-${task.progress - step}-${index}`;
    const [first, second] = DEMO_SUBAGENTS[round];
    const note = (kind, message, toolUseId) =>
      this.recordEvent({
        kind,
        message,
        agentId: task.assignedAgentId,
        runId: run.id,
        taskId: task.id,
        data: { toolUseId, simulated: true },
      });
    if (step === 4) {
      note("delegation", `Delegated: ${first}`, id(0));
      note("delegation", `Delegated: ${second}`, id(1));
    } else if (step === 6)
      note("tool.end", `Subagent reported back: ${first}`, id(0));
    else if (step === 8)
      note("tool.end", `Subagent reported back: ${second}`, id(1));
  }
}

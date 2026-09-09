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
 * Visible state of an agent. Observed and managed runs report what the
 * provider actually did (activity inferred from tool names, labelled as
 * such); manual and simulated tasks keep the profile's working state; a
 * BLOCKED task always wins.
 */
function agentState(agent, task, run) {
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
  return {
    state: agent.workingState,
    activityProvenance: task.source === "demo" ? "system" : "user",
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
      .map((row) => ({
        id: row.id,
        message: row.message,
        kind: row.kind,
        agentId: row.agent_id ?? undefined,
        runId: row.run_id ?? undefined,
        taskId: row.task_id ?? undefined,
        timestamp: row.timestamp,
        provenance: row.provenance ?? "system",
        tool: row.tool ?? null,
        file: row.file ?? null,
        activity: parseJson(row.data, {}).activity ?? null,
      }));
  }

  runs(limit = 100) {
    const now = Date.now();
    return this.db
      .prepare(
        "SELECT * FROM runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(this.id, limit)
      .map((row) => rowToRun(row, now));
  }

  /** Runs that currently occupy an agent (queued, running, blocked, waiting, stale). */
  activeRuns() {
    const now = Date.now();
    const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE workspace_id = ? AND status IN (${placeholders}) ORDER BY started_at DESC`,
      )
      .all(this.id, ...ACTIVE_RUN_STATUSES)
      .map((row) => rowToRun(row, now));
  }

  snapshot() {
    const now = Date.now();
    const tasks = this.store.list();
    const activeRuns = this.activeRuns();
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
      const { state, activityProvenance } = agentState(agent, task, run);
      return {
        ...agent,
        state,
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
        actualModel: run?.actualModel ?? null,
        lastEventAt: run?.lastEventAt ?? null,
        elapsedMs: run ? Math.max(0, now - run.startedAt) : null,
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
          ? `${agent.name} started “${task.title}”`
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
        `${agent.name} started “${task.title}”`,
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
          78,
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
      const agents = this.snapshot().agents;
      samples.forEach(([title, description, progress, priority], i) => {
        const agent = agents[i];
        if (!agent || agent.taskId) return;
        let task = this.store.create({ title, description, priority }, "demo");
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
      this.store.create(
        {
          title: "Document the integration contract",
          description:
            "Describe how external tools can submit tasks to the local workspace API.",
          priority: "medium",
        },
        "demo",
      );
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
        }
      }
    });
    this.sequence++;
    this.emit("change", this.snapshot());
  }
}

import { randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";
import { classifyTool, TERMINAL_RUN_STATUSES } from "../contracts.js";

/** Event kinds whose summary is the agent's "current action" on cards. */
const ACTION_KINDS = new Set([
  "tool.start",
  "tool.end",
  "file.edit",
  "file.write",
  "file.read",
  "search",
  "web",
  "command",
  "test",
  "message",
  "prompt",
  "delegation",
  "approval.request",
]);

const ACTIVITY_BY_KIND = {
  "file.edit": "CODING",
  "file.write": "CODING",
  "file.read": "RESEARCHING",
  search: "RESEARCHING",
  web: "RESEARCHING",
  test: "TESTING",
  command: "COMMANDING",
  reasoning: "ANALYZING",
  message: "MESSAGING",
  delegation: "DELEGATING",
  "approval.request": "WAITING_APPROVAL",
  error: "ERROR",
};

function rowToRun(row) {
  const json = (value, fallback) => {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    agentSnapshot: json(row.agent_snapshot, {}),
    connectionId: row.connection_id ?? null,
    provider: row.provider,
    requestedModel: row.requested_model ?? null,
    actualModel: row.actual_model ?? null,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    mode: row.mode,
    providerSessionId: row.provider_session_id ?? null,
    cwd: row.cwd ?? null,
    branch: row.branch ?? null,
    worktree: row.worktree ?? null,
    host: row.host,
    label: row.label ?? null,
    title: row.title ?? null,
    currentAction: row.current_action ?? null,
    currentFile: row.current_file ?? null,
    activity: row.activity ?? null,
    lastEventAt: row.last_event_at ?? null,
    usage: json(row.usage, {}),
    cost: json(row.cost, {}),
    exitCode: row.exit_code ?? null,
    error: row.error ?? null,
    pid: row.pid ?? null,
    sourcePath: row.source_path ?? null,
    sourceOffset: row.source_offset ?? 0,
    summary: row.summary ?? null,
    orchestrationOwner: row.orchestration_owner,
    attempt: row.attempt,
    parentRunId: row.parent_run_id ?? null,
    configSnapshot: json(row.config_snapshot, {}),
    context: json(row.context, {}),
    prompt: row.prompt ?? null,
  };
}

function rowToEvent(row) {
  let data = {};
  try {
    data = row.data ? JSON.parse(row.data) : {};
  } catch {
    data = {};
  }
  return {
    id: row.id,
    sequence: row.sequence,
    workspaceId: row.workspace_id,
    runId: row.run_id ?? null,
    taskId: row.task_id ?? null,
    kind: row.kind,
    message: row.message,
    agentId: row.agent_id ?? null,
    timestamp: row.timestamp,
    provenance: row.provenance,
    tool: row.tool ?? null,
    file: row.file ?? null,
    providerEventId: row.provider_event_id ?? null,
    data,
  };
}

function truncateData(data, limit = 4000) {
  const text = JSON.stringify(data ?? {});
  if (text.length <= limit) return text;
  return JSON.stringify({ truncated: true, preview: text.slice(0, limit) });
}

/**
 * Single write path for run activity. Observers, managed-run adapters, and
 * the hook bridge all call `applyEvent`, so dedup, activity inference, task
 * mirroring, and snapshot broadcasting live in one place.
 */
export class RunRecorder {
  constructor(services, { broadcastIntervalMs = 250, now = Date.now } = {}) {
    this.db = services.db;
    this.hub = services.hub;
    this.bus = services.bus;
    this.broadcastIntervalMs = broadcastIntervalMs;
    /**
     * Clock used whenever a provider event carries no timestamp of its own.
     * Injectable so a test can compare two runs of the same stream: with the
     * real clock those events differ by milliseconds and nothing is comparable.
     */
    this.now = now;
    this.pending = new Map();
    /**
     * runId → { activity, currentAction, currentFile, actualModel }: the
     * timestamp of the event that last set each "latest state" field. Events
     * that arrive out of order (a replayed transcript, a hook event racing the
     * stream) must not let an older event overwrite a newer one; usage totals
     * are additive and need no guard. Kept in memory: after a restart the
     * first event applied wins again, which is the pre-existing behaviour.
     */
    this.latestAt = new Map();
  }

  get(runId) {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!row) throw new InputError("Run not found", 404);
    return rowToRun(row);
  }

  /**
   * Every attempt belonging to one conversation, oldest first: the run asked
   * for, everything it was resumed from, and everything resumed from it.
   *
   * Continuing a conversation with a headless provider creates a new run
   * linked by `parent_run_id` (RunWorker.input), so the chain is what a
   * person actually experienced as one exchange. The walk is guarded against
   * a cycle, which the schema does not forbid.
   */
  chain(runId) {
    const start = this.get(runId);
    const byId = this.db.prepare("SELECT * FROM runs WHERE id = ?");
    const byParent = this.db.prepare(
      "SELECT * FROM runs WHERE parent_run_id = ? ORDER BY attempt ASC, started_at ASC",
    );
    let root = start;
    const climbed = new Set([start.id]);
    while (root.parentRunId && !climbed.has(root.parentRunId)) {
      climbed.add(root.parentRunId);
      const parent = byId.get(root.parentRunId);
      if (!parent) break;
      root = rowToRun(parent);
    }
    const out = [];
    const seen = new Set();
    const queue = [root];
    while (queue.length) {
      const run = queue.shift();
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      out.push(run);
      for (const row of byParent.all(run.id)) queue.push(rowToRun(row));
    }
    return out;
  }

  find({ provider, providerSessionId }) {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE provider = ? AND provider_session_id = ?",
      )
      .get(provider, providerSessionId);
    return row ? rowToRun(row) : null;
  }

  list(workspaceId, { status, mode, limit = 100 } = {}) {
    const clauses = ["workspace_id = ?"];
    const params = [workspaceId];
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (mode) {
      clauses.push("mode = ?");
      params.push(mode);
    }
    params.push(limit);
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...params)
      .map(rowToRun);
  }

  active() {
    return this.db
      .prepare(
        "SELECT * FROM runs WHERE status IN ('queued','running','blocked','waiting_approval','stale') ORDER BY started_at DESC",
      )
      .all()
      .map(rowToRun);
  }

  /**
   * Creates a run (and optionally its task) for a workspace. When
   * `providerSessionId` is given and a run already exists for that provider
   * session, the existing run is returned instead.
   */
  ensureRun(input) {
    const {
      workspaceId,
      agentId,
      mode,
      provider,
      providerSessionId = null,
      taskId = null,
      createTask = null,
      cwd = null,
      branch = null,
      worktree = null,
      host = "local",
      label = null,
      title = null,
      prompt = null,
      requestedModel = null,
      connectionId = null,
      context = {},
      configSnapshot = {},
      sourcePath = null,
      pid = null,
      status = "running",
      startedAt = Date.now(),
      parentRunId = null,
      attempt = 1,
      orchestrationOwner = "agent-space",
    } = input;
    if (providerSessionId) {
      const existing = this.find({ provider, providerSessionId });
      if (existing) return existing;
    }
    const workspace = this.hub.get(workspaceId);
    const agent = workspace.profiles.get(agentId);
    let task = null;
    if (taskId) task = workspace.store.get(taskId);
    else if (createTask) {
      task = workspace.store.create(
        {
          title: createTask.title,
          description: createTask.description ?? "",
          priority: createTask.priority ?? "medium",
        },
        createTask.source ?? mode,
      );
    }
    if (!task) throw new InputError("A task is required to start a run");
    if (task.status === "QUEUE") {
      const busy = workspace.store
        .list()
        .some(
          (t) =>
            t.assignedAgentId === agent.id &&
            ["IN_PROGRESS", "BLOCKED"].includes(t.status) &&
            t.id !== task.id,
        );
      if (busy) throw new InputError(`${agent.name} is already working`, 409);
      task = workspace.store.assign(task.id, agent.id);
    }
    const id = randomUUID();
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
    this.db
      .prepare(
        `INSERT INTO runs (id, workspace_id, task_id, agent_id, agent_snapshot, connection_id, provider, requested_model, status, started_at,
           mode, provider_session_id, cwd, branch, worktree, host, label, title, prompt, context, config_snapshot, source_path, pid, parent_run_id, attempt, orchestration_owner, last_event_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        task.id,
        agent.id,
        JSON.stringify(snapshot),
        connectionId,
        provider,
        requestedModel,
        status,
        startedAt,
        mode,
        providerSessionId,
        cwd,
        branch,
        worktree,
        host,
        label,
        title ?? task.title,
        prompt,
        JSON.stringify(context ?? {}),
        JSON.stringify(configSnapshot ?? {}),
        sourcePath,
        pid,
        parentRunId,
        attempt,
        orchestrationOwner,
        startedAt,
      );
    this.record(id, {
      kind: "session.start",
      provenance: mode === "observed" ? "provider" : "system",
      summary:
        mode === "observed"
          ? `${agent.name} session observed (${provider})`
          : `${agent.name} started “${task.title}” via ${provider}`,
      timestamp: startedAt,
      providerEventId: providerSessionId
        ? `${provider}:${providerSessionId}:start`
        : null,
    });
    this.scheduleBroadcast(workspaceId);
    return this.get(id);
  }

  update(runId, fields) {
    const map = {
      status: "status",
      endedAt: "ended_at",
      actualModel: "actual_model",
      branch: "branch",
      worktree: "worktree",
      label: "label",
      title: "title",
      currentAction: "current_action",
      currentFile: "current_file",
      activity: "activity",
      lastEventAt: "last_event_at",
      exitCode: "exit_code",
      error: "error",
      pid: "pid",
      sourcePath: "source_path",
      sourceOffset: "source_offset",
      summary: "summary",
      providerSessionId: "provider_session_id",
      cwd: "cwd",
      connectionId: "connection_id",
    };
    const jsonMap = {
      usage: "usage",
      cost: "cost",
      context: "context",
      configSnapshot: "config_snapshot",
    };
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(fields)) {
      if (map[key]) {
        sets.push(`${map[key]} = ?`);
        params.push(value ?? null);
      } else if (jsonMap[key]) {
        sets.push(`${jsonMap[key]} = ?`);
        params.push(JSON.stringify(value ?? {}));
      }
    }
    if (!sets.length) return this.get(runId);
    params.push(runId);
    this.db
      .prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    return this.get(runId);
  }

  /** Inserts one normalized event. Returns null when a duplicate was skipped. */
  record(runId, event) {
    const run = this.get(runId);
    if (event.providerEventId) {
      const dup = this.db
        .prepare("SELECT id FROM events WHERE provider_event_id = ?")
        .get(event.providerEventId);
      if (dup) return null;
    }
    const runtime = this.hub.get(run.workspaceId);
    runtime.sequence++;
    const id = randomUUID();
    const timestamp = event.timestamp ?? this.now();
    const activity =
      event.activity ??
      (event.tool ? classifyTool(event.tool, event.data) : null) ??
      ACTIVITY_BY_KIND[event.kind] ??
      null;
    this.db
      .prepare(
        `INSERT INTO events (id, sequence, workspace_id, run_id, task_id, kind, message, agent_id, timestamp, provenance, data, tool, file, provider_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runtime.sequence,
        run.workspaceId,
        runId,
        run.taskId,
        event.kind ?? "status",
        String(event.summary ?? "").slice(0, 500),
        run.agentId,
        timestamp,
        event.provenance ?? "provider",
        truncateData({
          ...(event.data ?? {}),
          activity: activity ?? undefined,
        }),
        event.tool ?? null,
        event.file ?? null,
        event.providerEventId ?? null,
      );
    return { id, activity, timestamp };
  }

  /**
   * Records an event and folds it into the run's live fields: activity,
   * current action/file, model, usage, last event time, and status hints.
   */
  applyEvent(runId, event) {
    const stored = this.record(runId, event);
    if (!stored) return null;
    const run = this.get(runId);
    const fields = {
      lastEventAt: Math.max(run.lastEventAt ?? 0, stored.timestamp),
    };
    // Out-of-order guard: a field is only overwritten by an event at least as
    // new as the one that last set it. Equal timestamps keep arrival order.
    const marks = this.latestAt.get(runId) ?? {};
    const fresh = (key) => !(marks[key] > stored.timestamp);
    const mark = (key) => {
      marks[key] = stored.timestamp;
    };
    if (
      stored.activity &&
      !TERMINAL_RUN_STATUSES.includes(run.status) &&
      fresh("activity")
    ) {
      fields.activity = stored.activity;
      mark("activity");
    }
    // Usage/status/system notes must not displace the last real action.
    if (
      event.summary &&
      ACTION_KINDS.has(event.kind) &&
      fresh("currentAction")
    ) {
      fields.currentAction = String(event.summary).slice(0, 200);
      mark("currentAction");
    }
    if (event.file && fresh("currentFile")) {
      fields.currentFile = String(event.file).slice(0, 500);
      mark("currentFile");
    }
    if (event.model && fresh("actualModel")) {
      fields.actualModel = event.model;
      mark("actualModel");
    }
    this.latestAt.set(runId, marks);
    if (event.usage && typeof event.usage === "object") {
      fields.usage = mergeUsage(run.usage, event.usage);
    }
    if (event.kind === "approval.request" && run.status === "running")
      fields.status = "waiting_approval";
    if (event.kind === "approval.decision" && run.status === "waiting_approval")
      fields.status = "running";
    // Only a run-level error is the run's error. A failed tool call carries a
    // tool name or tool-use id, and the session usually carries on; making it
    // the run's error showed a shell exit code as the session's failure.
    const toolScoped = Boolean(
      event.tool ||
      event.data?.toolUseId ||
      event.data?.toolCallId ||
      event.data?.isError,
    );
    if (event.kind === "error" && !toolScoped)
      fields.error = String(event.summary).slice(0, 500);
    if (run.status === "stale" && event.kind !== "session.end") {
      fields.status = "running";
    }
    this.update(runId, fields);
    this.scheduleBroadcast(run.workspaceId);
    return stored;
  }

  applyEvents(runId, events) {
    let count = 0;
    for (const event of events) if (this.applyEvent(runId, event)) count++;
    return count;
  }

  /**
   * Moves a run to a new status and mirrors it onto the task.
   * - completed (observed): task COMPLETED
   * - completed (managed): task stays IN_PROGRESS with review pending
   * - failed/cancelled/disconnected: task BLOCKED with the reason recorded
   */
  setStatus(
    runId,
    status,
    { error = null, exitCode = null, summary = null, mirrorTask = true } = {},
  ) {
    const run = this.get(runId);
    const ended =
      TERMINAL_RUN_STATUSES.includes(status) || status === "disconnected";
    const fields = { status };
    if (ended) fields.endedAt = Date.now();
    if (error !== null) fields.error = error;
    if (exitCode !== null) fields.exitCode = exitCode;
    if (summary !== null) fields.summary = summary;
    if (status === "stale") fields.activity = "STALE";
    if (status === "waiting_approval") fields.activity = "WAITING_APPROVAL";
    if (ended) fields.activity = status === "completed" ? "IDLE" : "ERROR";
    if (ended) this.latestAt.delete(runId);
    this.update(runId, fields);
    const workspace = this.hub.get(run.workspaceId);
    if (mirrorTask && run.taskId) {
      try {
        const task = workspace.store.get(run.taskId);
        if (task.status !== "COMPLETED") {
          if (status === "completed" && run.mode === "observed")
            workspace.store.update(task.id, { status: "COMPLETED" });
          else if (status === "completed" && run.mode === "managed")
            this.db
              .prepare(
                "UPDATE tasks SET review = ?, updated_at = ? WHERE id = ?",
              )
              .run(
                JSON.stringify({ runId, status: "pending" }),
                Date.now(),
                task.id,
              );
          else if (
            ["failed", "cancelled", "disconnected"].includes(status) &&
            task.status === "IN_PROGRESS"
          )
            workspace.store.update(task.id, { status: "BLOCKED" });
        }
      } catch {
        /* task may have been removed */
      }
    }
    const kind =
      status === "completed" ? "complete" : ended ? "error" : "status";
    this.record(runId, {
      kind,
      provenance: "system",
      summary:
        summary ??
        (status === "completed"
          ? `Run completed${run.title ? ` for “${run.title}”` : ""}`
          : status === "stale"
            ? "No activity from the provider for a while; marked stale"
            : `Run ${status}${error ? `: ${error}` : ""}`),
      timestamp: Date.now(),
    });
    this.scheduleBroadcast(run.workspaceId, true);
    return this.get(runId);
  }

  events(runId, { after = 0, limit = 500 } = {}) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
      )
      .all(runId, after, limit)
      .map(rowToEvent);
  }

  addArtifact(
    runId,
    {
      kind,
      path = "",
      title = null,
      content = null,
      taskId = null,
      metadata = {},
    },
  ) {
    const run = this.get(runId);
    const id = randomUUID();
    const size = content ? Buffer.byteLength(content) : 0;
    this.db
      .prepare(
        `INSERT INTO artifacts (id, run_id, kind, path, created_at, workspace_id, task_id, title, content, size, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        kind,
        path,
        Date.now(),
        run.workspaceId,
        taskId ?? run.taskId,
        title,
        content,
        size,
        JSON.stringify(metadata ?? {}),
      );
    this.record(runId, {
      kind: "status",
      provenance: "system",
      summary: `Artifact captured: ${title ?? kind}`,
      data: { artifactId: id, kind, size },
      timestamp: Date.now(),
    });
    this.scheduleBroadcast(run.workspaceId);
    return this.artifact(id);
  }

  artifact(id) {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
    if (!row) throw new InputError("Artifact not found", 404);
    return {
      id: row.id,
      runId: row.run_id,
      workspaceId: row.workspace_id,
      taskId: row.task_id,
      kind: row.kind,
      path: row.path,
      title: row.title,
      content: row.content,
      size: row.size,
      metadata: JSON.parse(row.metadata || "{}"),
      createdAt: row.created_at,
    };
  }

  artifacts(runId, { withContent = false } = {}) {
    return this.db
      .prepare(
        "SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC",
      )
      .all(runId)
      .map((row) => {
        const artifact = this.artifact(row.id);
        if (!withContent) delete artifact.content;
        return artifact;
      });
  }

  /** Coalesces snapshot broadcasts so a burst of events costs one emit. */
  scheduleBroadcast(workspaceId, immediate = false) {
    if (immediate) {
      const timer = this.pending.get(workspaceId);
      if (timer) clearTimeout(timer);
      this.pending.delete(workspaceId);
      this.emit(workspaceId);
      return;
    }
    if (this.pending.has(workspaceId)) return;
    const timer = setTimeout(() => {
      this.pending.delete(workspaceId);
      this.emit(workspaceId);
    }, this.broadcastIntervalMs);
    timer.unref?.();
    this.pending.set(workspaceId, timer);
  }

  emit(workspaceId) {
    try {
      const runtime = this.hub.get(workspaceId);
      runtime.emit("change", runtime.snapshot());
      this.bus.emit("global");
    } catch {
      /* workspace removed */
    }
  }

  flush() {
    for (const [workspaceId, timer] of this.pending) {
      clearTimeout(timer);
      this.emit(workspaceId);
    }
    this.pending.clear();
  }
}

export function mergeUsage(current = {}, incoming = {}) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (
      typeof value === "number" &&
      typeof merged[key] === "number" &&
      /token|request/i.test(key)
    )
      merged[key] += value;
    else if (typeof value === "number" && merged[key] === undefined)
      merged[key] = value;
    else if (typeof value !== "object") merged[key] = value;
  }
  // Never default to "provider". The source states its own provenance:
  // adapters that read a documented usage field say "provider"; an observer
  // parsing an unverified file format says "unverified". Stamping every usage
  // object as provider-reported made budget headroom and the Usage tab claim a
  // reliability the parse never had.
  const reportedBy = incoming.reportedBy ?? current.reportedBy ?? null;
  if (reportedBy === null) delete merged.reportedBy;
  else merged.reportedBy = reportedBy;
  return merged;
}

export { rowToRun, rowToEvent };

import { randomUUID } from "node:crypto";
import { openDatabase } from "./db.js";

const priorities = ["critical", "high", "medium", "low"];
const transitions = {
  QUEUE: ["IN_PROGRESS"],
  IN_PROGRESS: ["BLOCKED", "COMPLETED"],
  BLOCKED: ["IN_PROGRESS"],
  COMPLETED: [],
};

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const PROVIDER_IDS = ["claude-code", "codex", "copilot", "cursor", "gemini"];
const AUTONOMIES = ["observe-only", "propose", "sandbox", "scoped"];

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function rowToTask(row) {
  const task = {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    progress: row.progress,
    source: row.source,
    createdAt: row.created_at,
    // Schema v2 execution fields (roadmap R2–R5).
    dependsOn: parseJson(row.depends_on, []),
    deliverable: row.deliverable ?? "",
    target: parseJson(row.target, {}),
    provider: row.provider ?? null,
    executionPolicy: parseJson(row.execution_policy, {}),
    templateId: row.template_id ?? null,
    workflowId: row.workflow_id ?? null,
    review: parseJson(row.review, {}),
    updatedAt: row.updated_at ?? null,
  };
  if (row.assigned_agent_id) task.assignedAgentId = row.assigned_agent_id;
  if (row.started_at) task.startedAt = row.started_at;
  if (row.completed_at) task.completedAt = row.completed_at;
  return task;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max)
    throw new InputError(`${field} must be a string under ${max} characters`);
  return value.trim();
}

/**
 * Validates the optional schema v2 fields a task may be created with:
 * deliverable, target ({ folder, files[], range }), provider, executionPolicy
 * ({ autonomy, isolation, timeoutMs }), dependsOn (task ids in the same
 * workspace), templateId, workflowId. Unknown keys are ignored.
 */
function validateExtras(input, db, workspaceId) {
  const extras = {};
  const deliverable = optionalText(input.deliverable, "Deliverable", 2000);
  if (deliverable !== undefined) extras.deliverable = deliverable;
  if (input.provider !== undefined && input.provider !== null) {
    if (!PROVIDER_IDS.includes(input.provider))
      throw new InputError(
        `provider must be one of ${PROVIDER_IDS.join(", ")}`,
      );
    extras.provider = input.provider;
  }
  if (input.target !== undefined && input.target !== null) {
    const t = input.target;
    if (typeof t !== "object" || Array.isArray(t))
      throw new InputError("target must be an object");
    const target = {};
    const folder = optionalText(t.folder, "target.folder", 500);
    if (folder) target.folder = folder;
    if (t.files !== undefined) {
      if (
        !Array.isArray(t.files) ||
        t.files.length > 200 ||
        !t.files.every((f) => typeof f === "string" && f.length <= 500)
      )
        throw new InputError("target.files must be an array of paths");
      target.files = t.files.map((f) => f.trim()).filter(Boolean);
    }
    if (t.range !== undefined && t.range !== null) {
      const r = t.range;
      if (
        typeof r !== "object" ||
        typeof r.file !== "string" ||
        !Number.isInteger(r.start) ||
        !Number.isInteger(r.end) ||
        r.start < 1 ||
        r.end < r.start
      )
        throw new InputError("target.range needs { file, start, end }");
      target.range = { file: r.file, start: r.start, end: r.end };
      if (typeof r.revision === "string") target.range.revision = r.revision;
    }
    extras.target = target;
  }
  if (input.executionPolicy !== undefined && input.executionPolicy !== null) {
    const p = input.executionPolicy;
    if (typeof p !== "object" || Array.isArray(p))
      throw new InputError("executionPolicy must be an object");
    const policy = {};
    if (p.autonomy !== undefined) {
      if (!AUTONOMIES.includes(p.autonomy))
        throw new InputError(
          `executionPolicy.autonomy must be one of ${AUTONOMIES.join(", ")}`,
        );
      policy.autonomy = p.autonomy;
    }
    if (p.isolation !== undefined) {
      if (!["none", "worktree"].includes(p.isolation))
        throw new InputError(
          'executionPolicy.isolation must be "none" or "worktree"',
        );
      policy.isolation = p.isolation;
    }
    if (p.timeoutMs !== undefined) {
      if (!Number.isInteger(p.timeoutMs) || p.timeoutMs < 60000)
        throw new InputError("executionPolicy.timeoutMs must be >= 60000");
      policy.timeoutMs = p.timeoutMs;
    }
    extras.executionPolicy = policy;
  }
  if (input.dependsOn !== undefined && input.dependsOn !== null) {
    if (
      !Array.isArray(input.dependsOn) ||
      input.dependsOn.length > 100 ||
      !input.dependsOn.every((id) => typeof id === "string" && id)
    )
      throw new InputError("dependsOn must be an array of task ids");
    const ids = [...new Set(input.dependsOn)];
    for (const id of ids) {
      const exists = db
        .prepare("SELECT id FROM tasks WHERE id = ? AND workspace_id = ?")
        .get(id, workspaceId);
      if (!exists)
        throw new InputError(
          `Dependency ${id} does not exist in this workspace`,
        );
    }
    extras.dependsOn = ids;
  }
  const templateId = optionalText(input.templateId, "templateId", 120);
  if (templateId) extras.templateId = templateId;
  const workflowId = optionalText(input.workflowId, "workflowId", 120);
  if (workflowId) extras.workflowId = workflowId;
  return extras;
}

/**
 * Task records for one workspace, persisted in SQLite. Without arguments it
 * creates a private in-memory database with a single demo-capable workspace,
 * which is convenient for tests and scripts.
 */
export class TaskStore {
  constructor(db, workspaceId) {
    if (!db) {
      db = openDatabase();
      workspaceId = "local";
      db.prepare(
        "INSERT INTO workspaces (id, name, kind, created_at) VALUES (?, ?, 'demo', ?)",
      ).run(workspaceId, "Local workspace", Date.now());
    }
    this.db = db;
    this.workspaceId = workspaceId;
    const exists = db
      .prepare("SELECT id FROM workspaces WHERE id = ?")
      .get(workspaceId);
    if (!exists) throw new InputError("Workspace not found", 404);
  }

  #get(id) {
    return this.db
      .prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
      .get(id, this.workspaceId);
  }

  list() {
    return this.db
      .prepare("SELECT * FROM tasks WHERE workspace_id = ?")
      .all(this.workspaceId)
      .map(rowToTask)
      .sort(
        (a, b) =>
          priorities.indexOf(a.priority) - priorities.indexOf(b.priority) ||
          a.createdAt - b.createdAt,
      );
  }

  get(id) {
    const row = this.#get(id);
    if (!row) throw new InputError("Task not found", 404);
    return rowToTask(row);
  }

  create(input, source = "manual") {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new InputError("Expected an object");
    if (
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 200
    ) {
      throw new InputError("Title must contain 1–200 characters");
    }
    const priority = input.priority ?? "medium";
    if (!priorities.includes(priority))
      throw new InputError("Invalid priority");
    if (
      input.description !== undefined &&
      (typeof input.description !== "string" || input.description.length > 2000)
    )
      throw new InputError("Description must be under 2000 characters");
    const extras = validateExtras(input, this.db, this.workspaceId);
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, description, priority, status, progress, source, created_at,
           depends_on, deliverable, target, provider, execution_policy, template_id, workflow_id, updated_at)
         VALUES (?, ?, ?, ?, ?, 'QUEUE', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.workspaceId,
        input.title.trim(),
        input.description ?? "",
        priority,
        source,
        createdAt,
        JSON.stringify(extras.dependsOn ?? []),
        extras.deliverable ?? "",
        JSON.stringify(extras.target ?? {}),
        extras.provider ?? null,
        JSON.stringify(extras.executionPolicy ?? {}),
        extras.templateId ?? null,
        extras.workflowId ?? null,
        createdAt,
      );
    return this.get(id);
  }

  assign(id, agentId) {
    const row = this.#get(id);
    if (!row) throw new InputError("Task not found", 404);
    if (row.status !== "QUEUE")
      throw new InputError("Only queued tasks can be assigned", 409);
    const startedAt = Date.now();
    this.db
      .prepare(
        "UPDATE tasks SET assigned_agent_id = ?, status = 'IN_PROGRESS', started_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(agentId, startedAt, startedAt, id);
    return this.get(id);
  }

  removeDemoTasks() {
    const demoTasks = this.db
      .prepare(
        "SELECT id FROM tasks WHERE workspace_id = ? AND source = 'demo'",
      )
      .all(this.workspaceId);
    for (const { id } of demoTasks) {
      this.db
        .prepare(
          "DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?)",
        )
        .run(id);
      this.db.prepare("DELETE FROM runs WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    }
  }

  update(id, input) {
    const row = this.#get(id);
    if (!row) throw new InputError("Task not found", 404);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new InputError("Expected an object");
    const { status, progress } = input;
    if (status === undefined && progress === undefined)
      throw new InputError("Provide status or progress");
    if (row.status === "COMPLETED")
      throw new InputError("Completed tasks cannot be modified", 409);
    if (
      status !== undefined &&
      status !== row.status &&
      !transitions[row.status].includes(status)
    ) {
      throw new InputError("Invalid status transition", 409);
    }
    if (
      progress !== undefined &&
      (typeof progress !== "number" ||
        !Number.isFinite(progress) ||
        progress < row.progress ||
        progress > 100)
    ) {
      throw new InputError(
        "Progress must be a number between current progress and 100",
      );
    }
    const next = status ?? row.status;
    if (
      progress !== undefined &&
      next !== "IN_PROGRESS" &&
      next !== "COMPLETED"
    )
      throw new InputError("Progress requires an active task");
    if (progress === 100 && next !== "COMPLETED")
      throw new InputError("Use COMPLETED status for 100% progress");
    const now = Date.now();
    const nextProgress =
      next === "COMPLETED" ? 100 : (progress ?? row.progress);
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, progress = ?,
           started_at = CASE WHEN ? = 'IN_PROGRESS' THEN COALESCE(started_at, ?) ELSE started_at END,
           completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(next, nextProgress, next, now, next, now, now, id);
    return this.get(id);
  }
}

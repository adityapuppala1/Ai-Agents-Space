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
  };
  if (row.assigned_agent_id) task.assignedAgentId = row.assigned_agent_id;
  if (row.started_at) task.startedAt = row.started_at;
  if (row.completed_at) task.completedAt = row.completed_at;
  return task;
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
    const task = {
      id: randomUUID(),
      title: input.title.trim(),
      description: input.description ?? "",
      priority,
      status: "QUEUE",
      progress: 0,
      source,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, description, priority, status, progress, source, created_at)
         VALUES (?, ?, ?, ?, ?, 'QUEUE', 0, ?, ?)`,
      )
      .run(
        task.id,
        this.workspaceId,
        task.title,
        task.description,
        task.priority,
        task.source,
        task.createdAt,
      );
    return task;
  }

  assign(id, agentId) {
    const row = this.#get(id);
    if (!row) throw new InputError("Task not found", 404);
    if (row.status !== "QUEUE")
      throw new InputError("Only queued tasks can be assigned", 409);
    const startedAt = Date.now();
    this.db
      .prepare(
        "UPDATE tasks SET assigned_agent_id = ?, status = 'IN_PROGRESS', started_at = ? WHERE id = ?",
      )
      .run(agentId, startedAt, id);
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
           completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END
         WHERE id = ?`,
      )
      .run(next, nextProgress, next, now, next, now, id);
    return this.get(id);
  }
}

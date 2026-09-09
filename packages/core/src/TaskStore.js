import { randomUUID } from "node:crypto";

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

export class TaskStore {
  #tasks = new Map();

  list() {
    return structuredClone(
      [...this.#tasks.values()].sort(
        (a, b) =>
          priorities.indexOf(a.priority) - priorities.indexOf(b.priority) ||
          a.createdAt - b.createdAt,
      ),
    );
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
    this.#tasks.set(task.id, task);
    return structuredClone(task);
  }

  assign(id, agentId) {
    const task = this.#tasks.get(id);
    if (!task) throw new InputError("Task not found", 404);
    if (task.status !== "QUEUE")
      throw new InputError("Only queued tasks can be assigned", 409);
    task.assignedAgentId = agentId;
    task.status = "IN_PROGRESS";
    task.startedAt = Date.now();
    return structuredClone(task);
  }

  removeDemoTasks() {
    for (const [id, task] of this.#tasks)
      if (task.source === "demo") this.#tasks.delete(id);
  }

  update(id, input) {
    const task = this.#tasks.get(id);
    if (!task) throw new InputError("Task not found", 404);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new InputError("Expected an object");
    const { status, progress } = input;
    if (status === undefined && progress === undefined)
      throw new InputError("Provide status or progress");
    if (task.status === "COMPLETED")
      throw new InputError("Completed tasks cannot be modified", 409);
    if (
      status !== undefined &&
      status !== task.status &&
      !transitions[task.status].includes(status)
    ) {
      throw new InputError("Invalid status transition", 409);
    }
    if (
      progress !== undefined &&
      (typeof progress !== "number" ||
        !Number.isFinite(progress) ||
        progress < task.progress ||
        progress > 100)
    ) {
      throw new InputError(
        "Progress must be a number between current progress and 100",
      );
    }
    const next = status ?? task.status;
    if (
      progress !== undefined &&
      next !== "IN_PROGRESS" &&
      next !== "COMPLETED"
    )
      throw new InputError("Progress requires an active task");
    if (progress === 100 && next !== "COMPLETED")
      throw new InputError("Use COMPLETED status for 100% progress");
    task.status = next;
    if (progress !== undefined) task.progress = progress;
    if (next === "IN_PROGRESS") task.startedAt ??= Date.now();
    if (next === "COMPLETED") {
      task.progress = 100;
      task.completedAt = Date.now();
    }
    return structuredClone(task);
  }
}

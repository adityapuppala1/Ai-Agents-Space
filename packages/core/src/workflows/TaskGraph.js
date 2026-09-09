import { InputError } from "../TaskStore.js";
import { DEFAULT_POLICY } from "../contracts.js";

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function rowToNode(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    provider: row.provider ?? null,
    agentId: row.assigned_agent_id ?? null,
    workflowId: row.workflow_id ?? null,
    dependsOn: parseJson(row.depends_on, []),
  };
}

/**
 * Task dependency graph stored in `tasks.depends_on`. Validates edges
 * (existence, same workspace, no self edge, no cycles), answers readiness
 * questions, computes the critical path, and auto-dispatches dependents when
 * a task completes and the workspace policy allows it.
 *
 * Constructor: `new TaskGraph(services)` — uses services.db, services.hub,
 * and optionally services.audit, services.policy, services.runWorker.
 */
export class TaskGraph {
  constructor(services) {
    this.services = services;
    this.db = services.db;
    this.hub = services.hub;
    this.dispatched = new Set();
    this.knownCompleted = new Map();
    this._unwatch = null;
  }

  #rows(workspaceId) {
    return this.db
      .prepare(
        "SELECT id, title, status, priority, provider, assigned_agent_id, depends_on, workflow_id, created_at FROM tasks WHERE workspace_id = ? ORDER BY created_at",
      )
      .all(workspaceId);
  }

  #row(taskId) {
    return this.db
      .prepare(
        "SELECT id, workspace_id, title, status, priority, provider, assigned_agent_id, depends_on, workflow_id FROM tasks WHERE id = ?",
      )
      .get(taskId);
  }

  #policy(workspaceId) {
    const fromService = this.services.policy?.forWorkspace?.(workspaceId);
    if (fromService) return fromService;
    const row = this.db
      .prepare("SELECT policy FROM workspaces WHERE id = ?")
      .get(workspaceId);
    return { ...DEFAULT_POLICY, ...parseJson(row?.policy, {}) };
  }

  /** Returns the validated, de-duplicated dependency list or throws. */
  validate(workspaceId, taskId, dependsOn) {
    if (!Array.isArray(dependsOn))
      throw new InputError("dependsOn must be an array of task ids");
    const task = this.#row(taskId);
    if (!task || task.workspace_id !== workspaceId)
      throw new InputError("Task not found", 404);
    const ids = [...new Set(dependsOn.map((id) => String(id)))];
    const adjacency = new Map();
    for (const row of this.#rows(workspaceId))
      adjacency.set(row.id, parseJson(row.depends_on, []));
    for (const id of ids) {
      if (id === taskId)
        throw new InputError("A task cannot depend on itself", 400);
      if (!adjacency.has(id))
        throw new InputError(
          `Dependency ${id} does not exist in this workspace`,
          400,
        );
    }
    adjacency.set(taskId, ids);
    const cycle = findCycle(adjacency, taskId);
    if (cycle)
      throw new InputError(
        `Dependency would create a cycle: ${cycle.join(" -> ")}`,
        409,
      );
    return ids;
  }

  setDependencies(
    workspaceId,
    taskId,
    dependsOn,
    { actor = "local-user" } = {},
  ) {
    const ids = this.validate(workspaceId, taskId, dependsOn);
    this.db
      .prepare("UPDATE tasks SET depends_on = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(ids), Date.now(), taskId);
    this.services.audit?.record?.({
      actor,
      action: "task.dependencies.set",
      target: taskId,
      workspaceId,
      details: { dependsOn: ids },
    });
    this.services.bus?.emit("workspace", workspaceId);
    return this.node(taskId);
  }

  node(taskId) {
    const row = this.#row(taskId);
    if (!row) throw new InputError("Task not found", 404);
    return rowToNode(row);
  }

  dependencies(taskId) {
    const row = this.#row(taskId);
    if (!row) throw new InputError("Task not found", 404);
    const ids = parseJson(row.depends_on, []);
    return ids
      .map((id) => this.#row(id))
      .filter(Boolean)
      .map(rowToNode);
  }

  /** Dependencies that are not yet COMPLETED. */
  blockedBy(taskId) {
    return this.dependencies(taskId).filter(
      (dep) => dep.status !== "COMPLETED",
    );
  }

  /** Queued tasks whose dependencies are all completed. */
  ready(workspaceId) {
    const rows = this.#rows(workspaceId);
    const status = new Map(rows.map((row) => [row.id, row.status]));
    return rows
      .filter((row) => row.status === "QUEUE")
      .filter((row) =>
        parseJson(row.depends_on, []).every(
          (id) => status.get(id) === "COMPLETED",
        ),
      )
      .map(rowToNode);
  }

  /** Dependents of a task (tasks that list it in depends_on). */
  dependents(taskId) {
    const row = this.#row(taskId);
    if (!row) return [];
    return this.#rows(row.workspace_id)
      .filter((r) => parseJson(r.depends_on, []).includes(taskId))
      .map(rowToNode);
  }

  graph(workspaceId) {
    this.hub.get(workspaceId);
    const rows = this.#rows(workspaceId);
    const known = new Set(rows.map((row) => row.id));
    const nodes = rows.map(rowToNode);
    const edges = [];
    for (const node of nodes)
      for (const from of node.dependsOn)
        if (known.has(from)) edges.push({ from, to: node.id });
    return { nodes, edges, criticalPath: criticalPath(nodes) };
  }

  /**
   * Called when a task reaches COMPLETED. Dependents that just became ready
   * and have a provider are dispatched through services.runWorker when the
   * workspace policy does not disable auto-dispatch.
   */
  async onTaskCompleted(taskId, { actor = "system" } = {}) {
    const row = this.#row(taskId);
    if (!row) return [];
    const workspaceId = row.workspace_id;
    const policy = this.#policy(workspaceId);
    const readyIds = new Set(this.ready(workspaceId).map((node) => node.id));
    const results = [];
    for (const dependent of this.dependents(taskId)) {
      if (!readyIds.has(dependent.id)) continue;
      const result = { taskId: dependent.id, dispatched: false, reason: null };
      results.push(result);
      if (!dependent.provider) {
        result.reason = "no provider on task";
        continue;
      }
      if (policy.autoDispatch === false) {
        result.reason = "autoDispatch disabled by workspace policy";
        continue;
      }
      if (!this.services.runWorker?.start) {
        result.reason = "run worker unavailable";
        continue;
      }
      if (this.dispatched.has(dependent.id)) {
        result.reason = "already dispatched";
        continue;
      }
      this.dispatched.add(dependent.id);
      try {
        // RunWorker.start is async: a rejected launch (no root path, missing
        // binary, busy agent, policy) must land in the catch below, not as
        // an unhandled rejection with `dispatched` left set.
        const run = await this.services.runWorker.start({
          workspaceId,
          taskId: dependent.id,
          agentId: dependent.agentId ?? undefined,
          provider: dependent.provider,
        });
        result.dispatched = true;
        result.runId = run?.id ?? null;
        this.services.audit?.record?.({
          actor,
          action: "workflow.auto-dispatch",
          target: dependent.id,
          workspaceId,
          runId: run?.id ?? null,
          details: { after: taskId, provider: dependent.provider },
        });
      } catch (error) {
        this.dispatched.delete(dependent.id);
        result.reason = `dispatch failed: ${error.message}`;
        this.services.audit?.record?.({
          actor,
          action: "workflow.auto-dispatch.failed",
          target: dependent.id,
          workspaceId,
          details: { after: taskId, error: error.message },
        });
        try {
          this.hub
            .get(workspaceId)
            .changed(
              `Auto-dispatch of "${dependent.title}" failed: ${error.message}`,
              "error",
              dependent.agentId ?? undefined,
            );
        } catch {
          /* workspace gone */
        }
      }
    }
    return results;
  }

  /**
   * Subscribes to hub changes and calls onTaskCompleted for every task that
   * newly becomes COMPLETED. Returns an unsubscribe function.
   */
  watch() {
    if (this._unwatch) return this._unwatch;
    const listener = (workspaceId, snapshot) => {
      const first = !this.knownCompleted.has(workspaceId);
      const seen = this.knownCompleted.get(workspaceId) ?? new Set();
      this.knownCompleted.set(workspaceId, seen);
      const completed = (snapshot?.tasks ?? []).filter(
        (task) => task.status === "COMPLETED",
      );
      for (const task of completed) {
        // Mark before dispatching: a failed dispatch records a workspace
        // event, which re-enters this listener synchronously.
        const isNew = !seen.has(task.id);
        seen.add(task.id);
        if (!first && isNew)
          this.onTaskCompleted(task.id).catch(() => {
            /* reported through audit */
          });
      }
    };
    for (const workspace of this.hub.list({ includeArchived: true })) {
      try {
        listener(workspace.id, this.hub.get(workspace.id).snapshot());
      } catch {
        /* skip */
      }
    }
    this.hub.on("change", listener);
    this._unwatch = () => {
      this.hub.removeListener("change", listener);
      this._unwatch = null;
    };
    this.services.onClose?.(() => this._unwatch?.());
    return this._unwatch;
  }
}

/** DFS from `start` following depends_on edges; returns the cycle path or null. */
export function findCycle(adjacency, start) {
  const visiting = new Set();
  const done = new Set();
  const path = [];
  const visit = (id) => {
    if (done.has(id)) return null;
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    visiting.add(id);
    path.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    path.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };
  return visit(start);
}

/** Longest dependency chain by task count, as an ordered list of ids. */
export function criticalPath(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map();
  const visiting = new Set();
  const longest = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return [id];
    visiting.add(id);
    let best = [];
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const chain = longest(dep);
      if (chain.length > best.length) best = chain;
    }
    visiting.delete(id);
    const result = [...best, id];
    memo.set(id, result);
    return result;
  };
  let best = [];
  for (const node of nodes) {
    const chain = longest(node.id);
    if (chain.length > best.length) best = chain;
  }
  return best;
}

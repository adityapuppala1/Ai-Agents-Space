import { createHash } from "node:crypto";
import { InputError } from "../TaskStore.js";
import { DEFAULT_POLICY, PROVIDERS } from "../contracts.js";
import {
  contractFromRow,
  checkInputs,
  validateContract,
  validateResult,
} from "./contracts.js";

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
    contract: contractFromRow(row),
    branchCondition: parseJson(row.branch_condition, null),
    repairOf: row.repair_of ?? null,
    reviewer: row.reviewer ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    review: parseJson(row.review, {}),
    context: parseJson(row.context, {}),
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Conditions a step may be gated on. Evaluated when dependencies complete.
 *
 * For `previous.review`, `equals` is a review status: "pending",
 * "accepted", "rejected", "request-change", or "skipped" (the step was gated
 * out by its own condition, so nothing ran and nobody reviewed it).
 */
export const BRANCH_WHEN = [
  "previous.status",
  "previous.review",
  "artifact.exists",
  "contract.failed",
];

export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "blocked",
  "stale",
];

/** Validates a branch condition object. Throws InputError with a plain reason. */
export function validateBranchCondition(input) {
  if (input === null || input === undefined) return null;
  if (typeof input !== "object" || Array.isArray(input))
    throw new InputError("branchCondition must be an object or null");
  if (!BRANCH_WHEN.includes(input.when))
    throw new InputError(
      `branchCondition.when must be one of ${BRANCH_WHEN.join(", ")}`,
    );
  const then = input.then ?? "run";
  if (!["run", "skip"].includes(then))
    throw new InputError('branchCondition.then must be "run" or "skip"');
  if (input.equals === undefined)
    throw new InputError("branchCondition.equals is required");
  if (
    input.equals !== null &&
    !["string", "number", "boolean"].includes(typeof input.equals)
  )
    throw new InputError(
      "branchCondition.equals must be a string, number, boolean, or null",
    );
  return { when: input.when, equals: input.equals, then };
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
        "SELECT id, workspace_id, title, status, priority, provider, assigned_agent_id, depends_on, workflow_id, created_at, updated_at, review, context, contract, branch_condition, repair_of, reviewer, idempotency_key FROM tasks WHERE workspace_id = ? ORDER BY created_at",
      )
      .all(workspaceId);
  }

  #row(taskId) {
    return this.db
      .prepare(
        "SELECT id, workspace_id, title, description, status, priority, provider, assigned_agent_id, depends_on, workflow_id, created_at, updated_at, review, context, contract, branch_condition, repair_of, reviewer, idempotency_key FROM tasks WHERE id = ?",
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
    const skipped = [];
    for (const dependent of this.dependents(taskId)) {
      if (!readyIds.has(dependent.id)) continue;
      const result = { taskId: dependent.id, dispatched: false, reason: null };
      results.push(result);
      // A conditional branch is decided the moment its dependencies finish.
      const branch = this.evaluateBranch(dependent.id, { previousId: taskId });
      if (branch.applied === "skip") {
        result.skipped = true;
        result.reason = branch.reason;
        this.skipTask(dependent.id, branch.reason, { actor });
        skipped.push(dependent.id);
        continue;
      }
      // Mode 3: another engine owns this workflow. Agent Space observes it
      // and never dispatches, retries, or reassigns its runs.
      const ownership = this.ownershipFor(dependent.id);
      if (!ownership.local) {
        result.reason = ownership.reason;
        continue;
      }
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
      // One dispatcher, one key: a second run with the same key is refused
      // while the first is still active. Tool side effects still belong to
      // the provider (see claimDispatch).
      const claim = this.claimDispatch({
        workspaceId,
        taskId: dependent.id,
        prompt: dependent.title,
      });
      if (!claim.ok) {
        result.reason = claim.reason;
        continue;
      }
      result.idempotencyKey = claim.key;
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
    // Skipped steps complete immediately, so their own dependents are
    // evaluated in the same pass.
    for (const id of skipped) {
      const downstream = await this.onTaskCompleted(id, { actor });
      results.push(...downstream);
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

  /* ------------------------------------------------------------------ */
  /* Task contracts                                                      */
  /* ------------------------------------------------------------------ */

  /** The validated contract stored on a task. */
  contract(taskId) {
    return this.node(taskId).contract;
  }

  setContract(workspaceId, taskId, contract, { actor = "local-user" } = {}) {
    const row = this.#row(taskId);
    if (!row || row.workspace_id !== workspaceId)
      throw new InputError("Task not found", 404);
    const validated = validateContract(contract ?? {});
    this.db
      .prepare(
        "UPDATE tasks SET contract = ?, reviewer = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(validated),
        validated.reviewer ?? null,
        Date.now(),
        taskId,
      );
    this.services.audit?.record?.({
      actor,
      action: "task.contract.set",
      target: taskId,
      workspaceId,
      details: {
        criteria: validated.completionCriteria,
        reviewer: validated.reviewer,
        hasOutputSchema: !!validated.outputSchema,
      },
    });
    this.services.bus?.emit("workspace", workspaceId);
    return this.node(taskId);
  }

  setBranchCondition(
    workspaceId,
    taskId,
    condition,
    { actor = "local-user" } = {},
  ) {
    const row = this.#row(taskId);
    if (!row || row.workspace_id !== workspaceId)
      throw new InputError("Task not found", 404);
    const validated = validateBranchCondition(condition ?? null);
    this.db
      .prepare(
        "UPDATE tasks SET branch_condition = ?, updated_at = ? WHERE id = ?",
      )
      .run(validated ? JSON.stringify(validated) : null, Date.now(), taskId);
    this.services.audit?.record?.({
      actor,
      action: "task.branch.set",
      target: taskId,
      workspaceId,
      details: validated ?? { cleared: true },
    });
    this.services.bus?.emit("workspace", workspaceId);
    return this.node(taskId);
  }

  /** Required inputs of a task's contract against its recorded inputs. */
  checkTaskInputs(taskId, provided = null) {
    return checkInputs(this.node(taskId), provided);
  }

  /* ------------------------------------------------------------------ */
  /* Conditional branches                                                */
  /* ------------------------------------------------------------------ */

  #artifactKindsForTask(taskId) {
    return new Set(
      this.db
        .prepare("SELECT DISTINCT kind FROM artifacts WHERE task_id = ?")
        .all(taskId)
        .map((row) => row.kind),
    );
  }

  /**
   * Decides whether a gated step runs or is skipped.
   * → { condition, matches, applied: "run" | "skip", reason }
   */
  evaluateBranch(taskId, { previousId = null } = {}) {
    const node = this.node(taskId);
    const condition = node.branchCondition;
    if (!condition)
      return {
        condition: null,
        matches: null,
        applied: "run",
        reason: "no condition",
      };
    const dependencies = this.dependencies(taskId);
    const previous =
      dependencies.find((dep) => dep.id === previousId) ??
      dependencies[dependencies.length - 1] ??
      null;
    let matches = false;
    let observed = null;
    if (!previous) {
      observed = "no dependency";
    } else if (condition.when === "previous.status") {
      observed = previous.status;
      matches = previous.status === condition.equals;
    } else if (condition.when === "previous.review") {
      observed = previous.review?.status ?? "none";
      matches = observed === condition.equals;
    } else if (condition.when === "artifact.exists") {
      const kinds = this.#artifactKindsForTask(previous.id);
      observed = [...kinds].join(", ") || "none";
      matches =
        condition.equals === true
          ? kinds.size > 0
          : kinds.has(String(condition.equals));
    } else if (condition.when === "contract.failed") {
      const failed = (previous.review?.failures ?? []).length > 0;
      observed = failed;
      matches =
        failed ===
        (condition.equals === undefined ? true : Boolean(condition.equals));
    }
    const applied =
      condition.then === "skip"
        ? matches
          ? "skip"
          : "run"
        : matches
          ? "run"
          : "skip";
    const reason =
      applied === "skip"
        ? `skipped by condition (${condition.when} = ${JSON.stringify(observed)}, expected ${JSON.stringify(condition.equals)})`
        : `condition met (${condition.when} = ${JSON.stringify(observed)})`;
    return { condition, matches, applied, reason, observed };
  }

  /**
   * Marks a gated step COMPLETED without running anything. Nothing was
   * executed and no file was touched: the review note says so.
   */
  skipTask(taskId, reason = "skipped by condition", { actor = "system" } = {}) {
    const row = this.#row(taskId);
    if (!row) throw new InputError("Task not found", 404);
    if (row.status === "COMPLETED") return this.node(taskId);
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'COMPLETED', progress = 100, completed_at = ?, updated_at = ?,
           review = ? WHERE id = ?`,
      )
      .run(
        now,
        now,
        JSON.stringify({
          // NOT "accepted": nobody reviewed anything and nothing ran. A
          // downstream gate on previous.review = "accepted" must not fire on a
          // step that was skipped, and the lineage graph must not show an
          // accepted result with no run, no artifacts and no reviewer.
          status: "skipped",
          skipped: true,
          note: "skipped by condition",
          detail: reason,
          runId: null,
        }),
        taskId,
      );
    this.services.audit?.record?.({
      actor,
      action: "task.skipped",
      target: taskId,
      workspaceId: row.workspace_id,
      details: { reason },
    });
    try {
      this.hub
        .get(row.workspace_id)
        .changed(
          `Step "${row.title}" was skipped by its branch condition; nothing ran`,
          "system",
        );
    } catch {
      /* workspace gone */
    }
    return this.node(taskId);
  }

  /* ------------------------------------------------------------------ */
  /* Contract results, reviewer hand-off, bounded repair loops           */
  /* ------------------------------------------------------------------ */

  maxRepairAttempts(workspaceId) {
    const value = this.#policy(workspaceId)?.maxRepairAttempts;
    return Number.isInteger(value) && value >= 0
      ? value
      : DEFAULT_MAX_REPAIR_ATTEMPTS;
  }

  /** Repair tasks already created for a chain (the original task id). */
  repairAttempts(taskId) {
    const node = this.node(taskId);
    const root = node.repairOf ?? node.id;
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE repair_of = ?")
      .get(root);
    return { root, attempts: row?.n ?? 0 };
  }

  /**
   * Applies a finished run's evidence to the task contract.
   *
   * result = { runId, artifacts, finalMessage, events }
   * → { ok, failures, reviewTaskId, repairTaskId, exhausted }
   *
   * On failure the task review is set to pending with the failures listed.
   * When the contract names an agent reviewer, a REVIEW TASK is created and
   * assigned to that agent (depending on the original task) so the designer
   * and the reviewer can use different providers; the repair task is created
   * only when that reviewer rejects. With no agent reviewer the repair task
   * is created straight away, bounded by policy.maxRepairAttempts.
   */
  recordResult(taskId, result = {}) {
    const node = this.node(taskId);
    const row = this.#row(taskId);
    const workspaceId = row.workspace_id;
    const verdict = validateResult(node.contract, result);
    const actor = result.actor ?? "system";
    if (verdict.ok) {
      this.services.audit?.record?.({
        actor,
        action: "task.contract.met",
        target: taskId,
        workspaceId,
        runId: result.runId ?? null,
        details: { checked: verdict.checked },
      });
      return { ok: true, failures: [], checked: verdict.checked };
    }
    const review = {
      runId: result.runId ?? null,
      status: "pending",
      note: "Contract not met; a human or the named reviewer decides",
      failures: verdict.failures,
    };
    this.db
      .prepare("UPDATE tasks SET review = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(review), Date.now(), taskId);
    this.services.audit?.record?.({
      actor,
      action: "task.contract.failed",
      target: taskId,
      workspaceId,
      runId: result.runId ?? null,
      details: { failures: verdict.failures },
    });
    try {
      this.hub
        .get(workspaceId)
        .changed(
          `Contract not met for "${row.title}": ${verdict.failures.map((f) => f.criterion).join(", ")}`,
          "error",
          row.assigned_agent_id ?? undefined,
          result.runId ?? undefined,
        );
    } catch {
      /* workspace gone */
    }

    const reviewer = node.contract.reviewer;
    const out = {
      ok: false,
      failures: verdict.failures,
      checked: verdict.checked,
      reviewTaskId: null,
      repairTaskId: null,
      exhausted: false,
      reviewer: reviewer ?? "human",
    };
    if (reviewer && reviewer !== "human") {
      const created = this.createReviewTask(taskId, {
        reviewer,
        failures: verdict.failures,
        runId: result.runId ?? null,
        actor,
      });
      out.reviewTaskId = created?.id ?? null;
      return out;
    }
    const repair = this.createRepairTask(taskId, {
      failures: verdict.failures,
      runId: result.runId ?? null,
      actor,
    });
    out.repairTaskId = repair.taskId;
    out.exhausted = repair.exhausted;
    return out;
  }

  /**
   * Creates a review task assigned to another agent (which may run on a
   * different provider than the designer).
   */
  createReviewTask(
    taskId,
    { reviewer, failures = [], runId = null, actor = "system" } = {},
  ) {
    const row = this.#row(taskId);
    if (!row) throw new InputError("Task not found", 404);
    const workspace = this.hub.get(row.workspace_id);
    const agent = workspace.profiles.get(reviewer, { includeArchived: false });
    const existing = this.db
      .prepare(
        "SELECT id FROM tasks WHERE workspace_id = ? AND json_extract(context, '$.reviewOf') = ? AND status != 'COMPLETED'",
      )
      .get(row.workspace_id, taskId);
    if (existing) return { id: existing.id, reused: true };
    const task = workspace.store.create(
      {
        title: `Review: ${row.title}`.slice(0, 200),
        description: [
          `Review the result of "${row.title}".`,
          failures.length
            ? `Contract criteria not met: ${failures.map((f) => `${f.criterion} — ${f.detail}`).join("; ")}`
            : "",
          "Accept the result or reject it with a reason. Rejecting opens a bounded repair task.",
        ]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 2000),
        priority: row.priority,
      },
      "workflow",
    );
    this.db
      .prepare(
        `UPDATE tasks SET depends_on = ?, provider = ?, assigned_agent_id = ?, workflow_id = ?,
           template_id = ?, context = ?, reviewer = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify([taskId]),
        agent.provider ?? null,
        agent.id,
        row.workflow_id ?? null,
        row.template_id ?? null,
        JSON.stringify({ reviewOf: taskId, runId, role: "reviewer" }),
        agent.id,
        Date.now(),
        task.id,
      );
    this.services.audit?.record?.({
      actor,
      action: "task.review.created",
      target: task.id,
      workspaceId: row.workspace_id,
      runId,
      details: {
        reviewOf: taskId,
        reviewer: agent.id,
        reviewerProvider: agent.provider ?? null,
        designerProvider: row.provider ?? null,
      },
    });
    workspace.changed(
      `Review task opened for "${row.title}" and assigned to ${agent.name}`,
      "task",
      agent.id,
    );
    return { id: task.id, reused: false, provider: agent.provider ?? null };
  }

  /**
   * Bounded repair loop. Returns { taskId, exhausted, attempts, max }.
   * When the cap is reached nothing is created: the chain stops and the job
   * is listed by inbox()/supervisorView() for a human.
   */
  createRepairTask(
    taskId,
    { failures = [], runId = null, reason = null, actor = "system" } = {},
  ) {
    const row = this.#row(taskId);
    if (!row) throw new InputError("Task not found", 404);
    const workspaceId = row.workspace_id;
    const max = this.maxRepairAttempts(workspaceId);
    const { root, attempts } = this.repairAttempts(taskId);
    if (attempts >= max) {
      this.services.audit?.record?.({
        actor,
        action: "task.repair.exhausted",
        target: root,
        workspaceId,
        runId,
        details: { attempts, max },
      });
      try {
        this.hub
          .get(workspaceId)
          .changed(
            `Repair loop for "${row.title}" stopped after ${attempts} of ${max} attempts; it is waiting for you in the inbox`,
            "error",
          );
      } catch {
        /* workspace gone */
      }
      return { taskId: null, exhausted: true, attempts, max, root };
    }
    const workspace = this.hub.get(workspaceId);
    const detail =
      reason ??
      (failures.length
        ? failures.map((f) => `${f.criterion} — ${f.detail}`).join("; ")
        : "the previous attempt did not meet its contract");
    const task = workspace.store.create(
      {
        title: `Repair (${attempts + 1}/${max}): ${row.title}`.slice(0, 200),
        description:
          `Fix the previous attempt of "${row.title}".\n\n${detail}`.slice(
            0,
            2000,
          ),
        priority: row.priority,
      },
      "workflow",
    );
    this.db
      .prepare(
        `UPDATE tasks SET depends_on = ?, provider = ?, assigned_agent_id = ?, workflow_id = ?,
           template_id = ?, contract = ?, repair_of = ?, deliverable = ?, context = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify([taskId]),
        row.provider ?? null,
        row.assigned_agent_id ?? null,
        row.workflow_id ?? null,
        row.template_id ?? null,
        row.contract ?? "{}",
        root,
        "",
        JSON.stringify({ repairOf: root, previousTaskId: taskId, runId }),
        Date.now(),
        task.id,
      );
    this.services.audit?.record?.({
      actor,
      action: "task.repair.created",
      target: task.id,
      workspaceId,
      runId,
      details: { repairOf: root, attempt: attempts + 1, max },
    });
    workspace.changed(
      `Repair task ${attempts + 1} of ${max} created for "${row.title}"`,
      "task",
      row.assigned_agent_id ?? undefined,
    );
    return {
      taskId: task.id,
      exhausted: false,
      attempts: attempts + 1,
      max,
      root,
    };
  }

  /**
   * Records a reviewer's verdict on a task. A rejection opens a bounded
   * repair task; acceptance clears the pending review.
   */
  resolveReview(taskId, { decision, note = "", actor = "local-user" } = {}) {
    if (!["accept", "reject"].includes(decision))
      throw new InputError('decision must be "accept" or "reject"');
    const row = this.#row(taskId);
    if (!row) throw new InputError("Task not found", 404);
    const review = parseJson(row.review, {});
    const next = {
      ...review,
      status: decision === "accept" ? "accepted" : "rejected",
      note: note || review.note || "",
      decidedBy: actor,
      decidedAt: Date.now(),
    };
    this.db
      .prepare("UPDATE tasks SET review = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), Date.now(), row.id);
    this.services.audit?.record?.({
      actor,
      action: `task.review.${decision}`,
      target: taskId,
      workspaceId: row.workspace_id,
      details: { note },
    });
    if (decision === "accept") return { review: next, repair: null, taskId };
    const repair = this.createRepairTask(taskId, {
      failures: review.failures ?? [],
      runId: review.runId ?? null,
      reason: note || "the reviewer rejected the result",
      actor,
    });
    return { review: next, repair, taskId };
  }

  /* ------------------------------------------------------------------ */
  /* Single ownership and idempotency                                    */
  /* ------------------------------------------------------------------ */

  /**
   * sha256(workspaceId + taskId + attempt + prompt). Stable for the same
   * dispatch, different for a new attempt or a changed prompt.
   */
  idempotencyKeyFor({ workspaceId, taskId, attempt = 1, prompt = "" }) {
    return createHash("sha256")
      .update(String(workspaceId))
      .update(String(taskId))
      .update(String(attempt))
      .update(String(prompt ?? ""))
      .digest("hex");
  }

  /** Runs of a task that are not finished. */
  activeRuns(taskId) {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT id, status, attempt FROM runs WHERE task_id = ? AND status IN (${placeholders})`,
      )
      .all(taskId, ...ACTIVE_RUN_STATUSES);
  }

  /**
   * Claims the right to dispatch a task once.
   *
   * The guarantee is narrow and honest: Agent Space will not dispatch the
   * same (workspace, task, attempt, prompt) twice while a run for it is
   * still active. It says nothing about what the provider's tools did — a
   * side effect that already happened is not undone by a refused claim.
   */
  claimDispatch({ workspaceId, taskId, attempt = 1, prompt = "" } = {}) {
    const row = this.#row(taskId);
    if (!row) throw new InputError("Task not found", 404);
    const key = this.idempotencyKeyFor({
      workspaceId: workspaceId ?? row.workspace_id,
      taskId,
      attempt,
      prompt,
    });
    const active = this.activeRuns(taskId);
    if (row.idempotency_key === key && active.length)
      return {
        ok: false,
        key,
        reason: `a run with the same idempotency key is already active (run ${active[0].id}); Agent Space will not double-dispatch, but any side effect the provider already made still stands`,
        runId: active[0].id,
      };
    this.db
      .prepare(
        "UPDATE tasks SET idempotency_key = ?, updated_at = ? WHERE id = ?",
      )
      .run(key, Date.now(), taskId);
    return { ok: true, key, reason: null };
  }

  /** Clears the stored key so the same dispatch may be retried. */
  releaseDispatch(taskId) {
    this.db
      .prepare("UPDATE tasks SET idempotency_key = NULL WHERE id = ?")
      .run(taskId);
  }

  /** Who owns the control loop for a task (through its workflow). */
  ownershipFor(taskId) {
    const row = this.#row(taskId);
    if (!row) throw new InputError("Task not found", 404);
    if (!row.workflow_id)
      return {
        owner: "agent-space",
        externalId: null,
        local: true,
        reason: null,
      };
    const workflow = this.db
      .prepare("SELECT owner, external_id FROM workflows WHERE id = ?")
      .get(row.workflow_id);
    const owner = workflow?.owner ?? "agent-space";
    const local = owner === "agent-space";
    return {
      owner,
      externalId: workflow?.external_id ?? null,
      local,
      workflowId: row.workflow_id,
      reason: local
        ? null
        : `workflow ${row.workflow_id} is owned by "${owner}"${workflow?.external_id ? ` (external id ${workflow.external_id})` : ""}; Agent Space does not dispatch, retry, or reassign its runs`,
    };
  }

  /** Throws 409 when an external engine owns the task's workflow. */
  assertLocalOwnership(taskId) {
    const ownership = this.ownershipFor(taskId);
    if (!ownership.local) throw new InputError(ownership.reason, 409);
    return ownership;
  }

  /** Ownership guard for retry/reassign, addressed by run id. */
  assertRetryAllowed(runId) {
    const run = this.db
      .prepare("SELECT id, task_id FROM runs WHERE id = ?")
      .get(runId);
    if (!run) throw new InputError("Run not found", 404);
    return this.assertLocalOwnership(run.task_id);
  }

  /* ------------------------------------------------------------------ */
  /* Validation: cycles, missing inputs, unreachable steps, permissions  */
  /* ------------------------------------------------------------------ */

  #allowedProviders(workspaceId) {
    const connections = this.services.connections?.list?.() ?? [];
    const denied = new Map();
    for (const connection of connections) {
      const scoped = connection.allowedWorkspaces ?? [];
      if (!scoped.length) continue;
      if (!scoped.includes(workspaceId))
        denied.set(
          connection.provider,
          `connection "${connection.alias ?? connection.provider}" is not allowed in this workspace`,
        );
      else denied.delete(connection.provider);
    }
    return denied;
  }

  /**
   * Static checks over a workspace's graph (optionally one workflow).
   * → { ok, problems: [{ code, taskId, title, detail }] }
   *
   * codes: cycle | missing-input | unreachable | permission-conflict
   */
  validateWorkflow(workspaceId, { workflowId = null } = {}) {
    this.hub.get(workspaceId);
    const rows = this.#rows(workspaceId).filter(
      (row) => !workflowId || row.workflow_id === workflowId,
    );
    const nodes = rows.map(rowToNode);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const problems = [];
    const push = (code, node, detail) =>
      problems.push({
        code,
        taskId: node?.id ?? null,
        title: node?.title ?? null,
        detail,
      });

    // Cycles.
    const adjacency = new Map(
      nodes.map((node) => [
        node.id,
        node.dependsOn.filter((id) => byId.has(id)),
      ]),
    );
    const seenCycles = new Set();
    for (const node of nodes) {
      const cycle = findCycle(adjacency, node.id);
      if (!cycle) continue;
      const fingerprint = [...cycle].sort().join("|");
      if (seenCycles.has(fingerprint)) continue;
      seenCycles.add(fingerprint);
      push("cycle", node, `dependency cycle: ${cycle.join(" -> ")}`);
    }

    // Unreachable steps: no path from any root.
    const roots = nodes.filter(
      (node) => node.dependsOn.filter((id) => byId.has(id)).length === 0,
    );
    const reachable = new Set();
    const queue = roots.map((node) => node.id);
    while (queue.length) {
      const id = queue.shift();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const node of nodes)
        if (node.dependsOn.includes(id) && !reachable.has(node.id))
          queue.push(node.id);
    }
    for (const node of nodes) {
      if (reachable.has(node.id)) continue;
      const missingDeps = node.dependsOn.filter((id) => !byId.has(id));
      push(
        "unreachable",
        node,
        missingDeps.length
          ? `no path from any starting step: depends on ${missingDeps.join(", ")}, which is not part of this graph`
          : "no path from any starting step (its dependency chain never starts)",
      );
    }

    // Missing required inputs.
    for (const node of nodes) {
      const check = checkInputs(node);
      for (const miss of check.missing)
        push("missing-input", node, miss.detail);
    }

    // Permission conflicts: provider scope and denied tools.
    const deniedProviders = this.#allowedProviders(workspaceId);
    const policy = this.#policy(workspaceId);
    for (const node of nodes) {
      if (node.provider) {
        if (!PROVIDERS[node.provider])
          push(
            "permission-conflict",
            node,
            `unknown provider "${node.provider}"`,
          );
        else if (deniedProviders.has(node.provider))
          push(
            "permission-conflict",
            node,
            `provider ${PROVIDERS[node.provider].name}: ${deniedProviders.get(node.provider)}`,
          );
        if (policy.autonomy === "observe-only")
          push(
            "permission-conflict",
            node,
            "workspace policy is observe-only, so this step can never be launched here",
          );
      }
      for (const tool of node.contract.allowedTools ?? []) {
        let decision = null;
        try {
          decision = this.services.policy?.evaluate?.({
            workspaceId,
            request: { kind: "tool", tool, command: tool },
          });
        } catch {
          decision = null;
        }
        const deniedByList = (policy.deniedCommands ?? []).some((entry) =>
          tool.toLowerCase().includes(String(entry).toLowerCase()),
        );
        if (decision?.decision === "deny" || deniedByList)
          push(
            "permission-conflict",
            node,
            `the step requires "${tool}", which the workspace policy denies${decision?.reason ? `: ${decision.reason}` : ""}`,
          );
      }
    }

    return { ok: problems.length === 0, problems, checked: nodes.length };
  }

  /* ------------------------------------------------------------------ */
  /* Supervisor view and failed-job inbox                                */
  /* ------------------------------------------------------------------ */

  /**
   * Stalled dependencies and failed jobs for a workspace.
   * → { stalled: [...], failed: [...], repairExhausted: [...], compensations: [...] }
   */
  supervisorView(
    workspaceId,
    { stalledAfterMs = 15 * 60 * 1000, now = Date.now() } = {},
  ) {
    this.hub.get(workspaceId);
    const rows = this.#rows(workspaceId);
    const nodes = rows.map(rowToNode);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const runsByTask = new Map();
    for (const run of this.db
      .prepare(
        "SELECT id, task_id, status, started_at, ended_at, last_event_at, error FROM runs WHERE workspace_id = ? ORDER BY started_at, rowid",
      )
      .all(workspaceId))
      runsByTask.set(run.task_id, run);

    const stalled = [];
    for (const node of nodes) {
      if (node.status !== "QUEUE") continue;
      const blockers = [];
      for (const id of node.dependsOn) {
        const dep = byId.get(id);
        if (!dep) {
          blockers.push({ taskId: id, reason: "dependency is missing" });
          continue;
        }
        if (dep.status === "COMPLETED") continue;
        const run = runsByTask.get(dep.id);
        const since =
          run?.last_event_at ?? run?.ended_at ?? dep.updatedAt ?? null;
        const failedRun =
          run && ["failed", "disconnected", "cancelled"].includes(run.status);
        const blockedTask = dep.status === "BLOCKED";
        if (!failedRun && !blockedTask) continue;
        if (since !== null && now - since < stalledAfterMs) continue;
        blockers.push({
          taskId: dep.id,
          title: dep.title,
          status: dep.status,
          runStatus: run?.status ?? null,
          waitingMs: since === null ? null : now - since,
          reason: failedRun
            ? `its run ${run.status}${run.error ? `: ${run.error}` : ""}`
            : "the dependency is blocked",
        });
      }
      if (blockers.length)
        stalled.push({ taskId: node.id, title: node.title, blockers });
    }

    const failed = nodes
      .filter((node) => {
        const run = runsByTask.get(node.id);
        return (
          node.review?.status === "pending" ||
          (run && ["failed", "disconnected"].includes(run.status))
        );
      })
      .map((node) => ({
        taskId: node.id,
        title: node.title,
        status: node.status,
        review: node.review ?? {},
        runId: runsByTask.get(node.id)?.id ?? null,
        runStatus: runsByTask.get(node.id)?.status ?? null,
        failures: node.review?.failures ?? [],
      }));

    const repairExhausted = [];
    const seenRoots = new Set();
    for (const node of nodes) {
      const root = node.repairOf ?? node.id;
      if (seenRoots.has(root)) continue;
      seenRoots.add(root);
      const { attempts } = this.repairAttempts(node.id);
      const max = this.maxRepairAttempts(workspaceId);
      if (attempts >= max && attempts > 0) {
        const rootNode = byId.get(root);
        repairExhausted.push({
          taskId: root,
          title: rootNode?.title ?? null,
          attempts,
          max,
          detail: `the bounded repair loop stopped after ${attempts} of ${max} attempts`,
        });
      }
    }

    const compensations = [];
    for (const node of nodes) {
      const compensation = node.contract?.compensation;
      if (!compensation) continue;
      const run = runsByTask.get(node.id);
      if (!run || !["failed", "cancelled", "disconnected"].includes(run.status))
        continue;
      compensations.push({
        taskId: node.id,
        title: node.title,
        runId: run.id,
        description: compensation.description,
        command: compensation.command ?? null,
        automatic: false,
        note: "Agent Space never runs a compensation command on its own; approve it and run it yourself. Effects the provider already made outside this folder cannot be undone from here.",
      });
    }

    return { workspaceId, stalled, failed, repairExhausted, compensations };
  }

  /** Failed jobs and decisions waiting for a human in this workspace. */
  inbox(workspaceId) {
    const view = this.supervisorView(workspaceId);
    return {
      workspaceId,
      failed: view.failed,
      repairExhausted: view.repairExhausted,
      compensations: view.compensations,
      counts: {
        failed: view.failed.length,
        stalled: view.stalled.length,
        repairExhausted: view.repairExhausted.length,
        compensations: view.compensations.length,
      },
    };
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

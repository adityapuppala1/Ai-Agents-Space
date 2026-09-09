/**
 * Versioned checkpoints and manual recovery (roadmap §10, "Versioned
 * checkpoints, manual recovery, an inbox for failed jobs, and a supervisor
 * view of stalled dependencies" and "Compensation steps for reversible
 * operations; report external effects that cannot be automatically undone").
 *
 * What a checkpoint IS: a snapshot of orchestration state — task statuses,
 * reviews, the dependency graph, and the run ids that existed at that moment.
 *
 * What a checkpoint IS NOT: a backup. It never copies file contents, never
 * touches the working tree, and restoring it never re-runs anything. Files a
 * provider already changed stay changed; the restore event says so in plain
 * words, every time.
 */

import { randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";
import { transaction } from "../db.js";
import { validateContract, parseJson } from "./contracts.js";

export const CHECKPOINT_KINDS = ["pre-dispatch", "post-run", "manual"];

export const NOT_ROLLED_BACK =
  "File changes, commits, and anything a provider's tools did outside Agent Space are NOT rolled back by a checkpoint restore.";

function rowToCheckpoint(row, { withState = false } = {}) {
  const checkpoint = {
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id ?? null,
    taskId: row.task_id ?? null,
    runId: row.run_id ?? null,
    kind: row.kind,
    label: row.label ?? null,
    createdAt: row.created_at,
    taskCount: parseJson(row.state, {})?.tasks?.length ?? 0,
  };
  if (withState) checkpoint.state = parseJson(row.state, {});
  return checkpoint;
}

/**
 * Checkpoint store.
 *
 * `new CheckpointService(services)` — uses services.db, services.hub, and
 * optionally services.audit and services.bus.
 */
export class CheckpointService {
  constructor(services, { now = Date.now } = {}) {
    this.services = services;
    this.db = services.db;
    this.hub = services.hub;
    this.now = now;
  }

  #tasks(workspaceId, workflowId) {
    const rows = workflowId
      ? this.db
          .prepare(
            "SELECT * FROM tasks WHERE workspace_id = ? AND workflow_id = ? ORDER BY created_at, rowid",
          )
          .all(workspaceId, workflowId)
      : this.db
          .prepare(
            "SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at, rowid",
          )
          .all(workspaceId);
    return rows;
  }

  /**
   * create({ workspaceId, workflowId?, taskId?, runId?, kind, label? })
   * Snapshots the minimal recoverable state. No file contents, ever.
   */
  create({
    workspaceId,
    workflowId = null,
    taskId = null,
    runId = null,
    kind = "manual",
    label = null,
    actor = "local-user",
  } = {}) {
    if (!workspaceId) throw new InputError("workspaceId is required");
    if (!CHECKPOINT_KINDS.includes(kind))
      throw new InputError(
        `kind must be one of ${CHECKPOINT_KINDS.join(", ")}`,
      );
    this.hub.get(workspaceId);
    const rows = this.#tasks(workspaceId, workflowId);
    const state = {
      capturedAt: this.now(),
      workflowId,
      tasks: rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        progress: row.progress,
        review: parseJson(row.review, {}),
        dependsOn: parseJson(row.depends_on, []),
        assignedAgentId: row.assigned_agent_id ?? null,
        provider: row.provider ?? null,
        branchCondition: parseJson(row.branch_condition, null),
        repairOf: row.repair_of ?? null,
        idempotencyKey: row.idempotency_key ?? null,
      })),
      runIds: this.db
        .prepare(
          "SELECT id, task_id, status FROM runs WHERE workspace_id = ? ORDER BY started_at",
        )
        .all(workspaceId)
        .map((run) => ({
          id: run.id,
          taskId: run.task_id,
          status: run.status,
        })),
      note: NOT_ROLLED_BACK,
    };
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, workspace_id, workflow_id, task_id, run_id, kind, label, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        workflowId,
        taskId,
        runId,
        kind,
        label ? String(label).slice(0, 200) : null,
        JSON.stringify(state),
        this.now(),
      );
    this.services.audit?.record?.({
      actor,
      action: "checkpoint.create",
      target: id,
      workspaceId,
      runId,
      details: { kind, label, tasks: state.tasks.length },
    });
    return this.get(id);
  }

  get(id, { withState = true } = {}) {
    const row = this.db
      .prepare("SELECT * FROM checkpoints WHERE id = ?")
      .get(id);
    if (!row) throw new InputError("Checkpoint not found", 404);
    return rowToCheckpoint(row, { withState });
  }

  list({ workspaceId = null, workflowId = null, limit = 50 } = {}) {
    const clauses = [];
    const params = [];
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (workflowId) {
      clauses.push("workflow_id = ?");
      params.push(workflowId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM checkpoints ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, Math.min(Number(limit) || 50, 500))
      .map((row) => rowToCheckpoint(row));
  }

  /**
   * restore(id, { dryRun })
   *
   * Resets task statuses and reviews to the checkpoint. It never re-runs
   * anything, never cancels a live run, and never touches files. Returns the
   * list of tasks that moved plus the plain-language warning.
   */
  restore(id, { dryRun = false, actor = "local-user" } = {}) {
    const checkpoint = this.get(id);
    const state = checkpoint.state ?? {};
    const workspaceId = checkpoint.workspaceId;
    const changes = [];
    const missing = [];
    for (const snapshot of state.tasks ?? []) {
      const row = this.db
        .prepare(
          "SELECT id, title, status, progress, review FROM tasks WHERE id = ?",
        )
        .get(snapshot.id);
      if (!row) {
        missing.push({ taskId: snapshot.id, title: snapshot.title });
        continue;
      }
      const currentReview = JSON.stringify(parseJson(row.review, {}));
      const targetReview = JSON.stringify(snapshot.review ?? {});
      if (row.status === snapshot.status && currentReview === targetReview)
        continue;
      changes.push({
        taskId: row.id,
        title: row.title,
        from: row.status,
        to: snapshot.status,
        reviewChanged: currentReview !== targetReview,
      });
    }
    const activeRuns = this.db
      .prepare(
        "SELECT id, task_id, status FROM runs WHERE workspace_id = ? AND status IN ('queued','running','waiting_approval','stale')",
      )
      .all(workspaceId);

    const result = {
      checkpointId: id,
      workspaceId,
      dryRun,
      changes,
      missing,
      activeRuns: activeRuns.map((run) => ({
        id: run.id,
        taskId: run.task_id,
        status: run.status,
      })),
      rerun: false,
      filesRestored: false,
      note: NOT_ROLLED_BACK,
    };
    if (dryRun) return result;

    transaction(this.db, () => {
      for (const change of changes) {
        const snapshot = (state.tasks ?? []).find(
          (task) => task.id === change.taskId,
        );
        this.db
          .prepare(
            `UPDATE tasks SET status = ?, progress = ?, review = ?, updated_at = ?,
               completed_at = CASE WHEN ? = 'COMPLETED' THEN completed_at ELSE NULL END
             WHERE id = ?`,
          )
          .run(
            snapshot.status,
            snapshot.progress ?? 0,
            JSON.stringify(snapshot.review ?? {}),
            this.now(),
            snapshot.status,
            change.taskId,
          );
      }
    });

    this.services.audit?.record?.({
      actor,
      action: "checkpoint.restore",
      target: id,
      workspaceId,
      details: {
        moved: changes.map((c) => `${c.title}: ${c.from} → ${c.to}`),
        filesRestored: false,
      },
    });
    try {
      const moved = changes.length
        ? changes.map((c) => `“${c.title}” ${c.from} → ${c.to}`).join(", ")
        : "no task statuses changed";
      this.hub
        .get(workspaceId)
        .changed(
          `Checkpoint restored (${moved}). ${NOT_ROLLED_BACK} Nothing was re-run automatically.`,
          "system",
        );
    } catch {
      /* workspace gone */
    }
    this.services.bus?.emit("workspace", workspaceId);
    return result;
  }

  /**
   * registerCompensation(taskId, { description, command })
   *
   * Stores a compensation step on the task contract. Agent Space NEVER runs
   * it: it is surfaced in the inbox when the task's run fails so a human can
   * approve and run it, together with the effects that cannot be undone.
   */
  registerCompensation(
    taskId,
    { description, command = null, actor = "local-user" } = {},
  ) {
    const row = this.db
      .prepare("SELECT id, workspace_id, contract FROM tasks WHERE id = ?")
      .get(taskId);
    if (!row) throw new InputError("Task not found", 404);
    const contract = validateContract({
      ...parseJson(row.contract, {}),
      compensation: { description, command },
    });
    this.db
      .prepare("UPDATE tasks SET contract = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(contract), this.now(), taskId);
    this.services.audit?.record?.({
      actor,
      action: "task.compensation.register",
      target: taskId,
      workspaceId: row.workspace_id,
      details: {
        description: contract.compensation.description,
        automatic: false,
      },
    });
    return {
      taskId,
      compensation: contract.compensation,
      automatic: false,
      note: "Presented for approval only. Agent Space does not execute compensation commands.",
    };
  }

  /**
   * Compensation steps waiting for a human, plus the effects that cannot be
   * undone automatically. Sourced from the task graph's supervisor view when
   * one is available, otherwise computed here.
   */
  compensationInbox(workspaceId) {
    const fromGraph = this.services.graph?.supervisorView?.(workspaceId);
    if (fromGraph)
      return {
        workspaceId,
        entries: fromGraph.compensations,
        note: NOT_ROLLED_BACK,
      };
    const rows = this.db
      .prepare(
        `SELECT t.id, t.title, t.contract, r.id AS run_id, r.status AS run_status
           FROM tasks t LEFT JOIN runs r ON r.task_id = t.id
          WHERE t.workspace_id = ?`,
      )
      .all(workspaceId);
    const entries = [];
    for (const row of rows) {
      const compensation = parseJson(row.contract, {})?.compensation;
      if (!compensation) continue;
      if (!["failed", "cancelled", "disconnected"].includes(row.run_status))
        continue;
      entries.push({
        taskId: row.id,
        title: row.title,
        runId: row.run_id,
        description: compensation.description,
        command: compensation.command ?? null,
        automatic: false,
      });
    }
    return { workspaceId, entries, note: NOT_ROLLED_BACK };
  }
}

export function createCheckpointService(services, options = {}) {
  const checkpoints = new CheckpointService(services, options);
  services.checkpoints = checkpoints;
  return checkpoints;
}

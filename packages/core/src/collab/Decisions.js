import { randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";

/**
 * Decision history (roadmap §12): one chronological list of every human
 * decision on a workspace, a run, or a single approval.
 *
 * Three record sets are joined:
 *   approvals         the request itself (what was proposed, and by whom)
 *   decision_history  the outcome rows written when someone approves, denies
 *                     or requests a change
 *   tasks.review      the accept/reject verdict on a delivered run
 *
 * Nothing is inferred: every entry names its source table, its actor and the
 * note the person wrote. An approval that has been decided but has no
 * decision_history row (decided before this table existed) still shows its
 * outcome, taken from the approvals row.
 */

export const DECISION_OUTCOMES = Object.freeze([
  "approve",
  "deny",
  "request-change",
  "accept",
  "reject",
  "expired",
  "cancelled",
]);

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function rowToDecision(row) {
  return {
    id: row.id,
    approvalId: row.approval_id ?? null,
    workspaceId: row.workspace_id ?? null,
    runId: row.run_id ?? null,
    actor: row.actor,
    decision: row.decision,
    note: row.note ?? null,
    createdAt: row.created_at,
  };
}

export class Decisions {
  constructor(services, { now = Date.now } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
  }

  /** Writes one outcome row. Used by ApprovalService and by run reviews. */
  record({
    approvalId = null,
    workspaceId = null,
    runId = null,
    actor = "local-user",
    decision,
    note = null,
    at = null,
  } = {}) {
    if (!decision) throw new InputError("decision is required");
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO decision_history (id, approval_id, workspace_id, run_id, actor, decision, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        approvalId,
        workspaceId,
        runId,
        String(actor).slice(0, 120),
        String(decision).slice(0, 60),
        note ? String(note).slice(0, 1000) : null,
        Number.isFinite(at) ? at : this.now(),
      );
    return rowToDecision(
      this.db.prepare("SELECT * FROM decision_history WHERE id = ?").get(id),
    );
  }

  rows({ workspaceId = null, runId = null, approvalId = null } = {}) {
    const clauses = [];
    const params = [];
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (runId) {
      clauses.push("run_id = ?");
      params.push(runId);
    }
    if (approvalId) {
      clauses.push("approval_id = ?");
      params.push(approvalId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM decision_history ${where} ORDER BY created_at ASC LIMIT 1000`,
      )
      .all(...params)
      .map(rowToDecision);
  }

  /**
   * history({ workspaceId, runId, approvalId }) → chronological entries
   *   { at, source, type, actor, decision, note, summary, approvalId, runId,
   *     workspaceId, taskId? }
   */
  history({
    workspaceId = null,
    runId = null,
    approvalId = null,
    limit = 500,
  } = {}) {
    const clauses = [];
    const params = [];
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (runId) {
      clauses.push("run_id = ?");
      params.push(runId);
    }
    if (approvalId) {
      clauses.push("id = ?");
      params.push(approvalId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const approvals = this.db
      .prepare(
        `SELECT * FROM approvals ${where} ORDER BY requested_at ASC LIMIT 500`,
      )
      .all(...params);

    const outcomes = this.rows({ workspaceId, runId, approvalId });
    const entries = [];

    for (const approval of approvals) {
      const payload = parseJson(approval.payload, {});
      entries.push({
        at: approval.requested_at,
        source: "approvals",
        type: "request",
        actor: approval.provider ?? "provider",
        decision: null,
        note: approval.reason ?? null,
        summary: `${approval.kind ?? "tool"} requested: ${approval.action}`,
        approvalId: approval.id,
        runId: approval.run_id ?? null,
        workspaceId: approval.workspace_id ?? null,
        taskId: approval.task_id ?? null,
        status: approval.status,
      });
      const hasOutcomeRow = outcomes.some(
        (row) => row.approvalId === approval.id,
      );
      if (!hasOutcomeRow && approval.decided_at)
        entries.push({
          at: approval.decided_at,
          source: "approvals",
          type: "decision",
          actor: approval.decided_by ?? "system",
          decision: approval.decision ?? approval.status,
          note: payload._note ?? null,
          summary: `${approval.decision ?? approval.status}: ${approval.action}`,
          approvalId: approval.id,
          runId: approval.run_id ?? null,
          workspaceId: approval.workspace_id ?? null,
          taskId: approval.task_id ?? null,
          status: approval.status,
        });
    }

    const actionById = new Map(approvals.map((a) => [a.id, a.action]));
    for (const row of outcomes)
      entries.push({
        at: row.createdAt,
        source: "decision_history",
        type: "decision",
        actor: row.actor,
        decision: row.decision,
        note: row.note,
        summary: `${row.decision}: ${actionById.get(row.approvalId) ?? row.approvalId ?? "run review"}`,
        approvalId: row.approvalId,
        runId: row.runId,
        workspaceId: row.workspaceId,
        taskId: null,
        status: null,
      });

    // Run reviews live on the task, not in approvals.
    const reviewClauses = [];
    const reviewParams = [];
    if (workspaceId) {
      reviewClauses.push("workspace_id = ?");
      reviewParams.push(workspaceId);
    }
    if (!approvalId) {
      const tasks = this.db
        .prepare(
          `SELECT id, workspace_id, title, review, updated_at FROM tasks ${reviewClauses.length ? `WHERE ${reviewClauses.join(" AND ")}` : ""} LIMIT 500`,
        )
        .all(...reviewParams);
      for (const task of tasks) {
        const review = parseJson(task.review, {});
        // A skipped step carries a review row that no person decided.
        if (!review.status || review.status === "pending") continue;
        if (review.skipped === true || review.status === "skipped") continue;
        if (runId && review.runId !== runId) continue;
        entries.push({
          at: review.decidedAt ?? task.updated_at ?? 0,
          source: "tasks.review",
          type: "review",
          actor: review.decidedBy ?? review.actor ?? "local-user",
          decision: review.status,
          note: review.note ?? null,
          summary: `review ${review.status}: ${task.title}`,
          approvalId: null,
          runId: review.runId ?? null,
          workspaceId: task.workspace_id,
          taskId: task.id,
          status: review.status,
        });
      }
    }

    entries.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return entries.slice(0, Math.max(1, Math.min(Number(limit) || 500, 1000)));
  }
}

/** services.js optional-module factory. */
export function createDecisions(services) {
  services.decisions ??= new Decisions(services);
  return services.decisions;
}

export default Decisions;

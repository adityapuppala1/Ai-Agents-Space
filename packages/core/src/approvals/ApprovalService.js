import { createHash, randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";
import { redactSecrets } from "../audit/Audit.js";

export const APPROVAL_KINDS = [
  "tool",
  "command",
  "file",
  "network",
  "policy",
  "question",
  "permission",
];
const DECISIONS = ["approve", "deny"];

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

export function payloadHash(payload) {
  return createHash("sha256")
    .update(stableStringify(payload ?? {}))
    .digest("hex");
}

function truncate(text, max = 240) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function summarizePayload(kind, payload = {}) {
  if (kind === "command" && payload.command)
    return truncate(payload.command, 160);
  if (kind === "file" && (payload.path || payload.file))
    return truncate(payload.path ?? payload.file, 160);
  if (kind === "network" && (payload.url || payload.query))
    return truncate(payload.url ?? payload.query, 160);
  if (kind === "question" && payload.question)
    return truncate(payload.question, 160);
  if (kind === "permission")
    return truncate(
      payload.reason ??
        payload.message ??
        (Array.isArray(payload.permissions)
          ? payload.permissions.join(", ")
          : "provider permission request"),
      160,
    );
  if (payload.tool_name || payload.tool)
    return `tool ${payload.tool_name ?? payload.tool}`;
  return kind;
}

function rowToApproval(row) {
  const json = (v, f) => {
    try {
      return v ? JSON.parse(v) : f;
    } catch {
      return f;
    }
  };
  return {
    id: row.id,
    runId: row.run_id ?? null,
    workspaceId: row.workspace_id ?? null,
    taskId: row.task_id ?? null,
    kind: row.kind,
    action: row.action,
    payload: json(row.payload, {}),
    reason: row.reason ?? null,
    status: row.status,
    decision: row.decision ?? null,
    decidedBy: row.decided_by ?? null,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at ?? null,
    expiresAt: row.expires_at ?? null,
    provider: row.provider ?? null,
    providerRef: row.provider_ref ?? null,
  };
}

/**
 * Human-in-the-loop approvals. Requests are durable rows; waiters are
 * in-memory promises resolved by decide()/expiry. A decision binds to the
 * payload hash captured at request time so an edited payload cannot reuse an
 * old approval.
 */
export class ApprovalService {
  constructor(
    services,
    { now = Date.now, defaultTtlMs = 15 * 60 * 1000, sweepMs = 30000 } = {},
  ) {
    this.services = services;
    this.db = services.db;
    this.bus = services.bus;
    this.now = now;
    this.defaultTtlMs = defaultTtlMs;
    this.waiters = new Map(); // id → Set<{resolve, timer}>
    this.hashes = new Map(); // id → payload hash (also stored in details)
    this.sweepTimer = setInterval(() => this.expireSweep(), sweepMs);
    this.sweepTimer.unref?.();
    services.onClose?.(() => this.stop());
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const [id] of this.waiters) this.#resolveWaiters(id, this.#get(id));
  }

  #get(id) {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? rowToApproval(row) : null;
  }

  get(id) {
    const approval = this.#get(id);
    if (!approval) throw new InputError("Approval not found", 404);
    return this.#withState(approval);
  }

  /** Marks a pending row expired if its deadline has passed; returns fresh copy. */
  #withState(approval) {
    if (
      approval.status === "pending" &&
      approval.expiresAt &&
      approval.expiresAt <= this.now()
    ) {
      this.#expire(approval.id);
      return this.#get(approval.id);
    }
    return approval;
  }

  request({
    workspaceId = null,
    runId = null,
    taskId = null,
    kind = "tool",
    payload = {},
    reason = null,
    provider = null,
    providerRef = null,
    expiresInMs,
    actor = "system",
    rule = null,
  } = {}) {
    if (!APPROVAL_KINDS.includes(kind))
      throw new InputError(`kind must be one of ${APPROVAL_KINDS.join(", ")}`);
    let run = null;
    if (runId) {
      const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
      if (!row) throw new InputError("Run not found", 404);
      run = row;
      workspaceId ??= row.workspace_id;
      taskId ??= row.task_id;
      provider ??= row.provider;
    }
    if (!runId)
      throw new InputError(
        "Approvals must belong to a run (approvals.run_id is required)",
      );
    // Approvals bind a person to the exact text they approve, so the command
    // is kept whole (hook bodies are capped at 256 KB upstream).
    const safePayload = redactSecrets(payload ?? {}, 0, {
      maxString: 262144,
    });
    const hash = payloadHash(safePayload);
    const id = randomUUID();
    const requestedAt = this.now();
    const ttl =
      Number.isFinite(expiresInMs) && expiresInMs > 0
        ? expiresInMs
        : this.defaultTtlMs;
    const expiresAt = requestedAt + ttl;
    const action = summarizePayload(kind, safePayload);
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, action, status, requested_at, decided_at, workspace_id, task_id, kind, payload, reason, provider, provider_ref, expires_at)
         VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        action,
        requestedAt,
        workspaceId,
        taskId,
        kind,
        JSON.stringify({
          ...safePayload,
          _hash: hash,
          _rule: rule ?? undefined,
        }),
        reason,
        provider,
        providerRef,
        expiresAt,
      );
    this.hashes.set(id, hash);
    this.services.recorder?.applyEvent(runId, {
      kind: "approval.request",
      provenance: "system",
      summary: `Approval needed: ${action}`,
      timestamp: requestedAt,
      data: { approvalId: id, kind, reason, rule, payloadHash: hash },
    });
    this.services.audit?.record({
      actor,
      action: "approval.request",
      target: `approval:${id}`,
      workspaceId,
      runId,
      policyDecision: "ask",
      details: {
        kind,
        reason,
        rule,
        payload: safePayload,
        payloadHash: hash,
        expiresAt,
      },
    });
    this.bus?.emit("global");
    return this.#get(id);
  }

  decide(
    id,
    {
      decision,
      actor = "local-user",
      note = null,
      payloadHash: expectedHash = null,
    } = {},
  ) {
    if (!DECISIONS.includes(decision))
      throw new InputError("decision must be 'approve' or 'deny'");
    const approval = this.#get(id);
    if (!approval) throw new InputError("Approval not found", 404);
    if (approval.status === "expired")
      throw new InputError("Approval has expired; ask the agent to retry", 410);
    if (approval.status !== "pending")
      throw new InputError(`Approval already ${approval.status}`, 409);
    if (approval.expiresAt && approval.expiresAt <= this.now()) {
      this.#expire(id);
      throw new InputError("Approval has expired; ask the agent to retry", 410);
    }
    const storedHash = approval.payload?._hash ?? this.hashes.get(id) ?? null;
    if (expectedHash && storedHash && expectedHash !== storedHash)
      throw new InputError(
        "Approval payload changed since it was shown; refresh and decide again",
        409,
      );
    const decidedAt = this.now();
    const status = decision === "approve" ? "approved" : "denied";
    const noteText = note ? String(note).slice(0, 1000) : null;
    this.db
      .prepare(
        `UPDATE approvals SET status = ?, decision = ?, decided_by = ?, decided_at = ?, payload = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(
        status,
        decision,
        String(actor).slice(0, 120),
        decidedAt,
        JSON.stringify({ ...approval.payload, _note: noteText ?? undefined }),
        id,
      );
    const updated = this.#get(id);
    this.services.recorder?.applyEvent(approval.runId, {
      kind: "approval.decision",
      provenance: "user",
      summary: `${decision === "approve" ? "Approved" : "Denied"} by ${actor}: ${approval.action}${noteText ? ` — ${truncate(noteText, 120)}` : ""}`,
      timestamp: decidedAt,
      data: {
        approvalId: id,
        decision,
        actor,
        note: noteText,
        payloadHash: storedHash,
      },
    });
    this.services.audit?.record({
      actor,
      action: "approval.decide",
      target: `approval:${id}`,
      workspaceId: approval.workspaceId,
      runId: approval.runId,
      policyDecision: decision,
      details: {
        kind: approval.kind,
        decision,
        note: noteText,
        payloadHash: storedHash,
      },
    });
    this.#resolveWaiters(id, updated);
    this.bus?.emit("global");
    return updated;
  }

  #expire(id) {
    const changed = this.db
      .prepare(
        "UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(this.now(), id).changes;
    if (!changed) return null;
    const approval = this.#get(id);
    this.services.recorder?.applyEvent(approval.runId, {
      kind: "approval.decision",
      provenance: "system",
      summary: `Approval expired without a decision: ${approval.action}`,
      timestamp: this.now(),
      data: { approvalId: id, decision: "expired" },
    });
    this.services.audit?.record({
      actor: "system",
      action: "approval.expire",
      target: `approval:${id}`,
      workspaceId: approval.workspaceId,
      runId: approval.runId,
      policyDecision: "expired",
      details: { kind: approval.kind },
    });
    this.#resolveWaiters(id, approval);
    this.bus?.emit("global");
    return approval;
  }

  cancelForRun(runId, { reason = "run ended" } = {}) {
    const rows = this.db
      .prepare(
        "SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'",
      )
      .all(runId);
    for (const { id } of rows) {
      this.db
        .prepare(
          "UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(this.now(), id);
      this.services.audit?.record({
        actor: "system",
        action: "approval.cancel",
        target: `approval:${id}`,
        runId,
        policyDecision: "cancelled",
        details: { reason },
      });
      this.#resolveWaiters(id, this.#get(id));
    }
    if (rows.length) this.bus?.emit("global");
    return rows.length;
  }

  #resolveWaiters(id, approval) {
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const waiter of set) {
      clearTimeout(waiter.timer);
      waiter.resolve(approval);
    }
  }

  /**
   * Resolves with the approval once decided, expired, or cancelled. When the
   * caller's timeout passes first, the approval is marked expired so the
   * inbox never shows a decision nobody can act on.
   */
  wait(id, timeoutMs) {
    const current = this.#get(id);
    if (!current)
      return Promise.reject(new InputError("Approval not found", 404));
    const state = this.#withState(current);
    if (state.status !== "pending") return Promise.resolve(state);
    const remaining = state.expiresAt
      ? Math.max(0, state.expiresAt - this.now())
      : Infinity;
    const limit = Math.min(
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : Infinity,
      remaining,
    );
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      if (Number.isFinite(limit)) {
        waiter.timer = setTimeout(() => {
          const set = this.waiters.get(id);
          set?.delete(waiter);
          if (set && !set.size) this.waiters.delete(id);
          const expired = this.#expire(id) ?? this.#get(id);
          resolve(expired);
        }, limit);
        waiter.timer.unref?.();
      }
      if (!this.waiters.has(id)) this.waiters.set(id, new Set());
      this.waiters.get(id).add(waiter);
    });
  }

  expireSweep() {
    const rows = this.db
      .prepare(
        "SELECT id FROM approvals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?",
      )
      .all(this.now());
    for (const { id } of rows) this.#expire(id);
    return rows.length;
  }

  list({ status = null, workspaceId = null, runId = null, limit = 200 } = {}) {
    const clauses = [];
    const params = [];
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (workspaceId) {
      clauses.push("workspace_id = ?");
      params.push(workspaceId);
    }
    if (runId) {
      clauses.push("run_id = ?");
      params.push(runId);
    }
    params.push(Math.max(1, Math.min(Number(limit) || 200, 1000)));
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM approvals ${where} ORDER BY requested_at DESC LIMIT ?`,
      )
      .all(...params)
      .map(rowToApproval)
      .map((a) => this.#withState(a));
  }

  pending({ workspaceId = null } = {}) {
    return this.list({ status: "pending", workspaceId }).filter(
      (a) => a.status === "pending",
    );
  }

  listForRun(runId) {
    return this.list({ runId, limit: 500 });
  }

  /** Everything that needs a person: approvals, broken runs, review requests. */
  inbox({ workspaceId = null } = {}) {
    const approvals = this.pending({ workspaceId });
    const runRows = this.db
      .prepare(
        `SELECT r.id, r.workspace_id, r.task_id, r.agent_id, r.provider, r.mode, r.status, r.title, r.error, r.started_at, r.ended_at, r.last_event_at, r.attempt, t.title AS task_title
         FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
         WHERE r.status IN ('failed', 'stale', 'disconnected') AND (? IS NULL OR r.workspace_id = ?)
         ORDER BY COALESCE(r.ended_at, r.last_event_at, r.started_at) DESC LIMIT 200`,
      )
      .all(workspaceId, workspaceId);
    const runs = runRows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      taskId: r.task_id,
      agentId: r.agent_id,
      provider: r.provider,
      mode: r.mode,
      status: r.status,
      title: r.title ?? r.task_title ?? null,
      error: r.error ?? null,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? null,
      lastEventAt: r.last_event_at ?? null,
      attempt: r.attempt,
    }));
    const reviewRows = this.db
      .prepare(
        `SELECT id, workspace_id, title, status, review, assigned_agent_id, updated_at FROM tasks
         WHERE review LIKE '%"pending"%' AND (? IS NULL OR workspace_id = ?) ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 200`,
      )
      .all(workspaceId, workspaceId);
    const reviews = [];
    for (const row of reviewRows) {
      let review = {};
      try {
        review = JSON.parse(row.review || "{}");
      } catch {
        continue;
      }
      if (review.status !== "pending") continue;
      reviews.push({
        taskId: row.id,
        workspaceId: row.workspace_id,
        title: row.title,
        taskStatus: row.status,
        runId: review.runId ?? null,
        agentId: row.assigned_agent_id ?? null,
        note: review.note ?? null,
        updatedAt: row.updated_at ?? null,
      });
    }
    const questions = approvals.filter((a) => a.kind === "question");
    const counts = {
      approvals: approvals.length,
      runs: runs.length,
      reviews: reviews.length,
      questions: questions.length,
      total: approvals.length + runs.length + reviews.length,
    };
    return { approvals, runs, reviews, questions, counts };
  }
}

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
const DECISIONS = ["approve", "deny", "request-change"];

/**
 * Urgency (roadmap §12) is computed from stored facts only: whether the
 * request blocks a run that is waiting on it, how long it has waited, the
 * risk level of the rule that raised it, and the priority of its task.
 * Nothing is predicted and no score is invented for display.
 */
export const URGENCY_LEVELS = ["normal", "high", "critical"];
export const URGENCY_AGE_HIGH_MS = 10 * 60 * 1000;
export const URGENCY_AGE_CRITICAL_MS = 30 * 60 * 1000;

const HIGH_RISK_RULES =
  /deny|denied|risky|deploy|publish|push|secret|network|outside|force/i;

/** 'high' | 'medium' | 'low' from the policy rule id and the request kind. */
function riskLevel(approval) {
  const rule = approval.payload?._rule ?? approval.payload?.rule ?? null;
  const ruleId =
    typeof rule === "string" ? rule : (rule?.id ?? rule?.category ?? "");
  if (ruleId && HIGH_RISK_RULES.test(String(ruleId))) return "high";
  if (approval.kind === "command" || approval.kind === "network") return "high";
  if (approval.kind === "file" || approval.kind === "policy") return "medium";
  if (approval.kind === "permission" || approval.kind === "tool")
    return "medium";
  return "low";
}

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
    if (decision === "request-change")
      return this.#requestChange(approval, { actor, note, storedHash });
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
    this.#history({
      approvalId: id,
      workspaceId: approval.workspaceId,
      runId: approval.runId,
      actor,
      decision,
      note: noteText,
      at: decidedAt,
    });
    this.#resolveWaiters(id, updated);
    this.bus?.emit("global");
    return updated;
  }

  /**
   * 'request-change' records the outcome and leaves the approval pending: the
   * run stays waiting, no waiter is resolved, and the change request is
   * carried in the inbox so the agent picks it up on its next attempt. It is
   * deliberately NOT an approval.decision event, because that event would
   * return the run to `running`.
   */
  #requestChange(approval, { actor, note, storedHash }) {
    const at = this.now();
    const noteText = note ? String(note).slice(0, 1000) : null;
    const changes = Array.isArray(approval.payload?._changeRequests)
      ? approval.payload._changeRequests
      : [];
    const entry = { actor: String(actor).slice(0, 120), note: noteText, at };
    this.db
      .prepare(
        "UPDATE approvals SET payload = ? WHERE id = ? AND status = 'pending'",
      )
      .run(
        JSON.stringify({
          ...approval.payload,
          _changeRequests: [...changes, entry],
        }),
        approval.id,
      );
    this.services.recorder?.applyEvent(approval.runId, {
      kind: "status",
      provenance: "user",
      summary: `Change requested by ${actor}: ${approval.action}${noteText ? ` - ${truncate(noteText, 120)}` : ""}`,
      timestamp: at,
      data: {
        approvalId: approval.id,
        decision: "request-change",
        actor,
        note: noteText,
        payloadHash: storedHash,
        stillWaiting: true,
      },
    });
    this.services.audit?.record({
      actor,
      action: "approval.decide",
      target: `approval:${approval.id}`,
      workspaceId: approval.workspaceId,
      runId: approval.runId,
      policyDecision: "request-change",
      details: {
        kind: approval.kind,
        decision: "request-change",
        note: noteText,
        payloadHash: storedHash,
      },
    });
    this.#history({
      approvalId: approval.id,
      workspaceId: approval.workspaceId,
      runId: approval.runId,
      actor,
      decision: "request-change",
      note: noteText,
      at,
    });
    this.bus?.emit("global");
    const updated = this.#get(approval.id);
    return {
      ...updated,
      changeRequests: updated.payload?._changeRequests ?? [],
      stillWaiting: true,
    };
  }

  /** One decision_history row. Falls back silently when the table is absent. */
  #history({ approvalId, workspaceId, runId, actor, decision, note, at }) {
    if (this.services.decisions?.record) {
      try {
        return this.services.decisions.record({
          approvalId,
          workspaceId,
          runId,
          actor,
          decision,
          note,
          at,
        });
      } catch {
        /* fall through to the direct insert */
      }
    }
    try {
      this.db
        .prepare(
          `INSERT INTO decision_history (id, approval_id, workspace_id, run_id, actor, decision, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          approvalId,
          workspaceId,
          runId,
          String(actor).slice(0, 120),
          String(decision).slice(0, 60),
          note ?? null,
          at,
        );
    } catch {
      /* the decision_history table is not in this database; the approval row
         and the audit log still carry the decision. */
    }
    return null;
  }

  /**
   * urgency(approval) → { level: 'critical'|'high'|'normal', score, reason,
   * factors }. Blocking a waiting run, age, rule risk, task priority and an
   * imminent expiry each contribute a fixed, documented amount.
   */
  urgency(approval, { now = this.now() } = {}) {
    const factors = [];
    let score = 0;
    const run = approval.runId
      ? this.db
          .prepare("SELECT id, status, mode FROM runs WHERE id = ?")
          .get(approval.runId)
      : null;
    const blocking =
      !!run && ["waiting_approval", "running", "blocked"].includes(run.status);
    if (blocking) {
      score += 2;
      factors.push(`blocks a ${run.status} run`);
    }
    const risk = riskLevel(approval);
    if (risk === "high") {
      score += 2;
      factors.push("the policy rule that raised it is high risk");
    } else if (risk === "medium") {
      score += 1;
      factors.push("medium-risk request");
    }
    const task = approval.taskId
      ? this.db
          .prepare("SELECT priority FROM tasks WHERE id = ?")
          .get(approval.taskId)
      : null;
    if (task?.priority === "critical") {
      score += 2;
      factors.push("its task is critical priority");
    } else if (task?.priority === "high") {
      score += 1;
      factors.push("its task is high priority");
    }
    const ageMs = Math.max(0, now - (approval.requestedAt ?? now));
    if (ageMs > URGENCY_AGE_CRITICAL_MS) {
      score += 2;
      factors.push(`waiting ${Math.round(ageMs / 60000)} minutes`);
    } else if (ageMs > URGENCY_AGE_HIGH_MS) {
      score += 1;
      factors.push(`waiting ${Math.round(ageMs / 60000)} minutes`);
    }
    if (
      approval.status === "pending" &&
      Number.isFinite(approval.expiresAt) &&
      approval.expiresAt - now <= 2 * 60 * 1000
    ) {
      score += 1;
      factors.push("expires in under two minutes");
    }
    const level = score >= 5 ? "critical" : score >= 3 ? "high" : "normal";
    return {
      level,
      score,
      ageMs,
      risk,
      blocking,
      taskPriority: task?.priority ?? null,
      factors,
      reason: factors.length
        ? `${level}: ${factors.join("; ")}`
        : "normal: nothing is blocked and it has just arrived",
    };
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

  /**
   * The exact action a person is being asked to allow: the command, the path,
   * the URL, or a summary of the diff. Contents are never summarised away -
   * the payload itself still travels with the approval - this is the short
   * form the inbox shows first.
   */
  proposedAction(approval) {
    const payload = approval.payload ?? {};
    const input = payload.tool_input ?? payload.input ?? {};
    const command = payload.command ?? input.command ?? null;
    const path = payload.path ?? payload.file ?? input.file_path ?? null;
    const url = payload.url ?? input.url ?? null;
    const diff = payload.diff ?? payload.patch ?? input.patch ?? null;
    const action = {
      type: command
        ? "command"
        : url
          ? "network"
          : diff
            ? "diff"
            : path
              ? "file"
              : (approval.kind ?? "tool"),
      tool: payload.tool_name ?? payload.tool ?? input.tool ?? null,
      command: command ? String(command) : null,
      path: path ? String(path) : null,
      url: url ? String(url) : null,
      text: approval.action,
    };
    if (diff) {
      const lines = String(diff).split(/\r?\n/);
      action.diffSummary = {
        files: lines.filter((line) => line.startsWith("+++ ")).length,
        added: lines.filter(
          (line) => line.startsWith("+") && !line.startsWith("+++"),
        ).length,
        removed: lines.filter(
          (line) => line.startsWith("-") && !line.startsWith("---"),
        ).length,
        bytes: Buffer.byteLength(String(diff)),
      };
    }
    return action;
  }

  /** Everything this decision would touch, as typed rows for the UI. */
  affectedResources(approval) {
    const action = this.proposedAction(approval);
    const out = [];
    if (action.path) out.push({ type: "file", value: action.path });
    if (action.command) out.push({ type: "command", value: action.command });
    if (action.url) out.push({ type: "url", value: action.url });
    for (const file of approval.payload?.files ?? [])
      out.push({
        type: "file",
        value: typeof file === "string" ? file : (file?.path ?? String(file)),
      });
    if (approval.runId) out.push({ type: "run", value: approval.runId });
    if (approval.taskId) out.push({ type: "task", value: approval.taskId });
    if (approval.workspaceId)
      out.push({ type: "workspace", value: approval.workspaceId });
    return out;
  }

  /** Change requests recorded against still-pending approvals. */
  changeRequests({ workspaceId = null } = {}) {
    const out = [];
    for (const approval of this.pending({ workspaceId }))
      for (const entry of approval.payload?._changeRequests ?? [])
        out.push({
          approvalId: approval.id,
          runId: approval.runId,
          workspaceId: approval.workspaceId,
          taskId: approval.taskId,
          action: approval.action,
          actor: entry.actor,
          note: entry.note ?? null,
          at: entry.at,
          state: "waiting for the agent's next attempt",
        });
    return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }

  /**
   * Everything that needs a person: approvals, broken runs, review requests.
   * Approvals carry `urgency`, the exact `proposedAction` and the
   * `affectedResources`, and are ordered most urgent first (oldest first
   * within one level). Existing fields are unchanged.
   */
  inbox({ workspaceId = null } = {}) {
    const approvals = this.pending({ workspaceId }).map((approval) => ({
      ...approval,
      urgency: this.urgency(approval),
      proposedAction: this.proposedAction(approval),
      affectedResources: this.affectedResources(approval),
      changeRequests: approval.payload?._changeRequests ?? [],
    }));
    const rankOf = (approval) =>
      URGENCY_LEVELS.indexOf(approval.urgency?.level ?? "normal");
    approvals.sort(
      (a, b) =>
        rankOf(b) - rankOf(a) ||
        (b.urgency?.score ?? 0) - (a.urgency?.score ?? 0) ||
        (a.requestedAt ?? 0) - (b.requestedAt ?? 0),
    );
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
    const changeRequests = approvals.flatMap((approval) =>
      (approval.changeRequests ?? []).map((entry) => ({
        approvalId: approval.id,
        runId: approval.runId,
        workspaceId: approval.workspaceId,
        taskId: approval.taskId,
        action: approval.action,
        actor: entry.actor,
        note: entry.note ?? null,
        at: entry.at,
        state: "waiting for the agent's next attempt",
      })),
    );
    const counts = {
      approvals: approvals.length,
      runs: runs.length,
      reviews: reviews.length,
      questions: questions.length,
      // `total` keeps its original meaning (things needing a first decision);
      // change requests belong to an approval that is already counted.
      total: approvals.length + runs.length + reviews.length,
    };
    // Added as its own object so `counts` keeps exactly the keys it always had.
    const urgencyCounts = {
      critical: approvals.filter((a) => a.urgency?.level === "critical").length,
      high: approvals.filter((a) => a.urgency?.level === "high").length,
      normal: approvals.filter((a) => a.urgency?.level === "normal").length,
      changeRequests: changeRequests.length,
    };
    return {
      approvals,
      runs,
      reviews,
      questions,
      changeRequests,
      counts,
      urgencyCounts,
    };
  }
}

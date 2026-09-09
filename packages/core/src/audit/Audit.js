import { randomUUID } from "node:crypto";

const SECRET_KEY =
  /^(token|secret|password|passwd|authorization|key|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|credentials?|private[_-]?key|cookie|set-cookie)$/i;
const SECRET_KEY_LOOSE = /token|secret|password|authorization|credential/i;

/**
 * Recursively replaces values whose key names look like credentials. Arrays
 * and nested objects are walked; depth is bounded so cyclic input cannot hang.
 */
export function redactSecrets(value, depth = 0, options = {}) {
  const maxString = options.maxString ?? 4000;
  if (depth > 12) return "[redacted:depth]";
  if (Array.isArray(value))
    return value.map((v) => redactSecrets(v, depth + 1, options));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key) || SECRET_KEY_LOOSE.test(key))
        out[key] = "[redacted]";
      else out[key] = redactSecrets(item, depth + 1, options);
    }
    return out;
  }
  if (typeof value === "string" && value.length > maxString)
    return value.slice(0, maxString) + "…";
  return value;
}

function rowToEntry(row) {
  let details = {};
  try {
    details = JSON.parse(row.details || "{}");
  } catch {
    details = {};
  }
  return {
    id: row.id,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action,
    target: row.target ?? null,
    workspaceId: row.workspace_id ?? null,
    runId: row.run_id ?? null,
    policyDecision: row.policy_decision ?? null,
    details,
  };
}

/**
 * Append-only audit log. `record()` never throws on bad details: anything
 * unserializable is replaced with a marker so an audit failure cannot block
 * the action being audited.
 */
export class Audit {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
  }

  record({
    actor = "system",
    action,
    target = null,
    workspaceId = null,
    runId = null,
    policyDecision = null,
    details = {},
    timestamp,
  }) {
    if (!action || typeof action !== "string")
      throw new TypeError("audit.record requires an action");
    const id = randomUUID();
    let serialized;
    try {
      serialized = JSON.stringify(redactSecrets(details ?? {}));
    } catch {
      serialized = JSON.stringify({ unserializable: true });
    }
    if (serialized.length > 16384)
      serialized = JSON.stringify({
        truncated: true,
        preview: serialized.slice(0, 16000),
      });
    const ts = timestamp ?? this.now();
    this.db
      .prepare(
        `INSERT INTO audit_log (id, timestamp, actor, action, target, workspace_id, run_id, policy_decision, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ts,
        String(actor ?? "system").slice(0, 120),
        action.slice(0, 120),
        target === null || target === undefined
          ? null
          : String(target).slice(0, 500),
        workspaceId ?? null,
        runId ?? null,
        policyDecision ?? null,
        serialized,
      );
    return {
      id,
      timestamp: ts,
      actor,
      action,
      target,
      workspaceId,
      runId,
      policyDecision,
      details: JSON.parse(serialized),
    };
  }

  list({ limit = 200, workspaceId, runId, action, since } = {}) {
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
    if (action) {
      clauses.push("action = ?");
      params.push(action);
    }
    if (since) {
      clauses.push("timestamp >= ?");
      params.push(Number(since));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const cap = Math.max(1, Math.min(Number(limit) || 200, 2000));
    params.push(cap);
    return this.db
      .prepare(
        `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      )
      .all(...params)
      .map(rowToEntry);
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM audit_log WHERE id = ?").get(id);
    return row ? rowToEntry(row) : null;
  }
}

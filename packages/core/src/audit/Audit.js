import { createHash, randomUUID } from "node:crypto";

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

/**
 * Deterministic JSON: object keys sorted, so two structurally identical
 * detail objects always hash the same regardless of insertion order.
 */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return "null";
  return JSON.stringify(value);
}

/** The hash algorithm this build writes. Bumped when the input changes. */
export const AUDIT_CHAIN_VERSION = 2;

/**
 * hash = sha256(canonicalJson({sequence, timestamp, actor, action, target,
 *               workspaceId, runId, policyDecision, details, prevHash})).
 *
 * Chain version 2. Two things changed from version 1:
 *  - `workspaceId` and `runId` are covered. They are real columns that the UI
 *    and the diagnostics export present as evidence; leaving them out let a
 *    row be re-attributed to another workspace or run without breaking
 *    verify().
 *  - The fields are hashed as canonical JSON instead of being joined with
 *    a newline. `actor`, `action` and `target` are stored raw and carry caller
 *    text, so a newline inside one of them made the joined string ambiguous:
 *    actor "a<LF>b" + action "c" produced the same digest as actor "a"
 *    + action "b<LF>c". Canonical JSON quotes and escapes every field, so the
 *    encoding is injective.
 */
export function auditHash({
  sequence,
  timestamp,
  actor,
  action,
  target,
  workspaceId,
  runId,
  policyDecision,
  details,
  prevHash,
}) {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: AUDIT_CHAIN_VERSION,
        sequence: sequence ?? null,
        timestamp: timestamp ?? null,
        actor: actor ?? null,
        action: action ?? null,
        target: target ?? null,
        workspaceId: workspaceId ?? null,
        runId: runId ?? null,
        policyDecision: policyDecision ?? null,
        details: details ?? {},
        prevHash: prevHash ?? null,
      }),
    )
    .digest("hex");
}

/**
 * Chain version 1: the newline join this build no longer writes. Used only by
 * verify(), so rows recorded before the upgrade are reported as belonging to
 * the older chain version rather than as tampered with.
 */
export function legacyAuditHash({
  sequence,
  timestamp,
  actor,
  action,
  target,
  policyDecision,
  details,
  prevHash,
}) {
  return createHash("sha256")
    .update(
      [
        String(sequence ?? ""),
        String(timestamp ?? ""),
        String(actor ?? ""),
        String(action ?? ""),
        target === null || target === undefined ? "" : String(target),
        policyDecision === null || policyDecision === undefined
          ? ""
          : String(policyDecision),
        canonicalJson(details ?? {}),
        prevHash ?? "",
      ].join("\n"),
    )
    .digest("hex");
}

/** Caller text with control characters removed, clipped to `max`. */
function plainText(value, max) {
  let out = "";
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.slice(0, max);
}

function parseDetails(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function rowToEntry(row) {
  return {
    id: row.id,
    sequence: row.sequence ?? null,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action,
    target: row.target ?? null,
    workspaceId: row.workspace_id ?? null,
    runId: row.run_id ?? null,
    policyDecision: row.policy_decision ?? null,
    details: parseDetails(row.details),
    prevHash: row.prev_hash ?? null,
    hash: row.hash ?? null,
  };
}

const CSV_COLUMNS = [
  "sequence",
  "id",
  "timestamp",
  "isoTimestamp",
  "actor",
  "action",
  "target",
  "workspaceId",
  "runId",
  "policyDecision",
  "details",
  "prevHash",
  "hash",
];

/**
 * RFC 4180 escaping: quote when the value holds a comma, quote, or newline.
 *
 * A leading "=", "+", "-", "@", TAB or CR also gets a "'" prefix first.
 * Excel and LibreOffice read those as the start of a FORMULA, and the actor
 * and target columns carry text an API caller chose, so an exported audit log
 * could otherwise run a DDE command on the reviewer's machine.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);
  if (/^[=+@\t\r-]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/**
 * Append-only audit log with a tamper-evident hash chain (schema v5).
 *
 * `record()` never throws on bad details: anything unserializable is replaced
 * with a marker so an audit failure cannot block the action being audited.
 *
 * Chain rules:
 *   - every new row gets sequence = previous sequence + 1 (starting at 1)
 *   - prev_hash is the stored hash of the previous row (null for the first)
 *   - hash is computed by auditHash() over the record and prev_hash
 *   - verify() recomputes every hash and checks the links. It starts at the
 *     lowest sequence still present, so pruning the oldest rows (retention)
 *     stays valid while editing or removing a row in the middle does not.
 */
export class Audit {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    this.chained = this.#hasChainColumns();
  }

  #hasChainColumns() {
    try {
      const columns = this.db
        .prepare("PRAGMA table_info(audit_log)")
        .all()
        .map((row) => row.name);
      return (
        columns.includes("hash") &&
        columns.includes("prev_hash") &&
        columns.includes("sequence")
      );
    } catch {
      return false;
    }
  }

  /** The newest chained row, or null when the chain is empty. */
  head() {
    if (!this.chained) return null;
    const row = this.db
      .prepare(
        "SELECT sequence, hash FROM audit_log WHERE sequence IS NOT NULL ORDER BY sequence DESC LIMIT 1",
      )
      .get();
    return row ? { sequence: row.sequence, hash: row.hash } : null;
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
    // actor/action/target are stored raw and carry caller-chosen text, so
    // control characters are stripped before they are stored, hashed, or
    // exported. Stripping (not rejecting): an audit failure must never block
    // the action being audited.
    const safeActor = plainText(actor ?? "system", 120);
    const safeAction = plainText(action, 120);
    const safeTarget =
      target === null || target === undefined ? null : plainText(target, 500);
    const storedDetails = parseDetails(serialized);

    if (!this.chained) {
      this.db
        .prepare(
          `INSERT INTO audit_log (id, timestamp, actor, action, target, workspace_id, run_id, policy_decision, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          ts,
          safeActor,
          safeAction,
          safeTarget,
          workspaceId ?? null,
          runId ?? null,
          policyDecision ?? null,
          serialized,
        );
      return {
        id,
        sequence: null,
        timestamp: ts,
        actor: safeActor,
        action: safeAction,
        target: safeTarget,
        workspaceId: workspaceId ?? null,
        runId: runId ?? null,
        policyDecision: policyDecision ?? null,
        details: storedDetails,
        prevHash: null,
        hash: null,
      };
    }

    const previous = this.head();
    const sequence = (previous?.sequence ?? 0) + 1;
    const prevHash = previous?.hash ?? null;
    const hash = auditHash({
      sequence,
      timestamp: ts,
      actor: safeActor,
      action: safeAction,
      target: safeTarget,
      workspaceId: workspaceId ?? null,
      runId: runId ?? null,
      policyDecision,
      details: storedDetails,
      prevHash,
    });
    this.db
      .prepare(
        `INSERT INTO audit_log (id, timestamp, actor, action, target, workspace_id, run_id, policy_decision, details, sequence, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ts,
        safeActor,
        safeAction,
        safeTarget,
        workspaceId ?? null,
        runId ?? null,
        policyDecision ?? null,
        serialized,
        sequence,
        prevHash,
        hash,
      );
    return {
      id,
      sequence,
      timestamp: ts,
      actor: safeActor,
      action: safeAction,
      target: safeTarget,
      workspaceId: workspaceId ?? null,
      runId: runId ?? null,
      policyDecision: policyDecision ?? null,
      details: storedDetails,
      prevHash,
      hash,
    };
  }

  #filter({ workspaceId, runId, action, since, until } = {}) {
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
    if (until) {
      clauses.push("timestamp <= ?");
      params.push(Number(until));
    }
    return {
      where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
      params,
    };
  }

  list({ limit = 200, workspaceId, runId, action, since, until } = {}) {
    const { where, params } = this.#filter({
      workspaceId,
      runId,
      action,
      since,
      until,
    });
    const cap = Math.max(1, Math.min(Number(limit) || 200, 5000));
    return this.db
      .prepare(
        `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      )
      .all(...params, cap)
      .map(rowToEntry);
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM audit_log WHERE id = ?").get(id);
    return row ? rowToEntry(row) : null;
  }

  count() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;
  }

  /**
   * Walks the chain oldest → newest and recomputes every hash.
   * → { ok, brokenAt, brokenReason, count, unchained, legacy, chainVersion,
   *     firstSequence, lastSequence, headHash }
   * `brokenAt` is the sequence number of the first record that does not match
   * what was stored (an edited row, a removed row in the middle, or a broken
   * link). `unchained` counts rows written before schema v5; `legacy` counts
   * rows whose hash matches audit chain version 1, which did not cover
   * workspace_id or run_id — those two fields are unverifiable on such rows.
   */
  verify({ limit = 100000 } = {}) {
    if (!this.chained)
      return {
        ok: false,
        brokenAt: null,
        brokenReason: "The audit hash chain columns are missing (schema < 5)",
        count: 0,
        unchained: this.count(),
        legacy: 0,
        chainVersion: AUDIT_CHAIN_VERSION,
        firstSequence: null,
        lastSequence: null,
        headHash: null,
      };
    const unchained = this.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE sequence IS NULL")
      .get().n;
    const rows = this.db
      .prepare(
        "SELECT * FROM audit_log WHERE sequence IS NOT NULL ORDER BY sequence ASC LIMIT ?",
      )
      .all(Math.max(1, Math.min(Number(limit) || 100000, 1000000)));
    let previous = null;
    let legacy = 0;
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (previous) {
        if (entry.sequence !== previous.sequence + 1)
          return {
            ok: false,
            brokenAt: entry.sequence,
            brokenReason: `Sequence jumped from ${previous.sequence} to ${entry.sequence}: a record was removed`,
            count: rows.length,
            unchained,
            legacy,
            chainVersion: AUDIT_CHAIN_VERSION,
            firstSequence: rows[0].sequence,
            lastSequence: rows[rows.length - 1].sequence,
            headHash: null,
          };
        if (entry.prevHash !== previous.hash)
          return {
            ok: false,
            brokenAt: entry.sequence,
            brokenReason: "The link to the previous record does not match",
            count: rows.length,
            unchained,
            legacy,
            chainVersion: AUDIT_CHAIN_VERSION,
            firstSequence: rows[0].sequence,
            lastSequence: rows[rows.length - 1].sequence,
            headHash: null,
          };
      }
      const expected = auditHash(entry);
      // A row written before the chain version bump hashes with the version 1
      // input. It is reported as belonging to the older chain — its
      // workspace_id and run_id were never covered — not as tampered with.
      if (expected !== entry.hash && legacyAuditHash(entry) === entry.hash) {
        legacy += 1;
        previous = entry;
        continue;
      }
      if (expected !== entry.hash)
        return {
          ok: false,
          brokenAt: entry.sequence,
          brokenReason: "The stored hash does not match the record contents",
          count: rows.length,
          unchained,
          legacy,
          chainVersion: AUDIT_CHAIN_VERSION,
          firstSequence: rows[0].sequence,
          lastSequence: rows[rows.length - 1].sequence,
          headHash: null,
        };
      previous = entry;
    }
    return {
      ok: true,
      brokenAt: null,
      brokenReason: null,
      count: rows.length,
      unchained,
      legacy,
      chainVersion: AUDIT_CHAIN_VERSION,
      firstSequence: rows.length ? rows[0].sequence : null,
      lastSequence: previous?.sequence ?? null,
      headHash: previous?.hash ?? null,
    };
  }

  /** Every matching row, oldest first (export order). */
  entries({ since, until, workspaceId, runId, action, limit = 50000 } = {}) {
    const { where, params } = this.#filter({
      workspaceId,
      runId,
      action,
      since,
      until,
    });
    const cap = Math.max(1, Math.min(Number(limit) || 50000, 200000));
    return this.db
      .prepare(
        `SELECT * FROM audit_log ${where} ORDER BY timestamp ASC, rowid ASC LIMIT ?`,
      )
      .all(...params, cap)
      .map(rowToEntry);
  }

  /** CSV text (RFC 4180) with a fixed column order. */
  exportCsv(options = {}) {
    const rows = this.entries(options);
    const lines = [CSV_COLUMNS.join(",")];
    for (const entry of rows) {
      lines.push(
        [
          entry.sequence,
          entry.id,
          entry.timestamp,
          new Date(entry.timestamp).toISOString(),
          entry.actor,
          entry.action,
          entry.target,
          entry.workspaceId,
          entry.runId,
          entry.policyDecision,
          canonicalJson(entry.details),
          entry.prevHash,
          entry.hash,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return lines.join("\r\n") + "\r\n";
  }

  /** JSON text: the verification result plus every matching entry. */
  exportJson(options = {}) {
    const entries = this.entries(options);
    return JSON.stringify(
      {
        generatedAt: this.now(),
        filter: {
          since: options.since ?? null,
          until: options.until ?? null,
          workspaceId: options.workspaceId ?? null,
          runId: options.runId ?? null,
          action: options.action ?? null,
        },
        verification: this.verify(),
        count: entries.length,
        entries,
      },
      null,
      2,
    );
  }

  /** Convenience for HTTP routes: { contentType, body, filename }. */
  export(format = "json", options = {}) {
    const normalized = String(format).toLowerCase();
    if (normalized === "csv")
      return {
        contentType: "text/csv; charset=utf-8",
        filename: "agent-space-audit.csv",
        body: this.exportCsv(options),
      };
    return {
      contentType: "application/json; charset=utf-8",
      filename: "agent-space-audit.json",
      body: this.exportJson(options),
    };
  }
}

import { InputError } from "../TaskStore.js";
import { transaction } from "../db.js";
import { ENDED_RUN_STATUSES } from "./Incident.js";

export const SETTING_RETENTION = "retention";
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Nothing is deleted until an operator turns retention on. */
export const DEFAULT_RETENTION = Object.freeze({
  enabled: false,
  eventsDays: 90,
  runsDays: 365,
  auditDays: 730,
  artifactsDays: 180,
});

const DAY_FIELDS = ["eventsDays", "runsDays", "auditDays", "artifactsDays"];

/**
 * SQL fragment listing runs that must never be swept: still live, or attached
 * to a task that has not been completed. Written as a plain subquery (no CTE)
 * so it can be embedded in DELETE and COUNT alike.
 */
const PROTECTED_RUNS = `SELECT r.id FROM runs r
   LEFT JOIN tasks t ON t.id = r.task_id
   WHERE r.status NOT IN (${ENDED_RUN_STATUSES.map((s) => `'${s}'`).join(",")})
      OR t.id IS NULL
      OR t.status <> 'COMPLETED'`;

const UNFINISHED_TASKS = `SELECT id FROM tasks WHERE status <> 'COMPLETED'`;

export function validateRetention(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("Expected a retention policy object");
  const policy = { ...DEFAULT_RETENTION };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean")
      throw new InputError("retention.enabled must be true or false");
    policy.enabled = input.enabled;
  }
  for (const field of DAY_FIELDS) {
    if (input[field] === undefined) continue;
    const value = input[field];
    if (value === null) {
      policy[field] = null; // null = keep forever
      continue;
    }
    if (!Number.isInteger(value) || value < 1 || value > 3650)
      throw new InputError(
        `retention.${field} must be null (keep forever) or 1-3650 days`,
      );
    policy[field] = value;
  }
  const unknown = Object.keys(input).filter(
    (key) => key !== "enabled" && !DAY_FIELDS.includes(key),
  );
  if (unknown.length)
    throw new InputError(`Unknown retention field(s): ${unknown.join(", ")}`);
  return policy;
}

/**
 * Retention sweeps.
 *
 * Order matters because of the foreign keys: events and artifacts reference
 * runs, approvals reference runs, runs reference tasks. A sweep therefore
 * deletes events and artifacts first, then the run rows that are old enough
 * and no longer referenced.
 *
 * Two rules are absolute:
 *   1. A run that is still live is never swept, and neither is anything that
 *      belongs to it.
 *   2. A run whose task is not COMPLETED is never swept: the work is still
 *      open, so its history is still evidence.
 *
 * The audit log is pruned oldest-first only. Audit.verify() starts at the
 * lowest sequence still present, so trimming a prefix keeps the hash chain
 * verifiable while an edit or a deletion in the middle still shows up.
 */
export class RetentionService {
  constructor(services, { now = Date.now, intervalMs = DAY_MS } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
    this.intervalMs = intervalMs;
    this.timer = null;
  }

  policy() {
    let stored = null;
    try {
      stored = this.services.settings?.get?.(SETTING_RETENTION, null) ?? null;
    } catch {
      stored = null;
    }
    if (!stored || typeof stored !== "object") return { ...DEFAULT_RETENTION };
    try {
      return validateRetention(stored);
    } catch {
      return { ...DEFAULT_RETENTION };
    }
  }

  setPolicy(input, { actor = "local-user" } = {}) {
    const policy = validateRetention(input);
    this.services.settings?.set?.(SETTING_RETENTION, policy);
    try {
      this.services.audit?.record?.({
        actor,
        action: "ops.retention.update",
        details: policy,
      });
    } catch {
      /* audit is best effort */
    }
    this.restart();
    return policy;
  }

  #cutoffs(now) {
    const policy = this.policy();
    const at = now ?? this.now();
    const cut = (days) => (days === null ? null : at - days * DAY_MS);
    return {
      policy,
      now: at,
      events: cut(policy.eventsDays),
      runs: cut(policy.runsDays),
      audit: cut(policy.auditDays),
      artifacts: cut(policy.artifactsDays),
    };
  }

  /** Run ids that are old enough and safe to remove. */
  #sweepableRunIds(cutoff, limit = 5000) {
    if (cutoff === null) return [];
    return this.db
      .prepare(
        `SELECT id FROM runs
           WHERE COALESCE(ended_at, started_at) < ?
             AND id NOT IN (${PROTECTED_RUNS})
           ORDER BY COALESCE(ended_at, started_at) ASC
           LIMIT ?`,
      )
      .all(cutoff, limit)
      .map((row) => row.id);
  }

  #count(sql, ...params) {
    try {
      return this.db.prepare(sql).get(...params).n;
    } catch {
      return 0;
    }
  }

  /** preview({ now }) → the counts a sweep would delete, deleting nothing. */
  preview({ now } = {}) {
    const cut = this.#cutoffs(now);
    const events =
      cut.events === null
        ? 0
        : this.#count(
            `SELECT COUNT(*) AS n FROM events
               WHERE timestamp < ?
                 AND (run_id IS NULL OR run_id NOT IN (${PROTECTED_RUNS}))
                 AND (task_id IS NULL OR task_id NOT IN (${UNFINISHED_TASKS}))`,
            cut.events,
          );
    const artifacts =
      cut.artifacts === null
        ? 0
        : this.#count(
            `SELECT COUNT(*) AS n FROM artifacts
               WHERE created_at < ?
                 AND (run_id IS NULL OR run_id NOT IN (${PROTECTED_RUNS}))`,
            cut.artifacts,
          );
    const runs = this.#sweepableRunIds(cut.runs).length;
    const audit =
      cut.audit === null
        ? 0
        : this.#count(
            "SELECT COUNT(*) AS n FROM audit_log WHERE timestamp < ?",
            cut.audit,
          );
    return {
      policy: cut.policy,
      now: cut.now,
      cutoffs: {
        events: cut.events,
        runs: cut.runs,
        audit: cut.audit,
        artifacts: cut.artifacts,
      },
      counts: { events, artifacts, runs, audit },
      protectedRuns: this.#count(
        `SELECT COUNT(*) AS n FROM runs WHERE id IN (${PROTECTED_RUNS})`,
      ),
    };
  }

  /** sweep({ now }) → the counts actually deleted. Audited with the counts. */
  sweep({ now, actor = "system", dryRun = false } = {}) {
    if (dryRun) return { ...this.preview({ now }), deleted: false };
    const cut = this.#cutoffs(now);
    // Nothing is deleted until an operator turns retention on. The default
    // policy carries real day values, so without this guard a manual sweep on
    // a server that never enabled retention would delete against them.
    if (!cut.policy.enabled)
      return {
        policy: cut.policy,
        now: cut.now,
        counts: { events: 0, artifacts: 0, runs: 0, audit: 0 },
        deleted: false,
        reason: "retention is disabled",
      };
    const counts = { events: 0, artifacts: 0, runs: 0, audit: 0 };
    transaction(this.db, () => {
      if (cut.events !== null)
        counts.events = this.db
          .prepare(
            `DELETE FROM events
               WHERE timestamp < ?
                 AND (run_id IS NULL OR run_id NOT IN (${PROTECTED_RUNS}))
                 AND (task_id IS NULL OR task_id NOT IN (${UNFINISHED_TASKS}))`,
          )
          .run(cut.events).changes;
      if (cut.artifacts !== null)
        counts.artifacts = this.db
          .prepare(
            `DELETE FROM artifacts
               WHERE created_at < ?
                 AND (run_id IS NULL OR run_id NOT IN (${PROTECTED_RUNS}))`,
          )
          .run(cut.artifacts).changes;

      const runIds = this.#sweepableRunIds(cut.runs);
      for (const runId of runIds) {
        // Children first: the schema has real foreign keys and PRAGMA
        // foreign_keys is ON, so a run with dependants cannot be deleted.
        this.db.prepare("DELETE FROM events WHERE run_id = ?").run(runId);
        this.db.prepare("DELETE FROM artifacts WHERE run_id = ?").run(runId);
        this.db.prepare("DELETE FROM approvals WHERE run_id = ?").run(runId);
        try {
          this.db
            .prepare(
              "UPDATE observed_sessions SET run_id = NULL WHERE run_id = ?",
            )
            .run(runId);
        } catch {
          /* table may be absent in a partial schema */
        }
        this.db
          .prepare(
            "UPDATE runs SET parent_run_id = NULL WHERE parent_run_id = ?",
          )
          .run(runId);
        counts.runs += this.db
          .prepare("DELETE FROM runs WHERE id = ?")
          .run(runId).changes;
      }

      if (cut.audit !== null)
        counts.audit = this.db
          .prepare("DELETE FROM audit_log WHERE timestamp < ?")
          .run(cut.audit).changes;
    });
    try {
      this.services.audit?.record?.({
        actor,
        action: "ops.retention.sweep",
        details: {
          policy: cut.policy,
          cutoffs: {
            events: cut.events,
            runs: cut.runs,
            audit: cut.audit,
            artifacts: cut.artifacts,
          },
          deleted: counts,
        },
      });
    } catch {
      /* audit is best effort */
    }
    if (counts.events || counts.runs || counts.artifacts)
      this.services.bus?.emit?.("global");
    return { policy: cut.policy, now: cut.now, counts, deleted: true };
  }

  /** Starts the daily timer when the policy is enabled. Unref'd. */
  start() {
    this.stop();
    if (!this.policy().enabled) return false;
    this.timer = setInterval(() => {
      try {
        this.sweep({ actor: "system" });
      } catch (error) {
        this.services.log?.error?.(
          `[retention] sweep failed: ${error?.message ?? error}`,
        );
      }
    }, this.intervalMs);
    this.timer.unref?.();
    return true;
  }

  /** Re-reads the policy for an already running timer (no-op when stopped). */
  restart() {
    if (!this.timer) return false;
    this.start();
    return !!this.timer;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Factory used by services.js: `createRetentionService(services)`. */
export function createRetentionService(services, options = {}) {
  const retention = new RetentionService(services, options);
  services.retention = retention;
  services.onClose?.(() => retention.stop());
  return retention;
}

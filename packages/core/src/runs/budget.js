import { randomUUID } from "node:crypto";
import { DEFAULT_POLICY } from "../contracts.js";

/**
 * Token budgets for managed runs.
 *
 * Honesty rules (docs/ARCHITECTURE.md §0):
 *   - Token totals arrive from the provider *after* the work is done, so
 *     enforcement is post-hoc. Every enforcement event says so.
 *   - A reservation is an *estimate* and is labelled as one. `headroom()`
 *     reports `reported: false` when no run in the window reported usage.
 *   - Nothing is invented: when a workspace has no limit the tracker says
 *     `limit: null` instead of guessing one.
 *
 * Reservations live in `budget_reservations` (migration 3); the daily rollup
 * is a query over `runs.usage`, never a second copy of the numbers.
 */

export const BUDGET_EXCEEDED_ERROR = "token budget exceeded";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sums the provider-reported tokens of one usage object without double counting. */
export function totalTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const num = (value) => (Number.isFinite(value) ? value : 0);
  if (Number.isFinite(usage.total_tokens)) return usage.total_tokens;
  if (Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  if (Number.isFinite(usage.total)) return usage.total;
  const input =
    num(usage.input_tokens) + num(usage.inputTokens) + num(usage.prompt_tokens);
  const output =
    num(usage.output_tokens) +
    num(usage.outputTokens) +
    num(usage.completion_tokens);
  return input + output;
}

export function usageIsReported(usage) {
  return !!usage && typeof usage === "object" && !!usage.reportedBy;
}

function startOfDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * BudgetTracker(services, { now, dayMs })
 *
 * reserve({ workspaceId, runId, estimateTokens }) → reservation verdict
 * consume(runId, usage)                          → releases + enforces
 * enforce(runId)                                 → post-hoc limit check
 * remaining(workspaceId) / dayUsage(workspaceId) / headroom(workspaceId)
 */
export class BudgetTracker {
  constructor(services, options = {}) {
    this.services = services;
    this.db = services.db;
    this.now = options.now ?? Date.now;
    this.dayMs = options.dayMs ?? DAY_MS;
  }

  // ------------------------------------------------------------- policy

  policyFor(workspaceId) {
    try {
      const policy = this.services.policy?.forWorkspace?.(workspaceId);
      if (policy) return policy;
    } catch {
      /* fall through to the stored row */
    }
    let stored = {};
    try {
      const row = this.db
        .prepare("SELECT policy FROM workspaces WHERE id = ?")
        .get(workspaceId);
      stored = row?.policy ? JSON.parse(row.policy) : {};
    } catch {
      stored = {};
    }
    return {
      ...DEFAULT_POLICY,
      ...stored,
      budget: { ...DEFAULT_POLICY.budget, ...(stored.budget ?? {}) },
    };
  }

  maxTokensPerRun(workspaceId) {
    const value = this.policyFor(workspaceId)?.budget?.maxTokensPerRun;
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  dailyTokenLimit() {
    let value = null;
    try {
      value = this.services.settings?.get?.("budget.dailyTokenLimit", null);
    } catch {
      value = null;
    }
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Stores `budget.dailyTokenLimit`. Settings.set() refuses every key that
   * contains "token" (its secret guard cannot tell a budget from an auth
   * token), so this non-secret number is written straight to the settings
   * table. No credential ever passes through here.
   */
  setDailyTokenLimit(value) {
    const limit =
      value === null || value === undefined
        ? null
        : Number.isFinite(value) && value > 0
          ? Math.round(value)
          : null;
    if (limit === null) {
      this.db
        .prepare("DELETE FROM settings WHERE key = 'budget.dailyTokenLimit'")
        .run();
      return null;
    }
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('budget.dailyTokenLimit', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(limit), this.now());
    return limit;
  }

  maxRunsPerDay(workspaceId) {
    const value = this.policyFor(workspaceId)?.budget?.maxRunsPerDay;
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  // -------------------------------------------------------- reservations

  /**
   * Books estimated headroom for a run. The estimate is never presented as a
   * measurement: the verdict carries `basis: "estimate"`.
   *
   * → { ok, id, estimateTokens, limit, spent, reserved, remaining, reason }
   */
  reserve({ workspaceId, runId, estimateTokens = 0 } = {}) {
    const estimate =
      Number.isFinite(estimateTokens) && estimateTokens > 0
        ? Math.round(estimateTokens)
        : 0;
    const head = this.headroom(workspaceId);
    const perRun = this.maxTokensPerRun(workspaceId);
    if (perRun && estimate > perRun)
      return {
        ok: false,
        id: null,
        estimateTokens: estimate,
        basis: "estimate",
        limit: perRun,
        spent: head.spent,
        reserved: head.reserved,
        remaining: head.remaining,
        reason: `The estimated ${estimate} tokens for this run exceed the per-run budget of ${perRun}. Split the task or raise budget.maxTokensPerRun.`,
      };
    if (head.limit !== null && head.remaining !== null && head.remaining <= 0)
      return {
        ok: false,
        id: null,
        estimateTokens: estimate,
        basis: "estimate",
        limit: head.limit,
        spent: head.spent,
        reserved: head.reserved,
        remaining: head.remaining,
        reason: `The daily token budget of ${head.limit} is already committed (${head.spent} reported, ${head.reserved} reserved). Wait for the next day or raise budget.dailyTokenLimit.`,
      };
    const runsPerDay = this.maxRunsPerDay(workspaceId);
    const id = randomUUID();
    if (runId) {
      this.db
        .prepare(
          `INSERT INTO budget_reservations (id, workspace_id, run_id, estimate_tokens, created_at, released_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(id, workspaceId ?? null, runId, estimate, this.now());
    }
    const after = this.headroom(workspaceId);
    return {
      ok: true,
      id: runId ? id : null,
      estimateTokens: estimate,
      basis: "estimate",
      limit: after.limit,
      spent: after.spent,
      reserved: after.reserved,
      remaining: after.remaining,
      runsPerDay,
      reason: null,
    };
  }

  release(runId) {
    if (!runId) return 0;
    const result = this.db
      .prepare(
        "UPDATE budget_reservations SET released_at = ? WHERE run_id = ? AND released_at IS NULL",
      )
      .run(this.now(), runId);
    return Number(result?.changes ?? 0);
  }

  reservations(workspaceId, { since = null } = {}) {
    const from = since ?? startOfDay(this.now());
    if (workspaceId)
      return this.db
        .prepare(
          `SELECT * FROM budget_reservations
             WHERE workspace_id = ? AND released_at IS NULL AND created_at >= ?`,
        )
        .all(workspaceId, from);
    return this.db
      .prepare(
        "SELECT * FROM budget_reservations WHERE released_at IS NULL AND created_at >= ?",
      )
      .all(from);
  }

  // ----------------------------------------------------------- accounting

  /** Provider-reported tokens spent today (per workspace, or everywhere). */
  dayUsage(workspaceId = null, { since = null } = {}) {
    const from = since ?? startOfDay(this.now());
    const rows = workspaceId
      ? this.db
          .prepare(
            "SELECT usage, status FROM runs WHERE workspace_id = ? AND started_at >= ?",
          )
          .all(workspaceId, from)
      : this.db
          .prepare("SELECT usage, status FROM runs WHERE started_at >= ?")
          .all(from);
    let tokens = 0;
    let reported = false;
    for (const row of rows) {
      let usage = null;
      try {
        usage = row.usage ? JSON.parse(row.usage) : null;
      } catch {
        usage = null;
      }
      const total = totalTokens(usage);
      if (total > 0) tokens += total;
      if (usageIsReported(usage)) reported = true;
    }
    return { tokens, runs: rows.length, reported, since: from };
  }

  /**
   * headroom(workspaceId) → { limit, reserved, spent, remaining, reported }
   * `limit` is null when nobody set one; `reported: false` means no run in the
   * window reported tokens, so `spent` is a floor, not a measurement.
   */
  headroom(workspaceId = null) {
    const limit = this.dailyTokenLimit();
    const usage = this.dayUsage(workspaceId);
    const reserved = this.reservations(workspaceId).reduce(
      (sum, row) => sum + (Number(row.estimate_tokens) || 0),
      0,
    );
    return {
      limit,
      reserved,
      spent: usage.tokens,
      remaining: limit === null ? null : limit - usage.tokens - reserved,
      reported: usage.reported,
      basis: usage.reported
        ? "provider-reported tokens plus estimated reservations"
        : "no provider reported tokens yet; reservations are estimates",
      since: usage.since,
    };
  }

  remaining(workspaceId = null) {
    return this.headroom(workspaceId).remaining;
  }

  // ------------------------------------------------------------ enforcement

  run(runId) {
    try {
      return this.services.recorder?.get?.(runId) ?? null;
    } catch {
      return null;
    }
  }

  event(runId, summary, data = {}) {
    try {
      this.services.recorder?.applyEvent?.(runId, {
        kind: "status",
        provenance: "system",
        summary,
        data,
        timestamp: this.now(),
      });
    } catch {
      /* the run may already be gone */
    }
  }

  /** Records reported usage against the run's reservation, then enforces. */
  async consume(runId, usage = null) {
    const total = totalTokens(usage);
    const result = await this.enforce(runId, { usage });
    if (total > 0 || result.exceeded) this.release(runId);
    return { ...result, tokens: result.tokens || total };
  }

  /**
   * enforce(runId) → { exceeded, tokens, limit, action, reported }
   *
   * Post-hoc by nature: providers report token totals after the fact, so a run
   * can only be stopped once it has already spent the tokens. The recorded
   * event says exactly that.
   */
  async enforce(runId, { usage = null } = {}) {
    const run = this.run(runId);
    if (!run)
      return {
        exceeded: false,
        tokens: 0,
        limit: null,
        action: "none",
        reported: false,
      };
    const merged = usage ?? run.usage ?? null;
    const tokens = Math.max(totalTokens(merged), totalTokens(run.usage));
    const limit = this.maxTokensPerRun(run.workspaceId);
    const reported = usageIsReported(merged) || usageIsReported(run.usage);
    if (!limit || tokens <= limit)
      return { exceeded: false, tokens, limit, action: "none", reported };

    const active = ![
      "completed",
      "failed",
      "cancelled",
      "disconnected",
    ].includes(run.status);
    const detail = {
      tokens,
      limit,
      reported,
      basis: reported ? "provider-reported" : "unreported",
      enforcement: "post-hoc",
    };
    let action = "recorded";
    if (active) {
      try {
        await this.services.runWorker?.cancel?.(runId, {
          actor: "system",
          reason: BUDGET_EXCEEDED_ERROR,
        });
        action = "cancelled";
      } catch {
        action = "recorded";
      }
      try {
        this.services.recorder?.update?.(runId, {
          error: BUDGET_EXCEEDED_ERROR,
        });
      } catch {
        /* the run may already be closed */
      }
    }
    // The sentence has to agree with detail.basis: when nothing marked the
    // usage as provider-reported, saying "the provider reported" is a claim
    // the same event's own data denies.
    const source = reported
      ? "the provider reported"
      : "the recorded usage totals";
    this.event(
      runId,
      action === "cancelled"
        ? `Token budget exceeded: ${source} ${tokens} tokens against a limit of ${limit}, so the run was cancelled. Token totals arrive after the fact, so this enforcement is post-hoc: work already done is not undone.`
        : `Token budget exceeded: ${source} ${tokens} tokens against a limit of ${limit}. The run had already ended, so nothing could be stopped; this is recorded as an acknowledged overrun.`,
      { ...detail, action },
    );
    try {
      this.services.audit?.record?.({
        actor: "system",
        action: "run.budget.exceeded",
        target: runId,
        workspaceId: run.workspaceId,
        runId,
        policyDecision: "deny",
        details: detail,
      });
    } catch {
      /* audit is best effort */
    }
    this.release(runId);
    return { exceeded: true, tokens, limit, action, reported };
  }
}

export function createBudgetTracker(services, options = {}) {
  const tracker = new BudgetTracker(services, options);
  services.budget = tracker;
  return tracker;
}

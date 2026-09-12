import { existsSync, statSync } from "node:fs";
import * as nodeFs from "node:fs";
import { schemaVersion } from "../db.js";
import { databaseFile } from "./Backup.js";
import { LIVE_RUN_STATUSES } from "./Incident.js";

/** Explicit, documented thresholds. Nothing here is guessed at runtime. */
export const THRESHOLDS = Object.freeze({
  approvalAgeMs: 30 * 60 * 1000, // 30 minutes
  freeDiskBytes: 200 * 1024 * 1024, // 200 MB
  budgetUsedFraction: 0.9, // 90 percent
  observationSilenceMs: 5 * 60 * 1000, // 5 minutes without a successful poll
});

const ACTIVE_STATUSES = LIVE_RUN_STATUSES.filter((s) => s !== "queued");

function alert(level, code, title, detail, fix) {
  return { level, code, title, detail, fix };
}

/**
 * Service health for the operations dashboard.
 *
 * Every section is guarded: a missing service degrades that section to a null
 * or an empty list rather than failing the snapshot. Nothing is invented — a
 * number that cannot be measured is reported as null and labelled.
 */
export class HealthService {
  constructor(services, { now = Date.now, startedAt } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
    this.startedAt =
      startedAt ?? services.startedAt ?? Date.now() - process.uptime() * 1000;
  }

  #dbSection() {
    const path = databaseFile(this.db, this.services.options?.dbPath ?? null);
    const section = {
      path,
      inMemory: !path,
      sizeBytes: null,
      walBytes: null,
      writable: false,
      freeDiskBytes: null,
      error: null,
    };
    try {
      this.db.exec(
        "CREATE TEMP TABLE IF NOT EXISTS ops_health_probe (n INTEGER)",
      );
      this.db.exec("DROP TABLE IF EXISTS temp.ops_health_probe");
      section.writable = true;
    } catch (error) {
      section.error = error?.message ?? String(error);
    }
    if (path) {
      try {
        section.sizeBytes = statSync(path).size;
      } catch {
        /* file may be gone */
      }
      try {
        if (existsSync(`${path}-wal`))
          section.walBytes = statSync(`${path}-wal`).size;
        else section.walBytes = 0;
      } catch {
        /* ignore */
      }
      try {
        if (typeof nodeFs.statfsSync === "function") {
          const fs = nodeFs.statfsSync(path);
          section.freeDiskBytes = Number(fs.bavail) * Number(fs.bsize);
        }
      } catch {
        section.freeDiskBytes = null; // statfs unavailable on this platform
      }
    }
    return section;
  }

  #queueSection() {
    const empty = {
      active: 0,
      queued: 0,
      byWorkspace: {},
      byProvider: {},
      total: 0,
    };
    try {
      const marks = LIVE_RUN_STATUSES.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT workspace_id, provider, status, COUNT(*) AS n FROM runs
             WHERE status IN (${marks})
             GROUP BY workspace_id, provider, status`,
        )
        .all(...LIVE_RUN_STATUSES);
      const out = { ...empty, byWorkspace: {}, byProvider: {} };
      for (const row of rows) {
        out.total += row.n;
        if (row.status === "queued") out.queued += row.n;
        if (ACTIVE_STATUSES.includes(row.status)) out.active += row.n;
        out.byWorkspace[row.workspace_id] =
          (out.byWorkspace[row.workspace_id] ?? 0) + row.n;
        out.byProvider[row.provider] =
          (out.byProvider[row.provider] ?? 0) + row.n;
      }
      return out;
    } catch {
      return empty;
    }
  }

  #providersSection() {
    let connections = [];
    try {
      connections = (this.services.connections?.list?.() ?? []).map((row) => ({
        id: row.id,
        provider: row.provider,
        alias: row.alias,
        status: row.status,
        version: row.version ?? null,
        enabled: row.enabled !== false && row.enabled !== 0,
        observe: row.observe !== false && row.observe !== 0,
        lastProbeAt: row.lastProbeAt ?? null,
        lastEventAt: row.lastEventAt ?? null,
        error: row.error ?? null,
      }));
    } catch {
      connections = [];
    }
    let breakers = null;
    try {
      breakers = this.services.runWorker?.providerHealth?.() ?? null;
    } catch {
      breakers = null;
    }
    return { connections, breakers };
  }

  #observationSection() {
    const observation = this.services.observation;
    if (!observation)
      return {
        enabled: false,
        running: false,
        lastPollAt: null,
        sessionsLive: 0,
        observerErrors: [],
      };
    let sessionsLive = 0;
    try {
      sessionsLive = observation.liveSessions?.()?.length ?? 0;
    } catch {
      sessionsLive = 0;
    }
    let observerErrors = [];
    try {
      const errors = observation.errors ?? observation.lastErrors ?? [];
      observerErrors = Array.isArray(errors) ? errors.slice(0, 10) : [];
    } catch {
      observerErrors = [];
    }
    let enabled = false;
    try {
      enabled = observation.enabled?.() ?? false;
    } catch {
      enabled = false;
    }
    return {
      enabled,
      running: observation.running ?? false,
      lastPollAt: observation.lastPollAt ?? null,
      sessionsLive,
      observerErrors,
    };
  }

  #approvalsSection() {
    try {
      const pending = this.services.approvals?.pending?.() ?? [];
      const now = this.now();
      let oldest = null;
      for (const approval of pending) {
        const at = approval.requestedAt ?? approval.createdAt ?? null;
        if (at && (oldest === null || at < oldest)) oldest = at;
      }
      return {
        pending: pending.length,
        oldestPendingMs: oldest === null ? null : Math.max(0, now - oldest),
      };
    } catch {
      return { pending: 0, oldestPendingMs: null };
    }
  }

  #budgetSection() {
    try {
      return this.services.budget?.headroom?.() ?? null;
    } catch {
      return null;
    }
  }

  /** Full snapshot with alerts. */
  snapshot() {
    const db = this.#dbSection();
    const queue = this.#queueSection();
    const providers = this.#providersSection();
    const observation = this.#observationSection();
    const approvals = this.#approvalsSection();
    const budget = this.#budgetSection();
    let incident = null;
    try {
      incident = this.services.incidents?.status?.() ?? null;
    } catch {
      incident = null;
    }
    const alerts = this.#alerts({
      db,
      providers,
      observation,
      approvals,
      budget,
      incident,
    });
    const worst = alerts.reduce(
      (level, item) =>
        item.level === "critical"
          ? "critical"
          : item.level === "warn" && level !== "critical"
            ? "warn"
            : level,
      "info",
    );
    let version = null;
    try {
      version = schemaVersion(this.db);
    } catch {
      version = null;
    }
    return {
      status: !db.writable ? "down" : worst === "info" ? "ok" : "degraded",
      checkedAt: this.now(),
      uptimeMs: Math.max(0, Date.now() - this.startedAt),
      schemaVersion: version,
      db,
      queue,
      providers,
      observation,
      approvals,
      budget,
      incident,
      alerts,
    };
  }

  #alerts({ db, providers, observation, approvals, budget, incident }) {
    const alerts = [];
    if (!db.writable)
      alerts.push(
        alert(
          "critical",
          "db.not-writable",
          "The database is not writable",
          db.error ?? "A write probe against the SQLite database failed.",
          "Check disk space and file permissions on the database file, then restart Agent Space.",
        ),
      );
    if (
      approvals.oldestPendingMs !== null &&
      approvals.oldestPendingMs > THRESHOLDS.approvalAgeMs
    )
      alerts.push(
        alert(
          "warn",
          "approvals.stale",
          "An approval has been waiting over 30 minutes",
          `${approvals.pending} approval(s) pending; the oldest has waited ${Math.round(
            approvals.oldestPendingMs / 60000,
          )} minutes. The run that asked for it is blocked until someone decides.`,
          "Open the decision inbox and approve or deny the request.",
        ),
      );
    const breakers = providers.breakers;
    if (breakers && typeof breakers === "object") {
      // RunWorker.providerHealth() answers an array of { provider, state };
      // a keyed object is still accepted. Name the provider from the entry,
      // or an array index ends up in the alert ("breaker for 0").
      for (const [key, state] of Object.entries(breakers)) {
        const provider = state?.provider ?? key;
        const open =
          state === "open" ||
          state?.state === "open" ||
          state?.open === true ||
          state?.circuit === "open";
        if (open)
          alerts.push(
            alert(
              "critical",
              "provider.circuit-open",
              `The circuit breaker for ${provider} is open`,
              "Repeated launch failures tripped the breaker, so no new run will be dispatched to this provider.",
              "Run the connection doctor for this provider, fix the reported problem, then resume dispatch.",
            ),
          );
      }
    }
    if (observation.enabled && observation.observerErrors.length)
      alerts.push(
        alert(
          "warn",
          "observation.errors",
          "Session observation is reporting errors",
          `${observation.observerErrors.length} observer error(s) on the last poll. Live sessions may be missing.`,
          "Check that the provider home directories are readable, or disable observation in settings.",
        ),
      );
    if (
      observation.enabled &&
      observation.running &&
      observation.lastPollAt &&
      this.now() - observation.lastPollAt > THRESHOLDS.observationSilenceMs
    )
      alerts.push(
        alert(
          "warn",
          "observation.stalled",
          "Session observation has not completed a poll recently",
          `The last successful poll was ${Math.round(
            (this.now() - observation.lastPollAt) / 60000,
          )} minutes ago.`,
          "Restart the server, or disable observation if a provider home is unreachable.",
        ),
      );
    if (
      db.freeDiskBytes !== null &&
      db.freeDiskBytes < THRESHOLDS.freeDiskBytes
    )
      alerts.push(
        alert(
          "critical",
          "disk.low",
          "Free disk space is under 200 MB",
          `${Math.round(db.freeDiskBytes / (1024 * 1024))} MB free on the volume holding the database.`,
          "Free disk space or move the database (AGENT_SPACE_DB) to a larger volume.",
        ),
      );
    if (budget && typeof budget === "object") {
      const used = Number(budget.usedFraction ?? budget.used ?? NaN);
      const limit = Number(budget.limit ?? NaN);
      const fraction = Number.isFinite(budget.usedFraction)
        ? budget.usedFraction
        : Number.isFinite(used) && Number.isFinite(limit) && limit > 0
          ? used / limit
          : null;
      if (fraction !== null && fraction > THRESHOLDS.budgetUsedFraction)
        alerts.push(
          alert(
            "warn",
            "budget.near-limit",
            "A budget is over 90 percent used",
            `${Math.round(fraction * 100)} percent of the configured budget has been used.`,
            "Raise the limit in settings, or wait for the budget window to reset.",
          ),
        );
    }
    if (incident?.dispatchStopped)
      alerts.push(
        alert(
          "critical",
          "ops.dispatch-stopped",
          "New dispatch is stopped",
          `Stopped by ${incident.stoppedBy ?? "an operator"}${
            incident.reason ? `: ${incident.reason}` : "."
          } ${incident.unacknowledged?.length ?? 0} run(s) have not acknowledged the stop.`,
          "Resume operations from the operations console once the incident is over.",
        ),
      );
    return alerts;
  }
}

/** Factory used by services.js: `createHealthService(services)`. */
export function createHealthService(services, options = {}) {
  const health = new HealthService(services, options);
  services.health = health;
  return health;
}

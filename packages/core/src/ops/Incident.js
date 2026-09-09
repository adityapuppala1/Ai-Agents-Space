import { InputError } from "../TaskStore.js";
import { TERMINAL_RUN_STATUSES } from "../contracts.js";

/** Statuses that mean a run will never produce another event. */
export const ENDED_RUN_STATUSES = [...TERMINAL_RUN_STATUSES, "disconnected"];

/** Statuses that still occupy a worker slot. */
export const LIVE_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "blocked",
  "stale",
];

export const SETTING_STOPPED = "ops.dispatchStopped";
export const SETTING_STOP_DETAIL = "ops.dispatchStop";
export const SETTING_UNACKNOWLEDGED = "ops.unacknowledgedStops";
export const SETTING_QUARANTINED = "ops.quarantinedHosts";
export const SETTING_REVOKED = "ops.revokedConnections";

/**
 * Incident controls for the operations console.
 *
 * The stop flag lives in `settings` so it survives a restart and so any
 * component can read it without holding a reference to this service:
 *
 *   services.settings.get("ops.dispatchStopped", false) === true
 *
 * `assertDispatchAllowed(services)` below is the guard every dispatch path
 * should call (RunWorker.start, the run routes, the task graph auto-dispatch).
 *
 * Cancellation is *requested*, never assumed: a headless or offline worker may
 * not receive it, so every stopped run is listed as unacknowledged until its
 * status becomes terminal.
 */
export class IncidentService {
  constructor(services, { now = Date.now } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
  }

  // ------------------------------------------------------------- settings

  #get(key, fallback) {
    try {
      const value = this.services.settings?.get?.(key, fallback);
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  }

  #set(key, value) {
    try {
      this.services.settings?.set?.(key, value);
    } catch {
      /* settings may be unavailable; incident state degrades to in-memory */
    }
    return value;
  }

  #audit(action, details, { actor = "local-user", target = null } = {}) {
    try {
      this.services.audit?.record?.({
        actor,
        action,
        target,
        details,
      });
    } catch {
      /* audit is best effort and must never block an incident control */
    }
  }

  // ---------------------------------------------------------------- state

  /** True when new dispatch must be refused. */
  isDispatchStopped() {
    return this.#get(SETTING_STOPPED, false) === true;
  }

  #liveRuns() {
    const marks = LIVE_RUN_STATUSES.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT id, provider, status, workspace_id, connection_id FROM runs WHERE status IN (${marks})`,
      )
      .all(...LIVE_RUN_STATUSES);
  }

  #runStatus(runId) {
    const row = this.db
      .prepare("SELECT status, provider FROM runs WHERE id = ?")
      .get(runId);
    return row ?? null;
  }

  /**
   * Drops entries whose run has ended and returns the ones still waiting.
   * Called by status() so the list self-heals without a background timer.
   */
  #pruneUnacknowledged() {
    const stored = this.#get(SETTING_UNACKNOWLEDGED, []);
    if (!Array.isArray(stored) || !stored.length) return [];
    const open = [];
    const live = [];
    for (const entry of stored) {
      const row = this.#runStatus(entry?.runId);
      if (!row) continue; // run row is gone (retention): nothing to acknowledge
      if (ENDED_RUN_STATUSES.includes(row.status)) continue;
      open.push(entry);
      live.push({
        runId: entry.runId,
        provider: entry.provider ?? row.provider ?? null,
        requestedAt: entry.requestedAt ?? null,
        requestedBy: entry.requestedBy ?? null,
        reason: entry.reason ?? null,
        status: row.status,
      });
    }
    if (open.length !== stored.length) this.#set(SETTING_UNACKNOWLEDGED, open);
    return live;
  }

  // ------------------------------------------------------------- controls

  /**
   * Stops new dispatch and requests cancellation of every run that is still
   * live. Returns the stop record with the runs it asked to cancel.
   */
  async stopAll({ actor = "local-user", reason = "" } = {}) {
    const at = this.now();
    const detail = {
      stoppedAt: at,
      stoppedBy: String(actor ?? "local-user").slice(0, 120),
      reason: String(reason ?? "").slice(0, 500),
    };
    this.#set(SETTING_STOPPED, true);
    this.#set(SETTING_STOP_DETAIL, detail);

    const runs = this.#liveRuns();
    const pending = this.#get(SETTING_UNACKNOWLEDGED, []);
    const known = new Set(
      (Array.isArray(pending) ? pending : []).map((entry) => entry?.runId),
    );
    const requested = [];
    const failures = [];
    for (const run of runs) {
      if (!known.has(run.id)) {
        pending.push({
          runId: run.id,
          provider: run.provider ?? null,
          requestedAt: at,
          requestedBy: detail.stoppedBy,
          reason: detail.reason,
        });
        known.add(run.id);
      }
      try {
        await this.services.runWorker?.cancel?.(run.id, { actor });
        requested.push(run.id);
      } catch (error) {
        // Queued/observed runs and runs owned by another process cannot be
        // cancelled from here. They stay unacknowledged, which is the point.
        failures.push({
          runId: run.id,
          error: error?.message ?? String(error),
        });
      }
    }
    this.#set(SETTING_UNACKNOWLEDGED, Array.isArray(pending) ? pending : []);
    this.#audit(
      "ops.stopAll",
      {
        reason: detail.reason,
        runsFound: runs.length,
        cancellationRequested: requested.length,
        cancellationFailed: failures,
      },
      { actor },
    );
    this.services.bus?.emit?.("global");
    return {
      ...detail,
      dispatchStopped: true,
      cancellationRequested: requested,
      cancellationFailed: failures,
      unacknowledged: this.#pruneUnacknowledged(),
    };
  }

  /** Clears the stop flag. Unacknowledged stops stay listed until they end. */
  resume({ actor = "local-user", reason = "" } = {}) {
    const was = this.#get(SETTING_STOP_DETAIL, null);
    this.#set(SETTING_STOPPED, false);
    this.#set(SETTING_STOP_DETAIL, null);
    this.#audit(
      "ops.resume",
      { reason: String(reason ?? "").slice(0, 500), previousStop: was },
      { actor },
    );
    this.services.bus?.emit?.("global");
    return this.status();
  }

  /**
   * Disables a compromised connection: enabled = 0, observe = 0, its live runs
   * are asked to cancel, and the revocation is recorded. Agent Space never
   * stores provider credentials, so "revoke" means "stop using this
   * connection here"; the operator must still rotate the credential in the
   * provider's own CLI. That instruction is returned as `nextStep`.
   */
  async revokeConnection(id, { actor = "local-user", reason = "" } = {}) {
    if (!id || typeof id !== "string")
      throw new InputError("A connection id is required");
    const row = this.db
      .prepare("SELECT id, provider, alias FROM connections WHERE id = ?")
      .get(id);
    if (!row) throw new InputError("Connection not found", 404);
    const at = this.now();

    let connection = null;
    try {
      connection =
        (await this.services.connections?.update?.(id, {
          enabled: false,
          observe: false,
        })) ?? null;
    } catch {
      connection = null;
    }
    if (!connection) {
      this.db
        .prepare(
          "UPDATE connections SET enabled = 0, observe = 0, updated_at = ? WHERE id = ?",
        )
        .run(at, id);
    }

    const marks = LIVE_RUN_STATUSES.map(() => "?").join(",");
    const runs = this.db
      .prepare(
        `SELECT id, provider, status FROM runs
         WHERE status IN (${marks})
           AND (connection_id = ? OR (connection_id IS NULL AND provider = ?))`,
      )
      .all(...LIVE_RUN_STATUSES, id, row.provider);
    const cancelled = [];
    const failed = [];
    const pending = this.#get(SETTING_UNACKNOWLEDGED, []);
    const list = Array.isArray(pending) ? pending : [];
    const known = new Set(list.map((entry) => entry?.runId));
    for (const run of runs) {
      if (!known.has(run.id)) {
        list.push({
          runId: run.id,
          provider: run.provider ?? null,
          requestedAt: at,
          requestedBy: String(actor ?? "local-user").slice(0, 120),
          reason: `connection ${row.provider}/${row.alias} revoked`,
        });
        known.add(run.id);
      }
      try {
        await this.services.runWorker?.cancel?.(run.id, { actor });
        cancelled.push(run.id);
      } catch (error) {
        failed.push({ runId: run.id, error: error?.message ?? String(error) });
      }
    }
    this.#set(SETTING_UNACKNOWLEDGED, list);

    const revoked = this.#get(SETTING_REVOKED, []);
    const history = Array.isArray(revoked) ? revoked : [];
    history.unshift({
      connectionId: id,
      provider: row.provider,
      alias: row.alias,
      at,
      by: String(actor ?? "local-user").slice(0, 120),
      reason: String(reason ?? "").slice(0, 500),
    });
    this.#set(SETTING_REVOKED, history.slice(0, 100));

    this.#audit(
      "ops.connection.revoke",
      {
        provider: row.provider,
        alias: row.alias,
        reason: String(reason ?? "").slice(0, 500),
        runsCancelled: cancelled,
        runsFailed: failed,
      },
      { actor, target: id },
    );
    this.services.bus?.emit?.("global");
    return {
      connectionId: id,
      provider: row.provider,
      alias: row.alias,
      enabled: false,
      observe: false,
      cancelledRuns: cancelled,
      cancellationFailed: failed,
      nextStep: `Agent Space stores no credential for ${row.provider}. Rotate or sign out of the credential in the provider's own CLI to complete the revocation.`,
    };
  }

  /** Marks an execution host unavailable (or releases it with release:true). */
  quarantineRunner(
    host,
    { actor = "local-user", reason = "", release = false } = {},
  ) {
    const name = String(host ?? "").trim();
    if (!name) throw new InputError("A host name is required");
    if (name.length > 120) throw new InputError("Host name is too long");
    const stored = this.#get(SETTING_QUARANTINED, []);
    const list = (Array.isArray(stored) ? stored : []).filter(
      (entry) => entry?.host?.toLowerCase() !== name.toLowerCase(),
    );
    if (!release)
      list.push({
        host: name,
        at: this.now(),
        by: String(actor ?? "local-user").slice(0, 120),
        reason: String(reason ?? "").slice(0, 500),
      });
    this.#set(SETTING_QUARANTINED, list.slice(0, 100));
    this.#audit(
      release ? "ops.runner.release" : "ops.runner.quarantine",
      { host: name, reason: String(reason ?? "").slice(0, 500) },
      { actor, target: name },
    );
    this.services.bus?.emit?.("global");
    return { host: name, quarantined: !release, quarantinedHosts: list };
  }

  /** True when a host must not receive work. */
  isQuarantined(host) {
    const name = String(host ?? "").toLowerCase();
    const stored = this.#get(SETTING_QUARANTINED, []);
    return (Array.isArray(stored) ? stored : []).some(
      (entry) => entry?.host?.toLowerCase() === name,
    );
  }

  /** Full incident state for the console and the health snapshot. */
  status() {
    const detail = this.#get(SETTING_STOP_DETAIL, null) ?? {};
    const quarantined = this.#get(SETTING_QUARANTINED, []);
    const revoked = this.#get(SETTING_REVOKED, []);
    return {
      dispatchStopped: this.isDispatchStopped(),
      stoppedAt: detail.stoppedAt ?? null,
      stoppedBy: detail.stoppedBy ?? null,
      reason: detail.reason ?? null,
      unacknowledged: this.#pruneUnacknowledged(),
      quarantinedHosts: Array.isArray(quarantined) ? quarantined : [],
      revokedConnections: Array.isArray(revoked) ? revoked : [],
    };
  }
}

/**
 * Guard for every dispatch path. Throws InputError(409) while dispatch is
 * stopped. Safe to call when the incident service is absent.
 */
export function assertDispatchAllowed(services) {
  const stopped =
    services?.incidents?.isDispatchStopped?.() ??
    services?.settings?.get?.(SETTING_STOPPED, false) === true;
  if (stopped)
    throw new InputError(
      "New dispatch is stopped by an operator (ops.dispatchStopped). Resume operations before launching runs.",
      409,
    );
}

/** Factory used by services.js: `createIncidentService(services)`. */
export function createIncidentService(services, options = {}) {
  const incidents = new IncidentService(services, options);
  services.incidents = incidents;
  return incidents;
}

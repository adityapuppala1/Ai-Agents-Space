import { randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";
import {
  REGISTRY,
  REGISTRY_IDS,
  capabilityMatrix,
  compareVersions,
  compatibility,
  listProviders,
} from "../providers/registry.js";
import {
  detectProviders,
  categorizeDetection,
  remediationFor,
  authExpiryFor,
  ERROR_CATEGORIES,
} from "../providers/detect.js";
import { planMigration, applyMigration } from "./migration.js";

/**
 * Connections: one persisted row per provider alias (`default` for the local
 * CLI). The service owns detection refreshes, per-connection settings
 * (enabled / observe / alias / owner / allowed workspaces), the capability
 * matrix, and the plain-language "doctor".
 *
 * Attach as `services.connections`:
 *   services.connections = new ConnectionService(services, { env, detect })
 *
 * Nothing here stores credentials; detection only checks that files exist.
 */

const STATUSES = ["unknown", "detected", "ready", "error", "missing"];
const DEFAULT_ALIAS = "default";
const PROBE_HISTORY_LIMIT = 20;

/**
 * What a connection connects to. Only `coding-runtime` is implemented today;
 * the other kinds are accepted so a row can be recorded honestly, and they
 * carry no detection or launch support (status stays `unknown` unless a probe
 * is written for them).
 */
export const CONNECTION_KINDS = [
  "coding-runtime",
  "model-api",
  "local-model-server",
  "external-agent-service",
  "workflow-engine",
];

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

/** Environment names that would carry a credential; never stored. */
const SECRET_ENV = /key|token|secret|password|passwd|credential|auth|cookie/i;

function rowToConnection(row) {
  const parse = (text, fallback) => {
    try {
      return text ? JSON.parse(text) : fallback;
    } catch {
      return fallback;
    }
  };
  const provider = REGISTRY[row.provider];
  const errorCategory = row.error_category ?? null;
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind ?? "coding-runtime",
    errorCategory,
    remediation: errorCategory
      ? remediationFor(errorCategory, row.provider)
      : null,
    authExpiresAt: row.auth_expires_at ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    providerName: provider?.name ?? row.provider,
    badge: provider?.badge ?? row.provider,
    alias: row.alias,
    host: row.host,
    status: row.status,
    version: row.version ?? null,
    binaryPath: row.binary_path ?? null,
    homePath: row.home_path ?? null,
    lastProbeAt: row.last_probe_at ?? null,
    lastEventAt: row.last_event_at ?? null,
    error: row.error ?? null,
    enabled: Boolean(row.enabled),
    observe: Boolean(row.observe),
    owner: row.owner ?? null,
    allowedWorkspaces: parse(row.allowed_workspaces, []),
    details: parse(row.details, {}),
    capabilities: parse(row.capabilities, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Keeps only non-credential environment overrides. Anything whose name looks
 * like a key, token, secret, password, or credential is dropped and only its
 * name is remembered, so a secret can never reach the database.
 */
export function sanitizeEnv(input) {
  if (input === undefined || input === null) return { env: {}, refusedEnv: [] };
  if (typeof input !== "object" || Array.isArray(input))
    throw new InputError("env must be an object of NAME: value strings");
  const env = {};
  const refusedEnv = [];
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(name))
      throw new InputError(`env name "${name}" is not a valid variable name`);
    if (typeof value !== "string" || value.length > 500)
      throw new InputError(`env.${name} must be a string under 500 characters`);
    if (SECRET_ENV.test(name)) {
      refusedEnv.push(name);
      continue;
    }
    env[name] = value;
  }
  return { env, refusedEnv };
}

function statusFor(entry) {
  if (entry.error && !entry.found) return "error";
  if (!entry.found) return "missing";
  if (entry.error) return "error";
  return entry.authHint === "logged-in-likely" ? "ready" : "detected";
}

export class ConnectionService {
  /**
   * @param services service container from createServices()
   * @param options.detect  detection function (defaults to detectProviders)
   * @param options.env     environment for detection (defaults to process.env)
   * @param options.now     clock
   * @param options.hooksInstalled  override for the Claude hook status
   */
  constructor(
    services,
    { detect = detectProviders, env, now, hooksInstalled } = {},
  ) {
    this.services = services;
    this.db = services.db;
    this.bus = services.bus;
    this.detect = detect;
    this.env = env ?? process.env;
    this.now = now ?? Date.now;
    this.hooksOverride = hooksInstalled;
    this.lastDetection = new Map();
  }

  hooksInstalled() {
    if (typeof this.hooksOverride === "boolean") return this.hooksOverride;
    try {
      const value = this.services.settings?.get?.(
        "hooks.claudeCode.installed",
        false,
      );
      if (typeof value === "boolean") return value;
    } catch {
      /* settings unavailable */
    }
    try {
      const status = this.services.hookInstaller?.status?.();
      if (status && typeof status.installed === "boolean")
        return status.installed;
    } catch {
      /* installer unavailable */
    }
    return false;
  }

  /** Registry view for GET /api/providers. */
  providers() {
    return listProviders({ hooksInstalled: this.hooksInstalled() });
  }

  /** Runs detection for every provider and upserts one row per provider. */
  async refresh({ force = true, providers = REGISTRY_IDS } = {}) {
    const entries = await this.detect({ env: this.env, force, providers });
    for (const entry of entries) this.#upsert(entry);
    this.bus.emit("global");
    return this.list();
  }

  /** Re-detects a single connection's provider and records a probe entry. */
  async probe(id) {
    const connection = this.get(id);
    const [entry] = await this.detect({
      env: this.env,
      force: true,
      providers: [connection.provider],
    });
    this.#upsert(entry, connection.alias, { id: connection.id });
    this.bus.emit("global");
    return this.get(id);
  }

  #upsert(entry, alias = DEFAULT_ALIAS, { id: knownId = null } = {}) {
    const now = this.now();
    this.lastDetection.set(entry.provider, entry);
    const capabilities = JSON.stringify(this.capabilities(entry.provider));
    const health = categorizeDetection(entry, { env: this.env });
    const compat = compatibility(entry.provider, entry.version ?? null);
    const details = JSON.stringify({
      authHint: entry.authHint ?? "unknown",
      homeExists: Boolean(entry.homeExists),
      override: Boolean(entry.override),
      binaryName: entry.binaryName ?? null,
      versionOutput: entry.versionOutput ?? null,
      launchVerified: REGISTRY[entry.provider]?.launchVerified ?? false,
      docsUrl: REGISTRY[entry.provider]?.docsUrl ?? null,
      errorDetail: health.detail,
      remediation: health.remediation,
      compatibility: compat,
    });
    const id = knownId ?? `${entry.provider}-${alias}`;
    const status = statusFor(entry);
    const ok = !health.category;
    this.db
      .prepare(
        `INSERT INTO connections
           (id, workspace_id, provider, alias, host, capabilities, created_at, kind,
            status, version, binary_path, home_path, last_probe_at, error, details, updated_at,
            error_category, auth_expires_at, last_success_at)
         VALUES (?, NULL, ?, ?, 'local', ?, ?, 'coding-runtime', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, alias) DO UPDATE SET
           capabilities = excluded.capabilities,
           status = excluded.status,
           version = excluded.version,
           binary_path = excluded.binary_path,
           home_path = excluded.home_path,
           last_probe_at = excluded.last_probe_at,
           error = excluded.error,
           details = excluded.details,
           updated_at = excluded.updated_at,
           error_category = excluded.error_category,
           auth_expires_at = excluded.auth_expires_at,
           last_success_at = COALESCE(excluded.last_success_at, connections.last_success_at)`,
      )
      .run(
        id,
        entry.provider,
        alias,
        capabilities,
        now,
        status,
        entry.version ?? null,
        entry.binaryPath ?? null,
        entry.homePath ?? null,
        entry.probedAt ?? now,
        entry.error ?? null,
        details,
        now,
        health.category,
        authExpiryFor(entry.provider, entry),
        ok ? (entry.probedAt ?? now) : null,
      );
    const rowId =
      this.db
        .prepare("SELECT id FROM connections WHERE provider = ? AND alias = ?")
        .get(entry.provider, alias)?.id ?? id;
    this.#recordProbe(rowId, {
      probedAt: entry.probedAt ?? now,
      ok,
      category: health.category,
      detail:
        health.detail ??
        (ok
          ? `${REGISTRY[entry.provider]?.name ?? entry.provider}${entry.version ? ` ${entry.version}` : ""} answered --version`
          : null),
    });
  }

  /** Appends one probe entry and keeps only the newest 20 per connection. */
  #recordProbe(connectionId, { probedAt, ok, category, detail }) {
    try {
      this.db
        .prepare(
          `INSERT INTO connection_probes (id, connection_id, probed_at, ok, category, detail)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          connectionId,
          probedAt ?? this.now(),
          ok ? 1 : 0,
          category ?? null,
          detail ? String(detail).slice(0, 500) : null,
        );
      this.db
        .prepare(
          `DELETE FROM connection_probes
            WHERE connection_id = ?
              AND id NOT IN (
                SELECT id FROM connection_probes WHERE connection_id = ?
                 ORDER BY probed_at DESC, rowid DESC LIMIT ?
              )`,
        )
        .run(connectionId, connectionId, PROBE_HISTORY_LIMIT);
    } catch {
      /* probe history is best effort; it never blocks a refresh */
    }
  }

  /** Newest-first probe history for one connection (at most 20 rows). */
  probes(id, { limit = PROBE_HISTORY_LIMIT } = {}) {
    const connection = this.get(id);
    const rows = this.db
      .prepare(
        `SELECT * FROM connection_probes WHERE connection_id = ?
          ORDER BY probed_at DESC, rowid DESC LIMIT ?`,
      )
      .all(
        connection.id,
        Math.max(1, Math.min(PROBE_HISTORY_LIMIT, Number(limit) || 20)),
      );
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.connection_id,
      probedAt: row.probed_at,
      ok: Boolean(row.ok),
      category: row.category ?? null,
      detail: row.detail ?? null,
      remediation: row.category
        ? remediationFor(row.category, connection.provider)
        : null,
    }));
  }

  /**
   * Creates an extra connection for a provider (a second account, a different
   * host, or a non-coding-runtime endpoint recorded honestly as `kind`).
   * Nothing here contacts the provider: the row starts as `unknown` until it
   * is probed. Credential-looking environment variables are refused.
   */
  create(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new InputError("Expected an object");
    const provider = String(input.provider ?? "").trim();
    if (!REGISTRY[provider])
      throw new InputError(
        `provider must be one of ${REGISTRY_IDS.join(", ")}`,
        400,
      );
    const alias = String(input.alias ?? "").trim();
    if (!ALIAS_PATTERN.test(alias))
      throw new InputError(
        "alias must be 1-40 letters, digits, dots, dashes, or underscores",
      );
    const kind = input.kind ?? "coding-runtime";
    if (!CONNECTION_KINDS.includes(kind))
      throw new InputError(
        `kind must be one of ${CONNECTION_KINDS.join(", ")}`,
      );
    const host = String(input.host ?? "local").trim() || "local";
    if (host.length > 120)
      throw new InputError("host must be under 120 characters");
    if (input.owner !== undefined && input.owner !== null) {
      if (typeof input.owner !== "string" || input.owner.length > 80)
        throw new InputError("owner must be a string under 80 characters");
    }
    const allowedWorkspaces = input.allowedWorkspaces ?? [];
    if (
      !Array.isArray(allowedWorkspaces) ||
      allowedWorkspaces.length > 200 ||
      !allowedWorkspaces.every(
        (w) => typeof w === "string" && w && w.length <= 80,
      )
    )
      throw new InputError(
        "allowedWorkspaces must be an array of workspace ids",
      );
    for (const key of ["binaryPath", "homePath"]) {
      const value = input[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || value.length > 500)
        throw new InputError(`${key} must be a string under 500 characters`);
    }
    const { env, refusedEnv } = sanitizeEnv(input.env);
    const existing = this.db
      .prepare("SELECT id FROM connections WHERE provider = ? AND alias = ?")
      .get(provider, alias);
    if (existing)
      throw new InputError(
        `${REGISTRY[provider].name} already has a connection called "${alias}"`,
        409,
      );
    const now = this.now();
    const id = `${provider}-${alias}`;
    this.db
      .prepare(
        `INSERT INTO connections
           (id, workspace_id, provider, alias, host, capabilities, created_at, kind,
            status, version, binary_path, home_path, last_probe_at, error, details, updated_at,
            owner, allowed_workspaces, enabled, observe, error_category)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'unknown', NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, 1, 1, NULL)`,
      )
      .run(
        id,
        provider,
        alias,
        host,
        JSON.stringify(this.capabilities(provider)),
        now,
        kind,
        input.binaryPath ?? null,
        input.homePath ?? null,
        JSON.stringify({
          createdBy: "user",
          env,
          refusedEnv,
          docsUrl: REGISTRY[provider]?.docsUrl ?? null,
          note:
            kind === "coding-runtime"
              ? "User-created alias. Probe it to record its own health."
              : `Recorded as "${kind}". Agent Space implements coding runtimes only, so this connection cannot launch runs.`,
        }),
        now,
        input.owner ? input.owner.trim() : null,
        JSON.stringify([...new Set(allowedWorkspaces)]),
      );
    this.services.audit?.record?.({
      actor: input.actor ?? "local-user",
      action: "connection.create",
      target: id,
      details: { provider, alias, kind, host },
    });
    this.bus.emit("global");
    return this.get(id);
  }

  /**
   * Removes a connection. Refuses while a run references it so run history
   * keeps its provenance.
   */
  remove(id, { actor = "local-user" } = {}) {
    const connection = this.get(id);
    let used = 0;
    try {
      used =
        this.db
          .prepare("SELECT COUNT(*) AS n FROM runs WHERE connection_id = ?")
          .get(connection.id)?.n ?? 0;
    } catch {
      used = 0;
    }
    if (used)
      throw new InputError(
        `${connection.providerName} "${connection.alias}" is used by ${used} run${used === 1 ? "" : "s"}; it cannot be removed.`,
        409,
      );
    this.db
      .prepare("DELETE FROM connection_probes WHERE connection_id = ?")
      .run(connection.id);
    this.db.prepare("DELETE FROM connections WHERE id = ?").run(connection.id);
    this.services.audit?.record?.({
      actor,
      action: "connection.remove",
      target: connection.id,
      details: { provider: connection.provider, alias: connection.alias },
    });
    this.bus.emit("global");
    return { removed: connection.id };
  }

  list() {
    return this.db
      .prepare("SELECT * FROM connections ORDER BY provider, alias")
      .all()
      .map(rowToConnection);
  }

  get(id) {
    const row = this.db
      .prepare("SELECT * FROM connections WHERE id = ?")
      .get(String(id ?? ""));
    if (!row) throw new InputError("Connection not found", 404);
    return rowToConnection(row);
  }

  /** Finds the connection row for a provider (default alias unless given). */
  forProvider(providerId, alias = DEFAULT_ALIAS) {
    const row = this.db
      .prepare("SELECT * FROM connections WHERE provider = ? AND alias = ?")
      .get(providerId, alias);
    return row ? rowToConnection(row) : null;
  }

  /**
   * Updates user-editable fields: enabled, observe, alias, allowedWorkspaces,
   * owner. Everything else is owned by detection.
   */
  update(id, patch) {
    const existing = this.get(id);
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      throw new InputError("Expected an object");
    const fields = {};
    for (const key of ["enabled", "observe"]) {
      if (patch[key] === undefined) continue;
      if (typeof patch[key] !== "boolean")
        throw new InputError(`${key} must be true or false`);
      fields[key] = patch[key] ? 1 : 0;
    }
    if (patch.alias !== undefined) {
      if (
        typeof patch.alias !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,39}$/i.test(patch.alias.trim())
      )
        throw new InputError(
          "alias must be 1-40 letters, digits, dots, dashes, or underscores",
        );
      fields.alias = patch.alias.trim();
      const clash = this.db
        .prepare(
          "SELECT id FROM connections WHERE provider = ? AND alias = ? AND id != ?",
        )
        .get(existing.provider, fields.alias, id);
      if (clash) throw new InputError("alias already in use", 409);
    }
    if (patch.owner !== undefined) {
      if (patch.owner !== null && typeof patch.owner !== "string")
        throw new InputError("owner must be a string or null");
      if (patch.owner && patch.owner.length > 80)
        throw new InputError("owner must be under 80 characters");
      fields.owner = patch.owner ? patch.owner.trim() : null;
    }
    if (patch.kind !== undefined) {
      if (!CONNECTION_KINDS.includes(patch.kind))
        throw new InputError(
          `kind must be one of ${CONNECTION_KINDS.join(", ")}`,
        );
      fields.kind = patch.kind;
    }
    if (patch.host !== undefined) {
      if (
        typeof patch.host !== "string" ||
        !patch.host.trim() ||
        patch.host.length > 120
      )
        throw new InputError("host must be a string under 120 characters");
      fields.host = patch.host.trim();
    }
    if (patch.allowedWorkspaces !== undefined) {
      const list = patch.allowedWorkspaces;
      if (
        !Array.isArray(list) ||
        list.length > 200 ||
        !list.every((w) => typeof w === "string" && w && w.length <= 80)
      )
        throw new InputError(
          "allowedWorkspaces must be an array of workspace ids",
        );
      fields.allowed_workspaces = JSON.stringify([...new Set(list)]);
    }
    const unknown = Object.keys(patch).filter(
      (key) =>
        ![
          "enabled",
          "observe",
          "alias",
          "owner",
          "allowedWorkspaces",
          "kind",
          "host",
        ].includes(key),
    );
    if (unknown.length)
      throw new InputError(`Unknown field(s): ${unknown.join(", ")}`);
    if (!Object.keys(fields).length) throw new InputError("Nothing to update");
    const assignments = Object.keys(fields)
      .map((column) => `${column} = ?`)
      .join(", ");
    this.db
      .prepare(
        `UPDATE connections SET ${assignments}, updated_at = ? WHERE id = ?`,
      )
      .run(...Object.values(fields), this.now(), id);
    this.bus.emit("global");
    return this.get(id);
  }

  /**
   * Records that a provider produced an event (observed or managed). A real
   * event is the strongest health signal there is, so it also updates
   * `last_success_at` and clears a stale error category.
   */
  markEvent(providerId, at = this.now()) {
    this.db
      .prepare(
        "UPDATE connections SET last_event_at = ? WHERE provider = ? AND (last_event_at IS NULL OR last_event_at < ?)",
      )
      .run(at, providerId, at);
    this.db
      .prepare(
        "UPDATE connections SET last_success_at = ? WHERE provider = ? AND (last_success_at IS NULL OR last_success_at < ?)",
      )
      .run(at, providerId, at);
  }

  /**
   * Version/OS compatibility for one provider. With no version the stored
   * connection version is used.
   */
  compatibility(providerId, version) {
    if (!REGISTRY[providerId])
      throw new InputError(`Unknown provider: ${providerId}`, 404);
    const resolved =
      version === undefined
        ? (this.forProvider(providerId)?.version ?? null)
        : version;
    return compatibility(providerId, resolved);
  }

  /** Compatibility verdicts for every provider, using the detected versions. */
  allCompatibility() {
    return Object.fromEntries(
      REGISTRY_IDS.map((id) => [id, this.compatibility(id)]),
    );
  }

  /**
   * Health record for one connection: what actually happened, when, and what
   * to do about it. Nothing here is invented; `authExpiresAt` stays null
   * because none of the five providers exposes an expiry we are allowed to
   * read (existence of a credential file is all Agent Space checks).
   */
  health(id) {
    const connection = this.get(id);
    return {
      id: connection.id,
      provider: connection.provider,
      alias: connection.alias,
      kind: connection.kind,
      status: connection.status,
      errorCategory: connection.errorCategory,
      error: connection.error,
      detail: connection.details?.errorDetail ?? null,
      remediation: connection.remediation,
      lastProbeAt: connection.lastProbeAt,
      lastEventAt: connection.lastEventAt,
      lastSuccessAt: connection.lastSuccessAt,
      authExpiresAt: connection.authExpiresAt,
      authExpiryNote:
        "No supported provider publishes a credential expiry that Agent Space may read, so this is always empty.",
      compatibility: this.compatibility(
        connection.provider,
        connection.version,
      ),
      probes: this.probes(connection.id),
    };
  }

  /**
   * Provider migration assistant. `migrate()` returns the plan; pass
   * `apply: true` to copy the compatible profile fields onto a profile for
   * the target provider (and optionally launch a run with `launch: true`).
   * See connections/migration.js — behaviour is never promised to match.
   */
  migrate({
    agentId,
    workspaceId,
    targetProvider,
    apply = false,
    taskId = null,
    launch = false,
    actor = "local-user",
  }) {
    if (!apply)
      return planMigration({
        services: this.services,
        connections: this,
        agentId,
        workspaceId,
        targetProvider,
      });
    return applyMigration({
      services: this.services,
      connections: this,
      agentId,
      workspaceId,
      targetProvider,
      taskId,
      launch,
      actor,
    });
  }

  /** Resolved capability matrix for one provider. */
  capabilities(providerId, { hooksInstalled } = {}) {
    if (!REGISTRY[providerId])
      throw new InputError(`Unknown provider: ${providerId}`, 404);
    return capabilityMatrix(providerId, {
      hooksInstalled:
        typeof hooksInstalled === "boolean"
          ? hooksInstalled
          : this.hooksInstalled(),
    });
  }

  /** Capability matrices for every provider, keyed by provider id. */
  allCapabilities(options = {}) {
    return Object.fromEntries(
      REGISTRY_IDS.map((id) => [id, this.capabilities(id, options)]),
    );
  }

  /** True when the capability is `verified` for that provider. */
  can(providerId, capability, options) {
    return this.capabilities(providerId, options)[capability] === "verified";
  }

  /**
   * Plain-language health items: [{ provider, level, title, detail, fix }].
   * Uses the stored rows (call refresh() first for fresh data).
   */
  doctor() {
    const items = [];
    const hooks = this.hooksInstalled();
    const rows = new Map(
      this.list()
        .filter((c) => c.alias === DEFAULT_ALIAS)
        .map((c) => [c.provider, c]),
    );
    for (const id of REGISTRY_IDS) {
      const provider = REGISTRY[id];
      const connection = rows.get(id);
      const push = (level, title, detail, fix = null) =>
        items.push({ provider: id, level, title, detail, fix });
      if (!connection) {
        push(
          "warn",
          `${provider.name} has not been checked yet`,
          "Run a connection refresh to look for the CLI.",
          "POST /api/connections/refresh",
        );
        continue;
      }
      if (connection.status === "missing") {
        if (id === "cursor")
          push(
            "warn",
            "cursor-agent is not installed",
            "The Cursor IDE may be present, but managed runs need the cursor-agent CLI. Observation of Cursor is experimental.",
            provider.installHint,
          );
        else if (id === "gemini")
          push(
            "warn",
            "Gemini CLI is not installed",
            "Gemini support is unverified; capabilities stay unknown until a real run has been checked.",
            provider.installHint,
          );
        else
          push(
            "error",
            `${provider.name} binary not found`,
            `Looked for ${provider.binaries.join(", ")} on PATH. Set ${connection.details?.override ? "" : `${"AGENT_SPACE_BIN_" + id.toUpperCase().replace(/-/g, "_")} or `}PATH so the CLI can be launched.`,
            provider.installHint,
          );
        continue;
      }
      if (connection.status === "error") {
        push(
          "error",
          `${provider.name} probe failed`,
          connection.error ?? "The version probe did not succeed.",
          `Run \`${provider.binaries[0]} --version\` in a terminal and fix what it reports.`,
        );
        continue;
      }
      if (connection.errorCategory === "not-logged-in") {
        push(
          "warn",
          `${provider.name} is probably not logged in`,
          connection.details?.errorDetail ??
            `No credentials file was found under ${connection.homePath}. Only file existence is checked; contents are never read.`,
          connection.remediation,
        );
      } else if (connection.errorCategory) {
        push(
          "warn",
          `${provider.name}: ${connection.errorCategory.replace(/-/g, " ")}`,
          connection.details?.errorDetail ??
            connection.error ??
            "The last probe did not succeed.",
          connection.remediation,
        );
      }
      // `supported === false` is already covered by the minimum-version
      // warning below; only the "never tested here" case is added.
      const compat = this.compatibility(id, connection.version);
      if (compat.supported === "untested" && connection.version) {
        push(
          "warn",
          `${provider.name} ${connection.version} has not been tested here`,
          compat.reason,
          "Run a small sandbox task and confirm it behaves before relying on it.",
        );
      }
      if (
        provider.minVersion &&
        connection.version &&
        compareVersions(connection.version, provider.minVersion) < 0
      ) {
        push(
          "warn",
          `${provider.name} ${connection.version} is older than the verified version`,
          `The stream and launch formats were verified on ${provider.verifiedVersions.join(", ") || provider.minVersion}. Older versions may behave differently.`,
          `Update ${provider.binaries[0]} to ${provider.minVersion} or newer.`,
        );
      }
      if (!connection.enabled) {
        push(
          "warn",
          `${provider.name} connection is disabled`,
          "Runs cannot be launched through this connection while it is disabled.",
          "Enable it on the Connections page.",
        );
      }
      if (!connection.observe) {
        push(
          "warn",
          `${provider.name} observation is turned off`,
          "Sessions started outside Agent Space will not appear as live sessions.",
          "Turn observation on for this connection.",
        );
      }
      if (id === "claude-code" && !hooks) {
        push(
          "warn",
          "Claude Code hooks are not installed",
          "Without the hook bridge, approvals for Claude Code cannot be routed through the inbox and the approve capability is reported as unknown.",
          "Install the hook bridge (POST /api/hooks/claude-code/install) — it keeps existing hooks such as rtk.",
        );
      }
      if (
        provider.launchVerified === "format-verified" ||
        provider.launchVerified === "flags-verified"
      ) {
        push(
          "warn",
          `${provider.name} managed runs are experimental`,
          provider.launchNote,
          "Run a small sandbox task and confirm it completes before relying on it.",
        );
      }
      if (
        id === "cursor" &&
        !connection.details?.override &&
        connection.details?.binaryName &&
        connection.details.binaryName !== "cursor-agent"
      ) {
        // The IDE's `cursor` launcher answers --version, but managed runs
        // need the separate cursor-agent CLI.
        push(
          "warn",
          `Cursor IDE ${connection.version ?? ""} detected; cursor-agent is not installed`.replace(
            /\s+/g,
            " ",
          ),
          `Found ${connection.binaryPath}, which is the IDE launcher. Managed runs need the cursor-agent CLI; observation of Cursor is experimental.`,
          provider.installHint,
        );
      }
      if (!items.some((item) => item.provider === id && item.level !== "ok")) {
        push(
          "ok",
          `${provider.name} ${connection.version ?? ""} is ready`.replace(
            /\s+/g,
            " ",
          ),
          `Found at ${connection.binaryPath}.`,
        );
      }
    }
    // Extra aliases created by the user: each one reports its own health.
    for (const extra of this.list().filter((c) => c.alias !== DEFAULT_ALIAS)) {
      const name = REGISTRY[extra.provider]?.name ?? extra.provider;
      if (extra.kind !== "coding-runtime") {
        items.push({
          provider: extra.provider,
          level: "warn",
          title: `${name} "${extra.alias}" is recorded as ${extra.kind}`,
          detail:
            "Agent Space implements coding runtimes only; this connection is recorded for reference and cannot launch runs.",
          fix: null,
        });
        continue;
      }
      if (extra.status === "unknown") {
        items.push({
          provider: extra.provider,
          level: "warn",
          title: `${name} "${extra.alias}" has never been probed`,
          detail: `Created ${extra.owner ? `for ${extra.owner} ` : ""}on host ${extra.host}. Nothing is known about it until it is probed.`,
          fix: `POST /api/connections/${extra.id}/probe`,
        });
        continue;
      }
      items.push({
        provider: extra.provider,
        level: extra.errorCategory ? "warn" : "ok",
        title: `${name} "${extra.alias}" is ${extra.status}`,
        detail:
          extra.details?.errorDetail ??
          extra.error ??
          `Host ${extra.host}${extra.owner ? `, owner ${extra.owner}` : ""}.`,
        fix: extra.remediation,
      });
    }
    return items;
  }

  /**
   * Explains which agent-profile fields carry over to another provider.
   * Accepts a profile object or `{ workspaceId, agentId }`. Behaviour is not
   * identical across providers: tools, permissions, and models differ, and
   * no conversation or hidden state is transferred.
   */
  migrationPreview(agentOrRef, toProviderId) {
    const target = REGISTRY[toProviderId];
    if (!target) throw new InputError(`Unknown provider: ${toProviderId}`, 404);
    let profile = agentOrRef;
    if (profile && profile.workspaceId && profile.agentId && !profile.name) {
      profile = this.services.hub
        .get(profile.workspaceId)
        .profiles.get(profile.agentId);
    }
    if (!profile || typeof profile !== "object")
      throw new InputError("Agent profile is required");
    const from = profile.provider ?? profile.runtime ?? null;
    const compatible = [];
    const unsupported = [];
    const add = (list, field, value, reason) => {
      if (value === undefined || value === null || value === "") return;
      list.push(reason ? { field, value, reason } : { field, value });
    };
    add(compatible, "name", profile.name);
    add(compatible, "role", profile.role);
    add(compatible, "instructions", profile.instructions);
    add(compatible, "color", profile.color);
    add(compatible, "specialty", profile.specialty);
    if (Array.isArray(profile.skills) && profile.skills.length)
      add(compatible, "skills", profile.skills);
    add(
      unsupported,
      "model",
      profile.model,
      `Model names are runtime-specific; ${target.name} chooses its own model unless you pick one it supports.`,
    );
    add(
      unsupported,
      "runtime",
      profile.runtime,
      "The runtime field is replaced by the target provider.",
    );
    add(
      unsupported,
      "connectionId",
      profile.connectionId,
      "Connections are per provider; a new connection is used.",
    );
    add(
      unsupported,
      "workingState",
      profile.workingState,
      "Demo animation state only; real activity comes from provider events.",
    );
    const connection = this.forProvider(toProviderId);
    return {
      from,
      to: toProviderId,
      toName: target.name,
      compatible,
      unsupported,
      targetStatus: connection?.status ?? "unknown",
      capabilities: this.capabilities(toProviderId),
      notes: [
        `${target.name} has its own tools, permissions, and models; behaviour will differ from ${from ? (REGISTRY[from]?.name ?? from) : "the current provider"}.`,
        "Conversation history and hidden model state are not transferred. Only the profile fields listed as compatible are copied.",
        target.launchVerified === true
          ? "Managed runs are verified for this provider."
          : `Managed runs are ${target.launchVerified === "format-verified" ? "experimental" : "not verified"} for this provider.`,
      ],
    };
  }

  /** Summary for globalSnapshot(): enabled/status per provider. */
  summary() {
    return this.list().map((c) => ({
      id: c.id,
      provider: c.provider,
      alias: c.alias,
      kind: c.kind,
      host: c.host,
      owner: c.owner,
      errorCategory: c.errorCategory,
      remediation: c.remediation,
      lastSuccessAt: c.lastSuccessAt,
      authExpiresAt: c.authExpiresAt,
      status: c.status,
      version: c.version,
      enabled: c.enabled,
      observe: c.observe,
      lastEventAt: c.lastEventAt,
      lastProbeAt: c.lastProbeAt,
    }));
  }
}

export { STATUSES as CONNECTION_STATUSES, ERROR_CATEGORIES };

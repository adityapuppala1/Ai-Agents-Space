import { createHash } from "node:crypto";
import { InputError } from "../TaskStore.js";

/**
 * Release governance (roadmap §11): settings-backed feature flags with a
 * registry of KNOWN flags, per-workspace overrides, an audited change
 * history, adapter canaries, and a compatibility gate.
 *
 * Storage (all through services.settings, never secrets):
 *   flags.<name>                    global value
 *   flags.<name>.workspace.<id>     per-workspace override (scope "workspace")
 *   flags.canary.<provider>         { percent: 0-100 } | { workspaces: [ids] }
 *
 * Honesty note on canaries: this build ships exactly ONE adapter
 * implementation per provider (plus the Codex app-server transport, which is
 * selected by the `codex.useAppServer` setting, not by a canary). canary()
 * therefore returns a channel LABEL — "stable" or "next" — chosen
 * deterministically per workspace. adapters/index.js MAY consult
 * `services.flags.canary(providerId, { workspaceId }).channel` to pick a
 * second implementation once one exists; today nothing behaves differently
 * on "next", and the returned `reason` says so.
 */

export const FLAG_REGISTRY = Object.freeze({
  "scheduler.dispatch": Object.freeze({
    description:
      "Lets the scheduler dispatch runs. The scheduler consults this per workspace on every occurrence; turning it off records skipped occurrences instead of starting runs.",
    default: true,
    scope: "workspace",
  }),
  "schedules.runNow": Object.freeze({
    description:
      "Allows POST /api/schedules/:id/run-now to dispatch a schedule immediately.",
    default: true,
    scope: "workspace",
  }),
  "adapters.nextChannel": Object.freeze({
    description:
      "Marks the 'next' adapter channel as selectable by canaries. Label only: this build has one adapter implementation per provider, so 'next' changes nothing until a second implementation is registered.",
    default: false,
    scope: "global",
  }),
});

export const FLAG_PREFIX = "flags.";
export const CANARY_PREFIX = "flags.canary.";
export const ACTION_FLAG_SET = "flags.set";
export const ACTION_CANARY_SET = "flags.canary.set";

const FLAG_NAME = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Deterministic 0-99 bucket for a (provider, workspace) pair. No Math.random. */
export function canaryBucket(providerId, workspaceId) {
  const digest = createHash("sha256")
    .update(`${providerId}:${workspaceId ?? ""}`)
    .digest();
  return digest.readUInt32BE(0) % 100;
}

export function validateCanaryConfig(input) {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("Canary config must be { percent } or { workspaces } or null");
  const hasPercent = input.percent !== undefined;
  const hasList = input.workspaces !== undefined;
  if (hasPercent === hasList)
    throw new InputError("Canary config needs exactly one of percent or workspaces");
  if (hasPercent) {
    if (!Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100)
      throw new InputError("percent must be an integer between 0 and 100");
    return { percent: input.percent };
  }
  if (!Array.isArray(input.workspaces) || input.workspaces.some((id) => typeof id !== "string" || !WORKSPACE_ID.test(id)))
    throw new InputError("workspaces must be an array of workspace ids");
  return { workspaces: [...new Set(input.workspaces)] };
}

export class FeatureFlags {
  constructor(services, { registry = FLAG_REGISTRY } = {}) {
    this.services = services;
    this.registry = registry;
  }

  #settings() {
    const settings = this.services.settings;
    if (!settings) throw new InputError("Settings are not available", 503);
    return settings;
  }

  definition(name) {
    if (typeof name !== "string" || !FLAG_NAME.test(name))
      throw new InputError("Flag name must be dotted lower-case words");
    const def = this.registry[name];
    if (!def)
      throw new InputError(`Unknown flag "${name}". Known flags: ${Object.keys(this.registry).join(", ")}`, 404);
    return def;
  }

  #workspaceKey(name, workspaceId) {
    if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId))
      throw new InputError("workspaceId must be a short id");
    return `${FLAG_PREFIX}${name}.workspace.${workspaceId}`;
  }

  /** The global value (stored or default). */
  value(name) {
    const def = this.definition(name);
    const stored = this.#settings().get(`${FLAG_PREFIX}${name}`, undefined);
    return typeof stored === "boolean" ? stored : def.default;
  }

  /** Effective value: workspace override (if the scope allows one) → global → default. */
  isEnabled(name, { workspaceId = null } = {}) {
    const def = this.definition(name);
    if (workspaceId && def.scope === "workspace") {
      const override = this.#settings().get(this.#workspaceKey(name, workspaceId), undefined);
      if (typeof override === "boolean") return override;
    }
    return this.value(name);
  }

  /** Every known flag with its global value and stored workspace overrides. */
  list() {
    const all = this.#settings().all?.() ?? {};
    return Object.entries(this.registry).map(([name, def]) => {
      const overrides = {};
      const prefix = `${FLAG_PREFIX}${name}.workspace.`;
      for (const [key, value] of Object.entries(all))
        if (key.startsWith(prefix) && typeof value === "boolean") overrides[key.slice(prefix.length)] = value;
      return { name, description: def.description, default: def.default, scope: def.scope, value: this.value(name), overrides };
    });
  }

  /**
   * Sets a flag globally or for one workspace. Validates that the flag is
   * registered and that the scope allows a workspace override, then writes
   * an audit change-history entry with old value, new value and actor.
   */
  set(name, value, { workspaceId = null, actor = "local-user" } = {}) {
    const def = this.definition(name);
    if (typeof value !== "boolean") throw new InputError(`${name} must be true or false`);
    if (workspaceId && def.scope !== "workspace")
      throw new InputError(`${name} is a global flag and has no per-workspace override`, 409);
    const key = workspaceId ? this.#workspaceKey(name, workspaceId) : `${FLAG_PREFIX}${name}`;
    const oldValue = workspaceId ? this.#settings().get(key, null) : this.value(name);
    this.#settings().set(key, value);
    this.services.audit?.record?.({
      actor,
      action: ACTION_FLAG_SET,
      target: name,
      workspaceId,
      details: { name, workspaceId, oldValue, newValue: value, scope: workspaceId ? "workspace" : "global" },
    });
    this.services.bus?.emit?.("global");
    return { name, workspaceId, value, previous: oldValue };
  }

  /** Removes a workspace override so the global value applies again. */
  clear(name, { workspaceId, actor = "local-user" } = {}) {
    this.definition(name);
    if (!workspaceId) throw new InputError("workspaceId is required to clear an override");
    const key = this.#workspaceKey(name, workspaceId);
    const oldValue = this.#settings().get(key, null);
    this.#settings().delete(key);
    this.services.audit?.record?.({
      actor,
      action: ACTION_FLAG_SET,
      target: name,
      workspaceId,
      details: { name, workspaceId, oldValue, newValue: null, scope: "workspace", cleared: true },
    });
    return { name, workspaceId, value: null, previous: oldValue };
  }

  /** Change history for one flag (or canary), newest first, from the audit log. */
  history(name, { limit = 100 } = {}) {
    const audit = this.services.audit;
    if (!audit?.list) return [];
    const isCanary = name.startsWith("canary.");
    const target = isCanary ? name.slice("canary.".length) : name;
    const entries = audit.list({ action: isCanary ? ACTION_CANARY_SET : ACTION_FLAG_SET, limit: 5000 });
    return entries
      .filter((entry) => entry.target === target)
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 1000)))
      .map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        actor: entry.actor,
        workspaceId: entry.workspaceId,
        oldValue: entry.details?.oldValue ?? null,
        newValue: entry.details?.newValue ?? null,
        details: entry.details,
        hash: entry.hash,
      }));
  }

  /* ------------------------------------------------------------ canaries */

  canaryConfig(providerId) {
    const stored = this.#settings().get(`${CANARY_PREFIX}${providerId}`, null);
    try {
      return validateCanaryConfig(stored ?? null);
    } catch {
      return null;
    }
  }

  /**
   * canary(providerId, { workspaceId }) → { channel, reason, config, bucket }
   * "next" is selected deterministically: a listed workspace, or a bucket
   * (sha256 of provider:workspace mod 100) below `percent`. The label is
   * only meaningful once a second adapter implementation exists — see the
   * module comment; `implementations` reports what this build has.
   */
  canary(providerId, { workspaceId = null } = {}) {
    if (typeof providerId !== "string" || !providerId.trim())
      throw new InputError("providerId is required");
    const config = this.canaryConfig(providerId);
    const adapters = this.services.adapters ?? {};
    const implementations = Object.values(adapters).filter((a) => a?.provider === providerId).map((a) => a.id);
    const base = { provider: providerId, workspaceId, config, implementations, bucket: null };
    const note =
      implementations.length > 1
        ? null
        : "label only: this build has a single adapter implementation for this provider, so 'next' behaves exactly like 'stable'";
    if (!config) return { ...base, channel: "stable", reason: "no canary configured", note };
    if (!this.isEnabled("adapters.nextChannel"))
      return { ...base, channel: "stable", reason: "adapters.nextChannel flag is off", note };
    if (!workspaceId) return { ...base, channel: "stable", reason: "canaries are evaluated per workspace; no workspace given", note };
    if (config.workspaces) {
      const listed = config.workspaces.includes(workspaceId);
      return { ...base, channel: listed ? "next" : "stable", reason: listed ? "workspace is on the canary list" : "workspace is not on the canary list", note };
    }
    const bucket = canaryBucket(providerId, workspaceId);
    const chosen = bucket < config.percent;
    return {
      ...base,
      bucket,
      channel: chosen ? "next" : "stable",
      reason: `deterministic bucket ${bucket} ${chosen ? "<" : ">="} ${config.percent}%`,
      note,
    };
  }

  /**
   * Compatibility gate: a provider may only be moved towards "next" when its
   * detected (or given) version is a tested one. Delegates to
   * services.connections.compatibility; without it nothing is known and the
   * gate refuses.
   */
  gate(providerId, version = null) {
    const compat = this.services.connections?.compatibility?.(providerId, version ?? undefined) ?? null;
    if (!compat)
      return { allowed: false, provider: providerId, reason: "no compatibility information: the connection service is not available", compatibility: null };
    return {
      allowed: compat.supported === true,
      provider: providerId,
      reason: compat.reason ?? (compat.supported === true ? "tested version" : "untested"),
      compatibility: compat,
    };
  }

  /**
   * Configures a canary. Refused by the compatibility gate when the
   * provider's version is untested or unsupported, unless the config removes
   * the canary (null) or sets percent 0 / an empty list.
   */
  setCanary(providerId, input, { actor = "local-user", version = null } = {}) {
    if (typeof providerId !== "string" || !providerId.trim())
      throw new InputError("providerId is required");
    const config = validateCanaryConfig(input);
    const widens = config && ((config.percent ?? 0) > 0 || (config.workspaces?.length ?? 0) > 0);
    if (widens) {
      const gate = this.gate(providerId, version);
      if (!gate.allowed)
        throw new InputError(`Compatibility gate refused a canary for ${providerId}: ${gate.reason}`, 409);
    }
    const key = `${CANARY_PREFIX}${providerId}`;
    const oldValue = this.canaryConfig(providerId);
    if (config === null) this.#settings().delete(key);
    else this.#settings().set(key, config);
    this.services.audit?.record?.({
      actor,
      action: ACTION_CANARY_SET,
      target: providerId,
      details: { provider: providerId, oldValue, newValue: config },
    });
    this.services.bus?.emit?.("global");
    return { provider: providerId, config, previous: oldValue };
  }
}

/** Factory used by services.js: `createFeatureFlags(services)` → services.flags. */
export function createFeatureFlags(services, options = {}) {
  const flags = new FeatureFlags(services, options);
  services.flags = flags;
  return flags;
}

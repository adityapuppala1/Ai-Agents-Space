/**
 * Extension registry (roadmap §16, "Extension model").
 *
 * WHAT THIS IS
 * ------------
 * A record of extensions a workspace opted into: what they claim, what
 * permissions they would need, which version is pinned, what a staged update
 * would change, and what depends on what. It is the bookkeeping half of the
 * extension model.
 *
 * WHAT THIS IS NOT
 * ----------------
 * There is NO extension loader in this build. `install()` never imports,
 * requires, spawns, or evaluates anything. An entry whose kind is executable
 * (provider-adapter, workflow-adapter, tool-connector) is recorded with
 * `loaded: false` and stays inert until isolation and permission enforcement
 * for extension code exist. A signature proves the publisher and that the
 * bytes are unchanged; it is NOT evidence that the code is safe.
 *
 * Storage: one row per extension in the existing `settings` table under the
 * key prefix `extensions.item.<id>` (no migration). Rows are small JSON
 * records; nothing here stores credentials or file contents.
 */

import { createHash, randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";
import { DEFAULT_POLICY } from "../contracts.js";
import {
  validateManifest,
  diffPermissions,
  describePermissions,
  satisfiesRange,
  compareSemver,
  parseSemver,
  EXTENSION_KINDS,
  DEFAULT_PERMISSIONS,
} from "./manifest.js";

const KEY_PREFIX = "extensions.item.";

/** Run statuses that count as "using" an extension right now. */
const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "blocked",
  "stale",
];

/** The Agent Space version an extension's compatibility range is checked against. */
export const AGENT_SPACE_VERSION = "0.2.0";

/** Said out loud in the API, the UI, and the docs. */
export const SIGNATURE_MEANING =
  "A signature and checksum establish the publisher and that the bytes did not change. They are not a safety review, and this build never executes extension code.";

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

/**
 * The most an extension may ask for in a workspace. Derived from the
 * workspace policy, then narrowed further by `workspaces.settings.extensions`
 * when the workspace sets it:
 *
 *   { allowFilesystem: "none"|"read"|"write", allowNetwork: [destinations],
 *     allowShell: boolean, allowProviders: [provider ids] }
 *
 * Defaults are deliberately tight: nothing but read access is granted unless
 * the workspace says so.
 */
export function workspaceCeiling(policy = DEFAULT_POLICY, settings = {}) {
  const opt = settings?.extensions ?? {};
  const observeOnly = policy?.autonomy === "observe-only";
  const filesystem = opt.allowFilesystem ?? (observeOnly ? "read" : "read");
  const network = Array.isArray(opt.allowNetwork)
    ? opt.allowNetwork.map((d) => String(d).toLowerCase())
    : [];
  const shell = opt.allowShell === true && !observeOnly;
  const providers = Array.isArray(opt.allowProviders) ? opt.allowProviders : [];
  return { filesystem, network, shell, providers };
}

const FS_RANK = { none: 0, read: 1, write: 2 };

/**
 * Permissions the workspace ceiling does not cover.
 * → [{ permission, requested, allowed, detail }]
 */
export function permissionsExceeding(permissions, ceiling) {
  const asked = permissions ?? DEFAULT_PERMISSIONS;
  const problems = [];
  if (FS_RANK[asked.filesystem] > FS_RANK[ceiling.filesystem])
    problems.push({
      permission: "filesystem",
      requested: asked.filesystem,
      allowed: ceiling.filesystem,
      detail: `The extension asks for ${asked.filesystem} access; this workspace allows ${ceiling.filesystem}.`,
    });
  for (const destination of asked.network ?? []) {
    const allowed =
      ceiling.network.includes("*") ||
      ceiling.network.includes(destination) ||
      ceiling.network.some(
        (entry) =>
          entry.startsWith("*.") && destination.endsWith(entry.slice(1)),
      );
    if (!allowed)
      problems.push({
        permission: "network",
        requested: destination,
        allowed: ceiling.network.join(", ") || "none",
        detail: `This workspace has not allowed network access to ${destination}.`,
      });
  }
  if (asked.shell && !ceiling.shell)
    problems.push({
      permission: "shell",
      requested: "shell",
      allowed: "no shell",
      detail: "This workspace does not let extensions run shell commands.",
    });
  for (const provider of asked.providers ?? [])
    if (!ceiling.providers.includes(provider))
      problems.push({
        permission: "providers",
        requested: provider,
        allowed: ceiling.providers.join(", ") || "none",
        detail: `This workspace has not allowed extension access to ${provider}.`,
      });
  return problems;
}

/**
 * Strips everything that must never leave a machine from a shared template:
 * secrets, absolute or user paths, raw logs, and client data. Returns
 * `{ template, removed: [{ path, reason }] }` — what was taken out is always
 * reported, never removed silently.
 */
export function stripTemplate(template) {
  const removed = [];
  // Narrow on purpose: `apiToken` and `client_secret` are secrets, while
  // `maxTokens` (a budget) is not. Keys are split on camel case first.
  const SECRET_KEY =
    /(?:^|[._-])(?:auth|api|access|refresh|bearer|session|private|client)[._-]?(?:tokens?|keys?|secrets?)(?:$|[._-])|^tokens?$|secret|password|credential|authorization|api[_-]?key|cookie/i;
  const asWords = (text) => String(text).replace(/([a-z0-9])([A-Z])/g, "$1.$2");
  // Absolute and user paths anywhere in a string, not only at the start.
  const ABSOLUTE =
    /(?:\b[A-Za-z]:[\\/][^\s"']*|\\\\[^\s"']+|\/(?:home|Users|root)\/[^\s"']*)/g;
  const walk = (value, path) => {
    if (Array.isArray(value))
      return value.map((entry, index) => walk(entry, `${path}[${index}]`));
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (SECRET_KEY.test(asWords(key))) {
          removed.push({ path: childPath, reason: "secret" });
          continue;
        }
        if (key === "logs" || key === "rawLog" || key === "clientData") {
          removed.push({
            path: childPath,
            reason: key === "clientData" ? "client data" : "raw log",
          });
          continue;
        }
        out[key] = walk(child, childPath);
      }
      return out;
    }
    if (typeof value === "string") {
      ABSOLUTE.lastIndex = 0;
      if (ABSOLUTE.test(value)) {
        removed.push({ path, reason: "private path" });
        return value.replace(ABSOLUTE, "<path removed on export>");
      }
      if (SECRET_KEY.test(asWords(value)) && /[:=]\s*\S{8,}/.test(value)) {
        removed.push({ path, reason: "secret" });
        return "<value removed on export>";
      }
    }
    return value;
  };
  return { template: walk(structuredClone(template ?? {}), ""), removed };
}

/**
 * Extension registry. `createExtensionRegistry(services)` returns one; attach
 * it as `services.extensions`.
 *
 * services: { db, hub?, audit?, bus?, policy? }
 */
export class ExtensionRegistry {
  constructor(
    services,
    { now = Date.now, agentSpaceVersion = AGENT_SPACE_VERSION } = {},
  ) {
    this.services = services;
    this.db = services.db;
    this.now = now;
    this.agentSpaceVersion = agentSpaceVersion;
  }

  /* ------------------------------------------------------------ storage - */

  #read(id) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(`${KEY_PREFIX}${id}`);
    return row ? parseJson(row.value, null) : null;
  }

  #write(record) {
    const json = JSON.stringify(record);
    if (json.length > 16384)
      throw new InputError(
        "This extension record is too large to store (16 KB limit)",
      );
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(`${KEY_PREFIX}${record.id}`, json, this.now());
    return record;
  }

  #rows() {
    return this.db
      .prepare("SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key")
      .all(`${KEY_PREFIX}%`)
      .map((row) => parseJson(row.value, null))
      .filter(Boolean);
  }

  #audit(action, record, details = {}) {
    this.services.audit?.record?.({
      actor: details.actor ?? "local-user",
      action,
      target: record?.id ?? null,
      workspaceId: details.workspaceId ?? null,
      details: {
        kind: record?.kind,
        version: record?.manifest?.version,
        ...details,
      },
    });
    this.services.bus?.emit?.("global");
  }

  #workspaceCeiling(workspaceId) {
    const row = this.db
      .prepare("SELECT policy, settings FROM workspaces WHERE id = ?")
      .get(workspaceId);
    if (!row) throw new InputError(`Workspace ${workspaceId} not found`, 404);
    const policy = this.services.policy?.forWorkspace
      ? this.services.policy.forWorkspace(workspaceId)
      : { ...DEFAULT_POLICY, ...parseJson(row.policy, {}) };
    return workspaceCeiling(policy, parseJson(row.settings, {}));
  }

  /* ------------------------------------------------------------ queries - */

  list({ workspaceId = null, includeRevoked = true } = {}) {
    return this.#rows()
      .filter((record) =>
        workspaceId ? record.workspaces.includes(workspaceId) : true,
      )
      .filter((record) => (includeRevoked ? true : record.status !== "revoked"))
      .map((record) => structuredClone(record));
  }

  get(id) {
    const record = this.#read(String(id));
    if (!record) throw new InputError(`Extension ${id} not found`, 404);
    return structuredClone(record);
  }

  /** Everything installed and what each entry depends on. */
  dependencyInventory() {
    return this.#rows().map((record) => ({
      id: record.id,
      name: record.manifest.name,
      kind: record.kind,
      version: record.pinnedVersion ?? record.manifest.version,
      publisher: record.manifest.publisher.name,
      license: record.manifest.license,
      status: record.status,
      updateChannel: record.manifest.updateChannel,
      checksum: record.manifest.checksum,
      signed: !!record.manifest.signature,
      signatureMeaning: SIGNATURE_MEANING,
      loaded: false,
      dependencies: record.dependencies,
      workspaces: record.workspaces,
    }));
  }

  /* ------------------------------------------------------------- preview - */

  /**
   * What installing this manifest would mean, before anything is written.
   * → { manifest, kind, trust, permissionSummary, permissionProblems,
   *     compatible, changes, signature }
   */
  importPreview({ manifest, workspaceId = null } = {}) {
    const checked = validateManifest(manifest);
    const existing = this.#read(checked.id);
    const compatible = satisfiesRange(
      this.agentSpaceVersion,
      checked.compatibility.agentSpace,
    );
    const osSupported = checked.compatibility.os.includes(process.platform);
    const ceiling = workspaceId ? this.#workspaceCeiling(workspaceId) : null;
    const problems = ceiling
      ? permissionsExceeding(checked.permissions, ceiling)
      : [];
    const changes = [];
    if (!existing)
      changes.push(
        `New ${checked.kind} "${checked.name}" version ${checked.version}`,
      );
    else {
      const direction = compareSemver(
        checked.version,
        existing.manifest.version,
      );
      changes.push(
        direction === 0
          ? `Re-records version ${checked.version}`
          : direction > 0
            ? `Updates ${existing.manifest.version} → ${checked.version}`
            : `Downgrades ${existing.manifest.version} → ${checked.version}`,
      );
      changes.push(...diffPermissions(existing.manifest, checked).summary);
    }
    if (workspaceId) changes.push(`Opts workspace ${workspaceId} in`);
    return {
      manifest: checked,
      kind: checked.kind,
      trust: EXTENSION_KINDS[checked.kind],
      executable: checked.executable,
      loadedByThisBuild: false,
      permissionSummary: describePermissions(checked),
      permissionProblems: problems,
      wouldBeRefused: problems.length > 0 || !compatible || !osSupported,
      compatible,
      osSupported,
      agentSpaceVersion: this.agentSpaceVersion,
      changes,
      signature: {
        present: !!checked.signature,
        publisher: checked.signature?.publisher ?? null,
        means: SIGNATURE_MEANING,
      },
    };
  }

  /* ------------------------------------------------------------ install - */

  /**
   * Records an extension and opts one workspace in. Refuses when the manifest
   * asks for more than the workspace policy allows, when the compatibility
   * range excludes this build, or when the OS is not listed.
   */
  install({
    manifest,
    source = "local",
    workspaceId,
    dependencies = [],
    actor = "local-user",
  } = {}) {
    const checked = validateManifest(manifest);
    if (!workspaceId)
      throw new InputError("A workspace must opt in: workspaceId is required");
    const preview = this.importPreview({ manifest: checked, workspaceId });
    if (!preview.compatible)
      throw new InputError(
        `Extension ${checked.id} requires Agent Space ${checked.compatibility.agentSpace}; this build is ${this.agentSpaceVersion}`,
        409,
      );
    if (!preview.osSupported)
      throw new InputError(
        `Extension ${checked.id} supports ${checked.compatibility.os.join(", ")}; this host is ${process.platform}`,
        409,
      );
    if (preview.permissionProblems.length)
      throw new InputError(
        `Refused: the extension asks for more than workspace ${workspaceId} allows. ${preview.permissionProblems
          .map((problem) => problem.detail)
          .join(" ")}`,
        403,
      );
    if (!Array.isArray(dependencies))
      throw new InputError("dependencies must be an array");

    const existing = this.#read(checked.id);
    // Installing into a second workspace REPLACES the stored manifest for every
    // workspace already opted in, so each of them has to allow the new
    // permissions too. Without this, a caller widens an extension's
    // permissions for workspace A by installing it into a permissive
    // workspace B — bypassing the update()/acceptUpdate() path, which does
    // check every workspace and demands an explicit human acceptance.
    for (const opted of existing?.workspaces ?? []) {
      if (opted === workspaceId) continue;
      const problems = permissionsExceeding(
        checked.permissions,
        this.#workspaceCeiling(opted),
      );
      if (problems.length)
        throw new InputError(
          `Refused: ${checked.id} is already installed in workspace ${opted}, which does not allow what this manifest asks for. ${problems
            .map((problem) => problem.detail)
            .join(
              " ",
            )} Stage the change with update() so the new permissions are accepted explicitly.`,
          403,
        );
    }
    const record = {
      id: checked.id,
      kind: checked.kind,
      manifest: checked,
      source: String(source ?? "local").slice(0, 300),
      status: "installed",
      workspaces: [...new Set([...(existing?.workspaces ?? []), workspaceId])],
      pinnedVersion: checked.version,
      pending: null,
      // Declared, never resolved or fetched: nothing is downloaded here.
      dependencies: dependencies.map((entry) => ({
        id: String(entry?.id ?? entry ?? "").slice(0, 64),
        versionRange: String(entry?.versionRange ?? "*").slice(0, 80),
        resolved: false,
      })),
      uses: existing?.uses ?? [],
      installedAt: existing?.installedAt ?? this.now(),
      updatedAt: this.now(),
      loaded: false,
      loadRefusedReason:
        "This build records extensions; it does not load or execute them. Loading is deferred until isolation and permission enforcement for extension code exist.",
      signatureMeaning: SIGNATURE_MEANING,
    };
    this.#write(record);
    this.#audit("extension.install", record, {
      workspaceId,
      actor,
      source: record.source,
    });
    return structuredClone(record);
  }

  /** Fixes the version this workspace uses; a staged update cannot change it. */
  pin(id, version, { actor = "local-user" } = {}) {
    const record = this.get(id);
    if (!parseSemver(version))
      throw new InputError(`"${version}" is not a semantic version`);
    const known = [
      record.manifest.version,
      record.pending?.manifest?.version,
    ].filter(Boolean);
    if (!known.includes(version))
      throw new InputError(
        `Version ${version} is not recorded for ${id}. Known versions: ${known.join(", ")}`,
        409,
      );
    record.pinnedVersion = version;
    record.updatedAt = this.now();
    this.#write(record);
    this.#audit("extension.pin", record, { actor, pinnedVersion: version });
    return structuredClone(record);
  }

  /**
   * Stages a new manifest as a pending version with its permission diff.
   * Nothing changes until `acceptUpdate` is called: an update that widens
   * permissions is never applied silently.
   */
  update(id, manifest, { actor = "local-user" } = {}) {
    const record = this.get(id);
    const checked = validateManifest(manifest);
    if (checked.id !== record.id)
      throw new InputError(
        `Manifest id ${checked.id} does not match extension ${record.id}`,
      );
    if (checked.kind !== record.kind)
      throw new InputError(
        `An extension cannot change kind (${record.kind} → ${checked.kind}); install it as a new extension`,
      );
    const permissionDiff = diffPermissions(record.manifest, checked);
    record.pending = {
      manifest: checked,
      permissionDiff,
      requiresAcceptance: true,
      stagedAt: this.now(),
      stagedBy: actor,
    };
    record.updatedAt = this.now();
    this.#write(record);
    this.#audit("extension.update.staged", record, {
      actor,
      version: checked.version,
      escalates: permissionDiff.escalates,
    });
    return structuredClone(record);
  }

  /** Applies a staged update. `acceptedPermissions` must be true to proceed. */
  acceptUpdate(id, { acceptedPermissions = false, actor = "local-user" } = {}) {
    const record = this.get(id);
    if (!record.pending)
      throw new InputError(`Extension ${id} has no staged update`, 409);
    if (!acceptedPermissions)
      throw new InputError(
        `The staged update must be accepted explicitly. ${record.pending.permissionDiff.summary.join(" ")}`,
        409,
      );
    for (const workspaceId of record.workspaces) {
      const problems = permissionsExceeding(
        record.pending.manifest.permissions,
        this.#workspaceCeiling(workspaceId),
      );
      if (problems.length)
        throw new InputError(
          `Refused: the staged version asks for more than workspace ${workspaceId} allows. ${problems
            .map((problem) => problem.detail)
            .join(" ")}`,
          403,
        );
    }
    record.manifest = record.pending.manifest;
    record.pinnedVersion = record.pending.manifest.version;
    record.pending = null;
    record.updatedAt = this.now();
    this.#write(record);
    this.#audit("extension.update.accepted", record, { actor });
    return structuredClone(record);
  }

  /** Drops a staged update without applying it. */
  rejectUpdate(id, { actor = "local-user" } = {}) {
    const record = this.get(id);
    if (!record.pending)
      throw new InputError(`Extension ${id} has no staged update`, 409);
    record.pending = null;
    record.updatedAt = this.now();
    this.#write(record);
    this.#audit("extension.update.rejected", record, { actor });
    return structuredClone(record);
  }

  /**
   * Revokes an extension: it stays in the inventory (so an incident can be
   * traced) but no workspace may use it. Revocation is always allowed, even
   * while a run is active — it stops future use, it does not undo past use.
   */
  revoke(id, { reason = "", actor = "local-user" } = {}) {
    const record = this.get(id);
    record.status = "revoked";
    record.revokedAt = this.now();
    record.revokedReason = String(reason ?? "").slice(0, 300);
    record.updatedAt = this.now();
    this.#write(record);
    this.#audit("extension.revoke", record, {
      actor,
      reason: record.revokedReason,
    });
    return structuredClone(record);
  }

  /** Records that a run is using this extension. */
  beginUse(id, runId) {
    const record = this.get(id);
    if (record.status === "revoked")
      throw new InputError(`Extension ${id} is revoked`, 409);
    record.uses = [
      ...record.uses.filter((use) => use.runId !== runId),
      { runId, startedAt: this.now() },
    ];
    record.updatedAt = this.now();
    this.#write(record);
    return structuredClone(record);
  }

  /** Records that a run stopped using this extension. */
  endUse(id, runId) {
    const record = this.get(id);
    record.uses = record.uses.filter((use) => use.runId !== runId);
    record.updatedAt = this.now();
    this.#write(record);
    return structuredClone(record);
  }

  /** Recorded uses whose run is still active. A finished run never blocks removal. */
  activeUses(id) {
    const record = this.get(id);
    const ids = record.uses.map((use) => use.runId).filter(Boolean);
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, status FROM runs WHERE id IN (${placeholders}) AND status IN (${ACTIVE_RUN_STATUSES.map(
          () => "?",
        ).join(", ")})`,
      )
      .all(...ids, ...ACTIVE_RUN_STATUSES);
    return rows.map((row) => ({ runId: row.id, status: row.status }));
  }

  /** Removes an extension. Refused while a run that recorded a use is active. */
  remove(id, { actor = "local-user" } = {}) {
    const record = this.get(id);
    const active = this.activeUses(id);
    if (active.length)
      throw new InputError(
        `Extension ${id} is in use by ${active.length} active run(s) (${active
          .map((use) => `${use.runId}:${use.status}`)
          .join(
            ", ",
          )}). Cancel or finish them, or revoke the extension instead.`,
        409,
      );
    this.db
      .prepare("DELETE FROM settings WHERE key = ?")
      .run(`${KEY_PREFIX}${id}`);
    this.#audit("extension.remove", record, { actor });
    return { id, removed: true };
  }

  /**
   * Integrity check for a downloaded package.
   * → { ok, expected, actual, means }
   * Never a safety verdict: matching bytes only mean unchanged bytes.
   */
  verifyChecksum({ bytes, checksum }) {
    const expected = String(checksum ?? "").trim();
    if (!/^sha256:[a-f0-9]{64}$/i.test(expected))
      throw new InputError(
        'checksum must look like "sha256:<64 hex characters>"',
      );
    const buffer = Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(String(bytes ?? ""), "utf8");
    const actual = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
    return {
      ok: actual.toLowerCase() === expected.toLowerCase(),
      expected: expected.toLowerCase(),
      actual,
      means: SIGNATURE_MEANING,
    };
  }

  /* --------------------------------------------------- template sharing - */

  /**
   * A shareable copy of a workflow template with secrets, private paths, raw
   * logs, and client data removed. `removed` lists everything taken out.
   */
  exportTemplate(id, { getTemplate }) {
    if (typeof getTemplate !== "function")
      throw new InputError("exportTemplate needs a getTemplate function");
    const template = getTemplate(id);
    const { template: safe, removed } = stripTemplate(template);
    const body = JSON.stringify(safe);
    return {
      format: "agent-space-template",
      formatVersion: 1,
      exportedAt: this.now(),
      template: safe,
      removed,
      checksum: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      note: "Templates are data. Importing one adds tasks and prompts, never executable code. Every acceptance criterion is checked against recorded runs.",
    };
  }

  /**
   * Preview of an imported template: what it would create, what tools and
   * connectors it needs, and what was stripped. Nothing is written.
   */
  importTemplate(
    json,
    { validateTemplate, connectorVocabulary = {}, confirm = false } = {},
  ) {
    const preview = this.importTemplatePreview(json, {
      validateTemplate,
      connectorVocabulary,
    });
    return {
      preview,
      template: preview.valid ? preview.sanitized : null,
      applied: false,
      note: confirm
        ? "The preview is always shown first. Agent Space has no template store to write into: run the reviewed template with POST /api/workspaces/:id/workflows."
        : "Preview only. Nothing was written.",
    };
  }

  importTemplatePreview(
    json,
    { validateTemplate, connectorVocabulary = {} } = {},
  ) {
    const document = typeof json === "string" ? parseJson(json, null) : json;
    if (!document) throw new InputError("Could not read the template document");
    const template = document.template ?? document;
    const { template: safe, removed } = stripTemplate(template);
    let valid = true;
    let problem = null;
    try {
      validateTemplate?.(safe);
    } catch (error) {
      valid = false;
      problem = error.message;
    }
    const connectors = (safe.requiredConnectors ?? []).map((name) => ({
      name,
      status: connectorVocabulary[name]?.status ?? "unknown",
      detail:
        connectorVocabulary[name]?.detail ??
        "Not in this build's connector vocabulary",
    }));
    return {
      id: safe.id ?? null,
      name: safe.name ?? null,
      valid,
      problem,
      steps: (safe.steps ?? []).map((step) => ({
        key: step.key,
        title: step.title,
        role: step.role,
        dependsOn: step.dependsOn ?? [],
      })),
      roles: (safe.roles ?? []).map((role) => role.key),
      requiredTools: safe.requiredTools ?? [],
      connectors,
      unavailableConnectors: connectors.filter(
        (entry) => entry.status !== "available",
      ),
      permissionSummary: [
        "Templates are data: importing one creates tasks, prompts, and contracts.",
        `Tools the steps ask for: ${(safe.requiredTools ?? []).join(", ") || "none"}`,
        "Every tool call is still checked against the workspace policy at run time.",
      ],
      removed,
      sanitized: safe,
      importId: randomUUID(),
    };
  }
}

/** Factory used by services.js: `services.extensions = createExtensionRegistry(services)`. */
export function createExtensionRegistry(services, options = {}) {
  return new ExtensionRegistry(services, options);
}

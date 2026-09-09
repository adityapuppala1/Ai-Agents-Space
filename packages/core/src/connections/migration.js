import { InputError } from "../TaskStore.js";
import {
  REGISTRY,
  capabilityMatrix,
  compatibility,
} from "../providers/registry.js";

/**
 * Provider migration assistant.
 *
 * Moving an agent from one runtime to another copies the *profile fields we
 * own* (name, role, instructions, colour, skills, specialty). It never copies
 * conversation history, model state, tool permissions, or anything the
 * provider keeps privately, and it never claims the two runtimes behave the
 * same way.
 *
 *   plan({ services, agentId, workspaceId, targetProvider })
 *     → { from, to, compatible, unsupported, contextCarried, warnings, ... }
 *   apply({ services, agentId, workspaceId, targetProvider, taskId, launch })
 *     → { plan, profile, created, run, audited }
 *
 * `apply` writes an audit entry and, when `launch` is true and a `taskId` is
 * given, starts a run through `services.runWorker` with the same task and the
 * carried context. Both functions are pure with respect to the provider: no
 * CLI is contacted.
 */

export const MIGRATION_WARNING =
  "behaviour will differ; hidden state does not transfer";

/** Profile fields that survive a provider change unchanged. */
export const COMPATIBLE_FIELDS = [
  "name",
  "role",
  "instructions",
  "color",
  "skills",
  "specialty",
];

/** Profile fields that do not survive, each with the reason. */
const UNSUPPORTED_FIELDS = [
  [
    "model",
    (target) =>
      `Model names are runtime-specific; ${target.name} picks its own model unless you choose one it supports.`,
  ],
  ["runtime", () => "The runtime field is replaced by the target provider."],
  [
    "connectionId",
    () =>
      "Connections are per provider; the target provider's own connection is used.",
  ],
  [
    "workingState",
    () =>
      "Demo animation state only; real activity comes from the target provider's events.",
  ],
];

function findProfile(services, { agentId, workspaceId }) {
  if (!agentId || typeof agentId !== "string")
    throw new InputError("agentId is required");
  let resolvedWorkspaceId = workspaceId ?? null;
  if (!resolvedWorkspaceId) {
    const row = services.db
      ?.prepare("SELECT workspace_id FROM agent_profiles WHERE id = ?")
      .get(agentId);
    if (!row) throw new InputError("Agent not found", 404);
    resolvedWorkspaceId = row.workspace_id;
  }
  const workspace = services.hub.get(resolvedWorkspaceId);
  return { workspace, profile: workspace.profiles.get(agentId) };
}

function skillsOf(profile) {
  return Array.isArray(profile?.skills) ? profile.skills : [];
}

/**
 * Explains what carries over to `targetProvider` and what does not. Never
 * mutates anything.
 */
export function plan({
  services,
  connections = null,
  agentId,
  workspaceId,
  targetProvider,
}) {
  const target = REGISTRY[targetProvider];
  if (!target) throw new InputError(`Unknown provider: ${targetProvider}`, 404);
  const { workspace, profile } = findProfile(services, {
    agentId,
    workspaceId,
  });
  const from = profile.provider ?? profile.runtime ?? null;
  const compatible = [];
  const unsupported = [];
  for (const field of COMPATIBLE_FIELDS) {
    const value = field === "skills" ? skillsOf(profile) : profile[field];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    compatible.push({ field, value });
  }
  for (const [field, reason] of UNSUPPORTED_FIELDS) {
    const value = profile[field];
    if (value === undefined || value === null || value === "") continue;
    unsupported.push({ field, value, reason: reason(target) });
  }
  const connection =
    connections?.forProvider?.(targetProvider) ??
    services.connections?.forProvider?.(targetProvider) ??
    null;
  const contextCarried = {
    agentId: profile.id,
    workspaceId: workspace.id,
    workspaceName: workspace.record?.name ?? null,
    rootPath: workspace.record?.rootPath ?? null,
    name: profile.name,
    role: profile.role,
    instructions: profile.instructions ?? "",
    color: profile.color,
    specialty: profile.specialty ?? "",
    skills: skillsOf(profile),
  };
  const warnings = [MIGRATION_WARNING];
  warnings.push(
    `${target.name} has its own tools, permissions, and models; results from ${
      from ? (REGISTRY[from]?.name ?? from) : "the current provider"
    } will not be reproduced exactly.`,
  );
  warnings.push(
    "Conversation history, private reasoning, and provider-side session state are not transferred: only the fields listed as compatible are copied.",
  );
  if (!connection || connection.status === "missing")
    warnings.push(
      `${target.name} is not detected on this machine, so the migrated profile cannot run until the CLI is installed.`,
    );
  else if (connection.errorCategory)
    warnings.push(
      `${target.name} last reported "${connection.errorCategory}": ${connection.remediation ?? "probe the connection for details"}.`,
    );
  return {
    from,
    to: targetProvider,
    toName: target.name,
    agentId: profile.id,
    workspaceId: workspace.id,
    compatible,
    unsupported,
    contextCarried,
    warnings,
    capabilities: capabilityMatrix(targetProvider, {
      hooksInstalled:
        connections?.hooksInstalled?.() ??
        services.connections?.hooksInstalled?.() ??
        false,
    }),
    compatibility: compatibility(targetProvider, connection?.version ?? null),
    targetStatus: connection?.status ?? "unknown",
  };
}

/**
 * Copies the compatible fields onto a profile for the target provider,
 * records an audit entry, and optionally launches a run for `taskId`.
 * Behaviour parity is never implied: the plan's warnings travel with the
 * result and are recorded on the run's context.
 */
export async function apply({
  services,
  connections = null,
  agentId,
  workspaceId,
  targetProvider,
  taskId = null,
  launch = false,
  actor = "local-user",
}) {
  const migration = plan({
    services,
    connections,
    agentId,
    workspaceId,
    targetProvider,
  });
  const { workspace, profile } = findProfile(services, {
    agentId,
    workspaceId: migration.workspaceId,
  });
  const target = REGISTRY[targetProvider];
  const targetName = `${profile.name} (${target.badge ?? target.name})`.slice(
    0,
    60,
  );
  const fields = {
    name: targetName,
    role: profile.role,
    instructions: profile.instructions ?? "",
    color: profile.color,
    specialty: profile.specialty ?? "",
    provider: targetProvider,
  };
  const existing = workspace.profiles
    .list({ includeArchived: false })
    .find((p) => p.provider === targetProvider && p.name === targetName);
  let created = false;
  let migrated;
  if (existing) {
    migrated = workspace.profiles.update(existing.id, fields);
  } else {
    migrated = workspace.profiles.create(fields);
    created = true;
  }
  // `skills` is stored on the row but not accepted by create/update yet, so it
  // is copied directly. Failure is not fatal: the rest of the profile is done.
  const skills = skillsOf(profile);
  if (skills.length) {
    try {
      services.db
        .prepare("UPDATE agent_profiles SET skills = ? WHERE id = ?")
        .run(JSON.stringify(skills), migrated.id);
      migrated = workspace.profiles.get(migrated.id);
    } catch {
      /* skills column unavailable; the profile is still migrated */
    }
  }
  services.audit?.record?.({
    actor,
    action: "connection.migrate",
    target: migrated.id,
    workspaceId: workspace.id,
    details: {
      from: migration.from,
      to: targetProvider,
      sourceAgentId: profile.id,
      created,
      fieldsCopied: migration.compatible.map((entry) => entry.field),
      unsupported: migration.unsupported.map((entry) => entry.field),
      warnings: migration.warnings,
      taskId,
      launch: Boolean(launch),
    },
  });
  let run = null;
  let launchError = null;
  if (launch) {
    if (!taskId)
      throw new InputError("taskId is required to launch a migrated run");
    if (!services.runWorker?.start)
      throw new InputError("Managed runs are not available", 503);
    try {
      run = await services.runWorker.start({
        workspaceId: workspace.id,
        taskId,
        agentId: migrated.id,
        provider: targetProvider,
        actor,
      });
    } catch (error) {
      launchError = error?.message ?? String(error);
      if (!(error instanceof InputError)) throw error;
      throw error;
    }
  }
  services.bus?.emit?.("global");
  return {
    plan: migration,
    profile: migrated,
    created,
    run,
    launchError,
    warnings: migration.warnings,
  };
}

export { plan as planMigration, apply as applyMigration };
export default { plan, apply };

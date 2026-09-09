import { basename, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { PROVIDERS } from "../contracts.js";
import { DEMO_WORKSPACE_ID } from "../WorkspaceHub.js";
import { InputError } from "../TaskStore.js";

/**
 * Maps observed provider sessions onto Agent Space workspaces and agent
 * profiles. Pure bookkeeping: nothing here reads provider files.
 */

export const OBSERVED_WORKSPACE_ID = "observed";
export const OBSERVED_WORKSPACE_NAME = "Observed sessions";

export const PROVIDER_COLORS = {
  "claude-code": "#d97757",
  codex: "#10a37f",
  copilot: "#8957e5",
  cursor: "#5b5bd6",
  gemini: "#4285f4",
};

const WIN32 = process.platform === "win32";

// Private path helpers (mirrors util/paths.js which may not exist yet).
export function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\"))
    return homedir() + sep + p.slice(2);
  return p;
}

export function normalizePath(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  let out = resolve(expandHome(p.trim()));
  // Strip trailing separators except for roots like C:\ or /.
  while (out.length > 1 && /[\\/]$/.test(out) && !/^[a-z]:[\\/]$/i.test(out))
    out = out.slice(0, -1);
  if (WIN32) out = out.replace(/\//g, "\\").toLowerCase();
  return out;
}

export function samePath(a, b) {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return !!na && !!nb && na === nb;
}

export function isWithin(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  const prefix = /[\\/]$/.test(p) ? p : p + sep;
  return c.startsWith(prefix);
}

function workspaceRow(db, id) {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
}

function recordFor(services, id) {
  const record = services.hub.get(id).record;
  const row = workspaceRow(services.db, id);
  return { ...record, autoCreated: row?.auto_created === 1 };
}

/** Creates (once) the fallback workspace for sessions without a mappable cwd. */
export function ensureObservedWorkspace(services) {
  const { db, hub } = services;
  const row = workspaceRow(db, OBSERVED_WORKSPACE_ID);
  if (!row) {
    db.prepare(
      "INSERT INTO workspaces (id, name, kind, root_path, created_at, auto_created) VALUES (?, ?, 'project', NULL, ?, 1)",
    ).run(OBSERVED_WORKSPACE_ID, OBSERVED_WORKSPACE_NAME, Date.now());
    const runtime = hub.get(OBSERVED_WORKSPACE_ID);
    runtime.changed(
      "Workspace created automatically for observed sessions without a matching folder",
      "system",
    );
    hub.emit("workspaces");
  } else if (row.archived_at) {
    hub.restore(OBSERVED_WORKSPACE_ID);
  }
  return recordFor(services, OBSERVED_WORKSPACE_ID);
}

function autoCreateSetting(services) {
  try {
    const value = services.settings?.get?.(
      "observation.autoCreateWorkspaces",
      true,
    );
    return value === undefined || value === null ? true : !!value;
  } catch {
    return true;
  }
}

/**
 * Finds the workspace whose rootPath equals or contains `cwd` (deepest wins).
 * Otherwise auto-creates one named after the folder, or falls back to the
 * shared "Observed sessions" workspace. Never returns the demo workspace.
 */
export function resolveWorkspaceForCwd(services, cwd, options = {}) {
  const { hub, db } = services;
  const autoCreate = options.autoCreate ?? autoCreateSetting(services);
  const normalized = normalizePath(cwd);
  const candidates = hub
    .list({ includeArchived: false })
    .filter((w) => w.kind !== "demo" && w.id !== DEMO_WORKSPACE_ID);
  if (normalized) {
    let best = null;
    let bestLength = -1;
    for (const workspace of candidates) {
      if (!workspace.rootPath) continue;
      const root = normalizePath(workspace.rootPath);
      if (!root) continue;
      if (isWithin(normalized, root) && root.length > bestLength) {
        best = workspace;
        bestLength = root.length;
      }
    }
    if (best) return recordFor(services, best.id);
    if (autoCreate) {
      const folder = basename(resolve(expandHome(cwd))) || cwd;
      const parent = basename(dirname(resolve(expandHome(cwd))));
      const taken = (name) =>
        candidates.some((w) => w.name.toLowerCase() === name.toLowerCase()) ||
        hub
          .list({ includeArchived: true })
          .some((w) => w.name.toLowerCase() === name.toLowerCase());
      let name = folder.slice(0, 80);
      if (taken(name) && parent) name = `${folder} (${parent})`.slice(0, 80);
      let suffix = 2;
      const base = name;
      while (taken(name)) name = `${base} ${suffix++}`.slice(0, 80);
      const record = hub.create({ name, rootPath: cwd });
      db.prepare("UPDATE workspaces SET auto_created = 1 WHERE id = ?").run(
        record.id,
      );
      return recordFor(services, record.id);
    }
  }
  return ensureObservedWorkspace(services);
}

function profileRow(db, id) {
  return db.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id);
}

function hasActiveTask(db, agentId) {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE assigned_agent_id = ? AND status IN ('IN_PROGRESS', 'BLOCKED')",
      )
      .get(agentId).n > 0
  );
}

function profileWithProvider(services, workspace, id) {
  const profile = workspace.profiles.get(id);
  const row = profileRow(services.db, id);
  return {
    ...profile,
    provider: row?.provider ?? null,
    autoCreated: row?.auto_created === 1,
  };
}

/**
 * Returns an active auto-created agent profile for `providerId` in the
 * workspace. Reuses a free one (no active task); otherwise creates
 * "<Provider>", "<Provider> 2", ... When `index` is given, returns the
 * auto agent at that position (creating it when missing).
 */
export function ensureProviderAgent(
  services,
  workspaceId,
  providerId,
  { index } = {},
) {
  const { db, hub } = services;
  if (workspaceId === DEMO_WORKSPACE_ID)
    throw new InputError(
      "Observed sessions are never mapped to the demo workspace",
      409,
    );
  const workspace = hub.get(workspaceId);
  const provider = PROVIDERS[providerId];
  const displayName = provider?.name ?? providerId;
  const rows = db
    .prepare(
      "SELECT id FROM agent_profiles WHERE workspace_id = ? AND provider = ? AND auto_created = 1 AND archived_at IS NULL ORDER BY position, created_at",
    )
    .all(workspaceId, providerId);
  if (typeof index === "number" && index >= 0 && index < rows.length)
    return profileWithProvider(services, workspace, rows[index].id);
  if (index === undefined) {
    const free = rows.find((row) => !hasActiveTask(db, row.id));
    if (free) return profileWithProvider(services, workspace, free.id);
  }
  const ordinal = rows.length + 1;
  const name = (
    ordinal === 1 ? displayName : `${displayName} ${ordinal}`
  ).slice(0, 60);
  const created = workspace.createAgent({
    name,
    role: "Coding assistant",
    color: PROVIDER_COLORS[providerId] ?? "#4c78ce",
    specialty: `${displayName} sessions observed from local files`,
    workingState: "CODING",
    runtime: providerId,
  });
  db.prepare(
    "UPDATE agent_profiles SET provider = ?, auto_created = 1, updated_at = ? WHERE id = ?",
  ).run(providerId, Date.now(), created.id);
  return profileWithProvider(services, workspace, created.id);
}

/** True when the agent profile exists, is active, and belongs to the workspace. */
export function agentUsable(services, workspaceId, agentId) {
  if (!agentId) return false;
  const row = profileRow(services.db, agentId);
  return !!row && row.workspace_id === workspaceId && !row.archived_at;
}

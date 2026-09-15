import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { InputError, TaskStore } from "./TaskStore.js";
import { Workspace } from "./Workspace.js";
import { openDatabase, transaction } from "./db.js";
import { mergePolicy, validatePolicy } from "./policy/Policy.js";

export const DEMO_WORKSPACE_ID = "demo";
export const THEMES = [
  "studio",
  "operations",
  "garden",
  "midnight",
  "sandstone",
  "data-lab",
  "research-library",
  "creative-studio",
];

function slug(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "workspace"
  );
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function validate(input, { partial = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("Expected an object");
  const fields = {};
  if (input.name !== undefined || !partial) {
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.trim().length > 80
    )
      throw new InputError("Workspace name must contain 1–80 characters");
    fields.name = input.name.trim();
  }
  if (input.rootPath !== undefined) {
    if (
      input.rootPath !== null &&
      (typeof input.rootPath !== "string" || input.rootPath.length > 500)
    )
      throw new InputError("Root path must be a string under 500 characters");
    fields.rootPath = input.rootPath?.trim() || null;
  }
  if (input.theme !== undefined) {
    if (!THEMES.includes(input.theme))
      throw new InputError(`theme must be one of ${THEMES.join(", ")}`);
    fields.theme = input.theme;
  }
  if (input.policy !== undefined) {
    fields.policy = validatePolicy(input.policy, { partial: true });
  }
  return fields;
}

/**
 * Owns every workspace runtime for one database. The demo workspace always
 * exists and is the only place the simulation may run; project workspaces
 * start empty apart from their own editable agent roster.
 */
export class WorkspaceHub extends EventEmitter {
  constructor(db = openDatabase(), { demo = false } = {}) {
    super();
    this.db = db;
    this.runtimes = new Map();
    this.policyService = null;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO workspaces (id, name, kind, created_at) VALUES (?, 'Demo workspace', 'demo', ?)",
      )
      .run(DEMO_WORKSPACE_ID, Date.now());
    const demoWorkspace = this.get(DEMO_WORKSPACE_ID);
    if (demo) demoWorkspace.loadDemo();
  }

  /**
   * Lets the policy engine own policy writes (validation, audit, broadcast).
   * Without one, PATCH {policy} merges and stores the validated fields directly.
   */
  setPolicyService(service) {
    this.policyService = service ?? null;
  }

  #row(id) {
    return this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
  }

  has(id) {
    return !!this.#row(id);
  }

  list({ includeArchived = false } = {}) {
    const rows = this.db
      .prepare(
        `SELECT w.*,
           (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id AND t.status = 'IN_PROGRESS'
              AND (
                EXISTS (SELECT 1 FROM runs r WHERE r.task_id = t.id AND r.ended_at IS NULL
                          AND r.mode IN ('managed', 'observed')
                          AND r.status IN ('running', 'waiting_approval', 'stale'))
                OR (t.provider IS NULL
                    AND NOT EXISTS (SELECT 1 FROM runs m WHERE m.task_id = t.id AND m.mode IN ('managed', 'observed')))
              )) AS active,
           (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id AND t.status = 'BLOCKED') AS attention,
           (SELECT COUNT(*) FROM agent_profiles a WHERE a.workspace_id = w.id AND a.archived_at IS NULL) AS agents
         FROM workspaces w
         ${includeArchived ? "" : "WHERE w.archived_at IS NULL"}
         ORDER BY CASE w.kind WHEN 'demo' THEN 1 ELSE 0 END, w.created_at`,
      )
      .all();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      rootPath: row.root_path ?? null,
      createdAt: row.created_at,
      archivedAt: row.archived_at ?? null,
      autoCreated: row.auto_created === 1,
      theme: row.theme ?? "studio",
      policy: mergePolicy({}, parseJson(row.policy, {})),
      activeRuns: row.active,
      attention: row.attention,
      agents: row.agents,
    }));
  }

  /**
   * Startup: ends manual placeholder runs that earlier builds left on provider
   * work — a task that names a provider, or that a managed or observed run has
   * executed. Genuine manual work keeps its placeholder. Safe to run again.
   * Returns [{ runId, workspaceId, taskId }].
   */
  closeProviderPlaceholders() {
    const tasks = this.db
      .prepare(
        `SELECT DISTINCT r.workspace_id AS workspaceId, r.task_id AS taskId
           FROM runs r JOIN tasks t ON t.id = r.task_id
          WHERE r.mode = 'manual' AND r.ended_at IS NULL
            AND (t.provider IS NOT NULL
                 OR EXISTS (SELECT 1 FROM runs m WHERE m.task_id = t.id AND m.mode IN ('managed', 'observed')))`,
      )
      .all();
    const closed = [];
    for (const { workspaceId, taskId } of tasks) {
      if (!this.has(workspaceId)) continue;
      const ids = this.get(workspaceId).closePlaceholders(taskId, {
        reason:
          "Closed a placeholder left by an earlier version: a provider runs this task, and the placeholder opened when it was assigned never did any work.",
      });
      for (const runId of ids) closed.push({ runId, workspaceId, taskId });
    }
    return closed;
  }

  get(id) {
    let runtime = this.runtimes.get(id);
    if (runtime) return runtime;
    if (!this.#row(id)) throw new InputError("Workspace not found", 404);
    runtime = new Workspace(new TaskStore(this.db, id));
    runtime.on("change", (snapshot) => this.emit("change", id, snapshot));
    this.runtimes.set(id, runtime);
    return runtime;
  }

  snapshot(id) {
    return { ...this.get(id).snapshot(), workspaces: this.list() };
  }

  create(input) {
    const fields = validate(input);
    let id = slug(fields.name);
    while (this.has(id))
      id = `${slug(fields.name)}-${randomBytes(2).toString("hex")}`;
    this.db
      .prepare(
        "INSERT INTO workspaces (id, name, kind, root_path, created_at, theme, policy) VALUES (?, ?, 'project', ?, ?, ?, ?)",
      )
      .run(
        id,
        fields.name,
        fields.rootPath ?? null,
        Date.now(),
        fields.theme ?? "studio",
        JSON.stringify(fields.policy ?? {}),
      );
    const runtime = this.get(id);
    runtime.changed(`Workspace “${fields.name}” created`, "system");
    this.emit("workspaces");
    return runtime.record;
  }

  update(id, input, { actor = "local-user" } = {}) {
    const runtime = this.get(id);
    const fields = validate(input, { partial: true });
    if (!Object.keys(fields).length)
      throw new InputError(
        "Provide a name, root path, theme, or policy to update",
      );
    const current = runtime.record;
    const sets = [];
    const params = [];
    if (fields.name !== undefined) {
      sets.push("name = ?");
      params.push(fields.name);
    }
    if (fields.rootPath !== undefined) {
      sets.push("root_path = ?");
      params.push(fields.rootPath);
    }
    if (fields.theme !== undefined) {
      sets.push("theme = ?");
      params.push(fields.theme);
    }
    if (sets.length) {
      params.push(id);
      this.db
        .prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`)
        .run(...params);
    }
    let policyHandled = false;
    if (fields.policy !== undefined) {
      if (this.policyService?.setForWorkspace) {
        this.policyService.setForWorkspace(id, fields.policy, { actor });
        policyHandled = true;
      } else {
        this.db
          .prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
          .run(JSON.stringify(mergePolicy(current.policy, fields.policy)), id);
      }
    }
    if (sets.length || !policyHandled) {
      runtime.changed(
        fields.name && fields.name !== current.name
          ? `Workspace renamed to “${fields.name}”`
          : fields.theme && fields.theme !== current.theme
            ? `Office theme set to ${fields.theme}`
            : "Workspace settings updated",
        "system",
      );
    }
    this.emit("workspaces");
    return runtime.record;
  }

  /**
   * Applies a data-only visual preset in one database transaction. Presentation
   * imports must never leave a workspace with half an environment applied.
   */
  applyVisualPreset(id, { theme, visual, layout }) {
    const runtime = this.get(id);
    const current = runtime.record.settings ?? {};
    const next = { ...current, visual: { ...visual } };
    // A preset that says nothing about the layout leaves the one in place.
    if (layout !== undefined) next.officeLayout = layout;
    transaction(this.db, () => {
      this.db
        .prepare("UPDATE workspaces SET theme = ? WHERE id = ?")
        .run(theme, id);
      this.db
        .prepare("UPDATE workspaces SET settings = ? WHERE id = ?")
        .run(JSON.stringify(next), id);
    });
    runtime.changed("Office visual preset applied", "system");
    this.emit("workspaces");
    return runtime.record;
  }

  archive(id) {
    const runtime = this.get(id);
    if (runtime.isDemo)
      throw new InputError("The demo workspace cannot be archived", 409);
    this.db
      .prepare("UPDATE workspaces SET archived_at = ? WHERE id = ?")
      .run(Date.now(), id);
    runtime.changed("Workspace archived", "system");
    this.emit("workspaces");
    return runtime.record;
  }

  restore(id) {
    const runtime = this.get(id);
    this.db
      .prepare("UPDATE workspaces SET archived_at = NULL WHERE id = ?")
      .run(id);
    runtime.changed("Workspace restored", "system");
    this.emit("workspaces");
    return runtime.record;
  }

  tick() {
    for (const runtime of this.runtimes.values()) runtime.tick();
  }
}

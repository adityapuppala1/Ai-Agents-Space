import { randomUUID } from "node:crypto";
import { InputError } from "../TaskStore.js";

/**
 * Saved views for the Board, the Office, the shared filter set, the
 * Timeline and the Dependency Map (migration 12, table `saved_views`).
 * Analytics keeps its own `analytics_saved_views` table; this service never
 * touches it.
 *
 * A view is a named, workspace-scoped JSON `state` blob the client restores
 * verbatim (sort, grouping, filters, camera, collapsed lanes...). The server
 * validates shape and size only: it does not interpret the state, so no
 * saved view can change execution, policy or paths.
 *
 *   createSavedViews(services) -> attaches services.savedViews
 *   create({ workspaceId, scope, name, state, isDefault, actor })
 *   list(workspaceId, { scope })     get(id)
 *   update(id, { name, state, isDefault, actor })
 *   remove(id, { actor })            setDefault(id, { actor })
 */
export const VIEW_SCOPES = ["board", "office", "filters", "timeline", "deps"];
export const MAX_STATE_BYTES = 8 * 1024;
export const MAX_NAME_CHARS = 80;

function rowToView(row) {
  let state = {};
  try {
    state = JSON.parse(row.state ?? "{}");
  } catch {
    state = {};
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    name: row.name,
    state,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateScope(scope) {
  const value = String(scope ?? "").toLowerCase();
  if (!VIEW_SCOPES.includes(value))
    throw new InputError(`scope must be one of ${VIEW_SCOPES.join(", ")}`);
  return value;
}

function validateName(name) {
  if (typeof name !== "string") throw new InputError("name is required");
  const value = name.trim();
  if (value.length < 1 || value.length > MAX_NAME_CHARS)
    throw new InputError(`name must be 1-${MAX_NAME_CHARS} characters`);
  return value;
}

function validateState(state) {
  if (state === undefined || state === null) return "{}";
  if (typeof state !== "object" || Array.isArray(state))
    throw new InputError("state must be a JSON object");
  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch {
    throw new InputError("state must be JSON-serializable");
  }
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES)
    throw new InputError(
      `state exceeds ${MAX_STATE_BYTES} bytes; saved views hold layout and filters, not data`,
      413,
    );
  return serialized;
}

export class SavedViews {
  constructor(services) {
    this.services = services;
    this.db = services.db;
    this.hub = services.hub;
    this.now = () => Date.now();
  }

  #audit(actor, action, view, extra = {}) {
    this.services.audit?.record?.({
      actor: String(actor ?? "user"),
      action,
      target: `view:${view.id}`,
      workspaceId: view.workspaceId,
      details: { scope: view.scope, name: view.name, ...extra },
    });
  }

  #row(id) {
    return this.db.prepare("SELECT * FROM saved_views WHERE id = ?").get(id);
  }

  #clearDefault(workspaceId, scope, exceptId) {
    this.db
      .prepare(
        "UPDATE saved_views SET is_default = 0 WHERE workspace_id = ? AND scope = ? AND id <> ?",
      )
      .run(workspaceId, scope, exceptId);
  }

  create({
    workspaceId,
    scope,
    name,
    state = {},
    isDefault = false,
    actor = "user",
  }) {
    if (!workspaceId) throw new InputError("workspaceId is required");
    this.hub?.get?.(workspaceId);
    const scopeValue = validateScope(scope);
    const nameValue = validateName(name);
    const serialized = validateState(state);
    const id = randomUUID();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO saved_views (id, workspace_id, scope, name, state, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        scopeValue,
        nameValue,
        serialized,
        isDefault ? 1 : 0,
        now,
        now,
      );
    if (isDefault) this.#clearDefault(workspaceId, scopeValue, id);
    const view = this.get(id);
    this.#audit(actor, "view.create", view, { isDefault: view.isDefault });
    this.services.bus?.emit?.("workspace", workspaceId);
    return view;
  }

  list(workspaceId, { scope = null } = {}) {
    if (!workspaceId) throw new InputError("workspaceId is required");
    this.hub?.get?.(workspaceId);
    const scopeValue = scope ? validateScope(scope) : null;
    const rows = scopeValue
      ? this.db
          .prepare(
            "SELECT * FROM saved_views WHERE workspace_id = ? AND scope = ? ORDER BY is_default DESC, name COLLATE NOCASE ASC",
          )
          .all(workspaceId, scopeValue)
      : this.db
          .prepare(
            "SELECT * FROM saved_views WHERE workspace_id = ? ORDER BY scope ASC, is_default DESC, name COLLATE NOCASE ASC",
          )
          .all(workspaceId);
    return rows.map(rowToView);
  }

  get(id) {
    const row = this.#row(id);
    if (!row) throw new InputError("Saved view not found", 404);
    return rowToView(row);
  }

  update(id, { name, state, isDefault, actor = "user" } = {}) {
    const current = this.get(id);
    const nextName = name === undefined ? current.name : validateName(name);
    const nextState =
      state === undefined
        ? JSON.stringify(current.state)
        : validateState(state);
    const nextDefault =
      isDefault === undefined ? current.isDefault : Boolean(isDefault);
    const now = this.now();
    this.db
      .prepare(
        "UPDATE saved_views SET name = ?, state = ?, is_default = ?, updated_at = ? WHERE id = ?",
      )
      .run(nextName, nextState, nextDefault ? 1 : 0, now, id);
    if (nextDefault && !current.isDefault)
      this.#clearDefault(current.workspaceId, current.scope, id);
    const view = this.get(id);
    this.#audit(actor, "view.update", view, {
      changed: [
        name !== undefined && "name",
        state !== undefined && "state",
        isDefault !== undefined && "isDefault",
      ].filter(Boolean),
    });
    this.services.bus?.emit?.("workspace", view.workspaceId);
    return view;
  }

  setDefault(id, { actor = "user" } = {}) {
    const current = this.get(id);
    this.db
      .prepare(
        "UPDATE saved_views SET is_default = 1, updated_at = ? WHERE id = ?",
      )
      .run(this.now(), id);
    this.#clearDefault(current.workspaceId, current.scope, id);
    const view = this.get(id);
    this.#audit(actor, "view.default", view);
    this.services.bus?.emit?.("workspace", view.workspaceId);
    return view;
  }

  remove(id, { actor = "user" } = {}) {
    const view = this.get(id);
    this.db.prepare("DELETE FROM saved_views WHERE id = ?").run(id);
    this.#audit(actor, "view.delete", view);
    this.services.bus?.emit?.("workspace", view.workspaceId);
    return { id, removed: true, workspaceId: view.workspaceId };
  }
}

/** Composes the service and attaches it as `services.savedViews`. */
export function createSavedViews(services) {
  const instance = new SavedViews(services);
  services.savedViews = instance;
  return instance;
}

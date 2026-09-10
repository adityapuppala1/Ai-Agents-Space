import { randomUUID, createHash } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { InputError } from "../TaskStore.js";
import { isSecretPath } from "../contracts.js";
import { normalizePath, isWithin } from "./ContextManifest.js";

/**
 * Scoped memory and named knowledge collections (roadmap §12).
 *
 * Three scopes, never mixed:
 *   user      personal preferences; scope_id is always '' (one local person)
 *   workspace project knowledge; scope_id is the workspace id
 *   run       temporary notes; scope_id is the run id, dropped when the run ends
 *
 * Isolation rules that this module enforces rather than documents:
 *   - a workspace read always filters by workspace_id, so one project can
 *     never read another project's memory;
 *   - user-scoped values are offered to a run only when the setting
 *     `memory.shareUserScope` is true (default true);
 *   - forgetting is a hard DELETE, not a flag.
 *
 * Knowledge items keep source attribution and a captured_at timestamp.
 * `refreshCheck()` re-hashes the source file and flags items whose source
 * changed; it never reads a secret path and never leaves the workspace scope.
 */

export const MEMORY_SCOPES = Object.freeze(["user", "workspace", "run"]);
export const MEMORY_ACCESS = Object.freeze(["workspace", "private"]);
export const SHARE_USER_SCOPE_KEY = "memory.shareUserScope";

function sha256(text) {
  return createHash("sha256")
    .update(String(text ?? ""))
    .digest("hex");
}

function rowToMemory(row) {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id || null,
    kind: row.kind,
    key: row.key,
    value: row.value,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? null,
  };
}

function rowToCollection(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    access: row.access,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function rowToItem(row) {
  return {
    id: row.id,
    collectionId: row.collection_id,
    title: row.title,
    source: row.source || null,
    sourceUrl: row.source_url ?? null,
    content: row.content,
    contentHash: row.content_hash,
    capturedAt: row.captured_at,
    freshnessCheckedAt: row.freshness_checked_at ?? null,
    version: row.version,
    deletedAt: row.deleted_at ?? null,
  };
}

export class MemoryService {
  constructor(services, { now = Date.now } = {}) {
    this.services = services;
    this.db = services.db;
    this.now = now;
  }

  /* ------------------------------ scoping ------------------------------ */

  #scope(scope, scopeId) {
    if (!MEMORY_SCOPES.includes(scope))
      throw new InputError(`scope must be one of ${MEMORY_SCOPES.join(", ")}`);
    if (scope === "user") return { scope, scopeId: "" };
    const id = String(scopeId ?? "").trim();
    if (!id)
      throw new InputError(
        scope === "workspace"
          ? "workspace-scoped memory needs a workspaceId"
          : "run-scoped memory needs a runId",
      );
    return { scope, scopeId: id };
  }

  #expired(row) {
    return Number.isFinite(row?.expires_at) && row.expires_at <= this.now();
  }

  /* ------------------------------- memory ------------------------------- */

  set({
    scope,
    scopeId = null,
    key,
    value = "",
    kind = "note",
    source = "user",
    expiresAt = null,
  } = {}) {
    const target = this.#scope(scope, scopeId);
    const name = String(key ?? "").trim();
    if (!name) throw new InputError("key is required");
    if (name.length > 200) throw new InputError("key is too long (200 max)");
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (String(text).length > 20000)
      throw new InputError("value is too long (20000 characters max)");
    const at = this.now();
    const existing = this.db
      .prepare(
        "SELECT * FROM memories WHERE scope = ? AND scope_id = ? AND key = ?",
      )
      .get(target.scope, target.scopeId, name);
    const ttl = Number.isFinite(expiresAt) ? expiresAt : null;
    if (existing) {
      this.db
        .prepare(
          "UPDATE memories SET value = ?, kind = ?, source = ?, updated_at = ?, expires_at = ? WHERE id = ?",
        )
        .run(String(text), String(kind), String(source), at, ttl, existing.id);
      return this.#byId(existing.id);
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO memories (id, scope, scope_id, kind, key, value, source, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        target.scope,
        target.scopeId,
        String(kind),
        name,
        String(text),
        String(source),
        at,
        at,
        ttl,
      );
    return this.#byId(id);
  }

  #byId(id) {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    return row ? rowToMemory(row) : null;
  }

  get(scope, scopeId, key) {
    const target = this.#scope(scope, scopeId);
    const row = this.db
      .prepare(
        "SELECT * FROM memories WHERE scope = ? AND scope_id = ? AND key = ?",
      )
      .get(target.scope, target.scopeId, String(key ?? "").trim());
    if (!row || this.#expired(row)) return null;
    return rowToMemory(row);
  }

  list({ scope, scopeId = null, kind = null, includeExpired = false } = {}) {
    const target = this.#scope(scope, scopeId);
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE scope = ? AND scope_id = ?${kind ? " AND kind = ?" : ""}
         ORDER BY updated_at DESC, key ASC`,
      )
      .all(...[target.scope, target.scopeId, ...(kind ? [String(kind)] : [])]);
    return rows
      .filter((row) => includeExpired || !this.#expired(row))
      .map(rowToMemory);
  }

  /** Hard delete of one key. Returns the number of rows removed (0 or 1). */
  forget(scope, scopeId, key) {
    const target = this.#scope(scope, scopeId);
    return this.db
      .prepare(
        "DELETE FROM memories WHERE scope = ? AND scope_id = ? AND key = ?",
      )
      .run(target.scope, target.scopeId, String(key ?? "").trim()).changes;
  }

  /** Hard delete of every key in one scope. Returns the number of rows removed. */
  forgetAll(scope, scopeId) {
    const target = this.#scope(scope, scopeId);
    return this.db
      .prepare("DELETE FROM memories WHERE scope = ? AND scope_id = ?")
      .run(target.scope, target.scopeId).changes;
  }

  /** Removes expired rows (run notes with a TTL). Returns the count. */
  purgeExpired() {
    return this.db
      .prepare(
        "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(this.now()).changes;
  }

  /** Run notes are temporary: ending the run deletes them. */
  endRun(runId) {
    if (!runId) return 0;
    return this.forgetAll("run", runId);
  }

  #shareUserScope() {
    const value = this.services.settings?.get?.(SHARE_USER_SCOPE_KEY, true);
    return value === undefined || value === null ? true : value !== false;
  }

  /**
   * What a run may see: its own notes, its workspace's knowledge, and — only
   * when `memory.shareUserScope` is true — personal preferences. Nothing from
   * another workspace or another run is ever returned.
   */
  forRun({ runId = null, workspaceId = null } = {}) {
    const shareUser = this.#shareUserScope();
    return {
      user: shareUser ? this.list({ scope: "user" }) : [],
      userScopeShared: shareUser,
      workspace: workspaceId
        ? this.list({ scope: "workspace", scopeId: workspaceId })
        : [],
      run: runId ? this.list({ scope: "run", scopeId: runId }) : [],
    };
  }

  /* ------------------------- knowledge collections ------------------------- */

  createCollection({
    workspaceId,
    name,
    description = "",
    access = "workspace",
  } = {}) {
    if (!workspaceId) throw new InputError("workspaceId is required");
    const title = String(name ?? "").trim();
    if (!title) throw new InputError("name is required");
    if (!MEMORY_ACCESS.includes(access))
      throw new InputError(`access must be one of ${MEMORY_ACCESS.join(", ")}`);
    const existing = this.db
      .prepare(
        "SELECT id FROM knowledge_collections WHERE workspace_id = ? AND name = ?",
      )
      .get(workspaceId, title);
    if (existing)
      throw new InputError("A collection with that name already exists", 409);
    const id = randomUUID();
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO knowledge_collections (id, workspace_id, name, description, access, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(id, workspaceId, title, String(description ?? ""), access, at, at);
    return this.getCollection(id, { workspaceId });
  }

  listCollections(workspaceId) {
    if (!workspaceId) throw new InputError("workspaceId is required");
    return this.db
      .prepare(
        "SELECT * FROM knowledge_collections WHERE workspace_id = ? ORDER BY name ASC",
      )
      .all(workspaceId)
      .map((row) => ({
        ...rowToCollection(row),
        itemCount: this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM knowledge_items WHERE collection_id = ? AND deleted_at IS NULL",
          )
          .get(row.id).n,
      }));
  }

  /** A collection plus its live items. `workspaceId` pins the read to one project. */
  getCollection(
    collectionId,
    { workspaceId = null, includeDeleted = false } = {},
  ) {
    const row = this.db
      .prepare("SELECT * FROM knowledge_collections WHERE id = ?")
      .get(collectionId);
    if (!row) throw new InputError("Collection not found", 404);
    if (workspaceId && row.workspace_id !== workspaceId)
      throw new InputError("Collection not found", 404);
    const items = this.db
      .prepare(
        `SELECT * FROM knowledge_items WHERE collection_id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}
         ORDER BY captured_at ASC, title ASC`,
      )
      .all(collectionId)
      .map(rowToItem);
    return { ...rowToCollection(row), items };
  }

  updateCollection(collectionId, { name, description, access } = {}) {
    const current = this.db
      .prepare("SELECT * FROM knowledge_collections WHERE id = ?")
      .get(collectionId);
    if (!current) throw new InputError("Collection not found", 404);
    if (access !== undefined && !MEMORY_ACCESS.includes(access))
      throw new InputError(`access must be one of ${MEMORY_ACCESS.join(", ")}`);
    this.db
      .prepare(
        `UPDATE knowledge_collections SET name = ?, description = ?, access = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(
        name === undefined ? current.name : String(name).trim() || current.name,
        description === undefined ? current.description : String(description),
        access === undefined ? current.access : access,
        this.now(),
        collectionId,
      );
    return this.getCollection(collectionId);
  }

  deleteCollection(collectionId) {
    const removedItems = this.db
      .prepare("DELETE FROM knowledge_items WHERE collection_id = ?")
      .run(collectionId).changes;
    const removed = this.db
      .prepare("DELETE FROM knowledge_collections WHERE id = ?")
      .run(collectionId).changes;
    return { removed, removedItems };
  }

  #bump(collectionId) {
    this.db
      .prepare(
        "UPDATE knowledge_collections SET updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run(this.now(), collectionId);
  }

  addItem(
    collectionId,
    { title, source = "", sourceUrl = null, content = "", capturedAt } = {},
  ) {
    const collection = this.db
      .prepare("SELECT * FROM knowledge_collections WHERE id = ?")
      .get(collectionId);
    if (!collection) throw new InputError("Collection not found", 404);
    const name = String(title ?? "").trim();
    if (!name) throw new InputError("title is required");
    const sourcePath = String(source ?? "");
    if (sourcePath && isSecretPath(sourcePath))
      throw new InputError(
        "That source is a secret path and cannot be captured",
        400,
      );
    const id = randomUUID();
    const at = Number.isFinite(capturedAt) ? capturedAt : this.now();
    this.db
      .prepare(
        `INSERT INTO knowledge_items (id, collection_id, title, source, source_url, content, content_hash, captured_at, freshness_checked_at, version, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, NULL)`,
      )
      .run(
        id,
        collectionId,
        name,
        sourcePath,
        sourceUrl ? String(sourceUrl) : null,
        String(content ?? ""),
        sha256(content ?? ""),
        at,
      );
    this.#bump(collectionId);
    return this.getItem(id);
  }

  getItem(itemId) {
    const row = this.db
      .prepare("SELECT * FROM knowledge_items WHERE id = ?")
      .get(itemId);
    if (!row) throw new InputError("Knowledge item not found", 404);
    return rowToItem(row);
  }

  updateItem(itemId, { title, source, sourceUrl, content } = {}) {
    const row = this.db
      .prepare("SELECT * FROM knowledge_items WHERE id = ?")
      .get(itemId);
    if (!row) throw new InputError("Knowledge item not found", 404);
    if (source !== undefined && source && isSecretPath(String(source)))
      throw new InputError(
        "That source is a secret path and cannot be captured",
        400,
      );
    const nextContent = content === undefined ? row.content : String(content);
    this.db
      .prepare(
        `UPDATE knowledge_items SET title = ?, source = ?, source_url = ?, content = ?, content_hash = ?, version = version + 1 WHERE id = ?`,
      )
      .run(
        title === undefined ? row.title : String(title).trim() || row.title,
        source === undefined ? row.source : String(source),
        sourceUrl === undefined
          ? row.source_url
          : sourceUrl
            ? String(sourceUrl)
            : null,
        nextContent,
        sha256(nextContent),
        itemId,
      );
    this.#bump(row.collection_id);
    return this.getItem(itemId);
  }

  /** Soft delete: the item stops being offered but the row stays for audit. */
  deleteItem(itemId) {
    const row = this.db
      .prepare("SELECT * FROM knowledge_items WHERE id = ?")
      .get(itemId);
    if (!row) throw new InputError("Knowledge item not found", 404);
    this.db
      .prepare(
        "UPDATE knowledge_items SET deleted_at = ?, version = version + 1 WHERE id = ?",
      )
      .run(this.now(), itemId);
    this.#bump(row.collection_id);
    return this.getItem(itemId);
  }

  /** The explicit forgetting path: removes the row and its content for good. */
  purgeItem(itemId) {
    const row = this.db
      .prepare("SELECT * FROM knowledge_items WHERE id = ?")
      .get(itemId);
    if (!row) throw new InputError("Knowledge item not found", 404);
    const removed = this.db
      .prepare("DELETE FROM knowledge_items WHERE id = ?")
      .run(itemId).changes;
    this.#bump(row.collection_id);
    return { removed, itemId };
  }

  /**
   * Re-checks every live item against its source file: stamps
   * freshness_checked_at and reports which items are stale. Files outside the
   * workspace root and secret paths are never opened; they are reported with
   * a reason instead.
   */
  refreshCheck(collectionId) {
    const collection = this.db
      .prepare("SELECT * FROM knowledge_collections WHERE id = ?")
      .get(collectionId);
    if (!collection) throw new InputError("Collection not found", 404);
    const workspace = this.db
      .prepare("SELECT root_path FROM workspaces WHERE id = ?")
      .get(collection.workspace_id);
    const root = workspace?.root_path
      ? normalizePath(workspace.root_path)
      : null;
    const at = this.now();
    const items = this.db
      .prepare(
        "SELECT * FROM knowledge_items WHERE collection_id = ? AND deleted_at IS NULL ORDER BY captured_at ASC",
      )
      .all(collectionId);
    const results = [];
    for (const row of items) {
      const source = row.source ? String(row.source) : "";
      let state = "no-source";
      let detail = "item has no file source; freshness cannot be checked";
      let currentHash = null;
      if (source) {
        const abs = isAbsolute(source)
          ? normalizePath(source)
          : root
            ? normalizePath(resolve(root, source))
            : null;
        if (!abs) {
          state = "unchecked";
          detail = "workspace has no rootPath; relative sources are not read";
        } else if (isSecretPath(abs)) {
          state = "unchecked";
          detail = "secret path; never read";
        } else if (!root || !isWithin(abs, root)) {
          // Containment is MANDATORY, including when the workspace has no
          // rootPath. Without the !root case an absolute source was stat`d and
          // read anywhere on the host, which made refresh() an existence and
          // content oracle for files far outside any workspace.
          state = "unchecked";
          detail = "outside the workspace root; never read";
        } else if (!existsSync(abs)) {
          state = "missing";
          detail = "source file no longer exists";
        } else {
          try {
            const stat = statSync(abs);
            if (!stat.isFile()) {
              state = "unchecked";
              detail = "source is not a file";
            } else {
              currentHash = sha256(readFileSync(abs, "utf8"));
              state = currentHash === row.content_hash ? "fresh" : "changed";
              detail =
                state === "fresh"
                  ? "source file matches the captured content"
                  : "source file changed since capture";
            }
          } catch (error) {
            state = "unchecked";
            detail = `source could not be read: ${error.message}`;
          }
        }
      }
      this.db
        .prepare(
          "UPDATE knowledge_items SET freshness_checked_at = ? WHERE id = ?",
        )
        .run(at, row.id);
      results.push({
        id: row.id,
        title: row.title,
        source: source || null,
        state,
        stale: state === "changed" || state === "missing",
        detail,
        capturedAt: row.captured_at,
        checkedAt: at,
      });
    }
    return {
      collectionId,
      checkedAt: at,
      checked: results.length,
      stale: results.filter((r) => r.stale).length,
      items: results,
    };
  }

  /**
   * Knowledge items formatted for a context manifest: attribution and
   * captured_at travel with each entry, and private collections stay out
   * unless the caller asks for them by id.
   */
  itemsForContext(workspaceId, collectionIds = []) {
    if (!workspaceId) return [];
    const wanted = (Array.isArray(collectionIds) ? collectionIds : [])
      .map(String)
      .filter(Boolean);
    const collections = this.db
      .prepare(
        "SELECT * FROM knowledge_collections WHERE workspace_id = ? ORDER BY name ASC",
      )
      .all(workspaceId)
      .filter(
        (row) =>
          wanted.includes(row.id) ||
          (wanted.length === 0 && row.access === "workspace"),
      );
    const out = [];
    for (const collection of collections) {
      for (const row of this.db
        .prepare(
          "SELECT * FROM knowledge_items WHERE collection_id = ? AND deleted_at IS NULL ORDER BY captured_at ASC",
        )
        .all(collection.id)) {
        out.push({
          collectionId: collection.id,
          collection: collection.name,
          access: collection.access,
          itemId: row.id,
          title: row.title,
          source: row.source || null,
          sourceUrl: row.source_url ?? null,
          capturedAt: row.captured_at,
          freshnessCheckedAt: row.freshness_checked_at ?? null,
          bytes: Buffer.byteLength(row.content ?? ""),
          version: row.version,
        });
      }
    }
    return out;
  }
}

/** services.js optional-module factory. */
export function createMemory(services) {
  services.memory ??= new MemoryService(services);
  return services.memory;
}

export default MemoryService;

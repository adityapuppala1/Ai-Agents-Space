import { statSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve, isAbsolute, sep, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { isSecretPath, DEFAULT_POLICY } from "../contracts.js";
import { InputError } from "../TaskStore.js";
import { rank } from "./relevance.js";
import { scanManifest } from "./untrusted.js";

// Private path helpers (packages/core/src/util/paths.js belongs to module A).
const WIN = process.platform === "win32";

function expandHome(p) {
  if (!p) return p;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\"))
    return resolve(homedir(), p.slice(2));
  return p;
}

function normalizePath(p) {
  if (!p) return "";
  let out = resolve(expandHome(String(p)));
  if (WIN) out = out.replace(/\//g, "\\");
  if (out.length > 1) out = out.replace(/[\\/]+$/, "");
  return out;
}

function pathKey(p) {
  return WIN ? p.toLowerCase() : p;
}

function samePath(a, b) {
  return pathKey(normalizePath(a)) === pathKey(normalizePath(b));
}

function isWithin(child, parent) {
  const c = pathKey(normalizePath(child));
  const p = pathKey(normalizePath(parent));
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * Builds and checks context manifests: which files, documents, and
 * instructions are attached to a run. Only metadata is recorded; file
 * contents are never read into the manifest.
 *
 * Constructor: `new ContextManifest(services, { git = true })`.
 */
export class ContextManifest {
  constructor(services, { git = true } = {}) {
    this.services = services;
    this.db = services.db;
    this.hub = services.hub;
    this.git = git;
    this.repoCache = new Map();
  }

  #policy(workspaceId) {
    const fromService = this.services.policy?.forWorkspace?.(workspaceId);
    if (fromService) return fromService;
    const row = this.db
      .prepare("SELECT policy FROM workspaces WHERE id = ?")
      .get(workspaceId);
    return { ...DEFAULT_POLICY, ...parseJson(row?.policy, {}) };
  }

  #inRepo(dir) {
    if (!this.git) return false;
    const key = pathKey(normalizePath(dir));
    if (this.repoCache.has(key)) return this.repoCache.get(key);
    let result = false;
    try {
      const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
        windowsHide: true,
      });
      result = out.trim() === "true";
    } catch {
      result = false;
    }
    this.repoCache.set(key, result);
    return result;
  }

  /** `git:<blob>` when inside a repository, otherwise `mtime:<ms>`. */
  revision(path) {
    const dir = dirname(path);
    if (this.#inRepo(dir)) {
      try {
        const hash = execFileSync(
          "git",
          ["hash-object", "--", basename(path)],
          {
            cwd: dir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5000,
            windowsHide: true,
          },
        ).trim();
        if (/^[0-9a-f]{40,64}$/.test(hash)) return `git:${hash}`;
      } catch {
        /* fall through to mtime */
      }
    }
    return `mtime:${Math.round(statSync(path).mtimeMs)}`;
  }

  #scopes(workspace, policy) {
    const scopes = [];
    if (workspace.rootPath) scopes.push(normalizePath(workspace.rootPath));
    for (const folder of policy.allowedFolders ?? []) {
      if (!folder) continue;
      const abs = isAbsolute(expandHome(folder))
        ? normalizePath(folder)
        : workspace.rootPath
          ? normalizePath(resolve(workspace.rootPath, folder))
          : null;
      if (abs) scopes.push(abs);
    }
    return scopes;
  }

  /**
   * build({ workspaceId, taskId, agentId, runId, files, documents,
   *         instructions, maxFileBytes, memory, knowledge, relevance })
   *
   * `memory` (default true) pulls scoped memory through services.memory:
   * workspace knowledge for this workspace only, personal preferences when
   * `memory.shareUserScope` allows it, and the run's own notes.
   * `knowledge` is `true` (every workspace-access collection) or a list of
   * collection ids; each item keeps its source attribution and captured_at.
   * `relevance` is `true` or `{ include, exclude, maxItems, maxBytes,
   * diffFiles }` and reorders the files deterministically, recording why each
   * one is here and which ones fell outside the budget.
   */
  build({
    workspaceId,
    taskId = null,
    agentId = null,
    runId = null,
    files = [],
    documents = [],
    instructions = [],
    maxFileBytes = 200_000,
    memory = true,
    knowledge = null,
    relevance = null,
  }) {
    const runtime = this.hub.get(workspaceId);
    const workspace = runtime.record;
    const policy = this.#policy(workspaceId);
    const scopes = this.#scopes(workspace, policy);
    if (
      !Array.isArray(files) ||
      !Array.isArray(instructions) ||
      !Array.isArray(documents)
    )
      throw new InputError("files, documents, and instructions must be arrays");

    let task = null;
    if (taskId) {
      const row = this.db
        .prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
        .get(taskId, workspaceId);
      if (!row) throw new InputError("Task not found", 404);
      task = row;
    }
    let agent = null;
    if (agentId) agent = runtime.profiles.get(agentId);

    const requested = [...files.map(String)];
    const target = parseJson(task?.target, {});
    for (const file of target.files ?? []) requested.push(String(file));
    if (target.range?.file) requested.push(String(target.range.file));

    const included = [];
    const excluded = [];
    const seen = new Set();
    let totalBytes = 0;
    for (const raw of requested) {
      if (!raw.trim()) continue;
      const abs = isAbsolute(expandHome(raw))
        ? normalizePath(raw)
        : workspace.rootPath
          ? normalizePath(resolve(workspace.rootPath, raw))
          : null;
      if (!abs) {
        excluded.push({
          path: raw,
          reason: "outside-scope",
          detail:
            "workspace has no rootPath; relative paths cannot be resolved",
        });
        continue;
      }
      if (seen.has(pathKey(abs))) continue;
      seen.add(pathKey(abs));
      if (isSecretPath(abs)) {
        excluded.push({ path: abs, reason: "secret" });
        continue;
      }
      if (!scopes.some((scope) => isWithin(abs, scope))) {
        excluded.push({
          path: abs,
          reason: "outside-scope",
          detail: scopes.length
            ? "not inside rootPath or allowedFolders"
            : "workspace has no rootPath or allowedFolders",
        });
        continue;
      }
      if (!existsSync(abs)) {
        excluded.push({ path: abs, reason: "missing" });
        continue;
      }
      const stat = statSync(abs);
      if (!stat.isFile()) {
        excluded.push({ path: abs, reason: "not-a-file" });
        continue;
      }
      if (stat.size > maxFileBytes) {
        excluded.push({
          path: abs,
          reason: "too-large",
          bytes: stat.size,
          limit: maxFileBytes,
        });
        continue;
      }
      let revision;
      try {
        revision = this.revision(abs);
      } catch (error) {
        excluded.push({
          path: abs,
          reason: "unreadable",
          detail: error.message,
        });
        continue;
      }
      totalBytes += stat.size;
      included.push({
        path: abs,
        revision,
        bytes: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        included: true,
        reason: null,
      });
    }

    const lines = [];
    lines.push(
      `Workspace: ${workspace.name}${workspace.rootPath ? ` (${workspace.rootPath})` : ""}`,
    );
    if (agent?.instructions?.trim()) lines.push(agent.instructions.trim());
    if (task) {
      lines.push(`Task: ${task.title}`);
      if (task.description?.trim()) lines.push(task.description.trim());
      if (task.deliverable?.trim())
        lines.push(`Deliverable: ${task.deliverable.trim()}`);
    }
    for (const line of instructions)
      if (String(line).trim()) lines.push(String(line).trim());

    // Scoped memory. Workspace knowledge is read with the workspace id, so a
    // sibling project's memory can never appear here; personal preferences
    // are offered only when the setting allows it.
    const scoped =
      memory === false
        ? null
        : (this.services.memory?.forRun?.({ runId, workspaceId }) ?? null);
    if (scoped) {
      for (const entry of scoped.workspace)
        lines.push(`Workspace knowledge - ${entry.key}: ${entry.value}`);
      for (const entry of scoped.user)
        lines.push(`Personal preference - ${entry.key}: ${entry.value}`);
      for (const entry of scoped.run)
        lines.push(`Run note - ${entry.key}: ${entry.value}`);
    }

    const docs = documents
      .filter((doc) => doc && typeof doc === "object")
      .map((doc) => ({
        title: String(doc.title ?? doc.id ?? "document"),
        ref: doc.ref ?? doc.url ?? doc.id ?? null,
        revision: doc.revision ?? null,
        bytes: num(doc.bytes),
        source: doc.source ?? (doc.url ? "web" : undefined),
        // Kept only until the untrusted scan below; never stored.
        text: textOf(doc),
      }));
    const instructionBytes = Buffer.byteLength(lines.join("\n"));
    // Named knowledge collections travel as documents with attribution.
    const knowledgeItems = knowledge
      ? (this.services.memory?.itemsForContext?.(
          workspaceId,
          Array.isArray(knowledge) ? knowledge : [],
        ) ?? [])
      : [];
    for (const item of knowledgeItems)
      docs.push({
        title: item.title,
        ref: item.sourceUrl ?? item.source ?? item.itemId,
        revision: `knowledge:v${item.version}`,
        bytes: item.bytes,
        collection: item.collection,
        source: item.source,
        capturedAt: item.capturedAt,
        freshnessCheckedAt: item.freshnessCheckedAt,
        text: this.#knowledgeText(item.itemId),
      });

    // Relevance ranking is deterministic and explains every decision.
    let ranking = null;
    if (relevance) {
      const options = relevance === true ? {} : (relevance ?? {});
      ranking = rank({
        candidates: included.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          mtimeMs: file.mtimeMs,
        })),
        task: task
          ? {
              title: task.title,
              deliverable: task.deliverable,
              description: task.description,
              target,
            }
          : null,
        agent: agent ? { role: agent.role, skills: agent.skills ?? [] } : null,
        memories: scoped ? [...scoped.workspace, ...scoped.user] : [],
        diffFiles:
          options.diffFiles ?? (runId ? this.diffFilesForRun(runId) : []),
        include: options.include ?? [],
        exclude: options.exclude ?? [],
        maxItems: Number.isFinite(options.maxItems) ? options.maxItems : 40,
        maxBytes: Number.isFinite(options.maxBytes)
          ? options.maxBytes
          : 200_000,
        now: Number.isFinite(options.now) ? options.now : Date.now(),
      });
      const byPath = new Map(
        included.map((file) => [pathKey(file.path), file]),
      );
      const kept = [];
      for (const item of ranking.items) {
        const file = byPath.get(pathKey(item.path));
        if (!file) continue;
        if (item.included) {
          file.relevance = {
            score: item.score,
            why: item.why,
            breakdown: item.breakdown,
          };
          kept.push(file);
        } else {
          excluded.push({
            path: file.path,
            reason: item.reason.startsWith("budget:")
              ? "over-budget"
              : "excluded-by-request",
            detail: item.why,
            score: item.score,
          });
        }
      }
      included.length = 0;
      included.push(...kept);
      totalBytes = kept.reduce((sum, file) => sum + file.bytes, 0);
    }

    // Untrusted-content scan. Retrieved files and documents whose text
    // carries instruction-like content are NOT offered to the run unless a
    // person adopted exactly that content (path + content hash) for this
    // workspace. Findings are recorded; nothing is rewritten.
    const untrusted = this.#applyUntrusted({
      workspaceId,
      included,
      docs,
      excluded,
      maxFileBytes,
    });
    totalBytes = included.reduce((sum, file) => sum + file.bytes, 0);

    const docBytes = docs.reduce((sum, doc) => sum + (doc.bytes ?? 0), 0);
    const manifest = {
      version: 1,
      workspaceId,
      taskId,
      agentId,
      runId,
      rootPath: workspace.rootPath ?? null,
      files: included,
      excluded,
      documents: docs,
      instructions: lines,
      memory: scoped
        ? {
            userScopeShared: scoped.userScopeShared,
            user: scoped.user.map((m) => ({ key: m.key, source: m.source })),
            workspace: scoped.workspace.map((m) => ({
              key: m.key,
              source: m.source,
            })),
            run: scoped.run.map((m) => ({ key: m.key, source: m.source })),
          }
        : null,
      knowledge: knowledgeItems,
      untrusted,
      relevance: ranking
        ? {
            deterministic: true,
            weights: ranking.weights,
            controls: ranking.controls,
            budgets: ranking.budgets,
            taskWords: ranking.taskWords,
            items: ranking.items.map(
              ({ path, score, included: keep, reason, why }) => ({
                path,
                score,
                included: keep,
                reason,
                why,
              }),
            ),
          }
        : null,
      totalBytes: totalBytes + instructionBytes + docBytes,
      estimatedTokens: Math.ceil(
        (totalBytes + instructionBytes + docBytes) / 4,
      ),
      estimateLabel: "estimate",
      estimateBasis: "bytes / 4; provider tokenizers differ",
      createdAt: Date.now(),
    };
    manifest.hash = hashManifest(manifest);
    return manifest;
  }

  #knowledgeText(itemId) {
    try {
      const row = this.db
        .prepare("SELECT content FROM knowledge_items WHERE id = ?")
        .get(itemId);
      return typeof row?.content === "string" ? row.content : null;
    } catch {
      return null;
    }
  }

  #adoptedRows(workspaceId) {
    try {
      return this.db
        .prepare(
          "SELECT * FROM adopted_content WHERE workspace_id = ? AND revoked_at IS NULL",
        )
        .all(workspaceId);
    } catch {
      return [];
    }
  }

  /**
   * Scans `included` files and `docs`, then moves untrusted entries that no
   * adoption covers into `excluded` (reason "untrusted"). An adoption only
   * counts when both the path and the content hash match, so a document
   * that changed since it was adopted is excluded again. Returns the summary
   * stored on the manifest.
   */
  #applyUntrusted({ workspaceId, included, docs, excluded, maxFileBytes }) {
    const hashes = new Map();
    const readFile = (path) => {
      const stat = statSync(path);
      if (stat.size > maxFileBytes) return null;
      const buffer = readFileSync(path);
      if (buffer.includes(0)) return null; // binary: nothing to scan
      hashes.set(pathKey(path), sha256(buffer));
      return buffer.toString("utf8");
    };
    scanManifest({ files: included, documents: docs }, { readFile });
    for (const file of included) {
      const hash = hashes.get(pathKey(file.path)) ?? null;
      if (hash) file.contentHash = hash;
    }
    for (const doc of docs) {
      if (typeof doc.text === "string") doc.contentHash = sha256(doc.text);
      delete doc.text;
    }
    const adoptions = this.#adoptedRows(workspaceId);
    const findAdoption = (path, hash) =>
      adoptions.find(
        (row) =>
          pathKey(String(row.path)) === pathKey(String(path ?? "")) &&
          row.content_hash === hash,
      ) ?? null;
    const summary = {
      scanned: true,
      untrustedExcluded: 0,
      adopted: 0,
      findings: 0,
      basis:
        "deterministic pattern rules (context/untrusted.js); findings are labels, never edits",
    };
    const keep = [];
    for (const file of included) {
      summary.findings += file.findings?.length ?? 0;
      if (!file.untrusted) {
        keep.push(file);
        continue;
      }
      const adoption = findAdoption(file.path, file.contentHash ?? null);
      if (adoption) {
        file.adopted = adoptionSummary(adoption);
        summary.adopted++;
        keep.push(file);
        continue;
      }
      summary.untrustedExcluded++;
      excluded.push({
        path: file.path,
        reason: "untrusted",
        detail:
          "content carries instruction-like text; adopt it explicitly to include it",
        contentHash: file.contentHash ?? null,
        findings: file.findings,
      });
    }
    included.length = 0;
    included.push(...keep);
    const keptDocs = [];
    for (const doc of docs) {
      summary.findings += doc.findings?.length ?? 0;
      if (!doc.untrusted) {
        keptDocs.push(doc);
        continue;
      }
      const key = doc.ref ?? doc.title;
      const adoption = findAdoption(key, doc.contentHash ?? null);
      if (adoption) {
        doc.adopted = adoptionSummary(adoption);
        summary.adopted++;
        keptDocs.push(doc);
        continue;
      }
      summary.untrustedExcluded++;
      excluded.push({
        path: String(key),
        title: doc.title,
        reason: "untrusted",
        detail:
          "content carries instruction-like text; adopt it explicitly to include it",
        contentHash: doc.contentHash ?? null,
        findings: doc.findings,
      });
    }
    docs.length = 0;
    docs.push(...keptDocs);
    return summary;
  }

  /** sha256 of a file's current bytes, under the same scope rules as build(). */
  contentHash(workspaceId, path) {
    const workspace = this.hub.get(workspaceId).record;
    const scopes = this.#scopes(workspace, this.#policy(workspaceId));
    const abs = isAbsolute(expandHome(String(path)))
      ? normalizePath(path)
      : workspace.rootPath
        ? normalizePath(resolve(workspace.rootPath, String(path)))
        : null;
    if (!abs || isSecretPath(abs) || !scopes.some((s) => isWithin(abs, s)))
      throw new InputError("Path is outside the workspace scope", 403);
    if (!existsSync(abs)) throw new InputError("File not found", 404);
    return { path: abs, contentHash: sha256(readFileSync(abs)) };
  }

  /**
   * adopt({ workspaceId, path, contentHash, actor, reason })
   *
   * A deliberate, audited decision by a person to offer untrusted content
   * to runs in this workspace. The adoption is bound to the exact content
   * hash: when the content changes it no longer applies. `path` is a file
   * path or a document ref; when `contentHash` is omitted for a file inside
   * the workspace scope it is computed now.
   */
  adopt({
    workspaceId,
    path,
    contentHash = null,
    actor = "user",
    reason = "",
  }) {
    if (!workspaceId) throw new InputError("workspaceId is required");
    this.hub.get(workspaceId);
    if (!path || !String(path).trim()) throw new InputError("path is required");
    let key = String(path).trim();
    let hash = contentHash ? String(contentHash).trim().toLowerCase() : null;
    if (!hash) {
      const computed = this.contentHash(workspaceId, key);
      key = computed.path;
      hash = computed.contentHash;
    } else if (!/^[0-9a-f]{64}$/.test(hash))
      throw new InputError("contentHash must be a sha256 hex digest");
    else if (isAbsolute(expandHome(key))) key = normalizePath(key);
    if (isSecretPath(key))
      throw new InputError("Secret paths cannot be adopted", 403);
    const who = String(actor ?? "user").slice(0, 120) || "user";
    const why = String(reason ?? "").slice(0, 500);
    const existing = this.#adoptedRows(workspaceId).find(
      (row) =>
        pathKey(String(row.path)) === pathKey(key) && row.content_hash === hash,
    );
    if (existing) return rowToAdoption(existing);
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO adopted_content (id, workspace_id, path, content_hash, adopted_by, reason, adopted_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, workspaceId, key, hash, who, why, now);
    this.services.audit?.record?.({
      actor: who,
      action: "context.adopt",
      target: key,
      workspaceId,
      details: { adoptionId: id, contentHash: hash, reason: why },
    });
    return this.adoption(id);
  }

  adoption(id) {
    const row = this.db
      .prepare("SELECT * FROM adopted_content WHERE id = ?")
      .get(id);
    if (!row) throw new InputError("Adoption not found", 404);
    return rowToAdoption(row);
  }

  /** Active adoptions for a workspace (revoked ones too when asked). */
  adopted(workspaceId, { includeRevoked = false } = {}) {
    this.hub.get(workspaceId);
    const rows = includeRevoked
      ? this.db
          .prepare(
            "SELECT * FROM adopted_content WHERE workspace_id = ? ORDER BY adopted_at DESC",
          )
          .all(workspaceId)
      : this.#adoptedRows(workspaceId);
    return rows.map(rowToAdoption);
  }

  revoke(id, { actor = "user", workspaceId = null } = {}) {
    const current = this.adoption(id);
    if (workspaceId && current.workspaceId !== workspaceId)
      throw new InputError("Adoption not found", 404);
    if (current.revokedAt) return current;
    const now = Date.now();
    this.db
      .prepare("UPDATE adopted_content SET revoked_at = ? WHERE id = ?")
      .run(now, id);
    this.services.audit?.record?.({
      actor: String(actor ?? "user"),
      action: "context.revoke",
      target: current.path,
      workspaceId: current.workspaceId,
      details: { adoptionId: id, contentHash: current.contentHash },
    });
    return this.adoption(id);
  }

  /**
   * Recomputes revisions and lists files that changed or disappeared. With a
   * `workspaceId` the same scope and secret checks as build() apply, so the
   * endpoint cannot be used to probe or hash arbitrary files on disk.
   */
  detectStale(manifest, { workspaceId = null } = {}) {
    if (!manifest || !Array.isArray(manifest.files))
      throw new InputError("manifest.files is required");
    const changed = [];
    const missing = [];
    const excluded = [];
    let scopes = null;
    if (workspaceId) {
      const workspace = this.hub.get(workspaceId).record;
      scopes = this.#scopes(workspace, this.#policy(workspaceId));
    }
    for (const file of manifest.files) {
      if (!file?.path) continue;
      if (scopes) {
        const raw = String(file.path);
        const abs = isAbsolute(expandHome(raw)) ? normalizePath(raw) : null;
        if (!abs || isSecretPath(abs)) {
          excluded.push({
            path: raw,
            reason: abs ? "secret" : "outside-scope",
          });
          continue;
        }
        if (!scopes.some((scope) => isWithin(abs, scope))) {
          excluded.push({ path: raw, reason: "outside-scope" });
          continue;
        }
      }
      if (!existsSync(file.path)) {
        missing.push({ path: file.path, previous: file.revision });
        continue;
      }
      let current;
      try {
        current = this.revision(file.path);
      } catch {
        missing.push({ path: file.path, previous: file.revision });
        continue;
      }
      if (current !== file.revision)
        changed.push({ path: file.path, previous: file.revision, current });
    }
    return {
      stale: changed.length > 0 || missing.length > 0,
      changed,
      missing,
      excluded,
      checkedAt: Date.now(),
    };
  }

  /**
   * Repository-relative paths from the run's `diff` artifacts, resolved
   * against the run cwd/worktree. Used by relevance ranking so a file the run
   * actually touched outranks one it never opened. Returns [] when the run,
   * the table, or the artifact is missing.
   */
  diffFilesForRun(runId) {
    if (!runId) return [];
    let run = null;
    try {
      run = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    } catch {
      return [];
    }
    if (!run) return [];
    const base = run.worktree || run.cwd || null;
    const out = [];
    let rows = [];
    try {
      rows = this.db
        .prepare("SELECT metadata FROM artifacts WHERE run_id = ? AND kind = ?")
        .all(runId, "diff");
    } catch {
      return [];
    }
    for (const row of rows) {
      const meta = parseJson(row.metadata, {});
      for (const entry of meta.files ?? []) {
        const raw = typeof entry === "string" ? entry : entry?.path;
        if (!raw) continue;
        const abs = isAbsolute(String(raw))
          ? normalizePath(raw)
          : base
            ? normalizePath(resolve(base, String(raw)))
            : null;
        if (abs && !out.includes(abs)) out.push(abs);
      }
    }
    return out;
  }

  /**
   * Records that a manifest was handed to a provider on a host: the visible
   * record of which provider/host received which permitted inputs. Only
   * paths (workspace-relative where possible), counts, and the manifest hash
   * are stored - never file contents, and never a secret path.
   */
  recordTransfer({
    runId,
    provider = null,
    host = "local",
    manifest = null,
    workspaceId = null,
    at = Date.now(),
  } = {}) {
    if (!runId) throw new InputError("runId is required");
    if (!manifest || !Array.isArray(manifest.files))
      throw new InputError("manifest.files is required");
    const run = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    const wsId =
      workspaceId ?? manifest.workspaceId ?? run?.workspace_id ?? null;
    let root = manifest.rootPath ? normalizePath(manifest.rootPath) : null;
    if (!root && wsId) {
      const row = this.db
        .prepare("SELECT root_path FROM workspaces WHERE id = ?")
        .get(wsId);
      root = row?.root_path ? normalizePath(row.root_path) : null;
    }
    const paths = [];
    let bytes = 0;
    for (const file of manifest.files) {
      if (!file?.path) continue;
      const abs = normalizePath(file.path);
      if (isSecretPath(abs)) continue; // defence in depth: never record a secret
      bytes += Number.isFinite(file.bytes) ? file.bytes : 0;
      paths.push(root && isWithin(abs, root) ? relativeTo(root, abs) : abs);
    }
    const id = randomUUID();
    const details = {
      paths,
      documents: (manifest.documents ?? []).map((doc) => ({
        title: doc.title,
        ref: doc.ref ?? null,
        capturedAt: doc.capturedAt ?? null,
      })),
      knowledge: (manifest.knowledge ?? []).map((item) => ({
        collection: item.collection,
        title: item.title,
        capturedAt: item.capturedAt,
      })),
      instructionCount: (manifest.instructions ?? []).length,
      excludedCount: (manifest.excluded ?? []).length,
      estimatedTokens: manifest.estimatedTokens ?? null,
      estimateLabel: "estimate",
      memoryScopes: manifest.memory
        ? {
            user: manifest.memory.user.length,
            workspace: manifest.memory.workspace.length,
            run: manifest.memory.run.length,
            userScopeShared: manifest.memory.userScopeShared,
          }
        : null,
    };
    this.db
      .prepare(
        `INSERT INTO context_transfers (id, run_id, workspace_id, provider, host, manifest_hash, file_count, byte_count, created_at, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        runId,
        wsId,
        provider ?? run?.provider ?? null,
        String(host ?? "local"),
        manifest.hash ?? hashManifest(manifest),
        paths.length,
        bytes,
        at,
        JSON.stringify(details),
      );
    this.services.audit?.record?.({
      actor: "system",
      action: "context.transfer",
      target: `run:${runId}`,
      workspaceId: wsId,
      runId,
      details: {
        provider: provider ?? run?.provider ?? null,
        host: String(host ?? "local"),
        fileCount: paths.length,
        byteCount: bytes,
        manifestHash: manifest.hash ?? null,
      },
    });
    return this.transfer(id);
  }

  transfer(id) {
    const row = this.db
      .prepare("SELECT * FROM context_transfers WHERE id = ?")
      .get(id);
    if (!row) throw new InputError("Transfer not found", 404);
    return rowToTransfer(row);
  }

  /** Every recorded handover of inputs for one run, oldest first. */
  transfersForRun(runId) {
    return this.db
      .prepare(
        "SELECT * FROM context_transfers WHERE run_id = ? ORDER BY created_at ASC",
      )
      .all(runId)
      .map(rowToTransfer);
  }

  transfersForWorkspace(workspaceId, { limit = 100 } = {}) {
    return this.db
      .prepare(
        "SELECT * FROM context_transfers WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(workspaceId, Math.max(1, Math.min(Number(limit) || 100, 500)))
      .map(rowToTransfer);
  }

  /**
   * The staleness gate: call before accepting a patch or a review. When any
   * pinned file changed since the manifest was built, the caller must
   * re-review (or rebase) rather than apply stale line references.
   *
   * gateApply({ manifest, runId, workspaceId }) ->
   *   { ok, action: 'apply' | 're-review', stale: [{ path, was, now }],
   *     missing, excluded, checkedAt, reason }
   */
  gateApply({ manifest = null, runId = null, workspaceId = null } = {}) {
    let subject = manifest;
    let wsId = workspaceId;
    if (!subject && runId) {
      const run = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
      if (!run) throw new InputError("Run not found", 404);
      wsId ??= run.workspace_id;
      subject = parseJson(run.context, null);
    }
    if (!subject || !Array.isArray(subject.files))
      return {
        ok: true,
        action: "apply",
        stale: [],
        missing: [],
        excluded: [],
        checkedAt: Date.now(),
        reason: "no context manifest was pinned for this run; nothing to check",
      };
    wsId ??= subject.workspaceId ?? null;
    const result = this.detectStale(subject, { workspaceId: wsId });
    const stale = [
      ...result.changed.map((entry) => ({
        path: entry.path,
        was: entry.previous,
        now: entry.current,
        state: "changed",
      })),
      ...result.missing.map((entry) => ({
        path: entry.path,
        was: entry.previous,
        now: null,
        state: "missing",
      })),
    ];
    return {
      ok: stale.length === 0,
      action: stale.length === 0 ? "apply" : "re-review",
      stale,
      missing: result.missing,
      excluded: result.excluded,
      checkedAt: result.checkedAt,
      reason: stale.length
        ? `${stale.length} pinned file${stale.length === 1 ? "" : "s"} changed since the manifest was built; re-review or rebase instead of applying stale line references`
        : "every pinned file still matches the revision recorded in the manifest",
    };
  }
}

function relativeTo(root, abs) {
  const rest = abs.slice(root.length);
  return rest.replace(/^[/\\]+/, "");
}

function rowToTransfer(row) {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id ?? null,
    provider: row.provider ?? null,
    host: row.host,
    manifestHash: row.manifest_hash ?? null,
    fileCount: row.file_count,
    byteCount: row.byte_count,
    createdAt: row.created_at,
    details: parseJson(row.details, {}),
  };
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOf(doc) {
  for (const key of ["text", "content", "body"])
    if (typeof doc[key] === "string") return doc[key];
  return null;
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function adoptionSummary(row) {
  return {
    id: row.id,
    adoptedBy: row.adopted_by,
    adoptedAt: row.adopted_at,
    reason: row.reason ?? "",
  };
}

function rowToAdoption(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    contentHash: row.content_hash,
    adoptedBy: row.adopted_by,
    reason: row.reason ?? "",
    adoptedAt: row.adopted_at,
    revokedAt: row.revoked_at ?? null,
    active: row.revoked_at === null || row.revoked_at === undefined,
  };
}

export function hashManifest(manifest) {
  const material = {
    files: (manifest.files ?? []).map((f) => [
      pathKey(f.path),
      f.revision,
      f.bytes,
    ]),
    documents: (manifest.documents ?? []).map((d) => [
      d.title,
      d.ref,
      d.revision,
    ]),
    instructions: manifest.instructions ?? [],
  };
  return createHash("sha256").update(stableStringify(material)).digest("hex");
}

export { normalizePath, samePath, isWithin, expandHome };

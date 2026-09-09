import { statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, isAbsolute, sep, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { isSecretPath, DEFAULT_POLICY } from "../contracts.js";
import { InputError } from "../TaskStore.js";

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

  build({
    workspaceId,
    taskId = null,
    agentId = null,
    files = [],
    documents = [],
    instructions = [],
    maxFileBytes = 200_000,
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

    const docs = documents
      .filter((doc) => doc && typeof doc === "object")
      .map((doc) => ({
        title: String(doc.title ?? doc.id ?? "document"),
        ref: doc.ref ?? doc.url ?? doc.id ?? null,
        revision: doc.revision ?? null,
        bytes: num(doc.bytes),
      }));
    const instructionBytes = Buffer.byteLength(lines.join("\n"));
    const docBytes = docs.reduce((sum, doc) => sum + (doc.bytes ?? 0), 0);
    const manifest = {
      version: 1,
      workspaceId,
      taskId,
      agentId,
      rootPath: workspace.rootPath ?? null,
      files: included,
      excluded,
      documents: docs,
      instructions: lines,
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
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

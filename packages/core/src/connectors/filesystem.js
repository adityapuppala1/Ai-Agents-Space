/**
 * Filesystem connector — scoped reads under a workspace folder root.
 *
 * Honesty rules that shape this module:
 *  - Every path is resolved against the workspace `rootPath` and refused when
 *    it escapes it (`isWithin`), so a connector call can never read a file the
 *    workspace does not own. Symlinks are resolved before the check.
 *  - Secrets are never returned: `isSecretPath()` from contracts.js refuses
 *    credential files before they are opened.
 *  - Reads are capped (`MAX_READ_BYTES`) and say when they truncated.
 *  - Writes are refused outright: files are changed by provider runs, which
 *    carry policy, approvals, and a run record. A connector write would have
 *    none of that provenance.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { InputError } from "../TaskStore.js";
import { isSecretPath } from "../contracts.js";
import { basenameOf, isWithin, normalizePath } from "../util/paths.js";

/** Hard cap for a single file read (bytes). Larger files are truncated. */
export const MAX_READ_BYTES = 256 * 1024;
/** Hard cap for one directory listing. */
export const MAX_ENTRIES = 500;

export const FILESYSTEM_READ_OPS = Object.freeze([
  "list",
  "read",
  "stat",
  "diff",
]);

/** The workspace folder root, or a plain-language error when there is none. */
export function workspaceRoot(services, workspaceId) {
  if (!workspaceId) throw new InputError("workspaceId is required");
  let record = null;
  try {
    record = services?.hub?.get?.(workspaceId)?.record ?? null;
  } catch (error) {
    throw new InputError(error?.message ?? "Workspace not found", 404);
  }
  if (!record) throw new InputError("Workspace not found", 404);
  const root = record.rootPath;
  if (!root)
    throw new InputError(
      `Workspace ${workspaceId} has no folder root, so there is nothing to read on disk.`,
      409,
    );
  return normalizePath(root);
}

/**
 * Resolves `relative` inside `root` and refuses anything outside it, plus any
 * path that looks like a credential file. Returns the normalized absolute
 * path. An absolute input is accepted only when it is already inside the root.
 */
export function resolveScoped(root, relative = ".") {
  const raw = String(relative ?? ".").trim() || ".";
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(join(root, raw));
  const target = normalizePath(candidate);
  let real = target;
  try {
    real = normalizePath(realpathSync(candidate));
  } catch {
    /* the path may not exist yet; the containment check still applies */
  }
  const rootReal = (() => {
    try {
      return normalizePath(realpathSync(root));
    } catch {
      return root;
    }
  })();
  const contained =
    (isWithin(target, root) || target === root) &&
    (isWithin(real, rootReal) || real === rootReal);
  if (!contained)
    throw new InputError(
      `Path is outside the workspace folder root: ${raw}. The filesystem connector never reads outside ${root}.`,
      403,
    );
  if (isSecretPath(real) || isSecretPath(target))
    throw new InputError(
      `Refused: ${basenameOf(target)} looks like a credential file. Agent Space never reads secrets.`,
      403,
    );
  return real;
}

function entryKind(path) {
  try {
    const stat = statSync(path);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch {
    return "unknown";
  }
}

function listDirectory(root, relative) {
  const target = resolveScoped(root, relative);
  let names;
  try {
    names = readdirSync(target);
  } catch (error) {
    throw new InputError(
      `Cannot list ${relative ?? "."}: ${error.message}`,
      error.code === "ENOENT" ? 404 : 400,
    );
  }
  const entries = [];
  let skippedSecrets = 0;
  for (const name of names.slice(0, MAX_ENTRIES)) {
    const full = join(target, name);
    if (isSecretPath(full)) {
      skippedSecrets += 1;
      continue;
    }
    let size = null;
    let modifiedAt = null;
    try {
      const stat = statSync(full);
      size = stat.isFile() ? stat.size : null;
      modifiedAt = Math.round(stat.mtimeMs);
    } catch {
      /* unreadable entries are still listed, without stats */
    }
    entries.push({
      name,
      path: normalizePath(full),
      kind: entryKind(full),
      size,
      modifiedAt,
    });
  }
  return {
    root,
    path: target,
    entries,
    count: entries.length,
    truncated: names.length > MAX_ENTRIES,
    skippedSecrets,
  };
}

function readFile(root, relative, maxBytes) {
  const target = resolveScoped(root, relative);
  let stat;
  try {
    stat = statSync(target);
  } catch (error) {
    throw new InputError(`Cannot read ${relative}: ${error.message}`, 404);
  }
  if (!stat.isFile()) throw new InputError(`${relative} is not a file`, 400);
  const cap = Math.min(
    Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_READ_BYTES,
    MAX_READ_BYTES,
  );
  const buffer = readFileSync(target);
  const slice = buffer.subarray(0, cap);
  return {
    path: target,
    bytes: stat.size,
    returnedBytes: slice.length,
    truncated: buffer.length > slice.length,
    modifiedAt: Math.round(stat.mtimeMs),
    encoding: "utf8",
    content: slice.toString("utf8"),
  };
}

function statPath(root, relative) {
  const target = resolveScoped(root, relative);
  try {
    const stat = statSync(target);
    return {
      path: target,
      kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      bytes: stat.isFile() ? stat.size : null,
      modifiedAt: Math.round(stat.mtimeMs),
      exists: true,
    };
  } catch {
    return {
      path: target,
      kind: "unknown",
      bytes: null,
      modifiedAt: null,
      exists: false,
    };
  }
}

/**
 * Line diff between the file on disk and the text a caller proposes. It is a
 * common-prefix/suffix diff, not a minimal edit script: it is exact about what
 * changed at the ends and honest that the middle is reported as one block.
 */
export function diffLines(before, after) {
  const a = String(before ?? "").split(/\r?\n/);
  const b = String(after ?? "").split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start])
    start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  const hunk =
    removed.length || added.length
      ? [
          `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
          ...removed.map((line) => `-${line}`),
          ...added.map((line) => `+${line}`),
        ]
      : [];
  return {
    changed: hunk.length > 0,
    linesRemoved: removed.length,
    linesAdded: added.length,
    firstChangedLine: hunk.length ? start + 1 : null,
    diff: hunk.join("\n"),
    method: "common-prefix/suffix line diff (not a minimal edit script)",
  };
}

function diffAgainst(root, relative, content) {
  const target = resolveScoped(root, relative);
  let current = "";
  let exists = true;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    exists = false;
  }
  return {
    path: target,
    exists,
    ...diffLines(current, content ?? ""),
  };
}

/** Creates the filesystem connector. `services` supplies the workspace hub. */
export function createFilesystemConnector(services) {
  return {
    id: "filesystem",
    name: "Local files",
    kind: "files",

    async detect() {
      return {
        available: true,
        reason: null,
        detail:
          "Reads are scoped to each workspace folder root; nothing outside it is opened.",
      };
    },

    async capabilities() {
      const detect = await this.detect();
      return {
        id: "filesystem",
        available: detect.available,
        reason: detect.reason,
        status: "verified",
        reads: FILESYSTEM_READ_OPS,
        writes: [],
        limits: { maxReadBytes: MAX_READ_BYTES, maxEntries: MAX_ENTRIES },
        notes: [
          "Scoped to the workspace rootPath; paths outside it are refused (403).",
          "Credential files are refused by isSecretPath() and never returned.",
          "Writes are refused: files change through provider runs, which carry policy and approvals.",
        ],
      };
    },

    async read(op, params = {}) {
      const root = workspaceRoot(services, params.workspaceId);
      switch (op) {
        case "list":
          return listDirectory(root, params.path ?? ".");
        case "read":
          if (!params.path) throw new InputError("path is required");
          return readFile(root, params.path, params.maxBytes);
        case "stat":
          if (!params.path) throw new InputError("path is required");
          return statPath(root, params.path);
        case "diff":
          if (!params.path) throw new InputError("path is required");
          return diffAgainst(root, params.path, params.content);
        default:
          throw new InputError(
            `Unknown filesystem read op “${op}”. Supported: ${FILESYSTEM_READ_OPS.join(", ")}.`,
            400,
          );
      }
    },

    async write(op) {
      throw new InputError(
        `The filesystem connector is read-only; “${op}” is refused. Change files through a run so the edit carries policy, approval, and a run record.`,
        405,
      );
    },
  };
}

export default createFilesystemConnector;

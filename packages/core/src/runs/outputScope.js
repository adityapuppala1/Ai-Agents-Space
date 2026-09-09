import {
  mkdirSync,
  readdirSync,
  rmdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { git, isGitRepo, repoRoot, createWorktree } from "./worktree.js";

/**
 * Where a run is allowed to write, and how a pinned code range is identified.
 *
 * Two isolation shapes:
 *   - Git repository + isolation "worktree" → a real `git worktree` (worktree.js).
 *   - Non-Git folder + isolation "worktree" → a scoped output folder
 *     `<dataDir>/outputs/<runId>/`. Nothing is copied into it: the source
 *     documents stay where they are, the provider gets the folder as an extra
 *     writable directory, and the run event says the results must be copied
 *     back after review. Pretending a document folder is a worktree would be a
 *     lie, so we say exactly what it is.
 */

export const OUTPUT_SCOPE_NOTE =
  "Document work is scoped to this output folder; nothing was copied into it and nothing is copied back automatically. Review the results, then move what you want into the source folder.";

export function outputDirFor(dataDir, runId) {
  return resolve(join(dataDir, "outputs", runId));
}

/**
 * resolveRunScope({ cwd, isolation, dataDir, runId })
 *   → { mode, cwd, worktree, branch, outputDir, extraDirs, isRepo, repoRoot, note }
 *
 * `mode` is "worktree" | "output-folder" | "in-place".
 */
export async function resolveRunScope({
  cwd,
  isolation = "none",
  dataDir,
  runId,
} = {}) {
  const isRepo = await isGitRepo(cwd);
  const base = {
    mode: "in-place",
    cwd,
    worktree: null,
    branch: null,
    outputDir: null,
    extraDirs: [],
    isRepo,
    repoRoot: null,
    note: null,
  };
  if (isolation !== "worktree") return base;
  if (isRepo) {
    const root = await repoRoot(cwd);
    const created = await createWorktree(root, runId, dataDir);
    return {
      ...base,
      mode: "worktree",
      cwd: created.path,
      worktree: created.path,
      branch: created.branch,
      repoRoot: root,
      note: `Created isolated worktree on branch ${created.branch}`,
    };
  }
  const outputDir = outputDirFor(dataDir, runId);
  mkdirSync(outputDir, { recursive: true });
  return {
    ...base,
    mode: "output-folder",
    // The run still executes in the source folder so it can read the
    // documents; only the extra writable directory is the scoped output.
    cwd,
    outputDir,
    extraDirs: [outputDir],
    note: `${OUTPUT_SCOPE_NOTE} Output folder: ${outputDir}`,
  };
}

/**
 * Removes the scoped output folder when the run produced nothing. A folder
 * with files is always kept — deleting a run's only output would be data loss.
 * → { removed, kept, reason }
 */
export function releaseRunScope({ outputDir } = {}) {
  if (!outputDir || !existsSync(outputDir))
    return { removed: false, kept: false, reason: "no output folder" };
  let entries = [];
  try {
    entries = readdirSync(outputDir);
  } catch (error) {
    return { removed: false, kept: true, reason: error.message };
  }
  if (entries.length)
    return {
      removed: false,
      kept: true,
      reason: `${entries.length} file${entries.length === 1 ? "" : "s"} produced; kept for review`,
    };
  try {
    rmdirSync(outputDir);
    return {
      removed: true,
      kept: false,
      reason: "empty output folder removed",
    };
  } catch (error) {
    return { removed: false, kept: true, reason: error.message };
  }
}

function absolute(cwd, file) {
  return isAbsolute(file) ? resolve(file) : resolve(cwd ?? ".", file);
}

/**
 * pinRange({ cwd, file, start, end }) → { file, start, end, revision, pinnedAt }
 *
 * `revision` is `git:<blob sha>` inside a repository (the content hash of the
 * file as it is on disk, from `git hash-object`) and `mtime:<ms>:<size>`
 * otherwise. Both identify the exact bytes the range was read against.
 * Returns `revision: null` when the file does not exist — never a guess.
 */
export async function pinRange({ cwd, file, start = null, end = null } = {}) {
  if (!file) return null;
  const abs = absolute(cwd, String(file));
  const pin = {
    file: String(file),
    start,
    end,
    revision: null,
    pinnedAt: Date.now(),
  };
  if (!existsSync(abs)) {
    pin.revisionBasis = "file not found";
    return pin;
  }
  if (await isGitRepo(cwd)) {
    try {
      const out = await git(["hash-object", "--", abs], cwd, {
        timeoutMs: 15000,
      });
      const sha = out.trim().split(/\s+/)[0];
      if (/^[0-9a-f]{7,64}$/i.test(sha)) {
        pin.revision = `git:${sha}`;
        pin.revisionBasis =
          "git hash-object (content hash of the file on disk)";
        return pin;
      }
    } catch {
      /* fall through to the filesystem stamp */
    }
  }
  const stat = statSync(abs);
  pin.revision = `mtime:${Math.round(stat.mtimeMs)}:${stat.size}`;
  pin.revisionBasis = "modification time and size (no Git repository)";
  return pin;
}

/**
 * rangeIsStale(pin, { cwd }) → true when the file no longer matches the pinned
 * revision. An unpinned range is never called stale (we do not know).
 */
export async function rangeIsStale(pin, { cwd } = {}) {
  if (!pin?.file || !pin?.revision) return false;
  const current = await pinRange({
    cwd: cwd ?? pin.cwd,
    file: pin.file,
    start: pin.start ?? null,
    end: pin.end ?? null,
  });
  if (!current?.revision) return true; // the file went away
  return current.revision !== pin.revision;
}

import { execFile } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Git worktree helpers for sandboxed runs. Every call shells out to `git`
 * with a timeout and surfaces errors with the git message attached.
 */

export function git(args, cwd, { timeoutMs = 30000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || error.message || "").trim();
          const wrapped = new Error(
            `git ${args[0]} failed${message ? `: ${message}` : ""}`,
          );
          wrapped.code = error.code;
          wrapped.stdout = stdout;
          wrapped.stderr = stderr;
          return reject(wrapped);
        }
        resolvePromise(stdout);
      },
    );
  });
}

export async function isGitRepo(cwd) {
  if (!cwd || !existsSync(cwd)) return false;
  try {
    const out = await git(["rev-parse", "--is-inside-work-tree"], cwd, {
      timeoutMs: 10000,
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export async function repoRoot(cwd) {
  const out = await git(["rev-parse", "--show-toplevel"], cwd, {
    timeoutMs: 10000,
  });
  return resolve(out.trim());
}

export async function currentBranch(cwd) {
  try {
    const out = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd, {
      timeoutMs: 10000,
    });
    const branch = out.trim();
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

export function worktreeDir(dataDir, runId) {
  return resolve(join(dataDir, "worktrees", runId));
}

export function worktreeBranch(runId) {
  return `agent-space/${runId}`;
}

/**
 * Creates `<dataDir>/worktrees/<runId>` on a new branch `agent-space/<runId>`
 * from HEAD of the repository at `root`.
 */
export async function createWorktree(root, runId, dataDir) {
  const path = worktreeDir(dataDir, runId);
  const branch = worktreeBranch(runId);
  mkdirSync(resolve(join(dataDir, "worktrees")), { recursive: true });
  await git(["worktree", "add", "-b", branch, path, "HEAD"], root, {
    timeoutMs: 60000,
  });
  return { path, branch };
}

export async function removeWorktree(root, path) {
  await git(["worktree", "remove", "--force", path], root, {
    timeoutMs: 60000,
  });
  try {
    await git(["worktree", "prune"], root, { timeoutMs: 30000 });
  } catch {
    /* best effort */
  }
  return true;
}

export async function listWorktrees(root) {
  const out = await git(["worktree", "list", "--porcelain"], root, {
    timeoutMs: 30000,
  });
  const entries = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: resolve(line.slice(9).trim()), branch: null };
      entries.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice(7)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") current.branch = null;
  }
  return entries;
}

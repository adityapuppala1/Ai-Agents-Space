/**
 * Git connector — read-only Git facts about a workspace folder root.
 *
 * Honesty rules that shape this module:
 *  - Every command runs through `runCommand` with an ARGUMENT ARRAY and a
 *    timeout. A shell string is built only when the resolved binary is a
 *    Windows `.cmd`/`.bat` shim, and then every argument is quoted and any
 *    argument cmd.exe could still reinterpret is refused outright.
 *  - Arguments that could be read as options (a leading "-") or as shell
 *    syntax (`&`, `|`, `>`, `%`, …) are refused, and
 *    every path argument is scoped to the workspace root by the filesystem
 *    connector's `resolveScoped`.
 *  - Writes are refused: Agent Space never commits, pushes, or checks out on a
 *    person's behalf from a connector call.
 *  - When `git` is missing the connector reports { available: false, reason }
 *    instead of failing silently or pretending the repository is clean.
 */
import { InputError } from "../TaskStore.js";
import {
  defaultWhich,
  needsShell,
  parseVersion,
  runCommand,
} from "../providers/detect.js";
import { resolveScoped, workspaceRoot } from "./filesystem.js";

export const GIT_READ_OPS = Object.freeze([
  "status",
  "branch",
  "log",
  "diff",
  "blame",
  "worktrees",
  "remotes",
]);

/** Default timeout for one git invocation. */
export const GIT_TIMEOUT_MS = 15_000;
/** How long a successful `git --version` probe is reused. */
export const GIT_PROBE_TTL_MS = 60_000;

const MAX_LOG = 200;

/** Field separator inside git --format strings (unit separator, U+001F). */
const SEP = String.fromCharCode(31);

/** Refuses an argument git would read as an option. */
export function safeArgument(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new InputError(`${label} is required`);
  if (text.startsWith("-"))
    throw new InputError(
      `${label} may not start with "-" (that would be read as a git option)`,
      400,
    );
  if (/[\r\n\0]/.test(text))
    throw new InputError(`${label} may not contain line breaks`, 400);
  // On win32 a git/gh binary can resolve to a .cmd/.bat shim, which
  // `runCommand` has to run through cmd.exe. Shell metacharacters are refused
  // here so no connector argument can ever become command syntax, whichever
  // way the binary is spawned.
  if (/[&|<>^%"`$;!]/.test(text))
    throw new InputError(
      `${label} may not contain shell characters (& | < > ^ % " \` $ ; !)`,
      400,
    );
  return text;
}

function limitOf(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function parseLog(stdout) {
  const commits = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [hash, authorName, authorEmail, isoDate, ...rest] = line.split(SEP);
    commits.push({
      hash,
      shortHash: hash?.slice(0, 8) ?? null,
      author: authorName ?? null,
      authorEmail: authorEmail ?? null,
      date: isoDate ?? null,
      subject: rest.join(SEP),
    });
  }
  return commits;
}

function parsePorcelain(stdout) {
  const files = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const index = line[0];
    const worktree = line[1];
    const rest = line.slice(3);
    const [path, renamedTo] = rest.split(" -> ");
    files.push({
      path: renamedTo ?? path,
      renamedFrom: renamedTo ? path : null,
      index: index === " " ? null : index,
      worktree: worktree === " " ? null : worktree,
      staged: index !== " " && index !== "?",
      untracked: index === "?" && worktree === "?",
    });
  }
  return files;
}

function parseWorktrees(stdout) {
  const list = [];
  let current = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.path) list.push(current);
      current = {};
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current.path = value;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch")
      current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
  }
  if (current.path) list.push(current);
  return list;
}

function parseBlame(stdout) {
  const lines = [];
  let entry = null;
  for (const raw of String(stdout).split(/\r?\n/)) {
    const header = raw.match(/^([0-9a-f]{7,40}) (\d+) (\d+)(?: (\d+))?$/);
    if (header) {
      entry = {
        hash: header[1],
        line: Number(header[3]),
        author: null,
        date: null,
        text: null,
      };
      continue;
    }
    if (!entry) continue;
    if (raw.startsWith("author ")) entry.author = raw.slice(7);
    else if (raw.startsWith("author-time "))
      entry.date = new Date(Number(raw.slice(12)) * 1000).toISOString();
    else if (raw.startsWith("\t")) {
      entry.text = raw.slice(1);
      lines.push(entry);
      entry = null;
    }
  }
  return lines;
}

/**
 * Creates the Git connector.
 * options: { env, which, timeoutMs, now } — tests inject `which`/`env`.
 */
export function createGitConnector(
  services,
  {
    env = process.env,
    which = defaultWhich,
    timeoutMs = GIT_TIMEOUT_MS,
    now = Date.now,
  } = {},
) {
  let probe = null;

  async function resolveBinary() {
    if (probe && now() - probe.at < GIT_PROBE_TTL_MS) return probe;
    let binaryPath = null;
    let error = null;
    try {
      binaryPath =
        env.AGENT_SPACE_BIN_GIT || (await which("git", { env, timeoutMs }));
    } catch (caught) {
      error = caught.message;
    }
    if (!binaryPath) {
      probe = {
        at: now(),
        binaryPath: null,
        version: null,
        available: false,
        reason: error ?? "git is not on PATH",
      };
      return probe;
    }
    const result = await runCommand(binaryPath, ["--version"], {
      env,
      timeoutMs,
      shell: needsShell(binaryPath),
    });
    const ok = !result.error && !result.timedOut && result.code === 0;
    probe = {
      at: now(),
      binaryPath,
      version: ok ? parseVersion(result.stdout) : null,
      available: ok,
      reason: ok
        ? null
        : `git was found at ${binaryPath} but did not answer --version (${result.error ?? `exit code ${result.code}`})`,
    };
    return probe;
  }

  async function git(args, cwd) {
    const found = await resolveBinary();
    if (!found.available)
      throw new InputError(
        `Git is not usable on this machine: ${found.reason}. Install Git and make sure “git” is on PATH.`,
        503,
      );
    const result = await runCommand(found.binaryPath, args, {
      env,
      cwd,
      timeoutMs,
      shell: needsShell(found.binaryPath),
    });
    if (result.timedOut)
      throw new InputError(
        `git ${args[0]} timed out after ${timeoutMs} ms`,
        504,
      );
    if (result.error)
      throw new InputError(`git ${args[0]} failed: ${result.error}`, 500);
    if (result.code !== 0)
      throw new InputError(
        `git ${args[0]} exited with code ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
        400,
      );
    return result;
  }

  async function cwdFor(params) {
    const root = workspaceRoot(services, params.workspaceId);
    return params.path ? resolveScoped(root, params.path) : root;
  }

  return {
    id: "git",
    name: "Git",
    kind: "vcs",

    async detect() {
      const found = await resolveBinary();
      return {
        available: found.available,
        reason: found.reason,
        version: found.version,
        binaryPath: found.binaryPath,
      };
    },

    async capabilities() {
      const found = await resolveBinary();
      return {
        id: "git",
        available: found.available,
        reason: found.reason,
        version: found.version,
        status: found.available ? "verified" : "unavailable",
        reads: GIT_READ_OPS,
        writes: [],
        notes: [
          "Every git call uses an argument array and a timeout; no shell string is built.",
          "Writes (commit, push, checkout) are refused: they belong to a run with policy and approvals.",
          "All paths are scoped to the workspace folder root.",
        ],
      };
    },

    async read(op, params = {}) {
      const cwd = await cwdFor(params);
      switch (op) {
        case "status": {
          const result = await git(
            ["status", "--porcelain=v1", "--branch"],
            cwd,
          );
          const lines = result.stdout.split(/\r?\n/);
          const header = lines.find((line) => line.startsWith("##")) ?? "";
          const branch = header.replace(/^##\s*/, "").split("...")[0] || null;
          const files = parsePorcelain(
            lines.filter((line) => !line.startsWith("##")).join("\n"),
          );
          return { cwd, branch, files, clean: files.length === 0 };
        }
        case "branch": {
          const current = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
          const all = await git(
            [
              "for-each-ref",
              `--format=%(refname:short)${SEP}%(objectname)`,
              "refs/heads",
            ],
            cwd,
          );
          return {
            cwd,
            current: current.stdout.trim(),
            branches: all.stdout
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => {
                const [name, hash] = line.split(SEP);
                return { name, hash };
              }),
          };
        }
        case "log": {
          const limit = limitOf(params.limit, 20, MAX_LOG);
          const args = [
            "log",
            `--max-count=${limit}`,
            `--format=%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s`,
          ];
          if (params.ref) args.push(safeArgument(params.ref, "ref"));
          const result = await git(args, cwd);
          return { cwd, limit, commits: parseLog(result.stdout) };
        }
        case "diff": {
          const args = ["diff"];
          if (params.staged) args.push("--staged");
          if (params.stat) args.push("--stat");
          if (params.ref) args.push(safeArgument(params.ref, "ref"));
          if (params.file) {
            args.push("--", safeArgument(params.file, "file"));
          }
          const result = await git(args, cwd);
          const diff = result.stdout;
          const cap = 200_000;
          return {
            cwd,
            staged: Boolean(params.staged),
            truncated: diff.length > cap,
            diff: diff.slice(0, cap),
          };
        }
        case "blame": {
          const file = safeArgument(params.file, "file");
          const args = ["blame", "--porcelain"];
          if (params.startLine && params.endLine)
            args.push(
              "-L",
              `${Number(params.startLine)},${Number(params.endLine)}`,
            );
          args.push("--", file);
          const result = await git(args, cwd);
          return { cwd, file, lines: parseBlame(result.stdout) };
        }
        case "worktrees": {
          const result = await git(["worktree", "list", "--porcelain"], cwd);
          return { cwd, worktrees: parseWorktrees(result.stdout) };
        }
        case "remotes": {
          const result = await git(["remote", "-v"], cwd);
          const remotes = new Map();
          for (const line of result.stdout.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const [name, url] = line.split(/\s+/);
            if (!remotes.has(name)) remotes.set(name, { name, url });
          }
          return { cwd, remotes: [...remotes.values()] };
        }
        default:
          throw new InputError(
            `Unknown git read op “${op}”. Supported: ${GIT_READ_OPS.join(", ")}.`,
            400,
          );
      }
    },

    async write(op) {
      throw new InputError(
        `The Git connector is read-only; “${op}” is refused. Commits, pushes, and checkouts happen inside a run, where policy and approvals apply.`,
        405,
      );
    },
  };
}

export default createGitConnector;

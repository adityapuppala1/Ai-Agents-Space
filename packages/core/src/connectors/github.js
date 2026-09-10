/**
 * GitHub connector — read-only through the GitHub CLI (`gh`).
 *
 * Honesty rules that shape this module:
 *  - The only path to GitHub is the vendor's own CLI, run with an argument
 *    array and a timeout. No HTTP client, no token handling: `gh` keeps the
 *    credential and Agent Space never reads, stores, or logs it. `gh auth
 *    status` is asked only whether it exits 0.
 *  - When `gh` is missing or not logged in the connector reports
 *    { available: false, reason } and every read refuses with that reason —
 *    it never returns an empty list that would read as "no issues".
 *  - Reads only, by default. The single write (`createDraftPr`) needs BOTH an
 *    approved approval AND a workspace policy that does not deny `git push`;
 *    a draft PR is still a push.
 *  - Tests point AGENT_SPACE_BIN_GH at a stub; the real GitHub API is never
 *    called from tests.
 */
import { InputError } from "../TaskStore.js";
import {
  defaultWhich,
  needsShell,
  parseCommandLine,
  parseVersion,
  runCommand,
} from "../providers/detect.js";
import { workspaceRoot } from "./filesystem.js";
import { safeArgument } from "./git.js";

export const GITHUB_READ_OPS = Object.freeze([
  "repo",
  "issues",
  "prs",
  "checks",
  "checkRuns",
]);
export const GITHUB_WRITE_OPS = Object.freeze(["createDraftPr"]);

/**
 * `gh api` takes its first argument as an endpoint PATH, so anything
 * interpolated into one has to be shaped like the segment it replaces.
 * `safeArgument` alone is not enough: it allows "/" and "..", which would let
 * a caller steer the request to a different endpoint on the authenticated
 * account.
 */
function apiRepo(value) {
  const text = safeArgument(value, "repo");
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(text) || text.includes(".."))
    throw new InputError(
      'repo must be "owner/name" using letters, digits, ".", "_" and "-"',
      400,
    );
  return text;
}

function apiPathSegment(value, label) {
  const text = safeArgument(value, label);
  if (!/^[A-Za-z0-9._/-]+$/.test(text) || /(^|\/)\.\.(\/|$)/.test(text))
    throw new InputError(
      `${label} may only contain letters, digits, ".", "_", "-" and "/", and no ".." segment`,
      400,
    );
  return text;
}

/** Fields asked of `gh` so the shape is stable across versions. */
export const ISSUE_FIELDS =
  "number,title,state,url,updatedAt,author,labels,assignees";
export const PR_FIELDS =
  "number,title,state,url,updatedAt,author,isDraft,headRefName,baseRefName";

export const GH_TIMEOUT_MS = 20_000;
export const GH_PROBE_TTL_MS = 60_000;

function parseJsonOutput(stdout, what) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InputError(
      `The GitHub CLI did not return JSON for ${what}: ${error.message}`,
      502,
    );
  }
}

/**
 * Creates the GitHub connector.
 * options: { env, which, timeoutMs, now } — tests inject `env.AGENT_SPACE_BIN_GH`.
 */
export function createGithubConnector(
  services,
  {
    env = process.env,
    which = defaultWhich,
    timeoutMs = GH_TIMEOUT_MS,
    now = Date.now,
  } = {},
) {
  let probe = null;

  function overrideCommand() {
    const raw = env.AGENT_SPACE_BIN_GH;
    if (!raw) return null;
    const parts = parseCommandLine(raw);
    if (!parts.length) return null;
    return { command: parts[0], prefix: parts.slice(1) };
  }

  async function resolveBinary() {
    if (probe && now() - probe.at < GH_PROBE_TTL_MS) return probe;
    const override = overrideCommand();
    let command = override?.command ?? null;
    let prefix = override?.prefix ?? [];
    let error = null;
    if (!command) {
      try {
        command = await which("gh", { env, timeoutMs });
      } catch (caught) {
        error = caught.message;
      }
    }
    if (!command) {
      probe = {
        at: now(),
        command: null,
        prefix: [],
        version: null,
        authenticated: false,
        available: false,
        reason:
          error ??
          "the GitHub CLI (gh) is not on PATH — install it and run `gh auth login`",
      };
      return probe;
    }
    const shell = needsShell(command);
    const version = await runCommand(command, [...prefix, "--version"], {
      env,
      timeoutMs,
      shell,
    });
    if (version.error || version.timedOut || version.code !== 0) {
      probe = {
        at: now(),
        command,
        prefix,
        version: null,
        authenticated: false,
        available: false,
        reason: `gh was found at ${command} but did not answer --version (${version.error ?? `exit code ${version.code}`})`,
      };
      return probe;
    }
    const auth = await runCommand(command, [...prefix, "auth", "status"], {
      env,
      timeoutMs,
      shell,
    });
    const authenticated = !auth.error && !auth.timedOut && auth.code === 0;
    probe = {
      at: now(),
      command,
      prefix,
      version: parseVersion(version.stdout),
      authenticated,
      available: authenticated,
      // The token itself is never read; only the exit status is used.
      reason: authenticated
        ? null
        : "the GitHub CLI is installed but no account is logged in — run `gh auth login`",
    };
    return probe;
  }

  async function gh(args, cwd) {
    const found = await resolveBinary();
    if (!found.available)
      throw new InputError(`GitHub is not available: ${found.reason}.`, 503);
    const result = await runCommand(found.command, [...found.prefix, ...args], {
      env,
      cwd,
      timeoutMs,
      shell: needsShell(found.command),
    });
    if (result.timedOut)
      throw new InputError(
        `gh ${args[0]} timed out after ${timeoutMs} ms`,
        504,
      );
    if (result.error)
      throw new InputError(`gh ${args[0]} failed: ${result.error}`, 502);
    if (result.code !== 0)
      throw new InputError(
        `gh ${args.slice(0, 2).join(" ")} exited with code ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
        400,
      );
    return result;
  }

  function limitOf(value, fallback = 20) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), 100);
  }

  return {
    id: "github",
    name: "GitHub",
    kind: "hosting",

    async detect() {
      const found = await resolveBinary();
      return {
        available: found.available,
        reason: found.reason,
        version: found.version,
        authenticated: found.authenticated,
        binaryPath: found.command,
      };
    },

    async capabilities() {
      const found = await resolveBinary();
      return {
        id: "github",
        available: found.available,
        reason: found.reason,
        version: found.version,
        authenticated: found.authenticated,
        status: found.available ? "verified" : "unavailable",
        reads: GITHUB_READ_OPS,
        writes: GITHUB_WRITE_OPS,
        writeRequires: {
          createDraftPr: [
            "an approved approval bound to this exact request",
            "a workspace policy that does not deny `git push`",
          ],
        },
        notes: [
          "Everything goes through the `gh` CLI; Agent Space never holds a GitHub token.",
          "Read-only by default. `createDraftPr` is the only write and is refused without an approval.",
          "GitLab and hosted CI providers are not implemented — see docs/ROADMAP_STATUS.md.",
        ],
      };
    },

    async read(op, params = {}) {
      const cwd = workspaceRoot(services, params.workspaceId);
      switch (op) {
        case "repo": {
          const result = await gh(
            ["repo", "view", "--json", "name,owner,defaultBranchRef,url"],
            cwd,
          );
          return { cwd, repo: parseJsonOutput(result.stdout, "repo view") };
        }
        case "issues": {
          const args = [
            "issue",
            "list",
            "--json",
            ISSUE_FIELDS,
            "--limit",
            String(limitOf(params.limit)),
          ];
          if (params.state)
            args.push("--state", safeArgument(params.state, "state"));
          const result = await gh(args, cwd);
          const issues = parseJsonOutput(result.stdout, "issue list") ?? [];
          return { cwd, count: issues.length, issues };
        }
        case "prs": {
          const args = [
            "pr",
            "list",
            "--json",
            PR_FIELDS,
            "--limit",
            String(limitOf(params.limit)),
          ];
          if (params.state)
            args.push("--state", safeArgument(params.state, "state"));
          const result = await gh(args, cwd);
          const pullRequests = parseJsonOutput(result.stdout, "pr list") ?? [];
          return { cwd, count: pullRequests.length, pullRequests };
        }
        case "checks": {
          const args = ["pr", "checks", "--json", "name,state,link,workflow"];
          if (params.ref) args.push(safeArgument(params.ref, "ref"));
          const result = await gh(args, cwd);
          const checks = parseJsonOutput(result.stdout, "pr checks") ?? [];
          return { cwd, count: checks.length, checks };
        }
        case "checkRuns": {
          // Both values are interpolated into a gh api endpoint path, so they
          // are constrained to the shapes GitHub actually uses. Without this
          // the caller — not the connector — would choose which endpoint the
          // operator's stored credential queries.
          const ref = apiPathSegment(params.ref ?? "HEAD", "ref");
          const repo = params.repo ? apiRepo(params.repo) : "{owner}/{repo}";
          const result = await gh(
            ["api", `repos/${repo}/commits/${ref}/check-runs`],
            cwd,
          );
          const payload = parseJsonOutput(result.stdout, "check-runs") ?? {};
          return {
            cwd,
            ref,
            total: payload.total_count ?? payload.check_runs?.length ?? 0,
            checkRuns: (payload.check_runs ?? []).map((run) => ({
              name: run.name,
              status: run.status,
              conclusion: run.conclusion,
              startedAt: run.started_at,
              completedAt: run.completed_at,
              url: run.html_url,
            })),
          };
        }
        default:
          throw new InputError(
            `Unknown GitHub read op “${op}”. Supported: ${GITHUB_READ_OPS.join(", ")}.`,
            400,
          );
      }
    },

    /**
     * The only write. `approval` must be an APPROVED approval record whose
     * payload was bound to this request by the caller (the registry does the
     * binding); policy must also allow `git push`, because a draft PR pushes a
     * branch to the remote.
     */
    async write(op, params = {}, { approval = null } = {}) {
      if (op !== "createDraftPr")
        throw new InputError(
          `Unknown GitHub write op “${op}”. Supported: ${GITHUB_WRITE_OPS.join(", ")}.`,
          400,
        );
      if (!approval || approval.status !== "approved")
        throw new InputError(
          "Creating a draft pull request needs an approved approval; nothing was sent to GitHub.",
          403,
        );
      const cwd = workspaceRoot(services, params.workspaceId);
      const title = safeArgument(params.title, "title");
      const body = String(params.body ?? "").slice(0, 60_000);
      const args = [
        "pr",
        "create",
        "--draft",
        "--title",
        title,
        "--body",
        body,
      ];
      if (params.base) args.push("--base", safeArgument(params.base, "base"));
      if (params.head) args.push("--head", safeArgument(params.head, "head"));
      const result = await gh(args, cwd);
      const url = (result.stdout.match(/https:\/\/\S+/) ?? [null])[0];
      return {
        cwd,
        created: true,
        draft: true,
        url,
        approvalId: approval.id,
        output: result.stdout.trim().slice(0, 2000),
      };
    },
  };
}

export default createGithubConnector;

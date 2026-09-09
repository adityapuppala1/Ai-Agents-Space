/**
 * Data connectors — the read side of "local files/Git → GitHub" from the
 * roadmap. A connector is a source Agent Space can read context from; it is
 * NOT a provider (that is `connections`) and it never writes anything here.
 *
 * Honesty rules that shape this module:
 *  - Availability is measured, never assumed. `git`/`gh` are resolved on PATH
 *    and asked for their own `--version`; the filesystem connector reports the
 *    workspace roots that actually exist on disk.
 *  - A connector that cannot be used says so with a plain-language `detail`
 *    and a `fix`, instead of being hidden or reported as available.
 *  - Credentials are never read. For GitHub only the PRESENCE of a token
 *    variable or of the `gh` CLI's own auth state is checked, and no token
 *    value is stored, logged, or returned.
 *  - Nothing here is a capability grant: listing a connector does not enable a
 *    run to use it. Policy still decides that.
 */
import { statSync } from "node:fs";
import {
  defaultWhich,
  needsShell,
  parseVersion,
  runCommand,
} from "../providers/detect.js";
import { normalizePath } from "../util/paths.js";

/** Connectors in roadmap order: local files, Git, then GitHub. */
export const CONNECTOR_IDS = Object.freeze(["filesystem", "git", "github"]);

/** Availability values. `unknown` is used only when a probe could not run. */
export const AVAILABILITY = Object.freeze([
  "available",
  "unavailable",
  "unknown",
]);

/** How long a probe result is reused before the binaries are asked again. */
export const CONNECTOR_CACHE_TTL_MS = 60_000;

/** Environment variables whose presence (never value) hints at GitHub auth. */
export const GITHUB_TOKEN_ENV = Object.freeze([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_ACCESS_TOKEN",
]);

function directoryExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Workspace folder roots that exist on disk, with the ones that do not. */
export function workspaceRoots(services) {
  const rows = (() => {
    try {
      return services?.hub?.list?.() ?? [];
    } catch {
      return [];
    }
  })();
  const roots = [];
  for (const workspace of rows) {
    const root = workspace?.rootPath;
    if (!root) continue;
    roots.push({
      workspaceId: workspace.id,
      path: normalizePath(root),
      exists: directoryExists(root),
    });
  }
  return roots;
}

async function probeBinary(name, { env, timeoutMs, which }) {
  let binaryPath = null;
  try {
    binaryPath = await which(name, { env, timeoutMs });
  } catch (error) {
    return {
      found: false,
      binaryPath: null,
      version: null,
      error: error.message,
    };
  }
  if (!binaryPath)
    return { found: false, binaryPath: null, version: null, error: null };
  const result = await runCommand(binaryPath, ["--version"], {
    env,
    timeoutMs,
    shell: needsShell(binaryPath),
  });
  if (result.timedOut || result.error)
    return {
      found: true,
      binaryPath,
      version: null,
      error: result.error ?? "timed out",
    };
  return {
    found: true,
    binaryPath,
    version: parseVersion(`${result.stdout}\n${result.stderr}`),
    error: result.code === 0 ? null : `exited with code ${result.code}`,
  };
}

async function probeFilesystem(services) {
  const roots = workspaceRoots(services);
  const usable = roots.filter((root) => root.exists);
  return {
    id: "filesystem",
    name: "Local files",
    kind: "files",
    reads: ["files", "folders"],
    writes: [],
    availability: usable.length ? "available" : "unavailable",
    version: null,
    binaryPath: null,
    detail: usable.length
      ? `${usable.length} workspace folder root(s) readable`
      : roots.length
        ? "every workspace folder root is missing on disk"
        : "no workspace has a folder root yet",
    fix: usable.length
      ? null
      : "Set a folder root on a workspace that exists on this machine.",
    scope: usable.map((root) => root.path),
    missingRoots: roots.filter((root) => !root.exists).map((root) => root.path),
  };
}

async function probeGit(options) {
  const probe = await probeBinary("git", options);
  const available = probe.found && !probe.error;
  return {
    id: "git",
    name: "Git",
    kind: "vcs",
    reads: ["diff", "status", "branch", "revision"],
    writes: [],
    availability:
      probe.found && probe.error
        ? "unknown"
        : available
          ? "available"
          : "unavailable",
    version: probe.version,
    binaryPath: probe.binaryPath,
    detail: available
      ? `git ${probe.version ?? "version not reported"} on PATH`
      : probe.found
        ? `git found but did not answer --version (${probe.error})`
        : "git is not on PATH",
    fix: available ? null : "Install Git and make sure `git` is on PATH.",
    scope: [],
  };
}

async function probeGitHub(options) {
  const probe = await probeBinary("gh", options);
  const env = options.env ?? process.env;
  const tokenEnv = GITHUB_TOKEN_ENV.filter(
    (name) => typeof env?.[name] === "string" && env[name].trim() !== "",
  );
  let authenticated = tokenEnv.length > 0;
  let authDetail = tokenEnv.length
    ? `credential in ${tokenEnv.join(", ")} (presence only; the value is never read)`
    : null;
  if (!authenticated && probe.found && !probe.error) {
    const status = await runCommand(probe.binaryPath, ["auth", "status"], {
      env,
      timeoutMs: options.timeoutMs,
      shell: needsShell(probe.binaryPath),
    });
    authenticated = status.code === 0;
    authDetail = authenticated
      ? "GitHub CLI reports a logged-in account"
      : null;
  }
  const available = probe.found && !probe.error && authenticated;
  return {
    id: "github",
    name: "GitHub",
    kind: "hosting",
    reads: ["issues", "pull requests", "checks"],
    writes: [],
    availability: available ? "available" : "unavailable",
    version: probe.version,
    binaryPath: probe.binaryPath,
    detail: available
      ? `gh ${probe.version ?? "version not reported"}; ${authDetail}`
      : !probe.found
        ? "the GitHub CLI (gh) is not on PATH and no GITHUB_TOKEN is set"
        : probe.error
          ? `gh found but did not answer --version (${probe.error})`
          : "gh is installed but no account is logged in",
    fix: available
      ? null
      : !probe.found
        ? "Install the GitHub CLI, or set GITHUB_TOKEN, to read issues, pull requests and checks."
        : "Run `gh auth login` to let Agent Space read issues, pull requests and checks.",
    scope: [],
  };
}

/**
 * Connector registry. `list()` probes at most once per
 * CONNECTOR_CACHE_TTL_MS; `refresh()` always re-probes.
 */
export class Connectors {
  constructor(
    services,
    {
      env = process.env,
      which = defaultWhich,
      timeoutMs = 5000,
      now = Date.now,
    } = {},
  ) {
    this.services = services;
    this.options = { env, which, timeoutMs };
    this.now = now;
    this._cache = null;
    this._inFlight = null;
  }

  async refresh() {
    const options = this.options;
    const [filesystem, git, github] = await Promise.all([
      probeFilesystem(this.services),
      probeGit(options),
      probeGitHub(options),
    ]);
    const checkedAt = this.now();
    const list = [filesystem, git, github].map((connector) => ({
      ...connector,
      checkedAt,
    }));
    this._cache = { at: checkedAt, list };
    return list;
  }

  async list({ refresh = false } = {}) {
    if (
      !refresh &&
      this._cache &&
      this.now() - this._cache.at < CONNECTOR_CACHE_TTL_MS
    )
      return this._cache.list;
    if (!this._inFlight)
      this._inFlight = this.refresh().finally(() => {
        this._inFlight = null;
      });
    return this._inFlight;
  }

  async get(id) {
    const list = await this.list();
    return list.find((connector) => connector.id === id) ?? null;
  }
}

/** Optional-module factory: attaches `services.connectors`. */
export function createConnectors(services, options = {}) {
  const connectors = new Connectors(services, options);
  services.connectors = connectors;
  return connectors;
}

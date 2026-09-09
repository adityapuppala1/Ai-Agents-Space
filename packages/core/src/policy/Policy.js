import { resolve as resolvePath, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { InputError } from "../TaskStore.js";
import {
  AUTONOMY_PRESETS,
  DEFAULT_POLICY,
  isSecretPath,
} from "../contracts.js";

/* ---------- private path helpers (util/paths.js may not exist yet) ---------- */

const WIN = process.platform === "win32";

export function expandHome(p) {
  const text = String(p ?? "");
  if (text === "~" || text.startsWith("~/") || text.startsWith("~\\"))
    return homedir() + text.slice(1);
  return text;
}

/** Absolute, forward-slash, trailing-slash-free; lower-cased on win32. */
export function normalizePath(p, base) {
  if (p === null || p === undefined || p === "") return "";
  let text = expandHome(String(p).trim());
  if (!isAbsolute(text) && base) text = resolvePath(base, text);
  else text = resolvePath(text);
  text = text.replace(/\\/g, "/").replace(/\/+$/, "");
  return WIN ? text.toLowerCase() : text;
}

export function samePath(a, b) {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return !!na && na === nb;
}

export function isWithin(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}

/* ---------- rule catalogue (ids are stable; text is for humans) ---------- */

export const RISKY_COMMAND_PATTERNS = [
  {
    id: "rm-rf",
    category: "shell.risky",
    re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\b|\brm\s+-r\b.*\s-f\b/i,
    label: "recursive force delete (rm -rf)",
  },
  {
    id: "rmdir-s",
    category: "shell.risky",
    re: /\brmdir\s+.*\/s\b/i,
    label: "recursive directory removal (rmdir /s)",
  },
  {
    id: "del-f",
    category: "shell.risky",
    re: /\bdel\s+.*\/[fq]\b/i,
    label: "forced delete (del /f)",
  },
  {
    id: "remove-item-recurse",
    category: "shell.risky",
    re: /\bRemove-Item\b[^|\n]*-Recurse\b/i,
    label: "recursive Remove-Item",
  },
  {
    id: "git-push",
    category: "git.push",
    re: /\bgit\s+push\b/i,
    label: "git push",
  },
  {
    id: "git-reset-hard",
    category: "shell.risky",
    re: /\bgit\s+reset\s+--hard\b/i,
    label: "git reset --hard",
  },
  {
    id: "git-clean",
    category: "shell.risky",
    re: /\bgit\s+clean\b/i,
    label: "git clean",
  },
  {
    id: "git-force",
    category: "git.push",
    re: /\bgit\s+push\b.*(--force|-f\b)/i,
    label: "force push",
  },
  {
    id: "curl-sh",
    category: "shell.risky",
    re: /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i,
    label: "piping curl into a shell",
  },
  {
    id: "wget-sh",
    category: "shell.risky",
    re: /\bwget\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i,
    label: "piping wget into a shell",
  },
  {
    id: "iex-download",
    category: "shell.risky",
    re: /\b(iex|Invoke-Expression)\b.*\b(DownloadString|Invoke-WebRequest|iwr)\b|\b(DownloadString|Invoke-WebRequest|iwr)\b.*\|\s*(iex|Invoke-Expression)\b/i,
    label: "downloading and executing a script",
  },
  {
    id: "sudo",
    category: "shell.risky",
    re: /(^|[;&|]\s*)sudo\b/i,
    label: "sudo",
  },
  {
    id: "chmod-777",
    category: "shell.risky",
    re: /\bchmod\s+(-[a-z]+\s+)*[0-7]*777\b/i,
    label: "chmod 777",
  },
  {
    id: "format",
    category: "shell.risky",
    re: /(^|[;&|]\s*)format(\.com)?\s+[a-z]:/i,
    label: "formatting a drive",
  },
  {
    id: "mkfs",
    category: "shell.risky",
    re: /\bmkfs(\.[a-z0-9]+)?\b/i,
    label: "mkfs",
  },
  {
    id: "drop-table",
    category: "shell.risky",
    re: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    label: "DROP TABLE/DATABASE",
  },
  {
    id: "truncate",
    category: "shell.risky",
    re: /\bTRUNCATE\s+(TABLE\s+)?\w+/i,
    label: "TRUNCATE",
  },
  {
    id: "npm-publish",
    category: "deploy",
    re: /\b(npm|pnpm|yarn)\s+publish\b/i,
    label: "npm publish",
  },
  {
    id: "docker-push",
    category: "deploy",
    re: /\bdocker\s+(image\s+)?push\b/i,
    label: "docker push",
  },
  {
    id: "kubectl",
    category: "deploy",
    re: /\bkubectl\s+(apply|delete|rollout|scale|patch|replace|drain|cordon|exec)\b/i,
    label: "kubectl mutation",
  },
  {
    id: "terraform-apply",
    category: "deploy",
    re: /\bterraform\s+(apply|destroy)\b/i,
    label: "terraform apply/destroy",
  },
  {
    id: "deploy-verb",
    category: "deploy",
    re: /\b(vercel|netlify|firebase|gcloud|aws|az|heroku|fly|flyctl|wrangler|serverless|sls|cdk|pulumi)\s+(deploy|publish|release|push|up)\b/i,
    label: "deploy command",
  },
  {
    id: "ssh",
    category: "shell.risky",
    re: /(^|[;&|]\s*)ssh\b/i,
    label: "ssh",
  },
  {
    id: "scp",
    category: "shell.risky",
    re: /(^|[;&|]\s*)(scp|rsync)\b/i,
    label: "remote copy (scp/rsync)",
  },
  {
    id: "env-dump",
    category: "shell.risky",
    re: /(^|[;&|]\s*)(printenv|set|env)\s*$|\b(cat|type|Get-Content)\s+[^\s]*\.env\b/i,
    label: "dumping environment or .env",
  },
  {
    id: "indirect-exec",
    category: "shell.risky",
    re: /\$\(|`|\beval\b|\b(ba|z|da|k)?sh\s+-c\b|\bxargs\b|\b(iex|Invoke-Expression)\b|\bcmd(\.exe)?\s+\/[ck]\b|\bpowershell(\.exe)?\s+-(c|command|e|enc|encodedcommand)\b/i,
    label: "indirect command execution (eval, sh -c, $(...), xargs)",
  },
];

/**
 * Longest command the regex heuristics inspect. Some patterns are quadratic
 * on adversarial input (hook bodies may be 256 KB); anything longer is
 * flagged as risky instead of being scanned.
 */
export const MAX_INSPECT_CHARS = 8192;
const TOO_LONG = {
  id: "too-long",
  category: "shell.risky",
  label: `command too long to inspect (over ${MAX_INSPECT_CHARS} characters)`,
};

const WRITE_TOOL =
  /^(edit|write|multiedit|notebookedit|create|apply_patch|str_replace|edit_file|write_file|file_change|save)$/i;
const NETWORK_TOOL =
  /^(webfetch|websearch|web_fetch|web_search|fetch|curl|wget|http)$/i;
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "LS", "TodoWrite", "Task"];

function normalizeCommand(command) {
  return String(command ?? "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Shell quoting that changes nothing about what runs (`gi''t push`,
 * `rm -r"f"`, `s""h`) is removed before matching so it cannot hide a
 * command from the denied list or the heuristics. Best effort by design.
 */
export function dequoteCommand(text) {
  return String(text ?? "")
    .replace(/["']/g, "")
    .replace(/\\(?=[^\s])/g, "");
}

/** Escape a denied-list entry for use inside a RegExp. */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchDenied(command, deniedCommands) {
  const normalized = dequoteCommand(
    normalizeCommand(command).slice(0, MAX_INSPECT_CHARS),
  );
  for (const entry of deniedCommands ?? []) {
    const needle = normalizeCommand(entry);
    if (!needle) continue;
    const bare = dequoteCommand(needle);
    const re = new RegExp(
      `(^|[\\s;&|(])${escapeRe(bare).replace(/ /g, "\\s+")}(?=$|[\\s;&|)])`,
      "i",
    );
    if (re.test(normalized)) return entry;
    // Entries that end with a drive or directory (Remove-Item ... C:) match as prefixes.
    if (
      /[\\:]$/.test(needle) &&
      normalized.toLowerCase().includes(bare.toLowerCase())
    )
      return entry;
  }
  return null;
}

export function findRisky(command) {
  const normalized = normalizeCommand(command);
  if (!normalized) return null;
  if (normalized.length > MAX_INSPECT_CHARS) return TOO_LONG;
  const text = dequoteCommand(normalized);
  return RISKY_COMMAND_PATTERNS.find((p) => p.re.test(text)) ?? null;
}

/* ---------- validation ---------- */

function stringList(value, field, max = 200) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max)
    throw new InputError(`${field} must be an array of up to ${max} strings`);
  return value
    .map((item) => {
      if (typeof item !== "string" || item.length > 500)
        throw new InputError(
          `${field} entries must be strings under 500 characters`,
        );
      return item.trim();
    })
    .filter(Boolean);
}

export function validatePolicy(input, { partial = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("Policy must be an object");
  const out = {};
  if (input.autonomy !== undefined || !partial) {
    if (!AUTONOMY_PRESETS[input.autonomy])
      throw new InputError(
        `autonomy must be one of ${Object.keys(AUTONOMY_PRESETS).join(", ")}`,
      );
    out.autonomy = input.autonomy;
  }
  if (input.maxConcurrentRuns !== undefined) {
    const n = input.maxConcurrentRuns;
    if (!Number.isInteger(n) || n < 1 || n > 10)
      throw new InputError("maxConcurrentRuns must be an integer from 1 to 10");
    out.maxConcurrentRuns = n;
  }
  const allowedFolders = stringList(
    input.allowedFolders,
    "allowedFolders",
    100,
  );
  if (allowedFolders !== undefined) out.allowedFolders = allowedFolders;
  const deniedCommands = stringList(
    input.deniedCommands,
    "deniedCommands",
    200,
  );
  if (deniedCommands !== undefined) out.deniedCommands = deniedCommands;
  const requireApprovalFor = stringList(
    input.requireApprovalFor,
    "requireApprovalFor",
    20,
  );
  if (requireApprovalFor !== undefined)
    out.requireApprovalFor = requireApprovalFor;
  if (input.timeoutMs !== undefined) {
    const t = input.timeoutMs;
    if (!Number.isInteger(t) || t < 60000 || t > 7200000)
      throw new InputError("timeoutMs must be between 60000 and 7200000");
    out.timeoutMs = t;
  }
  if (input.allowedNetwork !== undefined) {
    if (typeof input.allowedNetwork !== "boolean")
      throw new InputError("allowedNetwork must be true or false");
    out.allowedNetwork = input.allowedNetwork;
  }
  if (input.autoDispatch !== undefined) {
    if (typeof input.autoDispatch !== "boolean")
      throw new InputError("autoDispatch must be true or false");
    out.autoDispatch = input.autoDispatch;
  }
  if (input.budget !== undefined) {
    const b = input.budget;
    if (!b || typeof b !== "object" || Array.isArray(b))
      throw new InputError("budget must be an object");
    const budget = {};
    for (const key of ["maxTokensPerRun", "maxRunsPerDay"]) {
      if (b[key] === undefined) continue;
      if (b[key] !== null && (!Number.isInteger(b[key]) || b[key] < 1))
        throw new InputError(
          `budget.${key} must be null or a positive integer`,
        );
      budget[key] = b[key];
    }
    out.budget = { ...DEFAULT_POLICY.budget, ...budget };
  }
  return out;
}

export function mergePolicy(base, override) {
  const merged = {
    ...DEFAULT_POLICY,
    ...(base ?? {}),
    ...(override ?? {}),
  };
  merged.budget = {
    ...DEFAULT_POLICY.budget,
    ...(base?.budget ?? {}),
    ...(override?.budget ?? {}),
  };
  merged.allowedFolders = [...(merged.allowedFolders ?? [])];
  merged.deniedCommands = [...(merged.deniedCommands ?? [])];
  merged.requireApprovalFor = [...(merged.requireApprovalFor ?? [])];
  if (!AUTONOMY_PRESETS[merged.autonomy])
    merged.autonomy = DEFAULT_POLICY.autonomy;
  return merged;
}

/* ---------- engine ---------- */

/**
 * Workspace policy engine. Decisions are computed server-side from the
 * merged workspace policy (DEFAULT_POLICY + workspaces.policy) and, when a
 * run is given, that run's effective autonomy (config_snapshot.autonomy).
 *
 * evaluate() → { decision: 'allow'|'deny'|'ask', reason, rule, category, autonomy }
 */
export class Policy {
  constructor(services, { now = Date.now } = {}) {
    this.services = services;
    this.db = services.db;
    this.hub = services.hub;
    this.now = now;
  }

  presets() {
    return Object.entries(AUTONOMY_PRESETS).map(([id, preset]) => ({
      id,
      ...preset,
    }));
  }

  #workspaceRow(workspaceId) {
    const row = this.db
      .prepare(
        "SELECT id, root_path, policy, kind FROM workspaces WHERE id = ?",
      )
      .get(workspaceId);
    if (!row) throw new InputError("Workspace not found", 404);
    let policy = {};
    try {
      policy = row.policy ? JSON.parse(row.policy) : {};
    } catch {
      policy = {};
    }
    return {
      id: row.id,
      rootPath: row.root_path ?? null,
      kind: row.kind,
      policy,
    };
  }

  forWorkspace(workspaceId) {
    const row = this.#workspaceRow(workspaceId);
    return mergePolicy({}, row.policy);
  }

  setForWorkspace(workspaceId, input, { actor = "local-user" } = {}) {
    const row = this.#workspaceRow(workspaceId);
    const fields = validatePolicy(input, { partial: true });
    if (!Object.keys(fields).length)
      throw new InputError("Provide at least one policy field");
    const next = mergePolicy(row.policy, fields);
    this.db
      .prepare("UPDATE workspaces SET policy = ? WHERE id = ?")
      .run(JSON.stringify(next), workspaceId);
    this.services.audit?.record({
      actor,
      action: "policy.update",
      target: `workspace:${workspaceId}`,
      workspaceId,
      details: { changed: Object.keys(fields), policy: next },
    });
    try {
      this.hub.get(workspaceId).changed("Workspace policy updated", "system");
    } catch {
      /* runtime unavailable */
    }
    this.services.bus?.emit("global");
    return next;
  }

  #run(runId) {
    if (!runId) return null;
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
    if (!row) return null;
    let configSnapshot = {};
    try {
      configSnapshot = row.config_snapshot
        ? JSON.parse(row.config_snapshot)
        : {};
    } catch {
      configSnapshot = {};
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      cwd: row.cwd ?? null,
      worktree: row.worktree ?? null,
      mode: row.mode,
      configSnapshot,
    };
  }

  /** Runs started today in a workspace (managed or observed launches). */
  #runsToday(workspaceId) {
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM runs WHERE (? IS NULL OR workspace_id = ?) AND mode = 'managed' AND started_at >= ?",
      )
      .get(workspaceId ?? null, workspaceId ?? null, start.getTime());
    return row?.n ?? 0;
  }

  /**
   * A run-level override (task execution_policy or a launch request) may only
   * tighten the workspace policy: a more restrictive autonomy, fewer
   * concurrent runs, a shorter timeout, extra denied commands and approval
   * categories. It can never widen what the workspace allows.
   */
  static tighten(base, override) {
    if (!override || typeof override !== "object") return base;
    const order = ["observe-only", "propose", "sandbox", "scoped"];
    const policy = { ...base };
    const requested = order.indexOf(override.autonomy);
    if (requested >= 0 && requested < order.indexOf(base.autonomy))
      policy.autonomy = override.autonomy;
    if (
      Number.isInteger(override.maxConcurrentRuns) &&
      override.maxConcurrentRuns >= 1 &&
      override.maxConcurrentRuns < base.maxConcurrentRuns
    )
      policy.maxConcurrentRuns = override.maxConcurrentRuns;
    if (
      Number.isFinite(override.timeoutMs) &&
      override.timeoutMs > 0 &&
      override.timeoutMs < base.timeoutMs
    )
      policy.timeoutMs = override.timeoutMs;
    if (override.allowedNetwork === false) policy.allowedNetwork = false;
    if (Array.isArray(override.deniedCommands))
      policy.deniedCommands = [
        ...new Set([...base.deniedCommands, ...override.deniedCommands]),
      ];
    if (Array.isArray(override.requireApprovalFor))
      policy.requireApprovalFor = [
        ...new Set([
          ...base.requireApprovalFor,
          ...override.requireApprovalFor,
        ]),
      ];
    return policy;
  }

  evaluateLaunch({
    workspaceId,
    workspace,
    provider = null,
    isolation = null,
    override = null,
  } = {}) {
    const id = workspaceId ?? workspace?.id;
    if (!id) throw new InputError("workspaceId is required");
    const policy = Policy.tighten(this.forWorkspace(id), override);
    const preset = AUTONOMY_PRESETS[policy.autonomy];
    const effective = {
      autonomy: policy.autonomy,
      isolation:
        policy.autonomy === "sandbox"
          ? "worktree"
          : (isolation ?? preset.isolation ?? "none"),
      allowedTools: policy.autonomy === "propose" ? [...READ_ONLY_TOOLS] : null,
      sandbox:
        policy.autonomy === "propose"
          ? "read-only"
          : preset.write
            ? "workspace-write"
            : "read-only",
      network: preset.network || policy.allowedNetwork === true,
      maxConcurrentRuns: policy.maxConcurrentRuns,
      timeoutMs: policy.timeoutMs,
      provider,
    };
    if (!preset.launch)
      return {
        allowed: false,
        reason: `Workspace autonomy is “${preset.label}”: runs are never launched from here.`,
        rule: "launch.observe-only",
        effective,
      };
    const perDay = policy.budget?.maxRunsPerDay;
    if (perDay && this.#runsToday(id) >= perDay)
      return {
        allowed: false,
        reason: `Daily run budget reached (${perDay} runs per day for this workspace).`,
        rule: "launch.budget.workspace",
        effective,
      };
    const globalLimit = this.services.settings?.get("budget.dailyRunLimit");
    if (globalLimit && this.#runsToday(null) >= globalLimit)
      return {
        allowed: false,
        reason: `Daily run budget reached (${globalLimit} runs per day across all workspaces).`,
        rule: "launch.budget.global",
        effective,
      };
    let reason = `Launch allowed under “${preset.label}”.`;
    if (policy.autonomy === "sandbox" && isolation && isolation !== "worktree")
      reason += " Isolation forced to a Git worktree by the sandbox preset.";
    if (policy.autonomy === "propose")
      reason += " Run is read-only: no file writes or shell.";
    return { allowed: true, reason, rule: "launch.allowed", effective };
  }

  /** Resolves the autonomy that governs a request. */
  #effectiveAutonomy(policy, run) {
    const fromRun = run?.configSnapshot?.autonomy;
    if (fromRun && AUTONOMY_PRESETS[fromRun]) return fromRun;
    return policy.autonomy;
  }

  #scopes(workspaceRow, run, policy) {
    const scopes = [];
    if (workspaceRow.rootPath)
      scopes.push({ path: workspaceRow.rootPath, label: "workspace root" });
    if (run?.worktree)
      scopes.push({ path: run.worktree, label: "run worktree" });
    if (run?.cwd) scopes.push({ path: run.cwd, label: "run cwd" });
    for (const folder of policy.allowedFolders ?? [])
      scopes.push({ path: folder, label: "allowed folder" });
    // Folders the launch handed to the provider (--add-dir); RunWorker only
    // grants those inside rootPath/allowedFolders, so listing them keeps the
    // hook evaluation and the launch grant in agreement.
    for (const dir of run?.configSnapshot?.extraDirs ?? [])
      if (typeof dir === "string")
        scopes.push({ path: dir, label: "run extra folder" });
    return scopes.filter((s) => normalizePath(s.path));
  }

  evaluate({ workspaceId, runId = null, request } = {}) {
    if (!request || typeof request !== "object")
      throw new InputError("request is required");
    const run = this.#run(runId);
    const wsId = workspaceId ?? run?.workspaceId;
    if (!wsId) throw new InputError("workspaceId or runId is required");
    const workspaceRow = this.#workspaceRow(wsId);
    const policy = mergePolicy({}, workspaceRow.policy);
    const autonomy = this.#effectiveAutonomy(policy, run);
    const preset = AUTONOMY_PRESETS[autonomy];
    const kind = this.#kindOf(request);
    const base = { autonomy, kind, workspaceId: wsId, runId: run?.id ?? null };
    const result = (decision, rule, reason, extra = {}) => ({
      decision,
      rule,
      reason,
      ...base,
      ...extra,
    });

    // Observe-only means "never launch from here, only watch": the person's
    // own session keeps its provider's permission prompts. Agent Space does
    // not decide for it either way (the hook bridge answers with no decision).
    if (autonomy === "observe-only")
      return result(
        "allow",
        "observe-only.passthrough",
        "Workspace is observe-only: Agent Space only watches this session and leaves permission decisions to the provider.",
        { passthrough: true },
      );

    if (kind === "command") {
      const command = String(request.command ?? "");
      const denied = matchDenied(command, policy.deniedCommands);
      if (denied)
        return result(
          "deny",
          "command.denied",
          `Command matches the denied list entry “${denied}”.`,
          { match: denied },
        );
      if (!preset.shell)
        return result(
          "deny",
          "shell.forbidden",
          `Autonomy “${preset.label}” does not allow shell commands.`,
        );
      const risky = findRisky(command);
      if (risky) {
        const approvable =
          preset.approvals !== "none" &&
          (policy.requireApprovalFor.includes(risky.category) ||
            policy.requireApprovalFor.includes("shell.risky"));
        if (approvable)
          return result(
            "ask",
            `command.risky.${risky.id}`,
            `Risky command (${risky.label}) needs a human decision.`,
            { category: risky.category, match: risky.label },
          );
        if (preset.approvals === "none")
          return result(
            "deny",
            `command.risky.${risky.id}`,
            `Risky command (${risky.label}) and this autonomy has no approval channel.`,
            { category: risky.category, match: risky.label },
          );
        return result(
          "allow",
          `command.risky.${risky.id}.unlisted`,
          `Risky command (${risky.label}) allowed: category “${risky.category}” is not in requireApprovalFor.`,
          { category: risky.category, match: risky.label },
        );
      }
      return result(
        "allow",
        "command.allowed",
        "Command is not risky and not denied.",
      );
    }

    if (kind === "file") {
      const rawPath = String(request.path ?? request.file ?? "");
      if (!rawPath)
        return result("allow", "file.no-path", "No file path to check.");
      if (isSecretPath(rawPath))
        return result(
          "deny",
          "file.secret",
          "Path looks like a credential or secret file; never exposed to agents.",
          { path: rawPath },
        );
      const access = this.#accessOf(request);
      if (access === "write" && !preset.write)
        return result(
          "deny",
          "file.write.forbidden",
          `Autonomy “${preset.label}” does not allow file writes.`,
          { path: rawPath, access },
        );
      const scopes = this.#scopes(workspaceRow, run, policy);
      const base = run?.cwd ?? workspaceRow.rootPath ?? undefined;
      const absolute = normalizePath(rawPath, base);
      if (!scopes.length)
        return result(
          "allow",
          "file.unscoped",
          "No workspace root, run cwd, or allowed folders configured; scope not enforced.",
          { path: rawPath, access },
        );
      const hit = scopes.find((s) => isWithin(absolute, s.path));
      if (hit)
        return result(
          "allow",
          "file.in-scope",
          `Path is inside the ${hit.label}.`,
          { path: rawPath, access, scope: hit.path },
        );
      return result(
        "deny",
        "file.out-of-scope",
        `Path is outside the workspace root, run folder, and allowed folders.`,
        { path: rawPath, access, scopes: scopes.map((s) => s.path) },
      );
    }

    if (kind === "network") {
      const target = request.url ?? request.query ?? request.host ?? "";
      if (!preset.network && policy.allowedNetwork !== true)
        return result(
          "deny",
          "network.forbidden",
          `Autonomy “${preset.label}” does not allow network access.`,
          { target },
        );
      if (
        policy.requireApprovalFor.includes("network") &&
        preset.approvals !== "none"
      )
        return result(
          "ask",
          "network.approval",
          "Network access needs a human decision (requireApprovalFor includes “network”).",
          { target },
        );
      return result("allow", "network.allowed", "Network access allowed.", {
        target,
      });
    }

    // Generic tool use (Task, Glob, Grep, TodoWrite, MCP tools…).
    const tool = String(request.tool ?? "");
    if (WRITE_TOOL.test(tool) && !preset.write)
      return result(
        "deny",
        "tool.write.forbidden",
        `Autonomy “${preset.label}” does not allow write tools (${tool}).`,
        { tool },
      );
    return result("allow", "tool.allowed", `Tool ${tool || "use"} allowed.`, {
      tool,
    });
  }

  #kindOf(request) {
    const kind = request.kind;
    if (["command", "file", "network", "tool"].includes(kind)) return kind;
    if (request.command !== undefined) return "command";
    if (request.path !== undefined || request.file !== undefined) return "file";
    if (request.url !== undefined) return "network";
    const tool = String(request.tool ?? "");
    if (NETWORK_TOOL.test(tool)) return "network";
    return "tool";
  }

  #accessOf(request) {
    if (request.access === "read" || request.access === "write")
      return request.access;
    if (WRITE_TOOL.test(String(request.tool ?? ""))) return "write";
    return "read";
  }

  /** Evaluation plus the rule text a person can read. */
  preview(workspaceId, request, { runId = null } = {}) {
    const evaluation = this.evaluate({ workspaceId, runId, request });
    const policy = this.forWorkspace(workspaceId);
    const preset = AUTONOMY_PRESETS[evaluation.autonomy];
    return {
      ...evaluation,
      explanation: [
        `Autonomy: ${preset.label} — ${preset.description}`,
        `Rule ${evaluation.rule}: ${evaluation.reason}`,
        evaluation.decision === "ask"
          ? "A pending approval will appear in the Decision inbox; the run waits until you decide or it expires."
          : evaluation.decision === "deny"
            ? "Denied server-side; the provider receives a deny decision with this reason."
            : "Allowed without asking.",
      ],
      policy,
    };
  }
}

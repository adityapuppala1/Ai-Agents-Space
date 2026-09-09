/**
 * Shared vocabulary for every module. Import from here instead of repeating
 * string literals so the UI, storage, adapters, and tests stay in agreement.
 */

export const PROVIDERS = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    binaries: ["claude"],
    homeEnv: "CLAUDE_CONFIG_DIR",
    homeDefault: "~/.claude",
  },
  codex: {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    binaries: ["codex"],
    homeEnv: "CODEX_HOME",
    homeDefault: "~/.codex",
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot CLI",
    vendor: "GitHub",
    binaries: ["copilot"],
    homeEnv: "COPILOT_HOME",
    homeDefault: "~/.copilot",
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    vendor: "Anysphere",
    binaries: ["cursor-agent", "agent", "cursor"],
    homeEnv: "CURSOR_HOME",
    homeDefault: "~/.cursor",
  },
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    vendor: "Google",
    binaries: ["gemini"],
    homeEnv: "GEMINI_HOME",
    homeDefault: "~/.gemini",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** How a run came to exist. */
export const RUN_MODES = ["manual", "simulated", "observed", "managed"];

/** Lifecycle of a run. `blocked` is a task-level pause; the rest are execution states. */
export const RUN_STATUSES = [
  "queued",
  "running",
  "blocked",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "disconnected",
  "stale",
];

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"];

/** What an agent is visibly doing. Drives office animation and the badge on the card. */
export const ACTIVITIES = [
  "IDLE",
  "ANALYZING",
  "CODING",
  "RESEARCHING",
  "TESTING",
  "DEBUGGING",
  "REVIEWING",
  "COMMANDING",
  "MESSAGING",
  "DELEGATING",
  "WAITING_APPROVAL",
  "BLOCKED",
  "ERROR",
  "STALE",
];

/** Normalized event kinds, shared by observers, adapters, and the hook bridge. */
export const EVENT_KINDS = [
  "session.start",
  "session.end",
  "turn.start",
  "turn.end",
  "prompt",
  "message",
  "reasoning",
  "tool.start",
  "tool.end",
  "file.read",
  "file.edit",
  "file.write",
  "search",
  "web",
  "command",
  "test",
  "approval.request",
  "approval.decision",
  "delegation",
  "usage",
  "error",
  "status",
  "system",
  "task",
  "complete",
];

/** Who asserted an event. Never label an inferred event as provider-reported. */
export const PROVENANCE = ["provider", "inferred", "user", "system"];

/**
 * Capability keys recorded per connection. Values are
 * "verified" | "unsupported" | "unknown" | "experimental".
 */
export const CAPABILITIES = [
  "observe",
  "launch",
  "stream",
  "attach",
  "interrupt",
  "resume",
  "fork",
  "approve",
  "reportModel",
  "reportUsage",
  "artifacts",
  "delegate",
];

/** Autonomy presets enforced by the policy engine, not just the UI. */
export const AUTONOMY_PRESETS = {
  "observe-only": {
    label: "Observe only",
    description: "Never launch runs from this workspace; only watch sessions.",
    launch: false,
    write: false,
    shell: false,
    network: false,
    approvals: "none",
  },
  propose: {
    label: "Propose",
    description:
      "Launch read-only runs that plan or explain. No file writes or shell.",
    launch: true,
    write: false,
    shell: false,
    network: false,
    approvals: "none",
  },
  sandbox: {
    label: "Execute in sandbox",
    description:
      "Writes go to an isolated Git worktree; shell allowed inside it; you review the patch.",
    launch: true,
    write: true,
    shell: true,
    network: false,
    isolation: "worktree",
    approvals: "risky",
  },
  scoped: {
    label: "Scoped execution",
    description:
      "Writes to the project folder; risky commands and pushes need your approval.",
    launch: true,
    write: true,
    shell: true,
    network: true,
    isolation: "none",
    approvals: "risky",
  },
};

export const DEFAULT_POLICY = {
  autonomy: "scoped",
  maxConcurrentRuns: 2,
  allowedFolders: [],
  deniedCommands: [
    "git push",
    "git push --force",
    "rm -rf /",
    "Remove-Item -Recurse -Force C:",
    "npm publish",
    "docker push",
    "kubectl apply",
    "terraform apply",
  ],
  requireApprovalFor: ["shell.risky", "network", "git.push", "deploy"],
  budget: { maxTokensPerRun: null, maxRunsPerDay: null },
  timeoutMs: 30 * 60 * 1000,
};

/**
 * Normalized event shape produced by every observer, adapter, and the hook
 * bridge. Only `kind`, `provider`, `timestamp`, and `summary` are required.
 *
 * {
 *   providerEventId: string|null,   // stable id for dedup (uuid, item id, or file:offset)
 *   provider: string,               // PROVIDER_IDS entry or "manual" | "simulated"
 *   sessionId: string|null,         // provider session/thread id
 *   cwd: string|null,
 *   timestamp: number,              // epoch ms
 *   kind: EVENT_KINDS entry,
 *   provenance: PROVENANCE entry,   // "provider" for parsed provider records
 *   summary: string,                // one human-readable line
 *   tool: string|null,              // provider tool name (Edit, exec_command, view…)
 *   file: string|null,              // primary file path when the event touches one
 *   activity: ACTIVITIES entry|null,// inferred activity; UI labels this as inferred
 *   model: string|null,
 *   usage: object|null,             // provider-reported token usage as given
 *   data: object,                   // provider-specific payload, truncated for storage
 * }
 */
export function makeEvent(partial) {
  return {
    providerEventId: null,
    sessionId: null,
    cwd: null,
    provenance: "provider",
    tool: null,
    file: null,
    activity: null,
    model: null,
    usage: null,
    data: {},
    ...partial,
  };
}

/** Maps a tool name to an activity. Shared across providers; extend per provider. */
export function classifyTool(tool, args = {}) {
  const name = String(tool ?? "").toLowerCase();
  const text = JSON.stringify(args ?? {}).toLowerCase();
  if (!name) return null;
  if (
    /^(edit|write|multiedit|notebookedit|apply_patch|create|str_replace|edit_file|write_file|file_change)$/.test(
      name,
    )
  )
    return "CODING";
  if (
    /^(read|view|glob|grep|ls|list_dir|read_file|fs_read|search_files|codebase_search)$/.test(
      name,
    )
  )
    return "RESEARCHING";
  if (/^(websearch|webfetch|web_search|fetch|web)$/.test(name))
    return "RESEARCHING";
  if (/^(task|agent|delegate|spawn_agent|subagent)$/.test(name))
    return "DELEGATING";
  if (
    /^(bash|powershell|exec|exec_command|shell|run_in_terminal|command_execution|local_shell|write_stdin|run_terminal_cmd|execute)$/.test(
      name,
    )
  ) {
    if (
      /\b(test|jest|vitest|pytest|mocha|playwright|npm run test|node --test|go test|cargo test|phpunit)\b/.test(
        text,
      )
    )
      return "TESTING";
    if (/\b(git (status|diff|log|blame)|cat |ls |dir |grep |find )/.test(text))
      return "RESEARCHING";
    if (/\b(build|compile|lint|tsc|eslint|prettier)\b/.test(text))
      return "DEBUGGING";
    return "COMMANDING";
  }
  if (/review|diff|patch/.test(name)) return "REVIEWING";
  return "COMMANDING";
}

export const DEFAULT_SECRET_PATTERNS = [
  /(^|[\\/])\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_(rsa|ed25519|ecdsa)(\.pub)?$/i,
  /(^|[\\/])\.credentials\.json$/i,
  /(^|[\\/])auth\.json$/i,
  /(^|[\\/])secrets?\.(json|ya?ml|toml)$/i,
  /\.npmrc$/i,
  /\.netrc$/i,
];

export function isSecretPath(path) {
  return DEFAULT_SECRET_PATTERNS.some((pattern) => pattern.test(String(path)));
}

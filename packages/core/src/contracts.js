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
  // A workflow step's result passed from one agent to the next; the event
  // names both agents and the artifacts (TaskGraph.onTaskCompleted).
  "handoff",
  // A team assembled for a workflow; the event names every member and role.
  "team",
];

/**
 * Artifact kinds RunWorker writes today. Shared vocabulary for readers, NOT
 * enforced: `artifacts.kind` is unconstrained TEXT and workflow contracts and
 * tests already store kinds of their own, so validating here would break them.
 */
export const ARTIFACT_KINDS = Object.freeze([
  "diff",
  "test-output",
  "message",
  "snippet",
]);

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

/**
 * The simple commands in a shell line, split on unquoted `;`, `|`, `&` and
 * newlines. Heredoc bodies are data, not commands, so the lines between
 * `<<TAG` and `TAG` are dropped; quoted text is never split.
 */
export function commandSegments(command) {
  const kept = [];
  let heredocEnd = null;
  for (const line of String(command ?? "").split("\n")) {
    if (heredocEnd) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    kept.push(line);
    const heredoc = line.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/);
    if (heredoc) heredocEnd = heredoc[2];
  }
  const text = kept.join("\n");
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      current += ch;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
    } else if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      segments.push(current);
      current = "";
    } else current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

// Leading words that run the next command: env assignments, cd is its own
// segment already, and wrappers such as npx or `bundle exec`.
const COMMAND_PREFIX =
  /^(?:(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)|(?:sudo|time|env|npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|bundle\s+exec|poetry\s+run|uv\s+run)\s+)+/i;
const SHELL_WRAPPER =
  /^(?:bash|sh|zsh|dash|pwsh|powershell(?:\.exe)?|cmd(?:\.exe)?)\s+(?:(?:-{1,2}[\w-]+|\/[ck])\s+)+([\s\S]+)$/i;
const TEST_RUNNER =
  /^(?:(?:jest|vitest|pytest|mocha|phpunit|rspec|ctest|tox|nose2|karma|ava)\b|(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?tests?\b|node\s+(?:--test|--experimental-test-runner)\b|(?:go|cargo|dotnet|mvn|gradle|swift|flutter|rails)\s+tests?\b|playwright\s+test\b|make\s+(?:test|check)\b|python3?\s+-m\s+(?:pytest|unittest)\b)/i;

/**
 * True when a shell line runs a test runner as a command, not when a test
 * runner's name appears in an argument (a grep pattern, an echo, a commit
 * message) or inside a heredoc.
 */
export function runsTests(command, depth = 0) {
  return commandSegments(command).some((segment) => {
    const bare = segment.replace(COMMAND_PREFIX, "");
    if (TEST_RUNNER.test(bare)) return true;
    // `bash -lc 'npm test'`, `pwsh -Command "npm test"`: look inside.
    const wrapped = depth < 2 ? bare.match(SHELL_WRAPPER) : null;
    if (!wrapped) return false;
    const inner = wrapped[1].trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
    return runsTests(inner, depth + 1);
  });
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
    // A test RUNNER being invoked as a command, not merely the word "test"
    // somewhere in it. `sed -n '1,20p' tests/office.test.js` reads a file and
    // `grep "npm test" docs` searches for words; calling either "Testing"
    // would state an activity the evidence does not support.
    const command =
      typeof args?.command === "string"
        ? args.command
        : Array.isArray(args?.command)
          ? args.command.join(" ")
          : typeof args?.cmd === "string"
            ? args.cmd
            : Array.isArray(args?.cmd)
              ? args.cmd.join(" ")
              : null;
    if (command !== null ? runsTests(command) : runsTests(text))
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

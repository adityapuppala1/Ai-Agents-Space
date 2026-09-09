import { CAPABILITIES, PROVIDERS, PROVIDER_IDS } from "../contracts.js";

/**
 * Provider registry: static, verified facts about each supported runtime.
 * Extends `contracts.PROVIDERS` with documentation links, what has actually
 * been verified on a real machine (docs/ARCHITECTURE.md §3), where the
 * provider stores sessions, and the default capability matrix.
 *
 * Capability values are one of `verified | unsupported | unknown |
 * experimental`. The special marker `verified-with-hooks` (Claude Code
 * `approve`) resolves to `verified` only when the hook bridge is installed;
 * otherwise it is reported as `unknown`. Use `capabilityMatrix()` to resolve.
 */

export const CAPABILITY_VALUES = [
  "verified",
  "unsupported",
  "unknown",
  "experimental",
];

const allUnknown = () =>
  Object.fromEntries(CAPABILITIES.map((key) => [key, "unknown"]));
const allUnsupported = () =>
  Object.fromEntries(CAPABILITIES.map((key) => [key, "unsupported"]));

export const REGISTRY = {
  "claude-code": {
    ...PROVIDERS["claude-code"],
    badge: "Claude Code",
    color: "#c9743a",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    installHint:
      "Install Claude Code (npm install -g @anthropic-ai/claude-code, or the native installer) and run `claude` once to log in.",
    launchVerified: true,
    /** Existence of any of these (relative to home) = "logged in likely". Never read. */
    authFiles: [".credentials.json"],
    /** Oldest version the verified launch/stream format was captured on. */
    minVersion: "2.0.0",
    verifiedVersions: ["2.1.258", "2.1.266"],
    versionArgs: ["--version"],
    storage:
      "Live session registry in ~/.claude/sessions/<pid>.json, transcripts in ~/.claude/projects/<slug>/<sessionId>.jsonl, prompt history in ~/.claude/history.jsonl. Hooks in ~/.claude/settings.json.",
    capabilities: {
      observe: "verified",
      launch: "verified",
      stream: "verified",
      attach: "experimental",
      interrupt: "verified",
      resume: "verified",
      fork: "unsupported",
      approve: "verified-with-hooks",
      reportModel: "verified",
      reportUsage: "verified",
      artifacts: "verified",
      delegate: "unsupported",
    },
  },
  codex: {
    ...PROVIDERS.codex,
    badge: "Codex",
    color: "#3b8f7a",
    docsUrl: "https://developers.openai.com/codex/cli",
    installHint:
      "Install Codex CLI (npm install -g @openai/codex) and run `codex login`.",
    launchVerified: "format-verified",
    launchNote:
      "Stream format verified on this machine; the account was rate limited during the end-to-end check, so a full completed run has not been observed.",
    authFiles: ["auth.json"],
    minVersion: "0.150.0",
    verifiedVersions: ["0.152.1"],
    versionArgs: ["--version"],
    storage:
      "Rollouts in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, session index in ~/.codex/session_index.jsonl, read-only state in ~/.codex/state_5.sqlite.",
    capabilities: {
      observe: "verified",
      launch: "experimental",
      stream: "verified",
      attach: "experimental",
      interrupt: "experimental",
      resume: "experimental",
      fork: "experimental",
      approve: "experimental",
      reportModel: "verified",
      reportUsage: "verified",
      artifacts: "experimental",
      delegate: "unsupported",
    },
  },
  copilot: {
    ...PROVIDERS.copilot,
    badge: "Copilot",
    color: "#5b7fd6",
    docsUrl:
      "https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli",
    installHint:
      "Install GitHub Copilot CLI (npm install -g @github/copilot) and run `copilot` once to authenticate with GitHub.",
    launchVerified: true,
    // No documented credential file name was verified; auth hint stays unknown.
    authFiles: [],
    minVersion: "1.0.0",
    verifiedVersions: ["1.0.80"],
    versionArgs: ["--version"],
    storage:
      "Sessions in ~/.copilot/session-store.db (read-only sqlite) and ~/.copilot/session-state/<id>/events.jsonl + workspace.yaml.",
    capabilities: {
      observe: "verified",
      launch: "verified",
      stream: "verified",
      attach: "experimental",
      interrupt: "verified",
      resume: "experimental",
      fork: "unsupported",
      approve: "unsupported",
      reportModel: "verified",
      reportUsage: "verified",
      artifacts: "verified",
      delegate: "unsupported",
    },
  },
  cursor: {
    ...PROVIDERS.cursor,
    badge: "Cursor",
    color: "#7a6fd1",
    docsUrl: "https://docs.cursor.com/cli",
    installHint:
      "Install the Cursor Agent CLI (`cursor-agent`) from https://cursor.com/cli to enable managed runs. The Cursor IDE alone is detect-only.",
    launchVerified: false,
    authFiles: [],
    minVersion: null,
    verifiedVersions: [],
    versionArgs: ["--version"],
    storage:
      "Experimental: %APPDATA%/Cursor/User/globalStorage/state.vscdb and ~/.cursor/ai-tracking/ai-code-tracking.db (read-only, best effort).",
    capabilities: { ...allUnsupported(), observe: "experimental" },
  },
  gemini: {
    ...PROVIDERS.gemini,
    badge: "Gemini",
    color: "#4a8fd9",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    installHint:
      "Install Gemini CLI (npm install -g @google/gemini-cli) and run `gemini` once to sign in.",
    launchVerified: false,
    // Per Gemini CLI docs; not verified on this machine (existence only, never read).
    authFiles: ["oauth_creds.json"],
    minVersion: null,
    verifiedVersions: [],
    versionArgs: ["--version"],
    storage:
      "Per docs (unverified): ~/.gemini/tmp/<project_hash>/chats/*.json and logs.json. ~/.gemini/antigravity is the Antigravity IDE (detect only).",
    capabilities: allUnknown(),
  },
};

export const REGISTRY_IDS = PROVIDER_IDS.filter((id) => REGISTRY[id]);

export function getProvider(id) {
  return REGISTRY[id] ?? null;
}

/**
 * Resolves the capability matrix for a provider into plain
 * verified/unsupported/unknown/experimental values.
 */
export function capabilityMatrix(providerId, { hooksInstalled = false } = {}) {
  const provider = REGISTRY[providerId];
  const defaults = provider?.capabilities ?? allUnknown();
  const matrix = {};
  for (const key of CAPABILITIES) {
    let value = defaults[key] ?? "unknown";
    if (value === "verified-with-hooks")
      value = hooksInstalled ? "verified" : "unknown";
    if (!CAPABILITY_VALUES.includes(value)) value = "unknown";
    matrix[key] = value;
  }
  return matrix;
}

/** Numeric comparison of dotted versions; unknown/unparseable → 0. */
export function compareVersions(a, b) {
  const parse = (value) =>
    String(value ?? "")
      .match(/\d+(?:\.\d+)*/)?.[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10)) ?? null;
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Serializable registry view for the API (no functions, resolved matrix). */
export function listProviders({ hooksInstalled = false } = {}) {
  return REGISTRY_IDS.map((id) => {
    const p = REGISTRY[id];
    return {
      id: p.id,
      name: p.name,
      badge: p.badge,
      vendor: p.vendor,
      color: p.color,
      binaries: p.binaries,
      homeEnv: p.homeEnv,
      homeDefault: p.homeDefault,
      docsUrl: p.docsUrl,
      installHint: p.installHint,
      launchVerified: p.launchVerified,
      launchNote: p.launchNote ?? null,
      minVersion: p.minVersion,
      verifiedVersions: p.verifiedVersions,
      storage: p.storage,
      capabilities: capabilityMatrix(id, { hooksInstalled }),
      binaryOverrideEnv: binaryOverrideEnvName(id),
    };
  });
}

/** `AGENT_SPACE_BIN_<PROVIDER>` with the id upper-cased and `-` → `_`. */
export function binaryOverrideEnvName(providerId) {
  return `AGENT_SPACE_BIN_${String(providerId).toUpperCase().replace(/-/g, "_")}`;
}

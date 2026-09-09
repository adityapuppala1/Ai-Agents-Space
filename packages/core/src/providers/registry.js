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
    launchVerified: "flags-verified",
    launchNote:
      "Launch flags were read from `gemini --help` of 0.59.0 on this machine, so the command line is verified. No authenticated run has been observed (the CLI exits 41 with an auth error), so the stream format, usage, and model reporting stay unknown.",
    /**
     * The authoritative "an auth method was chosen" signal is the existence of
     * ~/.gemini/settings.json (the CLI creates it only after you pick one).
     * Contents are never read. GEMINI_API_KEY / GOOGLE_GENAI_USE_VERTEXAI /
     * GOOGLE_GENAI_USE_GCA in the environment count too (see authEnv).
     */
    authFiles: ["settings.json"],
    authEnv: [
      "GEMINI_API_KEY",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_GENAI_USE_GCA",
    ],
    minVersion: "0.59.0",
    verifiedVersions: ["0.59.0"],
    versionArgs: ["--version"],
    storage:
      "~/.gemini/projects.json maps a lower-cased absolute cwd to a short project alias; per-project data lives in ~/.gemini/history/<alias>/ and ~/.gemini/tmp/<alias>/. ~/.gemini/settings.json exists only once an auth method is chosen. ~/.gemini/antigravity is the Antigravity IDE (detect only).",
    capabilities: {
      ...allUnknown(),
      // Flags verified from the CLI's own --help; no completed run observed.
      launch: "experimental",
      observe: "experimental",
    },
  },
};

export const REGISTRY_IDS = PROVIDER_IDS.filter((id) => REGISTRY[id]);

/**
 * Per-provider version/OS compatibility. `testedVersions` are the versions a
 * human actually exercised on this machine; `testedOS` is the platform list
 * those checks ran on (Windows 11 x64 only so far). Anything outside those
 * lists is reported as `untested`, never as unsupported.
 */
export const COMPATIBILITY = {
  "claude-code": {
    minVersion: "2.0.0",
    testedVersions: ["2.1.258", "2.1.266"],
    testedOS: ["win32"],
    notes:
      "Headless stream-json launch and the hook bridge were exercised on Windows 11 with 2.1.258/2.1.266.",
  },
  codex: {
    minVersion: "0.150.0",
    testedVersions: ["0.152.1"],
    testedOS: ["win32"],
    notes:
      "`codex exec --json` stream format verified on 0.152.1; the end-to-end run hit the account usage limit, and the app-server protocol was exercised against a fake only.",
  },
  copilot: {
    minVersion: "1.0.0",
    testedVersions: ["1.0.80"],
    testedOS: ["win32"],
    notes:
      "Headless `copilot -p --output-format json` verified on 1.0.80; non-interactive runs require an explicit tool allow list.",
  },
  cursor: {
    minVersion: null,
    testedVersions: [],
    testedOS: [],
    notes:
      "Only the Cursor IDE launcher (cursor.cmd) exists here; the cursor-agent CLI is not installed, so nothing has been tested.",
  },
  gemini: {
    minVersion: "0.59.0",
    testedVersions: ["0.59.0"],
    testedOS: ["win32"],
    notes:
      "Launch flags were read from `gemini --help` of 0.59.0 on Windows 11. The CLI is not authenticated here (every run exits 41), so no completed run, stream format, or usage report has been observed.",
  },
};

/**
 * Version/OS compatibility verdict for one provider.
 *
 *   { supported: true | false | "untested", reason }
 *
 * `true` only for a version we actually tested on this platform; `false` when
 * the version is older than the minimum the adapter was written against;
 * `untested` for everything else (unknown version, newer version, other OS).
 */
export function compatibility(
  providerId,
  version = null,
  { platform = process.platform } = {},
) {
  const record = COMPATIBILITY[providerId];
  const provider = REGISTRY[providerId];
  if (!record || !provider)
    return {
      provider: providerId,
      supported: "untested",
      reason: `Unknown provider: ${providerId}`,
      minVersion: null,
      testedVersions: [],
      testedOS: [],
      version: version ?? null,
      platform,
    };
  const base = {
    provider: providerId,
    minVersion: record.minVersion,
    testedVersions: record.testedVersions,
    testedOS: record.testedOS,
    notes: record.notes,
    version: version ?? null,
    platform,
  };
  if (!record.testedVersions.length)
    return {
      ...base,
      supported: "untested",
      reason: `${provider.name} has never been exercised here, so no version is known to work.`,
    };
  if (!record.testedOS.includes(platform))
    return {
      ...base,
      supported: "untested",
      reason: `${provider.name} was only tested on ${record.testedOS.join(", ")}; this machine reports ${platform}.`,
    };
  if (!version)
    return {
      ...base,
      supported: "untested",
      reason: `No version was reported for ${provider.name}; tested versions are ${record.testedVersions.join(", ")}.`,
    };
  if (record.minVersion && compareVersions(version, record.minVersion) < 0)
    return {
      ...base,
      supported: false,
      reason: `${provider.name} ${version} is older than ${record.minVersion}, the oldest version the adapter was written against.`,
    };
  if (record.testedVersions.includes(String(version)))
    return {
      ...base,
      supported: true,
      reason: `${provider.name} ${version} was tested on ${record.testedOS.join(", ")}.`,
    };
  return {
    ...base,
    supported: "untested",
    reason: `${provider.name} ${version} has not been tested here (tested: ${record.testedVersions.join(", ")}); it is newer than or different from the verified versions and may behave differently.`,
  };
}

/** Compatibility verdicts for every provider, keyed by provider id. */
export function allCompatibility(versions = {}, options = {}) {
  return Object.fromEntries(
    REGISTRY_IDS.map((id) => [
      id,
      compatibility(id, versions[id] ?? null, options),
    ]),
  );
}

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
      compatibility: COMPATIBILITY[id] ?? null,
      binaryOverrideEnv: binaryOverrideEnvName(id),
    };
  });
}

/** `AGENT_SPACE_BIN_<PROVIDER>` with the id upper-cased and `-` → `_`. */
export function binaryOverrideEnvName(providerId) {
  return `AGENT_SPACE_BIN_${String(providerId).toUpperCase().replace(/-/g, "_")}`;
}

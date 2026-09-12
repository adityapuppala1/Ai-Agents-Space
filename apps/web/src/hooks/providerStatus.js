import { providerLabel } from "./useApi.js";

/**
 * What a provider state shown in the product actually means. Detection finds a
 * CLI and, at most, a sign-in file; it never proves that a run will work. So
 * "Available" is the strongest claim made from detection alone, and
 * "Running" is reserved for a session or managed run that is live right now.
 */
export const PULSE_STATES = {
  running: {
    label: "Running",
    detail: "A session or managed run is active now.",
  },
  ready: {
    label: "Available",
    detail:
      "CLI found and a sign-in file exists. This check does not verify a run.",
  },
  detected: {
    label: "Installed",
    detail: "CLI found. Sign-in is not confirmed.",
  },
  error: {
    label: "Failed",
    detail: "The installed CLI did not answer its version check.",
  },
  unknown: {
    label: "Not checked",
    detail: "Detection has not finished yet.",
  },
};

const PULSE_ORDER = ["claude-code", "codex", "copilot", "gemini", "cursor"];
const rank = (provider) => {
  const index = PULSE_ORDER.indexOf(provider);
  return index === -1 ? PULSE_ORDER.length : index;
};

/**
 * Entries for the top-bar pulse: one per provider on this machine (the
 * default connection), never an absent one, in a stable order. A provider with
 * a live session or active run is "running" whatever its detection said.
 */
export function pulseEntries(connections = [], runningProviders = new Set()) {
  const byProvider = new Map();
  for (const connection of connections) {
    if (connection.alias && connection.alias !== "default") continue;
    if (!connection.provider || connection.status === "missing") continue;
    byProvider.set(connection.provider, connection);
  }
  return [...byProvider.values()]
    .sort((a, b) => rank(a.provider) - rank(b.provider))
    .map((connection) => {
      let state = "unknown";
      if (runningProviders.has(connection.provider)) state = "running";
      else if (PULSE_STATES[connection.status]) state = connection.status;
      return {
        id: connection.id ?? connection.provider,
        provider: connection.provider,
        name: providerLabel(connection.provider),
        state,
        ...PULSE_STATES[state],
      };
    });
}

/**
 * Rows for the compatibility card. The server answers with an object keyed by
 * provider (`{ "claude-code": { supported, reason, testedVersions, ... } }`);
 * older shapes (an array, or `{ notes | items }`) are still accepted. The card
 * read only the older keys, so it always said nothing was recorded.
 */
export function compatibilityRows(data) {
  if (!data) return [];
  const list = Array.isArray(data)
    ? data
    : (data.notes ??
      data.compatibility ??
      data.items ??
      Object.values(data).filter(
        (value) => value && typeof value === "object" && value.provider,
      ));
  return list.map((row) => ({
    provider: row.provider,
    version: row.version ?? null,
    tested: row.supported === true || row.verified === true,
    testedVersions: Array.isArray(row.testedVersions) ? row.testedVersions : [],
    testedOS: Array.isArray(row.testedOS) ? row.testedOS : [],
    reason: row.reason ?? row.note ?? row.detail ?? row.message ?? "",
    notes: row.notes && typeof row.notes === "string" ? row.notes : "",
  }));
}

/**
 * The Connections page uses the pulse words plus one more: a CLI that is not
 * on this machine is "Not detected". That is a fact about the machine, not a
 * failure, so it is shown quietly and never raises the outage banner.
 */
export const CONNECTION_STATES = {
  ...PULSE_STATES,
  missing: {
    label: "Not detected",
    detail: "No CLI was found on PATH or at its documented install location.",
  },
};
const STATE_TONE = {
  running: "live",
  ready: "ok",
  detected: "neutral",
  unknown: "neutral",
  missing: "muted",
  error: "bad",
};

/**
 * State for one connection row. "Running" applies to the default account
 * only: a live session cannot be attributed to one of several aliases.
 */
export function connectionState(connection, runningProviders = new Set()) {
  const isDefault = !connection?.alias || connection.alias === "default";
  let key = CONNECTION_STATES[connection?.status]
    ? connection.status
    : "unknown";
  if (
    isDefault &&
    key !== "missing" &&
    runningProviders.has(connection?.provider)
  )
    key = "running";
  const state = { key, tone: STATE_TONE[key], ...CONNECTION_STATES[key] };
  // No sign-in file is not proof of being signed out: some CLIs keep the
  // sign-in in the system keychain. So it stays "Installed", with the reason.
  if (
    key === "detected" &&
    connection?.details?.authHint === "no-credentials-file"
  )
    state.detail =
      "CLI found, but no sign-in file was found. Sign in from a terminal, unless this CLI keeps its sign-in in the system keychain.";
  return state;
}

/** What the sign-in check found, in words. The file itself is never read. */
export function authHintText(hint) {
  if (hint === "logged-in-likely")
    return "A sign-in file or credential variable is present.";
  if (hint === "no-credentials-file") return "No sign-in file was found.";
  return "This CLI has no documented sign-in file to check.";
}

/** Counts of default connections per state, strongest first, zeros dropped. */
export function connectionSummary(
  connections = [],
  runningProviders = new Set(),
) {
  const counts = new Map();
  for (const connection of connections) {
    if (connection.alias && connection.alias !== "default") continue;
    const { key, label, tone } = connectionState(connection, runningProviders);
    const entry = counts.get(key) ?? { key, label, tone, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const order = ["running", "ready", "detected", "error", "unknown", "missing"];
  return order.filter((key) => counts.has(key)).map((key) => counts.get(key));
}

/**
 * What stops a runtime from being used right now: an enabled connection
 * whose version check failed, or a provider whose circuit breaker is open or
 * parked by a usage limit. `breakers` is RunWorker.providerHealth() as served
 * in /api/ops/health (`providers.breakers`, an array). An absent CLI is not
 * an outage.
 */
export function connectionOutages(connections = [], breakers = []) {
  const tripped = new Map();
  for (const breaker of Array.isArray(breakers) ? breakers : [])
    if (breaker?.provider && (breaker.state === "open" || breaker.parkedUntil))
      tripped.set(breaker.provider, breaker);
  const rows = [];
  for (const connection of connections) {
    if (connection.enabled === false) continue;
    const breaker = tripped.get(connection.provider);
    if (connection.status !== "error" && !breaker) continue;
    rows.push({
      id: connection.id ?? connection.provider,
      provider: connection.provider,
      alias: connection.alias ?? "default",
      reason: breaker
        ? (breaker.parkReason ??
          breaker.lastError ??
          "Repeated launch failures paused new runs")
        : (connection.error ?? "The version check failed"),
      remediation: connection.remediation ?? null,
    });
  }
  return rows;
}

export const CAPABILITY_LABELS = {
  observe: "Observe sessions",
  launch: "Launch runs",
  stream: "Stream events",
  attach: "Attach to a session",
  interrupt: "Interrupt",
  resume: "Resume",
  fork: "Fork",
  approve: "Approvals",
  reportModel: "Report model",
  reportUsage: "Report usage",
  artifacts: "Artifacts",
  delegate: "Delegate",
};

/**
 * The registry matrix grouped by level, in a fixed order. Values outside the
 * four known levels count as unknown rather than being dropped.
 */
export function groupCapabilities(caps = {}) {
  const groups = {
    verified: [],
    experimental: [],
    unknown: [],
    unsupported: [],
  };
  for (const key of Object.keys(CAPABILITY_LABELS)) {
    if (caps[key] === undefined) continue;
    const bucket = groups[caps[key]] ?? groups.unknown;
    bucket.push({ key, label: CAPABILITY_LABELS[key] });
  }
  return groups;
}

/**
 * A long path shortened in the middle so the drive and the file both stay
 * visible: `C:\Users\me\AppData\Roaming\npm\claude.cmd` → `C:\…\npm\claude.cmd`.
 * Already-masked paths (`…/npm/claude.cmd`) pass through unchanged.
 */
export function shortPath(path, keep = 2) {
  const text = String(path ?? "");
  if (!text || text.startsWith("…")) return text;
  const separator = text.includes("\\") ? "\\" : "/";
  const parts = text.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= keep + 2) return text;
  const head = text.startsWith("/") ? `/${parts[0]}` : parts[0];
  return [head, "…", ...parts.slice(-keep)].join(separator);
}

/** Providers with a live observed session or an active managed run. */
export function runningProviderSet(agents = [], surfaces = []) {
  const running = new Set();
  for (const agent of agents)
    if (agent.activeProviderRun && agent.provider) running.add(agent.provider);
  for (const surface of surfaces)
    if ((surface.liveSessions ?? 0) > 0 && surface.provider)
      running.add(surface.provider);
  return running;
}

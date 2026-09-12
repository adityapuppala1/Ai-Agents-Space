import { PROVIDERS } from "../contracts.js";
import { REGISTRY_IDS, capabilityMatrix } from "../providers/registry.js";
import { totalTokens, usageIsReported } from "../runs/budget.js";

/**
 * Routing (roadmap §8 "explicit routing", §11 "classification-aware
 * routing"): which assistant should take a task, and why each other one
 * should not.
 *
 * It ranks; it never starts anything. Every candidate carries the checks
 * that decided it, in words, and only facts this machine has are used:
 *   - whether the assistant can be launched here and is connected;
 *   - the capabilities the task requires, from the provider registry
 *     ("verified" / "experimental" / "unknown" / "unsupported");
 *   - the workspace's data rules: which vendors may receive work carrying a
 *     sensitivity label (the vendor is where a cloud assistant sends it);
 *   - per-assistant daily token caps, against provider-reported usage;
 *   - evaluation pass rates, only once enough runs were graded to compare;
 *   - the workspace's preference order.
 * The data rule and the caps are also enforced at launch
 * (Policy.evaluateLaunch), so a ranking is advice and a refusal is not.
 */

/** Sensitivity labels, least to most sensitive. */
export const SENSITIVITY_LEVELS = Object.freeze([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

export const SENSITIVITY_LABELS = Object.freeze({
  public: "Public",
  internal: "Internal",
  confidential: "Confidential",
  restricted: "Restricted",
});

/** Where each assistant sends work: its vendor (contracts.PROVIDERS). */
export const VENDORS = Object.freeze(
  Object.fromEntries(
    Object.values(PROVIDERS)
      .filter((provider) => provider.vendor)
      .map((provider) => [vendorKey(provider.vendor), provider.vendor]),
  ),
);

function vendorKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

/** The vendor id an assistant sends work to, or null when unknown. */
export function vendorOf(provider) {
  const vendor = PROVIDERS[provider]?.vendor;
  return vendor ? vendorKey(vendor) : null;
}

/** The more sensitive of two labels; either may be missing. */
export function stricterSensitivity(a, b) {
  const ia = SENSITIVITY_LEVELS.indexOf(a);
  const ib = SENSITIVITY_LEVELS.indexOf(b);
  if (ia < 0) return ib < 0 ? null : b;
  if (ib < 0) return a;
  return ia >= ib ? a : b;
}

/**
 * A task's label: the workspace default or the task's own, whichever is
 * more sensitive. A task can raise its label, never lower it.
 */
export function effectiveSensitivity(policy, taskLabel = null) {
  return stricterSensitivity(policy?.dataSensitivity ?? null, taskLabel);
}

const nameOf = (provider) => PROVIDERS[provider]?.name ?? provider;

/**
 * Null when `provider` may receive work labelled `label` under the
 * workspace's data rules, otherwise { rule, reason }. A label with no rule
 * may go anywhere; a rule is the list of vendors allowed to receive it (an
 * empty list: none may).
 */
export function dataRefusal(policy, label, provider) {
  if (!label) return null;
  const allowed = policy?.dataRules?.[label];
  if (!Array.isArray(allowed)) return null;
  const vendor = vendorOf(provider);
  if (vendor && allowed.includes(vendor)) return null;
  const text = SENSITIVITY_LABELS[label] ?? label;
  const vendorName = PROVIDERS[provider]?.vendor ?? "its vendor";
  return {
    rule: "launch.data.destination",
    reason: allowed.length
      ? `${text} work may go only to ${allowed.map((v) => VENDORS[v] ?? v).join(", ")} under this workspace's data rules; ${nameOf(provider)} sends work to ${vendorName}.`
      : `${text} work may not be sent to any assistant under this workspace's data rules; ${nameOf(provider)} sends work to ${vendorName}.`,
  };
}

/**
 * The fallback assistant a retry policy names, rechecked against the data
 * rules for this work's label: { provider, refused } — provider null and
 * the reason when the other assistant's vendor may not receive it.
 */
export function allowedFallback(fallback, { rules, label }) {
  if (!fallback) return { provider: null, refused: null };
  const refusal = dataRefusal(rules, label, fallback);
  return refusal
    ? { provider: null, refused: refusal.reason }
    : { provider: fallback, refused: null };
}

function startOfDay(now) {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Tokens an assistant reported today in a workspace: { tokens, reported }. */
export function providerTokensToday(
  db,
  workspaceId,
  provider,
  now = Date.now(),
) {
  const rows = db
    .prepare(
      "SELECT usage FROM runs WHERE workspace_id = ? AND provider = ? AND started_at >= ?",
    )
    .all(workspaceId, provider, startOfDay(now));
  let tokens = 0;
  let reported = false;
  for (const row of rows) {
    let usage = null;
    try {
      usage = row.usage ? JSON.parse(row.usage) : null;
    } catch {
      usage = null;
    }
    const total = totalTokens(usage);
    if (total > 0) tokens += total;
    if (usageIsReported(usage)) reported = true;
  }
  return { tokens, reported };
}

/** Null under the assistant's daily cap, otherwise { rule, reason }. */
export function capRefusal(policy, provider, usage) {
  const cap = policy?.providerDailyTokens?.[provider];
  if (!Number.isInteger(cap) || cap < 1) return null;
  if ((usage?.tokens ?? 0) < cap) return null;
  return {
    rule: "launch.budget.provider",
    reason: `${nameOf(provider)} has used ${usage.tokens.toLocaleString("en-US")} of its ${cap.toLocaleString("en-US")} tokens for today in this workspace (provider-reported).`,
  };
}

/**
 * Pass/fail counts per assistant from graded runs in a workspace since
 * `since`: Map provider -> { pass, fail }. Verdicts marked unknown count
 * for neither.
 */
export function evaluationCounts(db, workspaceId, since) {
  const out = new Map();
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT r.provider AS provider, e.verdict AS verdict FROM evaluations e
           JOIN runs r ON r.id = e.run_id
          WHERE r.workspace_id = ? AND e.created_at >= ?`,
      )
      .all(workspaceId, since);
  } catch {
    return out;
  }
  for (const row of rows) {
    if (row.verdict !== "pass" && row.verdict !== "fail") continue;
    const entry = out.get(row.provider) ?? { pass: 0, fail: 0 };
    entry[row.verdict] += 1;
    out.set(row.provider, entry);
  }
  return out;
}

const READINESS = { ready: 0, detected: 1 };

/**
 * The ranking itself, from facts already gathered. Pure, so every rule is
 * unit tested.
 *
 * input: { policy, label, requires: [capability], allowExperimental,
 *   providers: [id], connectionOf(id) -> { status, reason } ,
 *   capabilitiesOf(id) -> matrix, usageOf(id) -> { tokens, reported },
 *   evaluationsOf(id) -> { pass, fail } }
 * → { label, candidates: [{ provider, name, vendor, eligible, checks:
 *     [{ check, ok, text }] }], recommended }
 */
export function rankProviders({
  policy = {},
  label = null,
  requires = [],
  allowExperimental = true,
  providers = REGISTRY_IDS,
  connectionOf = () => ({ status: "missing" }),
  capabilitiesOf = (id) => capabilityMatrix(id),
  usageOf = () => ({ tokens: 0, reported: false }),
  evaluationsOf = () => ({ pass: 0, fail: 0 }),
} = {}) {
  const prefer = policy.routingPreference ?? [];
  const minEvaluations = Number.isInteger(policy.minEvaluations)
    ? policy.minEvaluations
    : 5;
  const allowList = policy.allowedProviders ?? [];
  const candidates = providers.map((provider) => {
    const checks = [];
    // `short`: the same reason in a few words, for a picker option.
    const add = (check, ok, text, short = text) =>
      checks.push({ check, ok, text, short });
    const matrix = capabilitiesOf(provider) ?? {};
    const launch = matrix.launch ?? "unknown";
    if (launch === "unsupported" || launch === "unknown")
      add(
        "launch",
        false,
        launch === "unsupported"
          ? "Cannot be started from Agent Space (detected only)"
          : "Starting it from Agent Space has not been verified",
      );
    else
      add(
        "launch",
        true,
        launch === "verified" ? "Launch verified" : "Launch is experimental",
      );
    const connection = connectionOf(provider) ?? { status: "missing" };
    if (connection.status === "ready") add("connection", true, "Connected");
    else if (connection.status === "detected")
      add("connection", true, "Installed; sign-in not verified");
    else
      add(
        "connection",
        false,
        connection.reason ?? "Not installed or not available here",
      );
    if (allowList.length && !allowList.includes(provider))
      add(
        "allowed",
        false,
        "Not on this workspace's allowed assistants",
        "not on the allowed list",
      );
    for (const capability of requires ?? []) {
      const value = matrix[capability] ?? "unknown";
      const ok =
        value === "verified" || (allowExperimental && value === "experimental");
      add(
        "requires",
        ok,
        ok
          ? `${capability}: ${value}`
          : `Needs ${capability}, which is ${value} for ${nameOf(provider)}`,
        ok ? undefined : `needs ${capability} (${value})`,
      );
    }
    const data = dataRefusal(policy, label, provider);
    if (data)
      add(
        "data",
        false,
        data.reason,
        `not for ${SENSITIVITY_LABELS[label] ?? label} work (sends it to ${PROVIDERS[provider]?.vendor ?? "its vendor"})`,
      );
    else if (label)
      add(
        "data",
        true,
        `May receive ${SENSITIVITY_LABELS[label] ?? label} work (${PROVIDERS[provider]?.vendor ?? "vendor"})`,
      );
    const usage = usageOf(provider) ?? { tokens: 0, reported: false };
    const cap = capRefusal(policy, provider, usage);
    if (cap) add("budget", false, cap.reason, "over today's token cap");
    else if (Number.isInteger(policy.providerDailyTokens?.[provider]))
      add(
        "budget",
        true,
        usage.reported
          ? `${usage.tokens.toLocaleString("en-US")} of ${policy.providerDailyTokens[provider].toLocaleString("en-US")} tokens used today`
          : "No usage reported today",
      );
    const graded = evaluationsOf(provider) ?? { pass: 0, fail: 0 };
    const total = graded.pass + graded.fail;
    const rate = total >= minEvaluations ? graded.pass / total : null;
    add(
      "evaluation",
      true,
      rate === null
        ? `${total} graded result${total === 1 ? "" : "s"}; ${minEvaluations} needed to compare`
        : `${Math.round(rate * 100)}% of graded results passed (${graded.pass} of ${total})`,
    );
    return {
      provider,
      name: nameOf(provider),
      vendor: PROVIDERS[provider]?.vendor ?? null,
      eligible: checks.every((check) => check.ok),
      readiness: READINESS[connection.status] ?? 2,
      launch,
      rate,
      preferred: prefer.includes(provider) ? prefer.indexOf(provider) : null,
      checks,
    };
  });
  const order = (a, b) =>
    Number(b.eligible) - Number(a.eligible) ||
    (a.preferred ?? 99) - (b.preferred ?? 99) ||
    a.readiness - b.readiness ||
    (a.launch === "verified" ? 0 : 1) - (b.launch === "verified" ? 0 : 1) ||
    // Pass rates rank only between assistants that both have enough grades.
    (a.rate !== null && b.rate !== null ? b.rate - a.rate : 0) ||
    a.provider.localeCompare(b.provider);
  candidates.sort(order);
  const recommended = candidates.find((candidate) => candidate.eligible);
  return {
    label,
    candidates,
    recommended: recommended?.provider ?? null,
    why: recommended ? whyRecommended(recommended, candidates) : null,
  };
}

function whyRecommended(best, candidates) {
  const parts = [];
  if (best.preferred !== null) parts.push("first in this workspace's order");
  if (best.readiness === 0) parts.push("connected");
  if (best.launch === "verified") parts.push("launch verified");
  if (best.rate !== null)
    parts.push(`${Math.round(best.rate * 100)}% of graded results passed`);
  const others = candidates.filter((c) => c !== best && c.eligible).length;
  return `${best.name}: ${parts.join(", ") || "the only assistant that passes every check"}${others ? `; ${others} other assistant${others === 1 ? "" : "s"} also qualif${others === 1 ? "ies" : "y"}` : ""}.`;
}

/** Gathers the live facts for rankProviders from the composed services. */
export class Router {
  constructor(services, { now = Date.now } = {}) {
    this.services = services;
    this.now = now;
  }

  /**
   * rank({ workspaceId, taskId?, requires?, sensitivity?, allowExperimental? })
   * The label is the stricter of the workspace default, the task's own and
   * the one asked about.
   */
  rank({
    workspaceId,
    taskId = null,
    requires = [],
    sensitivity = null,
    allowExperimental = true,
  } = {}) {
    const { services } = this;
    const policy = services.policy.forWorkspace(workspaceId);
    let taskLabel = null;
    if (taskId) {
      const task = services.hub.get(workspaceId).store.get(taskId);
      taskLabel = task.executionPolicy?.sensitivity ?? null;
    }
    const label = stricterSensitivity(
      effectiveSensitivity(policy, taskLabel),
      sensitivity,
    );
    const connections = services.connections?.list?.() ?? [];
    const connectionOf = (provider) => {
      const mine = connections.filter((c) => c.provider === provider);
      if (!mine.length)
        return { status: "missing", reason: "Not installed or not detected" };
      const usable = mine.filter(
        (c) =>
          c.enabled !== false &&
          c.enabled !== 0 &&
          (!(c.allowedWorkspaces ?? []).length ||
            c.allowedWorkspaces.includes(workspaceId)),
      );
      if (!usable.length)
        return {
          status: "blocked",
          reason: "Disabled, or limited to other workspaces",
        };
      if (usable.some((c) => c.status === "ready")) return { status: "ready" };
      if (usable.some((c) => c.status === "detected"))
        return { status: "detected" };
      return {
        status: usable[0].status ?? "missing",
        reason:
          usable[0].status === "error"
            ? "Its version check failed"
            : "Binary not found",
      };
    };
    const since = this.now() - 30 * 24 * 60 * 60 * 1000;
    const evaluations = evaluationCounts(services.db, workspaceId, since);
    // Claude Code approvals are verified only with the hook bridge installed.
    let hooksInstalled = false;
    try {
      hooksInstalled = services.connections?.hooksInstalled?.() === true;
    } catch {
      hooksInstalled = false;
    }
    return rankProviders({
      policy,
      label,
      requires,
      allowExperimental,
      connectionOf,
      capabilitiesOf: (provider) =>
        capabilityMatrix(provider, { hooksInstalled }),
      usageOf: (provider) =>
        providerTokensToday(services.db, workspaceId, provider, this.now()),
      evaluationsOf: (provider) =>
        evaluations.get(provider) ?? { pass: 0, fail: 0 },
    });
  }
}

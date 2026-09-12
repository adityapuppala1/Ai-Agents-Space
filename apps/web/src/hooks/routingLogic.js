// The routing card's rules (components/RoutingRules.jsx): turning the stored
// policy into form state and back, and the words for a ranking. Pure, so
// node:test covers it.

/**
 * Form state from the stored policy and GET /api/routing:
 * { dataSensitivity, rows: { label: { any, vendors: [] } }, caps: { provider:
 * "" | number }, preference: [provider], minEvaluations }.
 */
export function rulesToForm(policy = {}, vocabulary = {}) {
  const levels = vocabulary.levels ?? [];
  const rules = policy.dataRules ?? {};
  const rows = {};
  for (const level of levels) {
    const allowed = rules[level];
    rows[level] = Array.isArray(allowed)
      ? { any: false, vendors: [...allowed] }
      : { any: true, vendors: [] };
  }
  const caps = {};
  for (const provider of vocabulary.providers ?? [])
    caps[provider.id] = policy.providerDailyTokens?.[provider.id] ?? "";
  return {
    dataSensitivity: policy.dataSensitivity ?? "",
    rows,
    caps,
    preference: [...(policy.routingPreference ?? [])],
    minEvaluations: policy.minEvaluations ?? 5,
  };
}

/** The PUT /policy patch for the routing fields. */
export function formToRules(form) {
  const dataRules = {};
  for (const [level, row] of Object.entries(form.rows ?? {}))
    dataRules[level] = row.any ? null : [...new Set(row.vendors)];
  const providerDailyTokens = {};
  for (const [provider, cap] of Object.entries(form.caps ?? {})) {
    const n = Number(cap);
    providerDailyTokens[provider] =
      cap === "" || !Number.isInteger(n) || n < 1 ? null : n;
  }
  return {
    dataSensitivity: form.dataSensitivity || null,
    dataRules,
    providerDailyTokens,
    routingPreference: [...form.preference],
    minEvaluations: Math.max(1, Number(form.minEvaluations) || 5),
  };
}

/** A label row in words: "Any vendor", "Nowhere", or the vendors allowed. */
export function ruleSummary(row, vendors = {}) {
  if (!row || row.any) return "Any vendor";
  if (!row.vendors.length) return "Nowhere: no assistant may receive it";
  return `Only ${row.vendors.map((v) => vendors[v] ?? v).join(", ")}`;
}

/** Moves `id` one place up (-1) or down (+1) in an ordered list. */
export function moveInOrder(list, id, delta) {
  const index = list.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * One line for a ranked candidate: why it is excluded (its first failing
 * check) or, when eligible, the facts that count.
 */
export function candidateLine(candidate) {
  const failing = (candidate?.checks ?? []).find((check) => !check.ok);
  if (failing) return failing.text;
  return (candidate?.checks ?? [])
    .filter((check) =>
      ["connection", "launch", "evaluation"].includes(check.check),
    )
    .map((check) => check.text)
    .join(" · ");
}

/**
 * The reason to show beside an assistant in a picker, or "" when routing has
 * nothing against it. `ranking` is a POST /route result (or null).
 */
export function routingReason(ranking, provider) {
  const candidate = ranking?.candidates?.find((c) => c.provider === provider);
  if (!candidate || candidate.eligible) return "";
  // Connection problems are already said by the picker itself.
  const failing = candidate.checks.find(
    (check) => !check.ok && check.check !== "connection",
  );
  return failing ? (failing.short ?? failing.text) : "";
}

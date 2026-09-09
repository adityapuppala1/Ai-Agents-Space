/**
 * Task-to-team suggestions (roadmap §10, "Task-to-team suggestions that the
 * user can inspect and edit; show the proposed number of runs and resource
 * assumptions").
 *
 * Deterministic and rule-based on purpose: no model is called, so the same
 * workspace and template always produce the same proposal, and every
 * assignment carries the reason it was made. Nothing is dispatched from
 * here — the result is a proposal the user edits and then starts themselves.
 */

import { InputError } from "../TaskStore.js";
import { PROVIDERS } from "../contracts.js";
import { listTemplates, getTemplate } from "./templates/index.js";

export const SUGGESTION_ASSUMPTIONS = Object.freeze([
  "one run per step",
  "no retries counted",
  "each step runs once, sequentially where it has dependencies",
  "token cost is not estimated: providers report usage only after a run",
]);

const ACTIVE_RUN_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "blocked",
  "stale",
];

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(text) {
  return normalize(text).split(" ").filter(Boolean);
}

/** Deterministic keyword score of a template against a free-text goal. */
export function scoreTemplate(template, goal) {
  const target = new Set(words(goal));
  if (!target.size) return 0;
  const haystack = [
    template.id,
    template.name,
    template.domain,
    template.description,
    ...(template.roles ?? []).map(
      (role) => role.name ?? role.title ?? role.key ?? "",
    ),
    ...(template.steps ?? []).map((step) => step.title ?? ""),
  ].join(" ");
  const pool = words(haystack);
  const counts = new Map();
  for (const word of pool) counts.set(word, (counts.get(word) ?? 0) + 1);
  let score = 0;
  for (const word of target) if (counts.has(word)) score += 1;
  return score;
}

/** Picks the template whose vocabulary best matches a goal; ties break by id. */
export function pickTemplate(goal) {
  const scored = listTemplates()
    .map((template) => ({ template, score: scoreTemplate(template, goal) }))
    .sort(
      (a, b) => b.score - a.score || a.template.id.localeCompare(b.template.id),
    );
  const best = scored[0];
  if (!best || best.score === 0) return null;
  return {
    ...best,
    alternatives: scored.slice(1, 4).filter((s) => s.score > 0),
  };
}

function loadFor(db, agentIds) {
  const load = new Map(agentIds.map((id) => [id, 0]));
  if (!agentIds.length) return load;
  const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(", ");
  for (const row of db
    .prepare(
      `SELECT agent_id, COUNT(*) AS n FROM runs WHERE status IN (${placeholders}) GROUP BY agent_id`,
    )
    .all(...ACTIVE_RUN_STATUSES))
    if (load.has(row.agent_id)) load.set(row.agent_id, row.n);
  return load;
}

function roleMatchScore(agent, role) {
  const roleWords = new Set([
    ...words(role?.key ?? ""),
    ...words(role?.name ?? role?.title ?? ""),
  ]);
  if (!roleWords.size) return 0;
  const agentWords = new Set([
    ...words(agent.role ?? ""),
    ...words(agent.specialty ?? ""),
    ...words(agent.name ?? ""),
    ...(agent.skills ?? []).flatMap((skill) => words(skill)),
  ]);
  let score = 0;
  for (const word of roleWords) if (agentWords.has(word)) score += 1;
  return score;
}

/**
 * suggestTeam(services, { workspaceId, templateId? , goal? })
 *
 * → {
 *     templateId, templateName, matchedFrom,
 *     assignments: [{ stepKey, title, role, agentId, agentName, provider,
 *                     reason, capability }],
 *     proposedRuns, assumptions, unassigned, editable: true, dispatched: false
 *   }
 */
export function suggestTeam(
  services,
  { workspaceId, templateId = null, goal = null } = {},
) {
  if (!workspaceId) throw new InputError("workspaceId is required");
  const workspace = services.hub.get(workspaceId);
  let template = null;
  let matchedFrom = "templateId";
  if (templateId) {
    template = getTemplate(templateId);
  } else if (goal && String(goal).trim()) {
    const picked = pickTemplate(goal);
    if (!picked)
      throw new InputError(
        "No template matches that goal. Pick a template explicitly.",
        404,
      );
    template = picked.template;
    matchedFrom = "goal";
  } else {
    throw new InputError("templateId or goal is required");
  }

  const agents = (workspace.snapshot().agents ?? []).filter(
    (agent) => !agent.archivedAt,
  );
  const load = loadFor(
    services.db,
    agents.map((agent) => agent.id),
  );
  const connections = services.connections?.list?.() ?? [];
  const readyProviders = new Set(
    connections
      .filter(
        (connection) =>
          connection.enabled !== false &&
          ["ready", "detected"].includes(connection.status) &&
          (!(connection.allowedWorkspaces ?? []).length ||
            connection.allowedWorkspaces.includes(workspaceId)),
      )
      .map((connection) => connection.provider),
  );
  const capabilityOf = (provider) => {
    const connection = connections.find((c) => c.provider === provider);
    const value = connection?.capabilities?.launch;
    return value ?? "unknown";
  };

  const rolesByKey = new Map(
    (template.roles ?? []).map((role) => [role.key ?? role.id ?? role, role]),
  );
  const assignments = [];
  const unassigned = [];
  const taken = new Map();

  for (const step of template.steps ?? []) {
    const role = rolesByKey.get(step.role) ?? {
      key: step.role,
      title: step.role,
    };
    const wanted = step.provider ?? null;
    const ranked = agents
      .map((agent) => {
        const providerMatch =
          wanted && agent.provider === wanted
            ? 3
            : !wanted && agent.provider
              ? 1
              : 0;
        const providerReady =
          agent.provider && readyProviders.has(agent.provider) ? 1 : 0;
        return {
          agent,
          roleScore: roleMatchScore(agent, role),
          providerMatch,
          providerReady,
          load: (load.get(agent.id) ?? 0) + (taken.get(agent.id) ?? 0),
        };
      })
      .sort(
        (a, b) =>
          b.providerMatch - a.providerMatch ||
          b.roleScore - a.roleScore ||
          b.providerReady - a.providerReady ||
          a.load - b.load ||
          a.agent.name.localeCompare(b.agent.name) ||
          a.agent.id.localeCompare(b.agent.id),
      );
    const best = ranked[0];
    if (!best) {
      unassigned.push({
        stepKey: step.key,
        title: step.title,
        role: step.role,
        reason: "this workspace has no agent profiles yet",
      });
      continue;
    }
    taken.set(best.agent.id, (taken.get(best.agent.id) ?? 0) + 1);
    const provider = best.agent.provider ?? wanted ?? null;
    const reasons = [];
    if (best.providerMatch === 3)
      reasons.push(
        `the step asks for ${PROVIDERS[wanted]?.name ?? wanted} and this profile uses it`,
      );
    else if (wanted)
      reasons.push(
        `the step suggests ${PROVIDERS[wanted]?.name ?? wanted}; no profile uses it, so the closest match was chosen`,
      );
    if (best.roleScore > 0)
      reasons.push(`its role matches "${role.name ?? role.title ?? role.key}"`);
    else
      reasons.push(
        `no profile role matches "${role.name ?? role.title ?? role.key}"`,
      );
    reasons.push(
      best.load === 0
        ? "it has no active run"
        : `it has ${best.load} run(s) already assigned in this proposal or in flight`,
    );
    if (provider && !readyProviders.has(provider))
      reasons.push(
        `its provider is not reported ready; connect it before starting`,
      );
    assignments.push({
      stepKey: step.key,
      title: step.title,
      role: step.role,
      agentId: best.agent.id,
      agentName: best.agent.name,
      provider,
      providerName: provider ? (PROVIDERS[provider]?.name ?? provider) : null,
      providerReady: provider ? readyProviders.has(provider) : false,
      capability: provider ? capabilityOf(provider) : "unknown",
      dependsOn: step.dependsOn ?? [],
      reason: reasons.join("; "),
      editable: true,
    });
  }

  return {
    workspaceId,
    templateId: template.id,
    templateName: template.name,
    matchedFrom,
    goal: goal ?? null,
    assignments,
    unassigned,
    proposedRuns: assignments.length,
    assumptions: [...SUGGESTION_ASSUMPTIONS],
    editable: true,
    dispatched: false,
    note: "This is a proposal. Edit it, then start it yourself: nothing is dispatched from a suggestion.",
  };
}

export function createSuggest(services) {
  const api = {
    suggestTeam: (input) => suggestTeam(services, input),
    pickTemplate,
    scoreTemplate,
  };
  services.suggest = api;
  return api;
}

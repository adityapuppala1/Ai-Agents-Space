// The team dialog's rules (TemplateGallery): who is staffed on each role of a
// workflow template, which assistant each role runs on, what the relay looks
// like, and the payload for POST /api/workspaces/:id/teams. Pure: no React,
// no fetch, so node:test covers it.

/** A role's key and display name; templates list roles as objects. */
export function roleKey(role) {
  return typeof role === "string" ? role : (role?.key ?? "");
}
export function roleName(role) {
  return typeof role === "string" ? role : (role?.name ?? role?.key ?? "");
}

/** "Investigator, Developer, QA engineer" (templates list roles as objects). */
export function roleNames(template) {
  return (template?.roles ?? []).map(roleName).filter(Boolean).join(", ");
}

/**
 * A step title with the typed inputs in place of its {{placeholders}}; an
 * input not typed yet reads "…", never the raw placeholder.
 */
export function fillTitle(title, inputs = {}) {
  return String(title ?? "").replace(
    /\{\{([^{}]*)\}\}/g,
    (_, key) => String(inputs?.[key.trim()] ?? "").trim() || "…",
  );
}

const TRAILING = new Set([" ", ":", "–", "—", "-"]);

/** "Reproduce: {{issue}}" -> "Reproduce": the step's own name, for a summary. */
export function shortTitle(title) {
  let bare = String(title ?? "").replace(/\{\{[^{}]*\}\}/g, "");
  while (bare && TRAILING.has(bare.at(-1))) bare = bare.slice(0, -1);
  bare = bare.trim();
  return bare || String(title ?? "");
}

/** Steps of a template grouped by role key, in template order. */
export function roleSteps(template) {
  const out = new Map();
  for (const step of template?.steps ?? []) {
    const list = out.get(step.role) ?? [];
    list.push(step);
    out.set(step.role, list);
  }
  return out;
}

/**
 * Starting choices per role: a profile already named for the role is used,
 * otherwise a new one is proposed; the assistant is the one the template's
 * steps ask for, if any. { roleKey: { agent: id | "new" | "", provider } }.
 */
export function defaultTeam(template, agents = []) {
  const steps = roleSteps(template);
  const team = {};
  for (const role of template?.roles ?? []) {
    const key = roleKey(role);
    const name = roleName(role).toLowerCase();
    const existing = agents.find(
      (agent) => !agent.archived && String(agent.name).toLowerCase() === name,
    );
    const stepProvider =
      (steps.get(key) ?? []).find((step) => step.provider)?.provider ?? "";
    team[key] = {
      agent: existing ? existing.id : "new",
      provider: stepProvider || existing?.provider || "",
    };
  }
  return team;
}

/** The assistant a step would run on: its own, or its role's choice. */
export function stepProvider(step, team) {
  return step?.provider || team?.[step?.role]?.provider || "";
}

/**
 * The relay as it will run: each step, who holds it, what it waits for, and
 * whether it can start by itself (an assistant is chosen for it).
 */
export function relayPreview(template, team, agents = [], inputs = {}) {
  const roles = new Map(
    (template?.roles ?? []).map((role) => [roleKey(role), roleName(role)]),
  );
  const titles = new Map(
    (template?.steps ?? []).map((step) => [
      step.key,
      fillTitle(step.title, inputs),
    ]),
  );
  return (template?.steps ?? []).map((step) => {
    const choice = team?.[step.role]?.agent ?? "";
    let holder = "Unassigned";
    if (choice === "new") holder = roles.get(step.role) ?? step.role;
    else if (choice)
      holder = agents.find((agent) => agent.id === choice)?.name ?? "Agent";
    return {
      key: step.key,
      title: titles.get(step.key),
      role: roles.get(step.role) ?? step.role,
      holder,
      provider: stepProvider(step, team),
      after: (step.dependsOn ?? []).map((key) => titles.get(key) ?? key),
    };
  });
}

/**
 * Whether "start the first steps now" can be offered: every step that waits
 * on nothing needs an assistant. Returns { ok, missing: [step titles] }.
 */
export function canStart(template, team) {
  const roots = (template?.steps ?? []).filter(
    (step) => !(step.dependsOn ?? []).length,
  );
  const missing = roots
    .filter((step) => !stepProvider(step, team))
    .map((step) => step.title);
  return { ok: roots.length > 0 && missing.length === 0, missing };
}

/** The request body for POST /api/workspaces/:id/teams. */
export function teamPayload(template, team, inputs, start) {
  const agentByRole = {};
  const providerByRole = {};
  const createAgents = [];
  for (const role of template?.roles ?? []) {
    const key = roleKey(role);
    const choice = team?.[key] ?? {};
    if (choice.agent === "new") createAgents.push(key);
    else if (choice.agent) agentByRole[key] = choice.agent;
    if (choice.provider) providerByRole[key] = choice.provider;
  }
  return {
    templateId: template?.id,
    inputs: inputs ?? {},
    agentByRole,
    providerByRole,
    createAgents,
    start: Boolean(start) && canStart(template, team).ok,
  };
}
